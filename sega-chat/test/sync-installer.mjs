// pkg3-155: установщик Windows не должен ломаться о кодировку PowerShell 5.1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSrc, ROOT } from './build.mjs';
import path from 'node:path';
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const buf = rel => fs.readFileSync(path.join(ROOT, rel));
const text = rel => readSrc(rel);
console.log('\n  Синхронизация папок · установщик Windows\n');
for (const rel of ['helper/install.ps1', 'helper/uninstall.ps1']) {
  const b = buf(rel);
  ok(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, rel + ' начинается с UTF-8 BOM');
  const s = text(rel);
  ok(s.charCodeAt(0) === 0xFEFF, rel + ' читается как UTF-8 с BOM');
  ok(!/Р[’°ЅСЃСЌ]|С[ЃЌЏ]|РљРѕ|Р°СЂ/.test(s), rel + ' не содержит mojibake от ANSI-чтения');
  ok(s.includes('$ErrorActionPreference = \'Stop\''), rel + ' останавливается на первой ошибке');
}
const install = text('helper/install.ps1');
ok(install.includes('В архиве нет server.txt'), 'русское сообщение про server.txt цело');
ok(install.includes('Адрес сервера должен начинаться с https://'), 'русское сообщение про адрес цело');
ok(install.includes('[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12'), 'скачивание Node.js использует TLS 1.2');
ok(install.includes('UTF-8 с BOM'), 'в скрипте есть предупреждение про BOM для будущих правок');
const cmd = text('helper/install.cmd');
ok(cmd.includes('-STA') && cmd.includes('-File "%~dp0install.ps1"'), 'install.cmd запускает PowerShell в STA и передаёт файл');
const uncmd = text('helper/uninstall.cmd');
ok(uncmd.includes('-STA') && uncmd.includes('-File "%~dp0uninstall.ps1"'), 'uninstall.cmd запускает PowerShell в STA и передаёт файл');
console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
