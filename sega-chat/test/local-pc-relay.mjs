// Изолированный тест почтового ящика, это не подключённый API.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {createRelay,digest,MAX_PACKET,MAX_PENDING,MAX_RECENT,MAX_AGE,REPLAY_WINDOW,LEASE,ONLINE_AGE} = createRequire(import.meta.url)('../local-pc/relay.js');
const {MAX_FUTURE,CLOCK_SKEW} = createRequire(import.meta.url)('../local-pc/secure-channel.js');
assert.equal(REPLAY_WINDOW,MAX_FUTURE+CLOCK_SKEW+1);
let now = 1_000_000;
const r = createRelay({clock:()=>now});
const dev = 'a'.repeat(32), tok = 'b'.repeat(64), id = 'c'.repeat(32), bad = 'd'.repeat(64);
r.register('owner',dev,digest(tok));
assert.equal(r.status('owner',dev).online,false);
assert.throws(()=>r.status('other',dev));
assert.throws(()=>r.next(dev,bad));
assert.equal(r.next(dev,tok),null);
assert.equal(r.status('owner',dev).online,true);
assert.throws(()=>r.request('other',dev,id,'cipher'));
assert.throws(()=>r.request('owner',dev,id,'x'.repeat(MAX_PACKET+1)));
r.request('owner',dev,id,'cipher');
r.request('owner',dev,id,'cipher'); // повтор после обрыва не создаёт второй запрос
assert.throws(()=>r.request('owner',dev,id,'other'));
assert.deepEqual(r.result('owner',dev,id),{ready:false});
assert.throws(()=>r.acknowledge('other',dev,id));
assert.throws(()=>r.acknowledge('owner',dev,id)); // ответ ещё не готов
const first = r.next(dev,tok);
assert.equal(first.packet,'cipher'); assert.equal(first.requestId,id);
assert.equal(r.next(dev,tok),null);
assert.throws(()=>r.reply(dev,bad,id,first.claim,'reply'));
assert.throws(()=>r.reply(dev,tok,id,'e'.repeat(32),'reply'));
now += LEASE;
assert.throws(()=>r.reply(dev,tok,id,first.claim,'reply'));
const second = r.next(dev,tok);
assert.notEqual(second.claim,first.claim);
assert.throws(()=>r.reply(dev,tok,id,first.claim,'reply'));
r.reply(dev,tok,id,second.claim,'reply');
r.reply(dev,tok,id,second.claim,'reply');
assert.throws(()=>r.reply(dev,tok,id,second.claim,'other'));
assert.deepEqual(r.result('owner',dev,id),{ready:true,packet:'reply'});
assert.deepEqual(r.result('owner',dev,id),{ready:true,packet:'reply'});
assert.throws(()=>r.acknowledge('other',dev,id));
r.acknowledge('owner',dev,id);r.acknowledge('owner',dev,id); // ответ подтверждения мог потеряться
assert.throws(()=>r.result('owner',dev,id));
assert.throws(()=>r.request('owner',dev,id,'cipher')); // повторный запрос не выполняется
assert.throws(()=>r.request('owner',dev,id,'other'));
assert.throws(()=>r.reply(dev,tok,id,second.claim,'reply'));
now += ONLINE_AGE;
assert.equal(r.status('owner',dev).online,false);
now += MAX_AGE;
assert.throws(()=>r.result('owner',dev,id));
for(let i=0;i<MAX_PENDING;i++) r.request('owner',dev,i.toString(16).padStart(32,'0'),'x');
assert.throws(()=>r.request('owner',dev,'f'.repeat(32),'x'));
assert.throws(()=>r.revoke('other',dev));
r.revoke('owner',dev);
assert.throws(()=>r.next(dev,tok));
assert.throws(()=>r.result('owner',dev,'0'.repeat(32)));
// Ограничение числа отметок остаётся независимым от живой очереди.
let time=2_000_000;
const bounded=createRelay({clock:()=>time});bounded.register('owner',dev,digest(tok));
for(let i=0;i<MAX_RECENT;i++) {
  const n=i.toString(16).padStart(32,'0');
  bounded.request('owner',dev,n,'x');const job=bounded.next(dev,tok);
  bounded.reply(dev,tok,n,job.claim,'y');bounded.acknowledge('owner',dev,n);
}
time++;
const last='f'.repeat(32);
// Место под отметку резервируется ДО принятия, а не теряется при ack.
assert.throws(()=>bounded.request('owner',dev,last,'x'),/много/);
time += REPLAY_WINDOW-1;
bounded.request('owner',dev,last,'x');const job=bounded.next(dev,tok);bounded.reply(dev,tok,last,job.claim,'y');
bounded.acknowledge('owner',dev,last);bounded.acknowledge('owner',dev,last);
assert.throws(()=>bounded.result('owner',dev,last));
// Отметка хранится до конца возможного срока действия шифрованного пакета,
// даже если ответ потерян или совсем не был получен. Неподтверждённый ответ
// нельзя ошибочно сообщать как подтверждённый.
let replayTime=5_000_000;const birth=replayTime;
const replay=createRelay({clock:()=>replayTime});replay.register('owner',dev,digest(tok));
const expired='1'.repeat(32), completed='2'.repeat(32), unacked='3'.repeat(32);
replay.request('owner',dev,expired,'запрос');
replay.request('owner',dev,completed,'запрос');replay.request('owner',dev,unacked,'запрос');
const expJob=replay.next(dev,tok), compJob=replay.next(dev,tok), unackedJob=replay.next(dev,tok);
assert.equal(expJob.requestId,expired);assert.equal(compJob.requestId,completed);assert.equal(unackedJob.requestId,unacked);
replay.reply(dev,tok,completed,compJob.claim,'ответ');replay.acknowledge('owner',dev,completed);
replay.reply(dev,tok,unacked,unackedJob.claim,'ответ');
replayTime=birth+MAX_AGE;
for(const rid of [expired,completed,unacked]) {
  assert.throws(()=>replay.request('owner',dev,rid,'запрос'));
  assert.throws(()=>replay.request('owner',dev,rid,'другой'));
  assert.throws(()=>replay.result('owner',dev,rid));
}
assert.throws(()=>replay.acknowledge('owner',dev,expired),/истёк/);
assert.throws(()=>replay.acknowledge('owner',dev,unacked),/истёк/);
replay.acknowledge('owner',dev,completed); // после потери ответа на ack
replayTime=birth+REPLAY_WINDOW-1;
for(const rid of [expired,completed,unacked])assert.throws(()=>replay.request('owner',dev,rid,'запрос'));
replayTime=birth+REPLAY_WINDOW;
for(const rid of [expired,completed,unacked])replay.request('owner',dev,rid,'новый');
// Это ограничение живёт только в памяти. Перезапуск/отзыв стирает отметки.
const restarted=createRelay({clock:()=>replayTime});restarted.register('owner',dev,digest(tok));
assert.doesNotThrow(()=>restarted.request('owner',dev,expired,'новый'));
console.log('local-pc-relay: владельцы, отзыв, подтверждение, ограничения и повторы проверены в памяти');
