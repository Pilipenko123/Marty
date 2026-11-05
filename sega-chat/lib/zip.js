'use strict';
//
// pkg3-130: свой ZIP-писатель — папка с Диска уезжает одним архивом.
//
// Новых зависимостей не берём: ZIP собираем сами, сжатие — встроенный zlib.
// Главное требование — не держать архив в памяти: VPS живёт на 550 МБ, а в
// папке бывают гигабайты музыки и видео. Поэтому каждый файл идёт потоком
// (Источник → deflate → ответ браузеру), а размеры и контрольная сумма
// дописываются ПОСЛЕ данных — это законный способ ZIP (флаг bit 3 с
// «data descriptor»), его понимают и Windows, и macOS, и unzip, и 7-Zip,
// и телефоны. Записи центрального каталога получают настоящие crc/размеры,
// поэтому распаковка проверяет целостность, как у обычного архива.

const zlib = require('zlib');
const { once } = require('events');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/** Контрольная сумма ZIP (CRC-32). prev — значение предыдущего куска. */
function crc32(buf, prev = 0) {
  let c = (prev ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) c = ((c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF]) >>> 0;
  return (c ^ -1) >>> 0;
}

/** Ограничения ZIP без ZIP64: один файл и весь архив — меньше 4 ГБ. */
const MAX_ENTRY = 3.5 * 1024 * 1024 * 1024;
const MAX_ZIP = 3.9 * 1024 * 1024 * 1024;

/** Уже сжатые типы незачем гонять через deflate — только время и процессор. */
function isCompressible(name, mime) {
  const n = String(name || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  if (/^(audio|video)\//.test(m)) return false;
  if (/^image\//.test(m) && !/bmp|tiff/.test(m)) return false;
  if (/^(application\/(zip|x-7z-compressed|x-rar-compressed|pdf|gzip)|font\/)/.test(m)) return false;
  return !/\.(mp3|m4a|aac|ogg|opus|flac|wav|wma|mp4|m4v|mov|avi|mkv|webm|jpg|jpeg|png|gif|webp|heic|svgz|zip|7z|rar|gz|bz2|xz|pdf|docx|xlsx|pptx|epub|jar|apk|iso)$/i.test(n);
}

/**
 * Имя внутри архива: путь сохраняем («Папка/файл.mp3»), а каждый кусок чистим —
 * без управляющих символов, без «..», без косых внутри имени и не пустой.
 */
function safeEntryName(name) {
  const parts = String(name == null ? '' : name).split('/');
  const out = [];
  for (const raw of parts) {
    let s = String(raw)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\\/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s === '.' || s === '..') continue;
    if (s.length > 120) {
      const dot = s.lastIndexOf('.');
      s = dot > 0 ? s.slice(0, 100) + s.slice(dot) : s.slice(0, 120);
    }
    out.push(s);
  }
  return out.join('/');
}

function dosTime(d) {
  const dt = d instanceof Date && !isNaN(d) ? d : new Date();
  const year = Math.min(2107, Math.max(1980, dt.getFullYear()));
  return {
    time: (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate()
  };
}

/** Писатель архива: пишет в любой поток (в нашем случае — в ответ HTTP). */
class ZipWriter {
  constructor(out) {
    this.out = out;
    this.off = 0;
    this.entries = [];
    this.closed = false;
  }

  async _write(buf) {
    this.off += buf.length;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  /** Сколько байт уже отдано браузеру. */
  get written() { return this.off; }

  /**
   * Добавить файл. `open` — функция, возвращающая поток (или async-итератор)
   * с содержимым; вызывается ТОЛЬКО когда очередь дошла до файла, чтобы не
   * держать открытыми сотни соединений.
   */
  async addFile(name, open, opts = {}) {
    const entry = safeEntryName(name);
    if (!entry) return false;
    const nameBuf = Buffer.from(entry, 'utf8');
    const { time, date } = dosTime(opts.mtime ? new Date(opts.mtime) : new Date());
    const method = isCompressible(entry, opts.mime) ? 8 : 0;
    // bit 3 — размеры и crc после данных; bit 11 — имя в UTF-8 (кириллица)
    const flags = 0x0808;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(0, 14);          // crc — потом
    lh.writeUInt32LE(0, 18);          // сжатый размер — потом
    lh.writeUInt32LE(0, 22);          // исходный размер — потом
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    // источник открываем ДО заголовка: не открылся — в архив не попало ни байта,
    // и файл можно честно прописать в «что-не-вошло»
    const source = await open();
    if (!source) throw new Error('нет содержимого: ' + entry);
    const localOff = this.off;
    await this._write(Buffer.concat([lh, nameBuf]));

    let crc = 0;
    let usize = 0;
    let csize = 0;
    try {

    if (method === 0) {
      for await (const chunk of source) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = crc32(b, crc);
        usize += b.length;
        if (usize > MAX_ENTRY) throw new Error('файл больше 3,5 ГБ — в архив не войдёт');
        csize = usize;
        await this._write(b);
      }
    } else {
      const def = zlib.createDeflateRaw({ level: 6 });
      const feed = (async () => {
        for await (const chunk of source) {
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          crc = crc32(b, crc);
          usize += b.length;
          if (usize > MAX_ENTRY) { def.destroy(new Error('файл больше 3,5 ГБ — в архив не войдёт')); return; }
          if (!def.write(b)) await once(def, 'drain');
        }
        def.end();
      })();
      for await (const chunk of def) {
        csize += chunk.length;
        await this._write(chunk);
      }
      await feed;
    }
    } catch (e) {
      // файл оборвался на середине — архив уже испорчен, пусть узнает вызывающий
      e.partial = true;
      throw e;
    }

    if (this.off > MAX_ZIP) throw new Error('архив получился больше 3,9 ГБ — скачайте папку по частям');

    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc >>> 0, 4);
    dd.writeUInt32LE(csize >>> 0, 8);
    dd.writeUInt32LE(usize >>> 0, 12);
    await this._write(dd);

    this.entries.push({ nameBuf, flags, method, time, date, crc, csize, usize, localOff });
    return true;
  }

  /** Пустая папка — тоже запись (иначе она пропадёт из архива). */
  async addDir(name) {
    const entry = safeEntryName(name);
    if (!entry) return false;
    const nameBuf = Buffer.from(entry.replace(/\/?$/, '/'), 'utf8');
    const { time, date } = dosTime(new Date());
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(0, 18);
    lh.writeUInt32LE(0, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const localOff = this.off;
    await this._write(Buffer.concat([lh, nameBuf]));
    this.entries.push({ nameBuf, flags: 0x0800, method: 0, time, date, crc: 0, csize: 0, usize: 0, localOff });
    return true;
  }

  /** Закрыть архив: центральный каталог и «конец каталога». */
  async end() {
    if (this.closed) return this.off;
    this.closed = true;
    const cdOff = this.off;
    for (const e of this.entries) {
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);        // кем создан
      ch.writeUInt16LE(20, 6);        // какая версия нужна
      ch.writeUInt16LE(e.flags, 8);
      ch.writeUInt16LE(e.method, 10);
      ch.writeUInt16LE(e.time, 12);
      ch.writeUInt16LE(e.date, 14);
      ch.writeUInt32LE(e.crc >>> 0, 16);
      ch.writeUInt32LE(e.csize >>> 0, 20);
      ch.writeUInt32LE(e.usize >>> 0, 24);
      ch.writeUInt16LE(e.nameBuf.length, 28);
      ch.writeUInt16LE(0, 30);        // extra
      ch.writeUInt16LE(0, 32);        // comment
      ch.writeUInt16LE(0, 34);        // диск
      ch.writeUInt16LE(0, 36);        // внутренние атрибуты
      ch.writeUInt32LE(e.method === 0 && /\/$/.test(e.nameBuf.toString('utf8')) ? 0x10 : 0, 38);
      ch.writeUInt32LE(e.localOff >>> 0, 42);
      await this._write(Buffer.concat([ch, e.nameBuf]));
    }
    const cdSize = this.off - cdOff;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize >>> 0, 12);
    eocd.writeUInt32LE(cdOff >>> 0, 16);
    eocd.writeUInt16LE(0, 20);
    await this._write(eocd);
    return this.off;
  }
}

/** Имя файла для «Скачать» в заголовке Content-Disposition (кириллица — UTF-8). */
function disposition(fileName) {
  const base = safeEntryName(fileName) || 'disk';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '.zip"; filename*=UTF-8\'\'' + encodeURIComponent(base + '.zip');
}

module.exports = { crc32, ZipWriter, safeEntryName, isCompressible, disposition, MAX_ENTRY, MAX_ZIP };
