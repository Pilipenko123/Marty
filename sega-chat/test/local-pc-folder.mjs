// Пока это только автономные проверки файловой основы, не тест доступа через сеть.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFolder, partsOf, MAX_CHUNK, MAX_ENTRIES } = require('../local-pc/folder.js');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sega-local-pc-'));
try {
  const root = path.join(tmp, 'chosen'), outside = path.join(tmp, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside); await fs.mkdir(path.join(root, 'Папка'));
  await fs.writeFile(path.join(root, 'Папка', 'файл.txt'), 'Привет!');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  let links = true;
  try {
    await fs.symlink(outside, path.join(root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'filelink'), 'file');
  } catch (e) {
    if (process.platform !== 'win32' || !['EPERM','EACCES'].includes(e.code)) throw e;
    links = false;
  }
  const folder = await createFolder(root);
  const items = await folder.list('');
  assert.deepEqual(items.map(x => x.name), ['Папка']);
  const sub = await folder.list('Папка');
  assert.equal(sub[0].name, 'файл.txt'); assert.equal(sub[0].size, Buffer.byteLength('Привет!'));
  assert.equal((await folder.read('Папка/файл.txt')).data.toString(), 'Привет!');
  assert.equal((await folder.read('Папка/файл.txt', 2, 4)).data.equals(Buffer.from('Привет!').subarray(2, 6)), true);
  assert.equal((await folder.read('Папка/файл.txt', 999, 5)).data.length, 0);
  const snapshot=await folder.read('Папка/файл.txt');
  assert.match(snapshot.version,/^[a-f0-9]{64}$/);
  assert.equal((await folder.read('Папка/файл.txt',2,4,snapshot.version)).version,snapshot.version);
  await fs.writeFile(path.join(root,'Папка','файл.txt'),'Новое содержимое');
  await assert.rejects(folder.read('Папка/файл.txt',2,4,snapshot.version),/изменился/);
  await assert.rejects(folder.read('Папка/файл.txt',2,4,'wrong'),/Неверная версия/);

  for (const p of ['../outside/secret.txt','/absolute','C:/secret','..\\secret','Папка/../x','Папка//x','foo.','aux.txt','a\0b','x:stream','x/*']) assert.throws(()=>partsOf(p));
  assert.throws(()=>partsOf('a'.repeat(4097)));
  for (const p of ['../outside/secret.txt','Папка/../x','C:/secret']) await assert.rejects(folder.read(p));
  if (links) { await assert.rejects(folder.list('shortcut')); await assert.rejects(folder.read('filelink')); await assert.rejects(folder.read('shortcut/secret.txt')); }
  await assert.rejects(folder.read('Папка'));
  await assert.rejects(folder.read('Папка/файл.txt', -1));
  await assert.rejects(folder.read('Папка/файл.txt', 0, MAX_CHUNK + 1));
  await assert.rejects(createFolder('relative'));
  await assert.rejects(createFolder(path.join(root, 'Папка', 'файл.txt')));
  assert.equal(MAX_ENTRIES, 5000);
  console.log('local-pc-folder: чтение папки, обход путей и ссылки проверены (без сети)');
} finally { await fs.rm(tmp, { recursive:true, force:true }); }
