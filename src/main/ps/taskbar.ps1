param(
  [Parameter(Mandatory=$true)][ValidateSet('status','apply-tray','apply-pin','restore-tray','restore-pin','restart-explorer')][string]$Action,
  [Parameter(Mandatory=$true)][string]$DataDir
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$Backup    = Join-Path $DataDir 'taskbar-backup'
$PinDir    = Join-Path $Backup 'pins'
$TrayJson  = Join-Path $Backup 'tray-state.json'
$PinJson   = Join-Path $Backup 'pin-manifest.json'
$TrayReg   = Join-Path $Backup 'NotifyIconSettings.reg'
$TrayNotifyReg = Join-Path $Backup 'TrayNotify.reg'
$TaskbandReg   = Join-Path $Backup 'Taskband.reg'

$PinPath = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$TrayKey = 'HKCU:\Control Panel\NotifyIconSettings'
$TrayNotifyKey = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\TrayNotify'
$TaskbandKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband'

function Ensure-Dirs {
  foreach ($d in @($Backup, $PinDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  }
}

function Restart-Explorer {
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1500
  if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
    Start-Process 'explorer.exe'
  }
}

function Get-PinCount {
  if (-not (Test-Path -LiteralPath $PinPath)) { return 0 }
  return @(Get-ChildItem -LiteralPath $PinPath -Filter *.lnk -ErrorAction SilentlyContinue).Count
}

# ---------------- 状态 ----------------
if ($Action -eq 'status') {
  $subs = @(Get-ChildItem -Path $TrayKey -ErrorAction SilentlyContinue)
  $promoted = 0
  foreach ($s in $subs) {
    $v = (Get-ItemProperty -Path $s.PSPath -Name IsPromoted -ErrorAction SilentlyContinue).IsPromoted
    if ($null -ne $v -and $v -eq 1) { $promoted++ }
  }
  $pinned = Get-PinCount
  $b = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
  $out = [ordered]@{
    pinnedCount  = $pinned
    trayTotal    = $subs.Count
    trayPromoted = $promoted
    backupExists = (Test-Path -LiteralPath $PinJson) -or (Test-Path -LiteralPath $TrayJson)
    osBuild      = [int]$b.CurrentBuild
  }
  $out | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'restart-explorer') {
  Restart-Explorer
  '{"ok":true}' | Write-Output
  exit 0
}

Ensure-Dirs

# ---------------- 托盘区：全部常显 ----------------
if ($Action -eq 'apply-tray') {
  # 备份登记项
  if (-not (Test-Path -LiteralPath $TrayJson)) {
    $snap = @{}
    foreach ($s in @(Get-ChildItem -Path $TrayKey -ErrorAction SilentlyContinue)) {
      $v = (Get-ItemProperty -Path $s.PSPath -Name IsPromoted -ErrorAction SilentlyContinue).IsPromoted
      $snap[$s.PSChildName] = $(if ($null -eq $v) { -1 } else { [int]$v })
    }
    ($snap | ConvertTo-Json -Compress) | Set-Content -LiteralPath $TrayJson -Encoding UTF8
    reg.exe export 'HKCU\Control Panel\NotifyIconSettings' "$TrayReg" /y | Out-Null
    reg.exe export 'HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\TrayNotify' "$TrayNotifyReg" /y | Out-Null
  }

  $n = 0
  foreach ($s in @(Get-ChildItem -Path $TrayKey -ErrorAction SilentlyContinue)) {
    New-ItemProperty -Path $s.PSPath -Name 'IsPromoted' -Value 1 -PropertyType DWord -Force | Out-Null
    $n++
  }
  # 旧版实现：清空托盘图标缓存，让系统重新枚举（全部默认显示）
  Remove-ItemProperty -Path $TrayNotifyKey -Name 'IconStreams' -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $TrayNotifyKey -Name 'PastIconsStream' -ErrorAction SilentlyContinue

  Restart-Explorer
  ([ordered]@{ ok = $true; updated = $n }) | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'restore-tray') {
  if (Test-Path -LiteralPath $TrayNotifyReg) { reg.exe import "$TrayNotifyReg" | Out-Null }
  if (Test-Path -LiteralPath $TrayJson) {
    $snap = Get-Content -LiteralPath $TrayJson -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $snap.PSObject.Properties) {
      $k = Join-Path $TrayKey $p.Name
      if (Test-Path -LiteralPath $k) {
        if ([int]$p.Value -lt 0) {
          Remove-ItemProperty -Path $k -Name 'IsPromoted' -ErrorAction SilentlyContinue
        } else {
          New-ItemProperty -Path $k -Name 'IsPromoted' -Value ([int]$p.Value) -PropertyType DWord -Force | Out-Null
        }
      }
    }
  }
  Restart-Explorer
  '{"ok":true}' | Write-Output
  exit 0
}

# ---------------- 任务栏：移除中间固定项 ----------------
if ($Action -eq 'apply-pin') {
  if (-not (Test-Path -LiteralPath $PinJson)) {
    $files = @(Get-ChildItem -LiteralPath $PinPath -Filter *.lnk -ErrorAction SilentlyContinue)
    $manifest = @()
    foreach ($f in $files) {
      Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $PinDir $f.Name) -Force
      $manifest += $f.Name
    }
    ($manifest | ConvertTo-Json -Compress) | Set-Content -LiteralPath $PinJson -Encoding UTF8
    reg.exe export 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband' "$TaskbandReg" /y | Out-Null
  }

  $removed = 0
  foreach ($f in @(Get-ChildItem -LiteralPath $PinPath -Filter *.lnk -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $f.FullName)) { $removed++ }
  }
  # 清掉任务栏缓存里的固定项，否则图标仍会显示
  Remove-ItemProperty -Path $TaskbandKey -Name 'Favorites' -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $TaskbandKey -Name 'FavoritesResolve' -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $TaskbandKey -Name 'FavoritesChanges' -ErrorAction SilentlyContinue

  Restart-Explorer
  ([ordered]@{ ok = $true; removed = $removed }) | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'restore-pin') {
  $restored = 0
  if (Test-Path -LiteralPath $PinDir) {
    foreach ($f in @(Get-ChildItem -LiteralPath $PinDir -Filter *.lnk -ErrorAction SilentlyContinue)) {
      Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $PinPath $f.Name) -Force -ErrorAction SilentlyContinue
      $restored++
    }
  }
  if (Test-Path -LiteralPath $TaskbandReg) { reg.exe import "$TaskbandReg" | Out-Null }
  Restart-Explorer
  ([ordered]@{ ok = $true; restored = $restored }) | ConvertTo-Json -Compress
  exit 0
}

'{"ok":false,"error":"unknown action"}' | Write-Output
