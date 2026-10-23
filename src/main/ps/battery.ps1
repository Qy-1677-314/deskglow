# Battery state for the widget panel. ASCII only: Windows PowerShell 5 reads
# non-BOM files with the OEM codepage, and a broken comment can kill the script.
# PowerStatus matches the tray icon. Win32_Battery.BatteryStatus is often 2
# (Unknown) while the pack is actually charging, so it is only a fallback.
$ErrorActionPreference = 'SilentlyContinue'

$has = $false
$pct = $null
$charging = $false
$ac = $false
$minutes = 0
$decided = $false

try {
  Add-Type -AssemblyName System.Windows.Forms
  $p = [System.Windows.Forms.SystemInformation]::PowerStatus
  if ($null -ne $p) {
    $ac = ([string]$p.PowerLineStatus -eq 'Online')
    $flags = [int]$p.BatteryChargeStatus
    # 128 = NoSystemBattery. 255 = Unknown (do not treat as "no battery":
    # 255 includes the 128 bit). Charging is bit 8.
    if ($flags -eq 128) {
      $decided = $true
      $has = $false
    } elseif ($flags -ne 255) {
      $decided = $true
      $has = $true
      $charging = (($flags -band 8) -ne 0)
      $life = [double]$p.BatteryLifePercent
      if ($life -ge 0 -and $life -le 1) { $pct = [int][Math]::Round($life * 100) }
      $sec = [int]$p.BatteryLifeRemaining
      if ($sec -gt 0 -and $sec -lt 86400) { $minutes = [int][Math]::Floor($sec / 60) }
    }
  }
} catch {}

if ((-not $decided) -or ($has -and $null -eq $pct)) {
  $b = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1
  if ($null -ne $b) {
    $has = $true
    if ($null -eq $pct) {
      try { $pct = [int]$b.EstimatedChargeRemaining } catch { $pct = 0 }
    }
    if (-not $charging) {
      $status = 0
      try { $status = [int]$b.BatteryStatus } catch { $status = 0 }
      # 6..9 = charging. 2 is Unknown, not "on AC".
      if ($status -ge 6 -and $status -le 9) { $charging = $true }
      if ($status -eq 3) { $ac = $true }
    }
    if ($minutes -le 0) {
      try { $minutes = [int]$b.EstimatedRunTime } catch { $minutes = 0 }
      # 71582788 = unknown
      if ($minutes -lt 0 -or $minutes -gt 60000) { $minutes = 0 }
    }
  }
}

if (-not $has) {
  '{"hasBattery":false}'
  exit 0
}
if ($null -eq $pct) { $pct = 0 }
if ($pct -lt 0) { $pct = 0 }
if ($pct -gt 100) { $pct = 100 }

$out = @{
  hasBattery = $true
  percent    = $pct
  charging   = $charging
  ac         = $ac
  minutes    = $minutes
}
$out | ConvertTo-Json -Compress
