// Настоящий DPAPI и синтаксис скриптов: только одноразовая виртуальная машина CI.
// НИКОГДА не перезаписывает существующую пользовательскую установку.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
  console.log('local-pc-windows-real: пропущено (нужна чистая Windows-машина CI)');
} else {
  const require=createRequire(import.meta.url);
  const {createWindowsVault}=require('../local-pc/windows-vault.js');
  const {createWindowsFolderProvider}=require('../local-pc/windows-safe-folder.js');
  // Отдельные временные данные. Ничего из пользовательских папок не читаем.
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'sega-guard-test-'));
  try {
    const root=path.join(scratch,'выбранная папка'), outside=path.join(scratch,'outside');
    await fs.mkdir(root); await fs.mkdir(outside); await fs.mkdir(path.join(root,'nested'));
    await fs.writeFile(path.join(root,'nested','тест.txt'),'безопасный текст');
    await fs.writeFile(path.join(outside,'secret.txt'),'внешний секрет');
    await fs.symlink(outside,path.join(root,'junction'),'junction');
    await fs.link(path.join(outside,'secret.txt'),path.join(root,'hardlink.txt'));
    const provider=createWindowsFolderProvider({timeoutMs:60000});
    // Настоящее завершение порождённого PowerShell после отмены, без сети.
    // Выполняется только в чистой Windows CI и пока там не запускалось.
    let processClosed;
    const cancellingProvider=createWindowsFolderProvider({timeoutMs:60000,spawnProcess(name,args,opts){
      const child=spawn(name,args,opts);
      processClosed=new Promise(resolve=>child.once('close',resolve));
      return child;
    }});
    const cancel=new AbortController(), cancelled=cancellingProvider.anchor(root,cancel.signal);
    cancel.abort();await assert.rejects(cancelled,e=>e.name==='AbortError');
    let timer;
    try { await Promise.race([processClosed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Процесс не завершился после остановки')),10000);})]); }
    finally {clearTimeout(timer);}
    const alias=path.join(scratch,'root-alias');
    await fs.symlink(root,alias,'junction');
    try {await assert.rejects(provider.anchor(alias));} finally {await fs.rmdir(alias);}
    const a=await provider.anchor(root), folder=await provider.folder(root,a);
    assert.equal(a.root.toLowerCase(),root.toLowerCase());
    assert((await folder.list('')).some(x=>x.name==='nested' && x.dir));
    assert(!(await folder.list('')).some(x=>['junction','hardlink.txt'].includes(x.name)));
    assert.equal((await folder.list('nested'))[0].name,'тест.txt');
    assert.equal((await folder.listFailOnSkipped('nested'))[0].name,'тест.txt');
    await assert.rejects(folder.list('junction'));
    await assert.rejects(folder.read('junction/secret.txt',0,100));
    await assert.rejects(folder.read('hardlink.txt',0,100));
    // Раздельно проверяем отказ при каждом запрещённом элементе; ни один
    // неполный список не должен возвращаться как результат строгого режима.
    await fs.unlink(path.join(root,'hardlink.txt'));
    await assert.rejects(folder.listFailOnSkipped('')); // только junction
    await fs.link(path.join(outside,'secret.txt'),path.join(root,'hardlink.txt'));
    await fs.rmdir(path.join(root,'junction'));
    await assert.rejects(folder.listFailOnSkipped('')); // только жёсткая ссылка
    await fs.unlink(path.join(root,'hardlink.txt'));
    assert.deepEqual((await folder.listFailOnSkipped('')).map(x=>x.name),['nested']);
    await assert.rejects(folder.read('../outside/secret.txt',0,100));
    const first=await folder.read('nested/тест.txt',0,4);
    const rest=await folder.read('nested/тест.txt',4,100,first.version);
    assert.equal(Buffer.concat([first.data,rest.data]).toString(),'безопасный текст');
    await fs.writeFile(path.join(root,'nested','тест.txt'),'изменено и длиннее прежнего');
    await assert.rejects(folder.read('nested/тест.txt',4,100,first.version));
    // Пытаемся одновременно подменить вложенную папку на junction. Никакое
    // успешное чтение не должно содержать файл из внешнего каталога. Небольшой
    // стресс-тест не является доказательством отсутствия всех возможных гонок.
    await fs.writeFile(path.join(root,'nested','secret.txt'),'внутри');
    const target=path.join(root,'nested'), parked=path.join(root,'nested-parked');
    let swaps=0;
    async function swapRepeatedly() {
      for(let i=0;i<40;i++) {
        try {await fs.rename(target,parked);}
        catch(e) {if(['EACCES','EPERM','EBUSY'].includes(e.code))continue;throw e;}
        let linked=false;
        try {
          await fs.symlink(outside,target,'junction'); linked=true; swaps++;
          await new Promise(resolve=>setTimeout(resolve,50));
        } finally {
          if(linked) await fs.rmdir(target);
          await fs.rename(parked,target);
        }
      }
    }
    const reads=Array.from({length:6},async()=>{
      try {return (await folder.read('nested/secret.txt',0,100)).data.toString();}
      catch(_) {return null;}
    });
    const [raceResults]=await Promise.all([Promise.all(reads),swapRepeatedly()]);
    assert(swaps>0,'Не удалось выполнить ни одной пробной подмены');
    assert(raceResults.every(x=>x===null || x==='внутри'));
    assert.equal((await folder.read('nested/secret.txt',0,100)).data.toString(),'внутри');
    // Замена корня по тому же пути должна приводить к отказу старой привязки.
    await fs.rename(root,root+'-old'); await fs.mkdir(root);
    await assert.rejects(folder.list(''));
    await assert.rejects(folder.read('nested/тест.txt',0,100));
    await fs.rmdir(root); await fs.rename(root+'-old',root);
    // Запрет переименования и точек соединения требует отдельно тестировать
    // под нагрузкой на Windows 10; эта проверка не доказывает отсутствие гонок.
    console.log('local-pc-windows-real: изолированные чтение, ссылки и замена корня проверены');
  } finally {
    // Удаляем junction как ссылку, не обходя содержимое целевой папки.
    for(const dir of ['выбранная папка','выбранная папка-old']) {
      try {await fs.rmdir(path.join(scratch,dir,'junction'));} catch(e) {if(e.code!=='ENOENT')throw e;}
    }
    await fs.rm(scratch,{recursive:true,force:true});
  }
  // DPAPI проверяем только в уникальном временном каталоге. Никогда не
  // используем фактический SEGA-CHAT/LocalDisk, даже на машине с GITHUB_ACTIONS.
  // Меняется ровно источник корня в копии скрипта; остальной код совпадает.
  const vaultScratch=await fs.mkdtemp(path.join(os.tmpdir(),'sega-vault-test-'));
  try {
    const root=path.join(vaultScratch,'root'), testDir=path.join(root,'SEGA-CHAT','LocalDisk');
    const original=path.resolve('local-pc','windows-vault.ps1');
    const source=await fs.readFile(original,'utf8');
    const rootLine='$root = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)';
    assert.equal(source.split(rootLine).length,2,'Исходный скрипт изменился — проверку изоляции надо пересмотреть');
    const testScript=path.join(vaultScratch,'test-vault.ps1');
    await fs.mkdir(root);
    await fs.writeFile(testScript,source.replace(rootLine,'$root = $env:SEGA_VAULT_TEST_ROOT'),'utf8');
    const vault=createWindowsVault({spawnProcess(name,args,opts){
      const idx=args.indexOf('-File');
      assert(idx>=0 && path.resolve(args[idx+1])===original);
      const isolated=[...args]; isolated[idx+1]=testScript;
      return spawn(name,isolated,{...opts,env:{...process.env,SEGA_VAULT_TEST_ROOT:root}});
    }});
    assert.equal(await vault.load(),null);
    // Каталог вместо файла не считается отсутствующей привязкой. Проверка
    // выполняется исключительно во временном изолированном корне.
    await fs.mkdir(testDir,{recursive:true});const fakeFile=path.join(testDir,'connection.dat');
    await fs.mkdir(fakeFile);await assert.rejects(vault.load());await fs.rmdir(fakeFile);
    assert.equal(await vault.load(),null);
    const value={secret:'тест-' + 'a'.repeat(64),folder:'C:\\Личная папка',version:1};
    await vault.save(value);assert.deepEqual(await vault.load(),value);
    const raw=await fs.readFile(path.join(testDir,'connection.dat'));
    assert(!raw.includes(Buffer.from(value.secret,'utf8')));
    const value2={...value,version:2};await vault.save(value2);assert.deepEqual(await vault.load(),value2);
    // Повреждённый файл не превращается в отсутствующую запись.
    await fs.writeFile(fakeFile,Buffer.from('повреждено'));await assert.rejects(vault.load());
    await vault.save(value2);assert.deepEqual(await vault.load(),value2);
    const acl=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::Out.Write((Get-Acl -LiteralPath $env:SEGA_TEST_DIR).AreAccessRulesProtected)'],{encoding:'utf8',env:{...process.env,SEGA_TEST_DIR:testDir}});
    assert.equal(acl.status,0); assert.equal(acl.stdout.trim(),'True');
    console.log('local-pc-windows-real: DPAPI и ACL проверены во временной копии скрипта с изолированным корнем');
  } finally { await fs.rm(vaultScratch,{recursive:true,force:true}); }
  for(const name of ['windows-vault.ps1','windows-wizard.ps1','windows-safe-folder.ps1']) {
    const script=path.resolve('local-pc',name);
    const syntax=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:SEGA_TEST_SCRIPT,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Error;exit 1}'],{encoding:'utf8',env:{...process.env,SEGA_TEST_SCRIPT:script}});
    assert.equal(syntax.status,0,`${name}: ${syntax.stderr}`);
  }
  // Проверяем не просто наличие кириллицы в байтах, а то, как её читает
  // настоящий парсер Windows PowerShell при открытии файла формы.
  const parseRussian="$e=$null;$t=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:SEGA_TEST_SCRIPT,[ref]$t,[ref]$e);if($e.Count){exit 1};$a=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value -eq 'Выбрать папку'},$true);if($a.Count -ne 1){exit 1}";
  const russian=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',parseRussian],{encoding:'utf8',env:{...process.env,SEGA_TEST_SCRIPT:path.resolve('local-pc','windows-wizard.ps1')}});
  assert.equal(russian.status,0,`PowerShell не распознал русскую надпись: ${russian.stderr}`);
  console.log('local-pc-windows-real: синтаксис и русская строка проверены парсером; форма и синхронизация не проверены');
}
