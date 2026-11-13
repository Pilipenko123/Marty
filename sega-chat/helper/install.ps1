# SEGA-CHAT · установка помощника синхронизации папок (Windows 10/11, без администратора)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'SEGA-CHAT-Sync'
$app = Join-Path $dest 'app'
$state = $dest
Write-Host 'SEGA-CHAT · помощник синхронизации папок'
Write-Host 'Переписка, игры и файлы на дисках не затрагиваются.'

$serverFile = Join-Path $src 'server.txt'
if (-not (Test-Path $serverFile)) { throw 'В архиве нет server.txt — скачайте помощник из чата заново.' }
$server = (Get-Content $serverFile -Raw).Trim()
if ($server -notmatch '^https://') { throw 'Адрес сервера должен начинаться с https://' }

$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) {
  $ver = & node -v
  if ($ver -match '^v(\d+)') { if ([int]$Matches[1] -ge 18) { $node = $cmd.Source } }
}
$runtime = Join-Path $dest 'runtime'
$localNode = Join-Path $runtime 'node.exe'
if (-not $node -and (Test-Path $localNode)) { $node = $localNode }
if (-not $node) {
  Write-Host 'Node.js не найден — скачиваю официальную переносимую версию…'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $sums = Invoke-WebRequest 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -UseBasicParsing
  $line = ($sums.Content -split "`n" | Where-Object { $_ -match 'node-v[0-9.]+-win-x64\.zip' } | Select-Object -First 1)
  if (-not $line) { throw 'Не нашёл официальный архив Node.js для Windows x64.' }
  $parts = $line.Trim() -split '\s+'
  $hash = $parts[0]; $zipName = $parts[1]
  $zip = Join-Path $env:TEMP $zipName
  Invoke-WebRequest ('https://nodejs.org/dist/latest-v22.x/' + $zipName) -OutFile $zip -UseBasicParsing
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $hash.ToLower()) { Remove-Item $zip -Force; throw 'Контрольная сумма Node.js не совпала — установка остановлена.' }
  Expand-Archive $zip -DestinationPath $runtime -Force
  $inner = Get-ChildItem $runtime -Directory | Select-Object -First 1
  if (-not $inner) { throw 'Архив Node.js распакован неверно.' }
  Get-ChildItem $inner.FullName -Force | Move-Item -Destination $runtime -Force
  Remove-Item $inner.FullName -Recurse -Force
  Remove-Item $zip -Force
  $node = $localNode
}
if (-not (Test-Path $node)) { throw 'Node.js не установлен.' }

New-Item -ItemType Directory -Force -Path $app | Out-Null
Get-ChildItem $src -File | Where-Object { $_.Name -notin @('server.txt','install.cmd','install.ps1','uninstall.cmd','uninstall.ps1') } | Copy-Item -Destination $app -Force
Copy-Item $serverFile (Join-Path $app 'server.txt') -Force

Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Выберите папку, которую нужно синхронизировать'
$dlg.ShowNewFolderButton = $true
if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw 'Папка не выбрана.' }
$root = $dlg.SelectedPath
Add-Type -AssemblyName Microsoft.VisualBasic
$code = [Microsoft.VisualBasic.Interaction]::InputBox('Вставьте код подключения из чата (кнопка «Код для этого ПК»)', 'SEGA-CHAT', '')
if (-not $code) { throw 'Код не введён.' }
$name = [Microsoft.VisualBasic.Interaction]::InputBox('Название этого компьютера', 'SEGA-CHAT', $env:COMPUTERNAME)
if (-not $name) { $name = $env:COMPUTERNAME }

& $node (Join-Path $app 'agent.js') pair --server $server --code $code.Trim() --root $root --name $name --state $state
if ($LASTEXITCODE -ne 0) { throw 'Подключение не удалось.' }

$vbs = Join-Path $dest 'run-hidden.vbs'
$agentJs = Join-Path $app 'agent.js'
$runArg = '"""' + $node + '"" ""' + $agentJs + '"" run --state ""' + $state + '"""'
Set-Content -Path $vbs -Value ('CreateObject("WScript.Shell").Run ' + $runArg + ', 0, False') -Encoding ASCII
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'SEGA-CHAT-Sync.vbs'
Copy-Item $vbs $lnk -Force
Remove-Item (Join-Path $state 'stop.flag') -ErrorAction SilentlyContinue
Start-Process wscript.exe -ArgumentList @($vbs)
Write-Host ''
Write-Host 'Готово. Помощник работает в фоне и запустится при следующем входе в Windows.'
Write-Host 'Вернитесь в чат и создайте папку синхронизации для этого компьютера.'
