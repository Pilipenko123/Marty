// Этап 1 синхронизации папок: правила, криптография и безопасная локальная запись.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BUILD } from './build.mjs';

const require = createRequire(import.meta.url);
const core = require('../helper/core.js');
const { createLocalFolder } = require('../helper/local.js');
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const fp = (text, mtime = 1000) => { const b = Buffer.from(text); return { hash: crypto.createHash('sha256').update(b).digest('hex'), size: b.length, mtimeMs: mtime }; };
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return e.code === code; } };
const rejectsCode = async (fn, code) => { try { await fn(); return false; } catch (e) { return e.code === code; } };

console.log('\n══════════════════════════════════════════════════');
console.log('  Синхронизация папок · этап 1 · ядро защиты файлов');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Пути и имена');
ok(core.normalizePath('Документы/Отчёт.pdf') === 'Документы/Отчёт.pdf', 'обычный путь с кириллицей сохраняется');
ok(core.normalizePath('e\u0301.txt') === 'é.txt', 'Unicode приводится к одному виду NFC');
ok(core.normalizePath('', { allowRoot: true }) === '', 'корень папки допустим только явно');
for (const p of ['../тайна.txt', 'а/../б.txt', '/etc/passwd', 'C:/Windows/win.ini', '\\\\сервер\\папка', 'а\\б.txt', 'файл:поток', 'CON.txt', 'nul', 'com1.log', 'lpt9', 'папка./файл', 'имя ', 'a//b', './a', 'a/<b', 'a/?', 'a/\x01']) {
  ok(throwsCode(() => core.normalizePath(p), (() => { try { core.normalizePath(p); return ''; } catch (e) { return e.code; } })()), 'опасный путь отклонён: ' + JSON.stringify(p));
}
ok(throwsCode(() => core.normalizePath('a/'.repeat(40) + 'b'), 'path-deep'), 'слишком глубокий путь отклонён');
ok(core.pathKey('Ёжик.TXT') === core.pathKey('ёжик.txt'), 'регистр не создаёт два разных файла Windows');
ok(core.detectCollisions(['Фото/Ель.jpg', 'Фото/ель.jpg']).length === 1, 'коллизия регистра найдена');
ok(core.detectCollisions(['а.txt', 'б.txt']).length === 0, 'разные имена не считаются коллизией');
const ignored = core.ignoreMatcher();
ok(ignored('проект/.git/config') && ignored('документ/~$отчёт.docx') && ignored('загрузка/file.crdownload'), 'служебные и временные файлы пропускаются');
ok(!ignored('документ/отчёт.docx'), 'обычный документ не пропускается');
const cname = core.conflictName('Фото/Ель.jpg', 'ПК-2', 'event12345678', () => false);
ok(cname.startsWith('Фото/Ель (конфликт ПК-2 event12345') && cname.endsWith('.jpg'), 'конфликтная копия сохраняет имя и расширение');
ok(core.conflictName('архив.tar.gz', 'ПК', 'event12345678', () => false).endsWith('.tar.gz'), 'длинное расширение не обрезается до точки');
ok(core.conflictName('a.txt', 'ПК', 'event12345678', p => p.includes('event12345678)')) !== cname, 'занятое имя получает следующий номер');

console.log('\n  2. Решение по версиям, а не по дате');
const a = fp('одинаково'), b = fp('новая версия', 1), c = fp('старая версия', 999999);
ok(core.classifyChange({ local: null, base: null, incoming: a }).action === 'create', 'новый файл создаётся');
ok(core.classifyChange({ local: a, base: null, incoming: a }).action === 'noop', 'та же сумма не копируется');
ok(core.classifyChange({ local: a, base: a, incoming: b }).action === 'update', 'неизменённый локальный файл обновляется');
ok(core.classifyChange({ local: b, base: a, incoming: c }).action === 'conflict', 'одновременные изменения дают конфликт, даже если датаincoming старее');
ok(core.classifyChange({ local: b, base: null, incoming: c }).action === 'conflict', 'без журнала чужая версия не затирает локальную');
ok(core.classifyChange({ local: b, base: a, incoming: a }).action === 'keep-local', 'локальная новая версия не откатывается старой пришедшей');
ok(core.classifyChange({ local: a, base: a, incoming: { deleted: true } }).action === 'confirm-delete', 'удаление требует подтверждения');
ok(core.classifyChange({ local: null, base: a, incoming: { deleted: true } }).action === 'noop', 'повторное удаление отсутствующего файла безопасно');
ok(core.classifyChange({ local: null, base: a, incoming: b }).action === 'confirm-restore', 'локальное удаление не отменяется молчаливым восстановлением');
ok(core.classifyChange({ local: a, base: a, incoming: Object.assign({ baseHash: c.hash }, b) }).action === 'conflict', 'несовпадение основания удалённой правки даёт конфликт');
ok(core.classifyChange({ local: null, base: { deleted: true, hash: a.hash }, incoming: b }).action === 'create', 'после подтверждённого удаления новый файл создаётся');

console.log('\n  3. Конверт события');
const key = crypto.randomBytes(32);
const event = { id: 'event-12345678', folderId: 'folder-12345678', deviceId: 'device-12345678', op: 'put', path: 'Документы/отчёт.txt', at: 1, file: a };
const env = core.sealEvent(key, event);
ok(env.alg === 'A256GCM' && !JSON.stringify(env).includes('отчёт'), 'событие зашифровано, путь не открыт в конверте');
ok(core.openEvent(key, env).path === event.path, 'свой ключ открывает событие');
ok(throwsCode(() => core.openEvent(crypto.randomBytes(32), env), 'envelope-auth'), 'чужой ключ не открывает событие');
const tampered = JSON.parse(JSON.stringify(env));
const raw = Buffer.from(tampered.ct, 'base64'); raw[0] ^= 1; tampered.ct = raw.toString('base64');
ok(throwsCode(() => core.openEvent(key, tampered), 'envelope-auth'), 'порча шифротекста обнаружена');
const moved = JSON.parse(JSON.stringify(env)); moved.context.folderId = 'folder-87654321';
ok(throwsCode(() => core.openEvent(key, moved), 'envelope-auth'), 'перенос конверта в другую папку обнаружен');
ok(throwsCode(() => core.sealEvent(crypto.randomBytes(16), event), 'key-length'), 'короткий ключ запрещён');
ok(throwsCode(() => core.sealEvent(key, Object.assign({}, event, { path: '../побег' })), 'path-segment'), 'опасный путь не шифруется как допустимый');

console.log('\n  4. Локальная папка: запись, конфликт, удаление');
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sega-sync-core-'));
const root = path.join(tmp, 'Папка');
const state = path.join(tmp, 'Служебная');
await fsp.mkdir(root);
const folder = createLocalFolder({ root, stateDir: state, folderId: 'folder-12345678', deviceId: 'device-12345678', now: () => 1000 });
await folder.init();
await folder.acquire();
ok(await rejectsCode(() => folder.acquire(), 'busy') === false, 'повторный захват тем же процессом безопасен');
const second = createLocalFolder({ root, stateDir: state, folderId: 'folder-12345678', deviceId: 'device-87654321' });
await second.init();
ok(await rejectsCode(() => second.acquire(), 'busy'), 'второй помощник не пишет в ту же папку одновременно');
await second.release();
ok(throwsCode(() => createLocalFolder({ root, stateDir: path.join(root, '.state'), folderId: 'folder-12345678', deviceId: 'device-12345678' }), 'state-inside'), 'журнал нельзя положить внутрь синхронизируемой папки');

const ev = (id, p, text, extra = {}) => Object.assign({ id, folderId: 'folder-12345678', deviceId: 'device-87654321', op: 'put', path: p, at: 1, file: fp(text) }, extra);
const put = (id, p, text, extra) => folder.apply(ev(id, p, text, extra), () => Buffer.from(text));
let r = await put('event-00000001', 'Документы/отчёт.txt', 'первая');
ok(r.action === 'create' && (await fsp.readFile(path.join(root, 'Документы/отчёт.txt'), 'utf8')) === 'первая', 'новый файл записан во вложенную папку');
r = await folder.apply(ev('event-00000001', 'Документы/отчёт.txt', 'первая'), () => Buffer.from('подмена'));
ok(r.action === 'noop' && r.reason === 'already-applied', 'повтор события не читает и не пишет содержимое');
r = await put('event-00000002', 'Документы/отчёт.txt', 'вторая');
ok(r.action === 'update' && (await fsp.readFile(path.join(root, 'Документы/отчёт.txt'), 'utf8')) === 'вторая', 'неизменённый локальный файл обновлён');
ok(fs.existsSync(path.join(state, 'backups', fp('первая').hash)), 'прежняя версия сохранена в служебной папке');
await fsp.writeFile(path.join(root, 'Документы/отчёт.txt'), 'моя правка');
r = await put('event-00000003', 'Документы/отчёт.txt', 'правка друга');
ok(r.action === 'conflict' && (await fsp.readFile(path.join(root, 'Документы/отчёт.txt'), 'utf8')) === 'моя правка', 'конфликт не затёр локальный оригинал');
ok(r.copy && (await fsp.readFile(path.join(root, r.copy), 'utf8')) === 'правка друга', 'пришедшая версия сохранена отдельной копией');
const before = await fsp.readdir(path.join(root, 'Документы'));
await folder.apply(ev('event-00000003', 'Документы/отчёт.txt', 'правка друга'), () => Buffer.from('правка друга'));
ok((await fsp.readdir(path.join(root, 'Документы'))).length === before.length, 'повтор конфликтного события не создал вторую копию');
ok(await rejectsCode(() => folder.apply(ev('event-00000004', 'плохой.txt', 'текст'), () => Buffer.from('другой текст')), 'checksum'), 'несовпадение суммы останавливает запись');
ok(!fs.existsSync(path.join(root, 'плохой.txt')), 'после ошибки суммы файла нет');
ok((await fsp.readdir(root)).every(n => !n.startsWith('.sega-tmp-')), 'временный файл убран после ошибки');

const del = { id: 'event-00000005', folderId: 'folder-12345678', deviceId: 'device-87654321', op: 'delete', path: 'Документы/отчёт.txt', file: fp('моя правка') };
r = await folder.apply(del);
ok(r.action === 'confirm-delete' && fs.existsSync(path.join(root, 'Документы/отчёт.txt')), 'удаление только записало запрос');
await fsp.writeFile(path.join(root, 'Документы/отчёт.txt'), 'ещё одна локальная правка');
ok(await rejectsCode(() => folder.approveDelete('event-00000005'), 'stale-delete'), 'изменившийся файл не удаляется по старому запросу');
await fsp.writeFile(path.join(root, 'Документы/отчёт.txt'), 'моя правка');
r = await folder.approveDelete('event-00000005');
ok(r.action === 'delete-approved' && !fs.existsSync(path.join(root, 'Документы/отчёт.txt')), 'подтверждённое удаление убрано из папки');
ok(r.saved && fs.existsSync(r.saved), 'удалённый файл сохранён в служебной копии');
ok(await rejectsCode(() => folder.approveDelete('event-00000005'), 'pending'), 'повторное подтверждение не выполняется');

await fsp.writeFile(path.join(root, 'обычный.txt'), 'виден');
await fsp.writeFile(path.join(root, '~$временный.docx'), 'скрыт');
await fsp.mkdir(path.join(root, '.git'));
await fsp.writeFile(path.join(root, '.git/config'), 'скрыт');
try { await fsp.symlink(path.join(tmp, 'outside'), path.join(root, 'ссылка'), 'dir'); } catch (e) {}
const scan = await folder.scan();
ok(scan.files.some(f => f.path === 'обычный.txt'), 'обычный файл найден сканированием');
ok(!scan.files.some(f => f.path.startsWith('.git/') || f.path.startsWith('~$')), 'служебные файлы не попали в сканирование');
ok(!scan.files.some(f => f.path === 'ссылка') && !scan.dirs.includes('ссылка'), 'символическая ссылка не обойдена');
await fsp.writeFile(path.join(root, 'Регистр.txt'), '1');
await fsp.writeFile(path.join(root, 'регистр.txt'), '2');
ok(await rejectsCode(() => folder.scan(), 'case-collision'), 'имена с разным регистром остановлены до синхронизации');
await fsp.unlink(path.join(root, 'регистр.txt'));
await folder.release();
const reopened = createLocalFolder({ root, stateDir: state, folderId: 'folder-12345678', deviceId: 'device-12345678' });
await reopened.init();
ok(!!reopened.journal.applied['event-00000003'], 'журнал переживает закрытие и открытие');
await reopened.release();
await fsp.rm(tmp, { recursive: true, force: true });

ok(typeof BUILD === 'string' && /^pkg3-\d+$/.test(BUILD), 'отметка выпуска читается из кода, без хардкода номера');
console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
