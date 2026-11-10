'use strict';
// Только экспериментальная точка входа. Не распространять и не запускать с
// настоящими файлами, пока она не проверена на Windows 10 и безопасные границы
// доступа к папке не завершены. Никакие файлы из интернета она не скачивает.
const {createWindowsVault}=require('./windows-vault');
const {showWizard}=require('./windows-wizard');
const {createCoordinator}=require('./agent-coordinator');
const {createAgentRunner}=require('./agent-runner');

async function runHelper({platform=process.platform, vault, wizard=showWizard, coordinator, runnerFactory=createAgentRunner, onStatus=()=>{}}={}) {
  if(platform!=='win32') throw new Error('Помощник работает только на Windows');
  const store=vault || createWindowsVault();
  const agent=coordinator || createCoordinator({vault:store});
  const previous=await store.load();
  if(!previous) {
    const chosen=await wizard();
    if(!chosen)return 'cancelled';
    await agent.prepare(chosen.code,chosen.folder);
  }
  const runner=runnerFactory({coordinator:agent,onStatus});
  const stop=()=>{runner.stop().catch(()=>{});};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try { await runner.start(); return 'stopped'; }
  finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop); }
}
if(require.main===module) {
  const labels={connecting:'Подключение…',online:'Компьютер подключён',offline:'Нет связи; повторяю',revoked:'Доступ отключён в мессенджере', 'folder-changed':'Папка изменилась; подключение остановлено',stopped:'Помощник остановлен'};
  runHelper({onStatus:s=>{if(labels[s])console.log(labels[s]);}}).catch(()=>{console.error('Не удалось запустить помощник. Проверьте настройки и повторите.');process.exitCode=1;});
}
module.exports={runHelper};
