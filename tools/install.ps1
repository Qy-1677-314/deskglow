# DeskGlow 安装到当前用户目录。由打包脚本复制时补上 UTF-8 BOM。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Show-Info([string]$text) {
  [System.Windows.Forms.MessageBox]::Show($text, 'DeskGlow') | Out-Null
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$zip = Join-Path $here 'payload.zip'
if (-not (Test-Path -LiteralPath $zip)) {
  Show-Info "找不到安装数据 payload.zip。"
  exit 1
}

$dest = Join-Path $env:LOCALAPPDATA 'Programs\DeskGlow'
$exe = Join-Path $dest 'DeskGlow.exe'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'

Write-Host "关闭已安装的 DeskGlow..."
Get-CimInstance Win32_Process -Filter "Name = 'DeskGlow.exe'" | ForEach-Object {
  if ($_.ExecutablePath -and ($_.ExecutablePath -ieq $exe)) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 500

Write-Host "安装到 $dest"
if (Test-Path -LiteralPath $dest) {
  Get-ChildItem -LiteralPath $dest -Force | Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
}

& $tar -xf $zip -C $dest
if ($LASTEXITCODE -ne 0) {
  Show-Info "解压失败，安装没有完成。"
  exit 1
}

$ver = ''
$verFile = Join-Path $dest 'version.txt'
if (Test-Path -LiteralPath $verFile) {
  $ver = (Get-Content -LiteralPath $verFile -Raw -Encoding UTF8).Trim()
}
if (-not $ver) { $ver = '0' }

$shell = New-Object -ComObject WScript.Shell
$icon = Join-Path $dest 'icon.ico'
foreach ($dir in @($shell.SpecialFolders('Desktop'), $shell.SpecialFolders('Programs'))) {
  if (-not $dir) { continue }
  $sc = $shell.CreateShortcut((Join-Path $dir 'DeskGlow.lnk'))
  $sc.TargetPath = $exe
  $sc.WorkingDirectory = $dest
  $sc.WindowStyle = 1
  $sc.Description = 'DeskGlow'
  if (Test-Path -LiteralPath $icon) { $sc.IconLocation = "$icon,0" }
  $sc.Save()
}

$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DeskGlow'
New-Item -Path $reg -Force | Out-Null
New-ItemProperty -Path $reg -Name DisplayName -Value 'DeskGlow 桌面美化' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $reg -Name DisplayVersion -Value $ver -PropertyType String -Force | Out-Null
New-ItemProperty -Path $reg -Name Publisher -Value 'DeskGlow' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $reg -Name InstallLocation -Value $dest -PropertyType String -Force | Out-Null
New-ItemProperty -Path $reg -Name DisplayIcon -Value $icon -PropertyType String -Force | Out-Null
$un = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dest\uninstall.ps1`""
New-ItemProperty -Path $reg -Name UninstallString -Value $un -PropertyType String -Force | Out-Null
New-ItemProperty -Path $reg -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $reg -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
$sizeKb = [int]((Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
New-ItemProperty -Path $reg -Name EstimatedSize -Value $sizeKb -PropertyType DWord -Force | Out-Null

Show-Info "已安装到：`n$dest`n`n桌面和开始菜单都有快捷方式。配置仍在原来的位置，这次安装不会改它。`n`n如果托盘里还有正在运行的 DeskGlow，请先退出，再打开桌面上的图标。"
Start-Process -FilePath $exe
