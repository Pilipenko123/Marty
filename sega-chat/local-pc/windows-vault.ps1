# Лабораторное хранилище помощника, отдельно от установщика. До проверки на
# Windows 10 и аудита не использовать для реальных подключений.
param([Parameter(Mandatory=$true)][ValidateSet('load','save')][string]$Mode)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Security
    $root = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrEmpty($root)) { throw 'local storage unavailable' }
    $dir = Join-Path $root 'SEGA-CHAT\LocalDisk'
    $file = Join-Path $dir 'connection.dat'
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('SEGA-CHAT LocalDisk v1')
    if ($Mode -eq 'load') {
        if (-not [System.IO.File]::Exists($file)) { [Console]::Out.Write('{"exists":false}'); exit 0 }
        $blob = [System.IO.File]::ReadAllBytes($file)
        if ($blob.Length -gt 65536) { throw 'bad data' }
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($bytes.Length -gt 16384) { throw 'bad data' }
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
        # Проверяем JSON и возвращаем его через канал в процесс, не в файл и не в журнал.
        $null = ConvertFrom-Json -InputObject $text
        [Console]::Out.Write('{"exists":true,"data":' + $text + '}')
        exit 0
    }
    $text = [Console]::In.ReadToEnd()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 16384) { throw 'bad data' }
    $null = ConvertFrom-Json -InputObject $text
    [System.IO.Directory]::CreateDirectory($dir) | Out-Null
    # На папке только текущий пользователь и SYSTEM; ключ DPAPI дополнительно
    # привязан к этому пользователю Windows. Администратор ПК не считается
    # противником, обладающим гарантированно меньшими правами.
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($who in @($sid, $system)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    [System.IO.Directory]::SetAccessControl($dir, $acl)
    $blob = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    $temp = Join-Path $dir ('connection-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $stream = New-Object System.IO.FileStream($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $stream.Write($blob, 0, $blob.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if ([System.IO.File]::Exists($file)) { [System.IO.File]::Replace($temp, $file, $null) }
        else { [System.IO.File]::Move($temp, $file) }
    } finally { if ([System.IO.File]::Exists($temp)) { [System.IO.File]::Delete($temp) } }
    [Console]::Out.Write('{"ok":true}')
} catch {
    # Не выдавать содержимое настроек, пути или ключи в вывод или ошибки.
    [Console]::Error.Write('Не удалось открыть защищённое хранилище Windows')
    exit 1
}
