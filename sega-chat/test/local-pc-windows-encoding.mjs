// Статическая проверка кодировки. Не заменяет запуск Windows PowerShell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const files=[
  ['windows-wizard.ps1','Выбрать папку'],
  ['windows-vault.ps1','Не удалось открыть защищённое хранилище Windows'],
  ['windows-safe-folder.ps1','Не удалось безопасно открыть папку или файл'],
  ['windows-safe-folder.cs','Ссылка или неверный тип']
];
for(const [name,phrase] of files) {
  const bytes=fs.readFileSync(new URL('../local-pc/'+name,import.meta.url));
  // Windows PowerShell 5.1 обычно распознаёт UTF-8 в скриптах по BOM.
  assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf],`${name}: нет UTF-8 BOM`);
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  assert(text.includes(phrase),`${name}: отсутствует исходная русская строка`);
}
console.log('local-pc-windows-encoding: UTF-8 BOM и русские строки проверены статически; Windows не запускалась');
