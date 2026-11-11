'use strict';

// Основа будущего помощника Windows. Этот модуль не слушает сеть и ничего не
// записывает: доступ к нему появится только после отдельной реализации связи,
// авторизации и проверки безопасности. Пути извне — относительные, с «/».
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const crypto = require('node:crypto');
const {validateSignal,checkAborted} = require('./abort');
const {partsOf} = require('./path-rules');

const MAX_CHUNK = 256 * 1024;
const MAX_ENTRIES = 5000;
async function createFolder(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Выберите папку на компьютере');
  // Пользователь выбирает корень лично. Закрепляем его настоящий путь; ссылки
  // и точки соединения ВНУТРИ этого корня не показываем и не открываем.
  const base = await fs.realpath(root);
  if (!(await fs.stat(base)).isDirectory()) throw new Error('Выберите папку на компьютере');

  async function resolve(relative, expectDirectory, signal) {
    checkAborted(signal);
    const parts = partsOf(relative);
    let current = base;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const st = await fs.lstat(current);
      checkAborted(signal);
      if (st.isSymbolicLink()) throw new Error('Ссылки на другие папки и файлы не поддерживаются');
      if (i < parts.length - 1 && !st.isDirectory()) throw new Error('Папка не найдена');
    }
    const st = await fs.lstat(current);
    checkAborted(signal);
    if (st.isSymbolicLink()) throw new Error('Ссылки на другие папки и файлы не поддерживаются');
    if (expectDirectory && !st.isDirectory()) throw new Error('Это не папка');
    if (!expectDirectory && !st.isFile()) throw new Error('Это не файл');
    const actual = await fs.realpath(current);
    checkAborted(signal);
    const within = path.relative(base, actual);
    if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) throw new Error('Путь вне выбранной папки');
    return { current, st };
  }

  async function list(relative = '', signal) {
    validateSignal(signal);checkAborted(signal);
    const dir = await resolve(relative, true, signal);
    const names = await fs.readdir(dir.current);
    checkAborted(signal);
    if (names.length > MAX_ENTRIES) throw new Error('В папке слишком много элементов');
    const items = [];
    for (const name of names) {
      checkAborted(signal);
      try {
        partsOf(name);
        const st = await fs.lstat(path.join(dir.current, name));
        checkAborted(signal);
        if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) continue;
        items.push({ name, dir: st.isDirectory(), size: st.isFile() ? st.size : 0, modified: st.mtime.toISOString() });
      } catch (e) {
        // Файл мог исчезнуть во время просмотра; неподдерживаемые имена не отдаём.
        if (e.code !== 'ENOENT' && e.message !== 'Неверный путь') throw e;
      }
    }
    return items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'ru'));
  }

  async function read(relative, offset = 0, length = MAX_CHUNK, expectedVersion = null, signal) {
    validateSignal(signal);checkAborted(signal);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK) throw new Error('Неверный размер чтения');
    if (expectedVersion !== null && (typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion))) throw new Error('Неверная версия файла');
    const found = await resolve(relative, false, signal);
    checkAborted(signal);
    const handle = await fs.open(found.current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      checkAborted(signal);
      const opened = await handle.stat();
      checkAborted(signal);
      if (!opened.isFile() || opened.dev !== found.st.dev || opened.ino !== found.st.ino) throw new Error('Файл изменился, повторите попытку');
      // Метка помогает обнаруживать изменение при передаче по частям. Это не
      // криптографический хеш содержимого и не замена проверке итогового файла.
      const fingerprint = st => crypto.createHash('sha256').update([st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':')).digest('hex');
      const before = await handle.stat({bigint:true});
      checkAborted(signal);
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Файл слишком большой');
      const version = fingerprint(before);
      if (expectedVersion && expectedVersion !== version) throw new Error('Файл изменился, начните заново');
      const size = Number(before.size);
      const data = Buffer.alloc(Math.min(length, Math.max(0, size - offset)));
      const result = data.length ? await handle.read(data, 0, data.length, offset) : { bytesRead: 0 };
      checkAborted(signal);
      const after = await handle.stat({bigint:true});
      checkAborted(signal);
      if (fingerprint(after) !== version) throw new Error('Файл изменился, начните заново');
      return { data: data.subarray(0, result.bytesRead), size, modified: before.mtime.toISOString(), version };
    } finally { await handle.close(); }
  }

  return Object.freeze({ list, read });
}

module.exports = { createFolder, partsOf, MAX_CHUNK, MAX_ENTRIES };
