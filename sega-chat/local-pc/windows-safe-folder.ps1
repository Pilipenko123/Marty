# ТОЛЬКО ДЛЯ ИСПЫТАНИЙ: не включён в мессенджер и не предназначен для скачивания.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $text=[Console]::In.ReadToEnd()
    if($text.Length -gt 16384) { throw 'request too large' }
    $r=ConvertFrom-Json -InputObject $text
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-safe-folder.cs')
    if($r.op -eq 'identity') { $result=[SegaLocalGuard]::Identify([string]$r.root) }
    elseif($r.op -eq 'list') { $result=[SegaLocalGuard]::List([string]$r.root,[string]$r.dev,[string]$r.ino,[string]$r.path) }
    elseif($r.op -eq 'listFailOnSkipped') { $result=[SegaLocalGuard]::ListFailOnSkipped([string]$r.root,[string]$r.dev,[string]$r.ino,[string]$r.path) }
    elseif($r.op -eq 'read') {
        $version=$null; if($null -ne $r.version) { $version=[string]$r.version }
        $result=[SegaLocalGuard]::Read([string]$r.root,[string]$r.dev,[string]$r.ino,[string]$r.path,[long]$r.offset,[int]$r.length,$version)
    }
    else { throw 'unknown command' }
    [Console]::Out.Write((ConvertTo-Json -InputObject @{ok=$true;result=$result} -Compress -Depth 8))
} catch {
    # Никогда не выводим секреты, имена файлов или подробности исключения.
    [Console]::Error.Write('Не удалось безопасно открыть папку или файл')
    exit 1
}
