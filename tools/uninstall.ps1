# DeskGlow 卸载。只删程序和快捷方式，不删用户配置。
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms

$dest = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dest 'DeskGlow.exe'

Get-CimInstance Win32_Process -Filter "Name = 'DeskGlow.exe'" | ForEach-Object {
  if ($_.ExecutablePath -and ($_.ExecutablePath -ieq $exe)) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 600

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @($shell.SpecialFolders('Desktop'), $shell.SpecialFolders('Programs'))) {
  if (-not $dir) { continue }
  $lnk = Join-Path $dir 'DeskGlow.lnk'
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
}
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DeskGlow' -Recurse -Force -ErrorAction SilentlyContinue

[System.Windows.Forms.MessageBox]::Show("DeskGlow 已从这台电脑移除。`n配置、图标缓存仍留在用户目录里，没有删除。", 'DeskGlow') | Out-Null

Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -ArgumentList '/c', "timeout /t 2 /nobreak >nul & rmdir /s /q `"$dest`""
