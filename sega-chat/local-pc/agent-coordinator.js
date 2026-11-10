'use strict';
// Прототип последовательности подключения. До реализации защищённого хранилища
// Windows и проверки файловых границ это не самостоятельный установщик.
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const pairing = require('./pairing');
const {createReadService} = require('./read-service');
const {validateSignal,checkAborted} = require('./abort');
const ID = /^[a-f0-9]{32}$/, TOKEN = /^[a-f0-9]{64}$/;
const hash = token => crypto.createHash('sha256').update(token,'utf8').digest('hex');
function validateConfig(c, trustedUrl) {
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
  pairing.parse(encoded, trustedUrl);
  return new Uint8Array(secret);
}

// Только для лабораторных тестов: realpath/stat НЕ защищают вложенные пути
// от подмены. Не использовать как границу защиты настоящих файлов.
async function anchorFolder(folderPath) {
  const root = await fs.realpath(folderPath);
  const st = await fs.stat(root,{bigint:true});
  if (!st.isDirectory() || st.ino === 0n) throw new Error('Не удалось надёжно проверить выбранную папку');
  return {root,dev:st.dev.toString(),ino:st.ino.toString()};
}
function createCoordinator({vault, transportFactory, folderFactory, anchor, trustedUrl, random = crypto.randomBytes} = {}) {
  // Никаких неявных настоящих файлов/сети по умолчанию. Переданные зависимости
  // всё равно могут быть небезопасными — этот код остаётся только для лаборатории.
  if (!vault || typeof vault.load !== 'function' || typeof vault.save !== 'function'
      || typeof transportFactory !== 'function' || typeof folderFactory !== 'function'
      || typeof anchor !== 'function' || typeof random !== 'function') throw new Error('Не заданы лабораторные зависимости');
  // Доверенный адрес должен поступить отдельно от кода подключения и отдельно
  // от загруженных настроек. Источник такого доверия ещё не реализован в UI.
  if (typeof trustedUrl !== 'string' || !trustedUrl) throw new Error('Не подтверждён адрес мессенджера');
  const trusted=pairing.normalizeUrl(trustedUrl);
  let config=null, transport=null, busy=false, currentFolder=null;
  // Транспорт и его кэш ответов живут между опросами. Поэтому сервис обращается
  // к заново проверенному объекту текущего опроса, а не к первому объекту,
  // случайно захваченному при создании транспорта. Это не устраняет гонки ОС.
  const folderProxy=Object.freeze({
    list(...args){if(!currentFolder)throw new Error('Папка недоступна');return currentFolder.list(...args);},
    read(...args){if(!currentFolder)throw new Error('Папка недоступна');return currentFolder.read(...args);}
  });
  function checkedFolder(folder) {
    if (!folder || typeof folder.list!=='function' || typeof folder.read!=='function') throw new Error('Папка недоступна');
    return folder;
  }
  async function locked(fn) {
    if (busy) throw new Error('Подключение уже обрабатывается');
    busy=true; try { return await fn(); } finally { busy=false; }
  }
  async function makeTransport(cfg, token, folder, secret, signal) {
    const service=createReadService({folder,secret,deviceId:cfg.deviceId});
    return transportFactory({baseUrl:cfg.url,deviceId:cfg.deviceId,token,service,signal});
  }
  // Только явно завершённый опрос означает, что сервер ответил. Иначе нельзя
  // отмечать подключение как действующее или показывать успешную связь.
  async function poll(client,signal) {
    if(!client || typeof client.step!=='function')throw new Error('Транспорт недоступен');
    checkAborted(signal);
    const result=await client.step(signal);
    checkAborted(signal);
    if(result!==true && result!==false)throw new Error('Неверный ответ опроса');
    return result;
  }
  async function saveConfig(cfg) {
    // save() должен атомарно сохранять данные в защищённое хранилище ДО ответа.
    // Пока Windows-реализация ещё не создана; простой JSON использовать нельзя.
    await vault.save({...cfg});
  }
  async function prepare(code, folderPath, confirmationUrl) { return locked(async () => {
    if (confirmationUrl !== undefined && pairing.normalizeUrl(confirmationUrl)!==trusted) throw new Error('Адрес мессенджера не совпадает');
    const setup=pairing.parse(code,trusted);
    if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) throw new Error('Выберите папку на компьютере');
    if (config || await vault.load()) throw new Error('Подключение уже настроено');
    const a=await anchor(folderPath);
    checkedFolder(await folderFactory(a.root,{dev:a.dev,ino:a.ino})); // до сохранения проверяем выбранную папку
    const fresh=random(32);
    if (!Buffer.isBuffer(fresh) || fresh.length !== 32) throw new Error('Не удалось создать секрет');
    const next={version:1,state:'pending',url:setup.url,deviceId:setup.deviceId,folder:a.root,rootDevice:a.dev,rootInode:a.ino,
      token:fresh.toString('hex'),setupToken:setup.token,key:Buffer.from(setup.secret).toString('base64url')};
    validateConfig(next,trusted);
    await saveConfig(next); // до запроса о привязке; иначе сбой потеряет новый токен
    config=next;
  }); }
  async function load() {
    if (config) return config;
    const loaded=await vault.load();
    validateConfig(loaded,trusted);
    config={...loaded};
    return config;
  }
  async function tick(signal) {
    validateSignal(signal);
    return locked(async () => {
      const checkStopped=()=>checkAborted(signal);
      checkStopped();
      currentFolder=null;
      try {
        const c=await load();
        checkStopped();
        const secret=validateConfig(c,trusted), a=await anchor(c.folder,signal);
        checkStopped();
        if (a.root !== c.folder || a.dev !== c.rootDevice || a.ino !== c.rootInode) {
          const e=new Error('Выбранная папка изменилась, подключение остановлено');
          e.code='LOCAL_FOLDER_CHANGED'; throw e;
        }
        const folder=checkedFolder(await folderFactory(c.folder,{dev:c.rootDevice,ino:c.rootInode},signal));
        checkStopped();
        currentFolder=folder;
        if (!transport) {
          const candidate=await makeTransport(c,c.token,folderProxy,secret,signal);
          checkStopped();
          transport=candidate;
        }
        if (c.state === 'pending') {
          let accepted=false;
          try {
            // Если предыдущий ответ потерялся, новый токен уже может работать.
            await poll(transport,signal); accepted=true;
          } catch (e) { if (!e || e.status !== 401) throw e; }
          checkStopped();
          if (!accepted) {
            const setup=await makeTransport(c,c.setupToken,folderProxy,secret,signal);
            checkStopped();
            if(!setup || typeof setup.claim!=='function')throw new Error('Транспорт недоступен');
            await setup.claim(hash(c.token),signal);
          }
          checkStopped();
          const active={...c,state:'active'}; delete active.setupToken;
          await saveConfig(active);
          config=active;
        }
        checkStopped();
        return await poll(transport,signal);
      } finally { currentFolder=null; }
    });
  }
  return Object.freeze({prepare,tick});
}
module.exports={createCoordinator,anchorFolder};
