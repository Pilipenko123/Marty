'use strict';
/** Секреты помощника. Windows: DPAPI текущего пользователя (без пароля в файле).
 * Другие ОС — только для разработческих проверок: файл 0600. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

function ps(script, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error('DPAPI: ' + (err || code))));
    p.stdin.end(input);
  });
}
const PROTECT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($e))";
const UNPROTECT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($d))";

function createVault(stateDir, opts = {}) {
  const file = path.join(stateDir, opts.win32 === false ? 'vault.json' : 'vault.bin');
  const win = opts.win32 !== undefined ? !!opts.win32 : process.platform === 'win32';
  async function save(obj) {
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const plain = Buffer.from(JSON.stringify(obj), 'utf8');
    const data = win ? Buffer.from(await ps(PROTECT, plain.toString('base64')), 'base64') : plain;
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    await fsp.rename(tmp, file);
  }
  async function load() {
    let raw;
    try { raw = await fsp.readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (win) {
      const b64 = await ps(UNPROTECT, raw.toString('base64'));
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    }
    return JSON.parse(raw.toString('utf8'));
  }
  return { save, load, file };
}
module.exports = { createVault };
