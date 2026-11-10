// Настоящий DPAPI и синтаксис скриптов: только одноразовая виртуальная машина CI.
// НИКОГДА не перезаписывает существующую пользовательскую установку.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
  console.log('local-pc-windows-real: пропущено (нужна чистая Windows-машина CI)');
} else {
  const {createWindowsVault}=createRequire(import.meta.url)('../local-pc/windows-vault.js');
  const probe=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::Out.Write([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))'],{encoding:'utf8'});
  assert.equal(probe.status,0);
  const localRoot=probe.stdout.trim(); assert(localRoot && path.isAbsolute(localRoot));
  const base=path.join(localRoot,'SEGA-CHAT'), testDir=path.join(base,'LocalDisk');
  let created=false;
  try {
    try { await fs.access(testDir); throw new Error('Настоящая установка существует — тест её не трогает'); }
    catch(e) { if(e.code!=='ENOENT')throw e; }
    created=true;
    const vault=createWindowsVault();
    assert.equal(await vault.load(),null);
    const value={secret:'тест-' + 'a'.repeat(64),folder:'C:\\Личная папка',version:1};
    await vault.save(value);assert.deepEqual(await vault.load(),value);
    const raw=await fs.readFile(path.join(testDir,'connection.dat'));
    assert(!raw.includes(Buffer.from(value.secret,'utf8')));
    const value2={...value,version:2};await vault.save(value2);assert.deepEqual(await vault.load(),value2);
    const acl=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::Out.Write((Get-Acl -LiteralPath $env:SEGA_TEST_DIR).AreAccessRulesProtected)'],{encoding:'utf8',env:{...process.env,SEGA_TEST_DIR:testDir}});
    assert.equal(acl.status,0); assert.equal(acl.stdout.trim(),'True');
    for(const name of ['windows-vault.ps1','windows-wizard.ps1']) {
      const script=path.resolve('local-pc',name);
      const syntax=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:SEGA_TEST_SCRIPT,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Error;exit 1}'],{encoding:'utf8',env:{...process.env,SEGA_TEST_SCRIPT:script}});
      assert.equal(syntax.status,0,`${name}: ${syntax.stderr}`);
    }
    console.log('local-pc-windows-real: DPAPI текущего пользователя, ACL, повторное сохранение и синтаксис PowerShell проверены на чистой Windows CI; форма и синхронизация не проверены');
  } finally {
    if(created) {await fs.rm(testDir,{recursive:true,force:true});try{await fs.rmdir(base)}catch(_) {}}
  }
}
