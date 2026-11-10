# Экспериментальное окно выбора папки. Установщиком не является и к приложению
# не подключено; до проверки на Windows 10 его нельзя выдавать пользователям.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'SEGA-CHAT — подключение папки'
    $form.StartPosition = 'CenterScreen'
    $form.ClientSize = New-Object System.Drawing.Size(560, 285)
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $label = New-Object System.Windows.Forms.Label
    $label.Location = New-Object System.Drawing.Point(18, 18)
    $label.Size = New-Object System.Drawing.Size(520, 42)
    $label.Text = 'Вставьте код из мессенджера и выберите папку на этом компьютере. Никому не отправляйте код.'
    $form.Controls.Add($label)
    $code = New-Object System.Windows.Forms.TextBox
    $code.Location = New-Object System.Drawing.Point(18, 65)
    $code.Size = New-Object System.Drawing.Size(520, 25)
    $code.UseSystemPasswordChar = $true
    $form.Controls.Add($code)
    $folder = New-Object System.Windows.Forms.TextBox
    $folder.Location = New-Object System.Drawing.Point(18, 111)
    $folder.Size = New-Object System.Drawing.Size(395, 25)
    $folder.ReadOnly = $true
    $form.Controls.Add($folder)
    $choose = New-Object System.Windows.Forms.Button
    $choose.Text = 'Выбрать папку'
    $choose.Location = New-Object System.Drawing.Point(420, 107)
    $choose.Size = New-Object System.Drawing.Size(118, 30)
    $choose.Add_Click({
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Выберите папку, которую хотите подключить'
        $dlg.ShowNewFolderButton = $true
        try { if ($dlg.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { $folder.Text = $dlg.SelectedPath } }
        finally { $dlg.Dispose() }
    })
    $form.Controls.Add($choose)
    $hint = New-Object System.Windows.Forms.Label
    $hint.Location = New-Object System.Drawing.Point(18, 154)
    $hint.Size = New-Object System.Drawing.Size(520, 45)
    $hint.Text = 'Будет доступна только выбранная папка. Для доступа компьютер должен быть включён и подключён к интернету.'
    $form.Controls.Add($hint)
    $accept = New-Object System.Windows.Forms.Button
    $accept.Text = 'Подключить'
    $accept.Location = New-Object System.Drawing.Point(302, 225)
    $accept.Size = New-Object System.Drawing.Size(112, 34)
    $accept.Add_Click({
        try {
            $raw = $code.Text.Trim()
            if ($raw.Length -lt 50 -or $raw.Length -gt 4096 -or $raw -notmatch '^[A-Za-z0-9_-]+$') { throw 'code' }
            if ([string]::IsNullOrWhiteSpace($folder.Text)) { throw 'folder' }
            $full = [System.IO.Path]::GetFullPath($folder.Text)
            $driveRoot = [System.IO.Path]::GetPathRoot($full)
            if ($full.TrimEnd('\') -eq $driveRoot.TrimEnd('\')) { throw 'folder' }
            $padded = $raw.Replace('-', '+').Replace('_', '/')
            while ($padded.Length % 4 -ne 0) { $padded += '=' }
            $data = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($padded)) | ConvertFrom-Json
            $uri = New-Object System.Uri([string]$data.u)
            if ($data.v -ne 1 -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'code' }
            $hostName = $uri.GetLeftPart([System.UriPartial]::Authority)
            $message = "Подключить папку:`n$full`n`nК мессенджеру: $hostName`n`nПродолжить?"
            if ([System.Windows.Forms.MessageBox]::Show($form, $message, 'Проверьте данные', 'YesNo', 'Question') -ne 'Yes') { return }
            $form.Tag = @{code=$raw; folder=$full}
            $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $form.Close()
        } catch {
            [System.Windows.Forms.MessageBox]::Show($form, 'Проверьте код и выберите обычную папку, не весь диск.', 'Не удалось продолжить', 'OK', 'Warning') | Out-Null
        }
    })
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Отмена'
    $cancel.Location = New-Object System.Drawing.Point(426, 225)
    $cancel.Size = New-Object System.Drawing.Size(112, 34)
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($accept); $form.Controls.Add($cancel)
    $form.AcceptButton = $accept; $form.CancelButton = $cancel
    try {
        if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK -and $form.Tag) {
            [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ok=$true;code=$form.Tag.code;folder=$form.Tag.folder}))
        } else { [Console]::Out.Write('{"ok":false}') }
    } finally { $code.Clear(); $form.Dispose() }
} catch {
    [Console]::Error.Write('Не удалось открыть окно подключения')
    exit 1
}
