/**
 * pkg3-74: пульт памяти сервера.
 *   • сводка: мои/все чаты, категории по mime, процент, свободное место диска;
 *   • списки загрузок: свои — с настоящими именами, все — только админу и
 *     с условными именами («Фото №1»);
 *   • удаление: владелец или админ; после — 410 на куски и пометка gone;
 *   • сводка по чатам и права очистки (создатель/админ);
 *   • предел хранилища: только админ, не меньше занятого, не больше диска.
 * Запуск: node test/storage.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')) }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8') };
}
async function waitReady(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/state')).ok) return; } catch (e) {}
    await wait(200);
  }
  throw new Error('не поднялся ' + base);
}
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });

console.log('\n══════════════════════════════════════════════════');
console.log('  Пульт памяти сервера — pkg3-74');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-st-'));
const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, { STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0', PORT: String(port) })
});
procs.push(proc);
const base = `http://127.0.0.1:${port}`;
await waitReady(base);

const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
let r = await call(base, '/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token, adminId = r.d.user.id;
async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  return call(base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
r = await register(creds('Поля'), admin);
const g1 = r.d.token, g1Id = r.d.user.id;
r = await register(creds('Гоша'), g1);
const g2 = r.d.token, g2Id = r.d.user.id;
ok(!!g2, 'участники готовы');

r = await call(base, '/api/chats', { method: 'POST', body: { titleBlob: 'enc:' + hex(), members: [g1Id, g2Id], keys: { [adminId]: { blob: 'w-a' }, [g1Id]: { blob: 'w-1' }, [g2Id]: { blob: 'w-2' } } } }, admin);
const grp = r.d.chat.id;
ok(r.status === 200, 'группа создана');

// ── загрузка файла (фото) от Поли
async function upload(token, chatId, mime, data) {
  const i = await call(base, '/api/upload/init', { method: 'POST', body: { chat: chatId, name: 'kitty', size: data.length, mime, parts: 1 } }, token);
  if (i.status !== 200) return i;
  await call(base, '/api/upload/chunk', { method: 'POST', body: { upId: i.d.upId, i: 0, data } }, token);
  return call(base, '/api/upload/fin', { method: 'POST', body: { upId: i.d.upId, stored: data.length } }, token);
}
r = await upload(g1, grp, 'image/png', 'QUJDRA==');
ok(r.status === 200, 'фото загружено');
r = await upload(g1, grp, 'video/mp4', 'QUJDRA==');
ok(r.status === 200, 'видео загружено');
r = await upload(g2, grp, 'application/pdf', 'QUJDRA==');
ok(r.status === 200, 'файл загружен другим участником');

// pkg3-147: фотография из чата приходит не отдельным файлом, а ВНУТРИ письма
// (клиент сжимает её в JPEG и шифрует). Проверяем, в какую долю попадает её вес.
const before = await call(base, '/api/storage/summary?scope=me&fresh=1', {}, g1);
const photosBefore = before.d.cats.photos.bytes;
const msgBlob = 'enc:' + 'A'.repeat(40000);
r = await call(base, '/api/messages', { method: 'POST', body: { chat: grp, blob: msgBlob } }, g1);
ok(r.status === 200, 'письмо с фотографией внутри отправлено');

// ── сводка
r = await call(base, '/api/storage/summary?scope=me', {}, g1);
// pkg3-146: «Мои чаты» — это ВСЯ переписка и ВСЕ вложения чатов, где человек
// состоит (владелец справедливо удивился, что «мои чаты» меньше «всех»).
ok(r.status === 200 && r.d.cats.photos.count === 1 && r.d.cats.media.count === 1 && r.d.cats.files.count === 1,
  'сводка «мои чаты»: вложения всех участников этих чатов посчитаны по mime');
ok(typeof r.d.disk === 'object' && r.d.disk && typeof r.d.disk.total === 'number' && r.d.disk.free >= 0,
  'сводка несёт правду о диске сервера (всего/свободно)');
ok(typeof r.d.folder === 'object' && r.d.folder && typeof r.d.folder.bytes === 'number',
  'и размер папки с данными мессенджера');
ok(typeof r.d.cats.other === 'object' && typeof r.d.cats.other.bytes === 'number',
  'есть доля «служебное» — чтобы доли сходились с занятым местом');
// pkg3-147: где именно лежат мегабайты — база с письмами, файлы вложений,
// архивы и прочее. Именно это отвечает на вопрос «где фотографии из чатов».
fs.writeFileSync(path.join(dir, 'upmeta-test.json'), 'x'.repeat(1000));
fs.mkdirSync(path.join(dir, 'archives'), { recursive: true });
fs.writeFileSync(path.join(dir, 'archives', 'a.json'), 'y'.repeat(2000));
fs.writeFileSync(path.join(dir, 'chat-icon-x.png'), 'z'.repeat(500));
const rFolder = await call(base, '/api/storage/summary?scope=me&fresh=1', {}, admin);
const fo = rFolder.d.folder;
ok(fo.db > 0 && fo.uploads > 0 && fo.meta >= 1000 && fo.archives >= 2000 && fo.other >= 500,
  'папка с данными разложена по смыслу: база, вложения, архивы, прочее');
ok(fo.db + fo.uploads + fo.meta + fo.archives + fo.other === fo.bytes && fo.bytes === fo.total,
  'сумма частей равна размеру папки — ничего не потеряно');
// pkg3-148: письмо теперь может нести метку «внутри фото на N байт» — клиент
// сообщает её при отправке. Тогда фото попадает в свою долю, а не в «Письма».
const phBytes = 30000;
let rPh;
rPh = await call(base, '/api/messages', { method: 'POST', body: { chat: grp, blob: 'enc:' + 'B'.repeat(phBytes), ph: phBytes, pn: 1 } }, g1);
ok(rPh.status === 200, 'письмо с пометкой «внутри фото» отправлено');
const msgId = rPh.d.message.id;
const rPhoto = await call(base, '/api/storage/summary?scope=me&fresh=1', {}, g1);
const dMsg = rPhoto.d.cats.messages.bytes - rFolder.d.cats.messages.bytes;
const dPhoto = rPhoto.d.cats.photos.bytes - rFolder.d.cats.photos.bytes;
ok(dPhoto >= phBytes, 'вес фото из письма попал в долю «Фотографии»');
ok(rPhoto.d.cats.photos.inline && rPhoto.d.cats.photos.inline.bytes >= phBytes, 'и помечен как «внутри писем» (inline)');
ok(dMsg >= 0 && dMsg < 2000, 'из доли «Письма» этот вес вычтен: там остался только служебный вес строки');
ok(Math.abs((dMsg + dPhoto) - (phBytes + 286)) < 400, 'общая занятая память выросла ровно на письмо — двойного счёта нет');

// досчёт для уже отправленных писем: устройство, расшифровавшее письмо, сообщает вес
let rAtt = await call(base, '/api/messages/att', { method: 'POST', body: { items: [{ id: msgId, ph: phBytes + 1000, pn: 1 }] } }, g1);
ok(rAtt.status === 200 && rAtt.d.saved === 1, 'метка веса фото обновляется для уже отправленного письма');
rAtt = await call(base, '/api/messages/att', { method: 'POST', body: { items: [{ id: msgId, ph: phBytes + 1000, pn: 1 }] } }, g1);
ok(rAtt.status === 200 && rAtt.d.saved === 0, 'повторный тот же отчёт ничего не переписывает');
// чат Поли и Гоши, админ в нём не состоит — его отчёт не должен приниматься
const dmOther = await call(base, '/api/chats', {
  method: 'POST',
  body: { titleBlob: 'enc:' + hex(), members: [g1Id, g2Id], keys: { [g1Id]: { blob: 'w-1' }, [g2Id]: { blob: 'w-2' } } }
}, g1);
const dmId = dmOther.d && dmOther.d.chat && dmOther.d.chat.id;
let rDm;
rDm = await call(base, '/api/messages', { method: 'POST', body: { chat: dmId, blob: 'enc:' + hex(), ph: 5000, pn: 1 } }, g1);
ok(!!dmId && rDm.status === 200, 'письмо с фото в чате, где админа нет');
rAtt = await call(base, '/api/messages/att', { method: 'POST', body: { items: [{ id: rDm.d.message.id, ph: 999999, pn: 1 }] } }, admin);
ok(rAtt.status === 200 && rAtt.d.saved === 0, 'не участник чата не может править вес фото в чужом письме');
rAtt = await call(base, '/api/messages/att', { method: 'POST', body: { items: [] } }, g1);
ok(rAtt.status === 400, 'пустой список отклоняется');

ok(typeof rFolder.d.program === 'object' && rFolder.d.program && rFolder.d.program.bytes > 0,
  'сводка сообщает, сколько занимает сама программа');
ok(rFolder.d.program.code > 0 && typeof rFolder.d.program.libs === 'number' && typeof rFolder.d.program.git === 'number',
  'и раскладывает её на код, библиотеки и историю обновлений');
ok(rFolder.d.program.bytes < rFolder.d.disk.total, 'программа меньше всего диска (единицы не перепутаны)');
ok(typeof r.d.free === 'number' && typeof r.d.percent === 'number' && r.d.canOperate === false,
  'сводка несёт свободное место, процент и признак админства');
r = await call(base, '/api/storage/summary?scope=all', {}, g2);
// pkg3-148: «Фотографии» теперь включают и снимки внутри писем, поэтому
// проверяем объём, а не число файловых загрузок
ok(r.status === 200 && r.d.cats.photos.bytes > 0 && r.d.cats.files.count === 1,
  'сводка «все»: участник видит только суммы, без операций');
r = await call(base, '/api/storage/summary?scope=all', {}, admin);
ok(r.status === 200 && r.d.canOperate === true, 'администратор получает право операций');

// ── списки
r = await call(base, '/api/storage/items?scope=me&kind=photos', {}, g1);
ok(r.status === 200 && r.d.items.length === 1 && r.d.items[0].name === 'kitty' && r.d.items[0].mine,
  'свои загрузки: настоящее имя и метка «моё»');
r = await call(base, '/api/storage/items?scope=all&kind=photos', {}, g2);
ok(r.status === 403, 'список всех загрузок участнику не отдаётся');
r = await call(base, '/api/storage/items?scope=all&kind=photos', {}, admin);
ok(r.status === 200 && r.d.items.every(it => /^Фото №\d+$/.test(it.name)) && r.d.items.every(it => it.chatLabel),
  'админу — условные имена «Фото №» и «чат №» без содержимого');

// ── удаления
const victim = (await call(base, '/api/storage/items?scope=me&kind=media', {}, g1)).d.items[0];
r = await call(base, '/api/storage/delete', { method: 'POST', body: { upId: victim.upId } }, g2);
ok(r.status === 403, 'чужое вложение удалить нельзя');
r = await call(base, '/api/storage/delete', { method: 'POST', body: { upId: victim.upId } }, admin);
ok(r.status === 200 && r.d.freed > 0, 'администратор удаляет чужое вложение, место освобождается');
r = await call(base, '/api/upload/' + encodeURIComponent(victim.upId) + '/0', {}, g1);
ok(r.status === 410, 'кусков удалённого вложения больше нет (410)');
r = await call(base, '/api/storage/summary?scope=me&fresh=1', {}, g1);
ok(r.d.cats.media.count === 0, 'сводка после удаления пересчитана');

// ── сводка по чатам и права очистки
r = await call(base, '/api/storage/chats?scope=me', {}, g1);
const row = (r.d.rows || []).find(x => x.chat === grp);
ok(r.status === 200 && !!row && row.canClear === false, 'Поля в чужой группе не видит кнопку очистки');
r = await call(base, '/api/storage/chats?scope=all', {}, admin);
const arow = (r.d.rows || []).find(x => x.chat === grp);
ok(r.status === 200 && !!arow && arow.canClear === true && typeof arow.n === 'number', 'админ видит все чаты с правом очистки и номерами');
r = await call(base, '/api/storage/chats?scope=all', {}, g2);
ok(r.status === 403, 'сводку по всем чатам видит только администратор');

// ── предел хранилища
r = await call(base, '/api/admin/storage/limit', { method: 'POST', body: { bytes: 1024 } }, g1);
ok(r.status === 403, 'предел хранилища меняет только администратор');
r = await call(base, '/api/admin/storage/limit', { method: 'POST', body: { bytes: 10 } }, admin);
ok(r.status === 400, 'предел меньше занятого отклоняется');
r = await call(base, '/api/admin/storage/limit', { method: 'POST', body: { bytes: 400 * 1024 * 1024 } }, admin);
ok(r.status === 200 && r.d.limit === 400 * 1024 * 1024, 'администратор поднял предел хранилища');
r = await call(base, '/api/state', {});
ok(r.d.limit === 400 * 1024 * 1024 && typeof r.d.diskFree === 'number' && r.d.diskFree >= 0,
  'новый предел виден в состоянии, а свободное место диска — число (pkg3-75: fs внутри diskFree)');

// ── очистка чата стирает вложения
r = await call(base, '/api/chats/' + grp + '/clear', { method: 'POST', body: {} }, admin);
ok(r.status === 200, 'очистка чата администратором прошла');
r = await call(base, '/api/storage/summary?scope=all&fresh=1', {}, admin);
// pkg3-148: у Поли с Гошей остался личный чат с фото в письме — учитываем это
ok(r.d.cats.files.count === 0 && (!r.d.cats.photos.inline || r.d.cats.photos.inline.bytes < 20000),
  'вложения очищенного чата стёрты с сервера');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Пульт памяти: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
