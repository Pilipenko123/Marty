/**
 * Проверка облачного хранилища в самых неприятных условиях:
 * над одной базой одновременно работают ДВА экземпляра функции.
 * Именно так ведёт себя Yandex Cloud, когда запросов становится много.
 *
 * Здесь не проверяется шифрование (это делает test-flow.mjs) — только то,
 * что данные не теряются, не перетираются и доезжают до второго экземпляра.
 *
 * Запуск: node test/test-cluster.mjs
 */

import { spawn } from 'node:child_process';
import { startMock } from './mock-ydb.mjs';
import { startMockS3 } from './mock-s3.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let bad = 0;
let t0 = Date.now();
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m + (process.env.TIMING ? ` [${Date.now() - t0} мс]` : '')); t0 = Date.now(); if (!c) bad++; };

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, d: ct.includes('json') ? await r.json() : await r.text() };
}
const syncOf = (base, token, since = 0, extra = '') => call(base, '/api/sync?since=' + since + extra, {}, token).then(r => r.d);
// «короткий опрос»: новых сообщений нет, спрашиваем только журнал изменений
const deltaOf = (base, token, s0) => syncOf(base, token, s0.seq, '&rsince=' + (s0.rnow || 0) + '&cchg=' + (s0.chg || 0));

async function waitReady(base) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/api/state')).ok) return; } catch (e) {}
    await wait(250);
  }
  throw new Error('не поднялся ' + base);
}

const mock = await startMock();
const s3m = await startMockS3({ bucket: 'sega-chat-code', token: 'iam-cluster' });
const env = {
  STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'sega_chat',
  YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey,
  CODE_BUCKET: 'sega-chat-code', S3_ENDPOINT: s3m.endpoint, YC_IAM_TOKEN: 'iam-cluster',
  HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0'
};
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
function up(port) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, env, { PORT: String(port) })
  });
  procs.push(p);
  return `http://127.0.0.1:${port}`;
}
const A = up(await freePort()), B = up(await freePort());
await waitReady(A); await waitReady(B);
console.log('\nДва экземпляра работают над одной базой (как при наплыве в облаке).\n');

// ── общие данные для входа (шифрование здесь неважно)
const CODE_SALT = hex(), CODE_PROOF = hex(32);
const creds = (name) => ({
  name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(),
  wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex()
});

const adminCred = creds('Мартин');
let r = await call(A, '/api/setup', {
  method: 'POST', body: Object.assign({}, adminCred, {
    codeProofSalt: CODE_SALT, codeProof: CODE_PROOF, codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
  })
});
ok(r.status === 200, 'экземпляр A создал мессенджер');
const admin = { token: r.d.token, id: r.d.user.id };

// второй экземпляр должен сразу увидеть чужую регистрацию
const st = await call(B, '/api/state');
ok(st.d.setupRequired === false, 'экземпляр B увидел, что мессенджер уже настроен');
const jamesCred = creds('Джеймс');
r = await call(B, '/api/register', { method: 'POST', body: Object.assign({}, jamesCred, { codeProof: CODE_PROOF }) });
ok(r.status === 200, 'экземпляр B зарегистрировал второго участника');
const james = { token: r.d.token, id: r.d.user.id };
ok((await syncOf(A, admin.token)).users.length === 2, 'экземпляр A увидел участника, созданного на B');

// ── чат создан на A, виден на B
r = await call(A, '/api/chats', {
  method: 'POST', body: {
    titleBlob: 'enc:' + hex(), members: [james.id],
    keys: { [admin.id]: { blob: 'k1' }, [james.id]: { blob: 'k2' } }
  }
}, admin.token);
ok(r.status === 200, 'чат создан на A');
const chat = r.d.chat.id;
ok((await syncOf(B, james.token)).chats.some(c => c.id === chat), 'чат виден на B');

// ── сообщения летают в обе стороны
await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'enc-A-1' } }, admin.token);
let s = await syncOf(B, james.token);
ok(s.messages.length === 1 && s.messages[0].blob === 'enc-A-1', 'сообщение с A прочитано на B');
const seqAfter = s.seq;
ok((await syncOf(B, james.token, seqAfter)).messages.length === 0, 'повторный опрос не тянет старое');

await call(B, '/api/messages', { method: 'POST', body: { chat, blob: 'enc-B-1' } }, james.token);
s = await syncOf(A, admin.token);
ok(s.messages.length === 2, 'оба экземпляра пишут в общую историю, ничего не затёрлось');
ok(new Set(s.messages.map(m => m.seq)).size === 2, 'номера сообщений не совпали');

// ── одновременная отправка с двух экземпляров
await Promise.all([
  call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'одновременно-A' } }, admin.token),
  call(B, '/api/messages', { method: 'POST', body: { chat, blob: 'одновременно-B' } }, james.token)
]);
s = await syncOf(A, admin.token);
ok(s.messages.filter(m => m.blob.startsWith('одновременно')).length === 2, 'два сообщения, отправленных в один момент, оба на месте');

// ── переименование чата
await call(B, '/api/chats/' + chat + '/title', { method: 'POST', body: { titleBlob: 'enc-new-title' } }, james.token);
ok((await syncOf(A, admin.token)).chats.find(c => c.id === chat).titleBlob === 'enc-new-title', 'переименование с B видно на A');

// ── длинное сообщение режется на куски и собирается обратно
const big = 'Ж'.repeat(60000) + '|конец';
r = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: big } }, admin.token);
ok(r.status === 200, 'отправлено сообщение на ' + big.length + ' символов');
s = await syncOf(B, james.token);
const gotBig = s.messages.find(m => m.blob.length > 50000);
ok(!!gotBig && gotBig.blob === big, 'длинное сообщение собрано из кусков без потерь');

// ── много сообщений: постраничная выборка из базы
for (let i = 0; i < Number(process.env.MANY || 120); i++) await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'm' + i } }, admin.token);
s = await syncOf(B, james.token);
ok(s.messages.length === Number(process.env.MANY || 120) + 5, `вся история (${s.messages.length} сообщений) вычитана постранично`);
ok(s.messages.filter(m => m.blob === 'm' + (Number(process.env.MANY || 120) - 1)).length === 1, 'последнее из череды сообщений на месте');
const usage = s.usage;
ok(usage.bytes > 60000 && usage.messages === Number(process.env.MANY || 120) + 5, 'счётчики памяти совпадают с историей');

// ── удаление
const victim = s.messages.find(m => m.blob === 'm' + Math.floor(Number(process.env.MANY || 120) / 2));
const genBefore = s.gen;
const beforeDel = await syncOf(B, james.token, s.seq);
r = await call(A, '/api/messages/' + victim.id, { method: 'DELETE' }, admin.token);
ok(r.status === 200, 'сообщение удалено на A');
s = await syncOf(B, james.token);
ok(!s.messages.some(m => m.id === victim.id), 'на B сообщение тоже пропало');
ok(s.gen === genBefore, 'удаление одного сообщения НЕ заставляет всех перечитывать историю');
ok(s.chg > beforeDel.chg, 'в журнале изменений появилась отметка');
const dDel = await deltaOf(B, james.token, beforeDel);
ok(dDel.gone.includes(victim.id), 'короткий опрос назвал B конкретное исчезнувшее сообщение');
ok(dDel.messages.length === 0, 'короткий опрос не тащит историю заново');
ok(s.usage.messages === Number(process.env.MANY || 120) + 4, 'счётчик сообщений уменьшился');

// ── аватар: большой, через куски, с удалением
const pic = 'data:image/png;base64,' + 'Q'.repeat(120000);
r = await call(A, '/api/profile', { method: 'POST', body: { avatar: 'enc:' + pic } }, admin.token);
ok(r.status === 200, 'аватар на 120 КБ сохранён');
const rev = r.d.user.avatar;
let av = await call(B, '/api/avatar/' + admin.id, {}, james.token);
ok(av.d.avatar === 'enc:' + pic && av.d.rev === rev, 'аватар целиком скачан со второго экземпляра');
await call(A, '/api/profile', { method: 'POST', body: { avatar: null } }, admin.token);
av = await call(B, '/api/avatar/' + admin.id, {}, james.token);
ok(av.d.avatar === null, 'после удаления от аватара не осталось кусков');

// ── архив: кодовое слово, скачивание, восстановление, удаление
const huge = 'x'.repeat(600000) + 'TAILMARK';   // архив из 12+ кусков: порядок кусков из базы не должен matter
r = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'enc:' + huge } }, admin.token);
ok(r.status === 200, 'огромное сообщение принято');
r = await call(A, '/api/chats/' + chat + '/archive', { method: 'POST', body: { reset: true } }, admin.token);
ok(r.status === 403, 'архивация без кодового слова отклонена');
r = await call(A, '/api/chats/' + chat + '/archive', { method: 'POST', body: { reset: true, codeProof: hex(32) } }, admin.token);
ok(r.status === 403, 'архивация с чужим кодовым словом отклонена');
r = await call(A, '/api/chats/' + chat + '/archive', { method: 'POST', body: { reset: true, codeProof: CODE_PROOF } }, admin.token);
ok(r.status === 200 && r.d.archive.count === Number(process.env.MANY || 120) + 5, 'архив создан на A');
const file = r.d.archive.file;
const dlBad = await fetch(B + '/api/archives/' + encodeURIComponent(file), { headers: { Authorization: 'Bearer ' + james.token } });
ok(dlBad.status === 403, 'без кодового слова тело архива не отдаётся');
const dl = await fetch(B + '/api/archives/' + encodeURIComponent(file), { headers: { Authorization: 'Bearer ' + james.token, 'X-Code-Proof': CODE_PROOF } });
const text = await dl.text();
ok(dl.status === 200 && text.includes('enc-A-1') && text.includes(big.slice(0, 200)) && text.includes('TAILMARK'), 'архив из 12+ кусков скачан целиком и в верном порядке');
s = await syncOf(B, james.token);
ok(s.messages.length === 0 && s.usage.messages === 0, 'после архивации история очищена на обоих экземплярах');
r = await call(B, '/api/chats/' + chat + '/restore', { method: 'POST', body: { file, codeProof: CODE_PROOF } }, james.token);
ok(r.status === 200 && r.d.restored === Number(process.env.MANY || 120) + 5, 'архив восстановлен на B');
s = await syncOf(A, admin.token);
ok(s.messages.length === Number(process.env.MANY || 120) + 5, 'восстановленная история видна на A');
r = await call(A, '/api/archives/' + encodeURIComponent(file), { method: 'DELETE' }, admin.token);
ok(r.status === 200, 'архив удалён с сервера');
// ── реакции, правка своих сообщений, статус
let sb = await syncOf(A, admin.token);
const mid = (sb.messages.find(m => m.chat === chat && !m.parent) || {}).id;
const genRx = sb.gen;
const beforeRx = await syncOf(B, james.token, sb.seq);
r = await call(A, '/api/messages/' + mid + '/react', { method: 'POST', body: { emoji: '🔥' } }, admin.token);
ok(r.status === 200 && (r.d.reactions['🔥'] || []).includes(admin.id), 'реакция поставилась');
sb = await syncOf(B, james.token);
const rx2 = ((sb.messages.find(m => m.id === mid) || {}).reactions || {})['🔥'] || [];
ok(rx2.includes(admin.id), 'реакцию видно у второго участника');
// главное нововведение pkg3-13: реакция приходит точечно, без перечитывания истории
ok(sb.gen === genRx, 'реакция не поднимает «поколение» базы (историю заново читать не нужно)');

const dRx = await deltaOf(B, james.token, beforeRx);
ok(dRx.changed.length === 1 && dRx.changed[0].id === mid, 'короткий опрос прислал ровно изменённое сообщение');
ok(((dRx.changed[0].reactions || {})['🔥'] || []).includes(admin.id), 'в этой посылке виден сам смайлик');
ok(dRx.messages.length === 0 && !dRx.gone.includes(mid), 'повторно прислано только уже известное (удаление из окна запаса) — лишнего нет');
// ── гонка двух экземпляров за номера сообщений
{
  const many = await Promise.all([
    call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'race-1' } }, admin.token),
    call(B, '/api/messages', { method: 'POST', body: { chat, blob: 'race-2' } }, james.token),
    call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'race-3' } }, james.token),
    call(B, '/api/messages', { method: 'POST', body: { chat, blob: 'race-4' } }, admin.token)
  ]);
  const seqs = many.map(r => r.d.message.seq);
  ok(many.every(r => r.status === 200), 'четыре одновременные отправки приняты обоими экземплярами');
  ok(new Set(seqs).size === 4, 'номера сообщений уникальны при гонке экземпляров: ' + seqs.join(','));
  const sA = await syncOf(A, admin.token, Math.min(...seqs) - 1);
  ok(seqs.every(q => sA.messages.some(m => m.seq === q)), 'курсор «с предпоследнего» достаёт все четыре гонщика');
}
const dIdle = await deltaOf(B, james.token, dRx);
ok(dIdle.changed.length === 0, 'повторный короткий опрос пустой (журнал не дёргает базу зря)');
r = await call(A, '/api/messages/' + mid + '/react', { method: 'POST', body: { emoji: '🔥' } }, admin.token);
ok(r.status === 200 && !((r.d.reactions || {})['🔥'] || []).includes(admin.id), 'повторное нажатие снимает реакцию');
r = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'enc:edit-me' } }, admin.token);
const eid = r.d.message.id;
r = await call(B, '/api/messages/' + mid + '/del-x', { method: 'DELETE' }, james.token).catch(() => ({ status: 0 }));
r = await call(B, '/api/messages/' + (sb.messages.find(m => m.uid === admin.id && m.chat === chat) || {}).id, { method: 'DELETE' }, james.token);
ok(r.status === 403, 'чужое сообщение удалить нельзя');
r = await call(A, '/api/messages/' + eid + '/edit', { method: 'POST', body: { blob: 'enc:edited' } }, admin.token);
ok(r.status === 200 && r.d.message.editedAt > 0, 'своё сообщение отредактировано');
r = await call(B, '/api/messages/' + eid + '/edit', { method: 'POST', body: { blob: 'enc:x' } }, james.token);
ok(r.status === 403, 'чужое сообщение редактировать нельзя');
sb = await syncOf(B, james.token);
ok((sb.messages.find(m => m.id === eid) || {}).blob === 'enc:edited', 'правка видна у второго участника');
const dEd = await deltaOf(B, james.token, beforeRx);
const edArrived = dEd.changed.some(m => m.id === eid && m.blob === 'enc:edited')
  || dEd.messages.some(m => m.id === eid && m.blob === 'enc:edited');
ok(edArrived, 'правка доходит до второго участника коротким опросом (журнал или список новых)');
ok(dEd.changed.some(m => m.id === mid), 'реакция пришла точечно, через журнал изменений');
r = await call(A, '/api/profile', { method: 'POST', body: { status: 'на связи до шести' } }, admin.token);
ok(r.status === 200 && r.d.user.status === 'на связи до шести', 'статус сохранён');
sb = await syncOf(B, james.token);
ok((sb.users.find(u => u.id === admin.id) || {}).status === 'на связи до шести', 'статус виден другим');

// ── фон чата, иконка чата, вложения
r = await call(A, '/api/chats/' + chat + '/wall', { method: 'POST', body: { wall: { type: 'grad', c1: '#112233', c2: '#445566', a: 90, pat: 'dots' } } }, admin.token);
ok(r.status === 200 && r.d.chat.wall.c1 === '#112233', 'фон чата сохранён');
sb = await syncOf(B, james.token);
ok(((sb.chats.find(x => x.id === chat) || {}).wall || {}).a === 90, 'фон виден второму участнику');
r = await call(B, '/api/chats/' + chat + '/wall', { method: 'POST', body: { wall: { type: 'pat', c1: '#112233', c2: '#445566', a: 90, pat: 'waves' } } }, james.token);
ok(r.status === 200 && r.d.chat.wall.pat === 'waves', 'фон может менять любой участник');
r = await call(A, '/api/chats/' + chat + '/wallphoto', { method: 'POST', body: { data: 'enc:wallphoto' } }, admin.token);
ok(r.status === 200 && r.d.chat.wallRev, 'фото фона сохранено');
const w = await call(B, '/api/wall/' + chat, {}, james.token);
ok(w.status === 200 && w.d.wall === 'enc:wallphoto', 'второй участник получает фото фона');
r = await call(A, '/api/chats/' + chat + '/icon', { method: 'POST', body: { data: 'enc:icon' } }, admin.token);
ok(r.status === 200 && r.d.chat.iconRev, 'иконка чата сохранена');
const ic = await call(B, '/api/chaticon/' + chat, {}, james.token);
ok(ic.status === 200 && ic.d.icon === 'enc:icon', 'второй участник получает иконку');
r = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'enc:video-att' } }, admin.token);
ok(r.status === 200, 'вложение принимается сервером');

const bigWall = 'enc:' + 'w'.repeat(120000);   // больше куска в 48К: фон читается из нескольких кусков
r = await call(A, '/api/chats/' + chat + '/wallphoto', { method: 'POST', body: { data: bigWall } }, admin.token);
ok(r.status === 200, 'большое фото фона принято');
const w2 = await call(B, '/api/wall/' + chat, {}, james.token);
ok(w2.status === 200 && w2.d.wall === bigWall, 'большое фото фона собирается из кусков без потерь');
// ── кусковая загрузка большого вложения (видео/аудио/файлы до 25 МБ)
const upPayload = 'V'.repeat(200000);
const CH = 90000;
const partsN = Math.ceil(upPayload.length / CH);
r = await call(A, '/api/upload/init', { method: 'POST', body: { chat, name: 'demo.mp4', size: upPayload.length, mime: 'video/mp4', parts: partsN } }, admin.token);
ok(r.status === 200 && r.d.upId, 'загрузка начата');
const upId = r.d.upId;
for (let i = 0; i < partsN; i++) {
  r = await call(A, '/api/upload/chunk', { method: 'POST', body: { upId, i, data: upPayload.slice(i * CH, (i + 1) * CH) } }, admin.token);
  ok(r.status === 200, 'кусок ' + (i + 1) + ' принят');
}
r = await call(A, '/api/upload/fin', { method: 'POST', body: { upId } }, admin.token);
ok(r.status === 200, 'загрузка завершена');
let got = '';
for (let i = 0; i < partsN; i++) { const g = await call(B, '/api/upload/' + upId + '/' + i, {}, james.token); got += g.d.data; }
ok(got === upPayload, 'второй участник собрал вложение из кусков без потерь');
r = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'enc:with-att', upId } }, admin.token);
ok(r.status === 200 && r.d.message.upId === upId, 'сообщение ссылается на вложение');
const upBefore = (await syncOf(A, admin.token)).usage.bytes;
r = await call(A, '/api/messages/' + r.d.message.id, { method: 'DELETE' }, admin.token);
ok(r.status === 200, 'сообщение с вложением удалено');
const upAfter = (await syncOf(A, admin.token)).usage.bytes;
ok(upAfter < upBefore, 'память освободилась после удаления вложения');

r = await call(A, '/api/chats/' + chat + '/clear', { method: 'POST', body: {} }, admin.token);
ok(r.status === 200 && typeof r.d.cleared === 'number' && r.d.usage.bytes >= 0, 'очистка чата освобождает место');
s = await syncOf(B, james.token);
ok(s.messages.filter(m => m.chat === chat).length === 0, 'после очистки история пуста у обоих');
ok((s.chats.find(x => x.id === chat) || {}).clearedByName != null, 'в чате видно, кто его очистил');
r = await call(A, '/api/chats/' + chat + '/archives', {}, admin.token);
ok(r.status === 200 && r.d.archives.length === 0, 'список архивов пуст после удаления');

// ── восстановление из копии: соседний экземпляр видит заменённую таблицу
{
  const rc = await call(A, '/api/admin/backup', { method: 'POST' }, admin.token);
  ok(rc.status === 200 && rc.d.ok, 'копия создана на A');
  await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'исчезнет-при-восстановлении' } }, admin.token);
  const rr = await call(A, '/api/admin/restore', { method: 'POST', body: { key: rc.d.backup.key, codeProof: CODE_PROOF } }, admin.token);
  ok(rr.status === 200 && rr.d.ok, 'восстановление на A прошло');
  await wait(400);
  const sB = await syncOf(B, james.token);
  ok(!sB.messages.some(m => m.blob === 'исчезнет-при-восстановлении'),
    'экземпляр B увидел заменённую таблицу (сообщения после копии нет)');
  const sA = await syncOf(A, admin.token);
  ok(!sA.messages.some(m => m.blob === 'исчезнет-при-восстановлении'), 'на A сообщения после копии тоже нет');
}

// ── присутствие и сессии
await call(A, '/api/sync?since=0&active=1', {}, admin.token);
const seen = (await syncOf(B, james.token)).users.find(u => u.id === admin.id);
ok(seen.activeAt > 0, 'второй экземпляр видит, что человек сейчас в чате');
const loginA = await call(A, '/api/login', { method: 'POST', body: { name: 'Джеймс', authKey: jamesCred.authKey } });
ok(loginA.status === 200, 'вход через A');
ok((await call(B, '/api/sync?since=0', {}, loginA.d.token)).status === 200, 'выданный на A пропуск работает на B');
await call(B, '/api/logout', { method: 'POST' }, loginA.d.token);
ok((await call(A, '/api/sync?since=0', {}, loginA.d.token)).status === 401, 'выход на B закрыл сессию и на A');

for (const p of procs) p.kill('SIGTERM');
await mock.close();
console.log('\n  обращений к базе за весь прогон: ' + mock.counters.calls);
console.log(bad ? '\n  ЕСТЬ ПРОВАЛЫ\n' : '\n  Оба экземпляра видят одну и ту же картину.\n');
process.exit(bad ? 1 : 0);
