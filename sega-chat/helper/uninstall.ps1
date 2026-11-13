# Файл сохранён в UTF-8 с BOM для Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dest = Join-Path $env:LOCALAPPDATA 'SEGA-CHAT-Sync'
$startup = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startup 'SEGA-CHAT-Sync.vbs') -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Set-Content -Path (Join-Path $dest 'stop.flag') -Value 'stop' -Encoding ASCII
Write-Host 'Автозапуск убран, помощник остановится в течение минуты.'
Write-Host 'Ваши файлы и служебные копии остались на месте:'
Write-Host $dest
Write-Host 'Удалить саму программу можно вручную после остановки. Файлы синхронизируемой папки не удаляются.'
