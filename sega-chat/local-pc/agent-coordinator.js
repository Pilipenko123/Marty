'use strict';
// Прототип последовательности подключения. До реализации защищённого хранилища
// Windows и проверки файловых границ это не самостоятельный установщик.
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const pairing = require('./pairing');
const {createFolder} = require('./folder');
const {createReadService} = require('./read-service');
const {createAgentClient} = require('./agent-client');
const ID = /^[a-f0-9]{32}$/, TOKEN = /^[a-f0-9]{64}$/;
const hash = token => crypto.createHash('sha256').update(token,'utf8').digest('hex');
function validateConfig(c) {
  if (!c || c.version !== 1 || !['pending','active'].includes(c.state) || typeof c.url !== 'string'
      || !ID.test(c.deviceId || '') || !TOKEN.test(c.token || '') || typeof c.folder !== 'string' || !path.isAbsolute(c.folder)
      || typeof c.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.key)
      || (c.state === 'pending' && !TOKEN.test(c.setupToken || ''))
      || typeof c.rootDevice !== 'string' || !/^\d+$/.test(c.rootDevice)
      || typeof c.rootInode !== 'string' || !/^[1-9]\d*$/.test(c.rootInode)
      || (c.state === 'active' && c.setupToken !== undefined)) throw new Error('Настройки подключения повреждены');
  const secret=Buffer.from(c.key,'base64url');
  if (secret.length !== 32 || secret.toString('base64url') !== c.key) throw new Error('Настройки подключения повреждены');
  // Проверяем тот же набор полей и защищённый адрес, что и в коде настройки.
  const encoded=Buffer.from(JSON.stringify({v:1,u:c.url,i:c.deviceId,t:c.token,k:c.key})).toString('base64url');
  pairing.parse(encoded);
  return new Uint8Array(secret);
}

async function anchorFolder(folderPath) {
  const root = await fs.realpath(folderPath);
  const st = await fs.stat(root,{bigint:true});
  if (!st.isDirectory() || st.ino === 0n) throw new Error('Не удалось надёжно проверить выбранную папку');
  return {root,dev:st.dev.toString(),ino:st.ino.toString()};
}
function createCoordinator({vault, transportFactory = createAgentClient, folderFactory = createFolder, anchor = anchorFolder, random = crypto.randomBytes} = {}) {
  if (!vault || typeof vault.load !== 'function' || typeof vault.save !== 'function') throw new Error('Нужно защищённое хранилище');
  let config=null, transport=null, busy=false;
  async function locked(fn) {
    if (busy) throw new Error('Подключение уже обрабатывается');
    busy=true; try { return await fn(); } finally { busy=false; }
  }
  async function makeTransport(cfg, token, folder, secret) {
    const service=createReadService({folder,secret,deviceId:cfg.deviceId});
    return transportFactory({baseUrl:cfg.url,deviceId:cfg.deviceId,token,service});
  }
  async function saveConfig(cfg) {
    // save() должен атомарно сохранять данные в защищённое хранилище ДО ответа.
    // Пока Windows-реализация ещё не создана; простой JSON использовать нельзя.
    await vault.save({...cfg});
  }
  async function prepare(code, folderPath, trustedUrl) { return locked(async () => {
    if (config || await vault.load()) throw new Error('Подключение уже настроено');
    if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) throw new Error('Выберите папку на компьютере');
    const setup=pairing.parse(code,trustedUrl);
    const a=await anchor(folderPath);
    await folderFactory(a.root,{dev:a.dev,ino:a.ino}); // до сохранения проверяем выбранную папку
    const fresh=random(32);
    if (!Buffer.isBuffer(fresh) || fresh.length !== 32) throw new Error('Не удалось создать секрет');
    const next={version:1,state:'pending',url:setup.url,deviceId:setup.deviceId,folder:a.root,rootDevice:a.dev,rootInode:a.ino,
      token:fresh.toString('hex'),setupToken:setup.token,key:Buffer.from(setup.secret).toString('base64url')};
    validateConfig(next);
    await saveConfig(next); // до запроса о привязке; иначе сбой потеряет новый токен
    config=next;
  }); }
  async function load() {
    if (config) return config;
    const loaded=await vault.load();
    validateConfig(loaded);
    config={...loaded};
    return config;
  }
  async function tick(signal) { return locked(async () => {
    const checkStopped=()=>{if(signal && signal.aborted){const e=new Error('Остановлено');e.name='AbortError';throw e;}};
    checkStopped();
    const c=await load(), secret=validateConfig(c), a=await anchor(c.folder);
    if (a.root !== c.folder || a.dev !== c.rootDevice || a.ino !== c.rootInode) {
      const e=new Error('Выбранная папка изменилась, подключение остановлено');
      e.code='LOCAL_FOLDER_CHANGED'; throw e;
    }
    const folder=await folderFactory(c.folder,{dev:c.rootDevice,ino:c.rootInode});
    checkStopped();
    if (!transport) transport=await makeTransport(c,c.token,folder,secret);
    if (c.state === 'pending') {
      let accepted=false;
      try {
        // Если предыдущий ответ потерялся, новый токен уже может работать.
        await transport.step(signal); accepted=true;
      } catch (e) { if (!e || e.status !== 401) throw e; }
      checkStopped();
      if (!accepted) {
        const setup=await makeTransport(c,c.setupToken,folder,secret);
        await setup.claim(hash(c.token),signal);
      }
      checkStopped();
      const active={...c,state:'active'}; delete active.setupToken;
      await saveConfig(active);
      config=active;
    }
    checkStopped();
    return transport.step(signal);
  }); }
  return Object.freeze({prepare,tick});
}
module.exports={createCoordinator};
