# Battery state for the widget panel. ASCII only: Windows PowerShell 5 reads
# non-BOM files with the OEM codepage, and a broken comment can kill the script.
$ErrorActionPreference = 'SilentlyContinue'

$b = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1
if ($null -eq $b) {
  '{"hasBattery":false}'
  exit 0
}

$pct = 0
try { $pct = [int]$b.EstimatedChargeRemaining } catch { $pct = 0 }
if ($pct -lt 0) { $pct = 0 }
if ($pct -gt 100) { $pct = 100 }

# Win32_Battery.BatteryStatus: 2 = AC, 3 = fully charged, 6..9 = charging
$status = 0
try { $status = [int]$b.BatteryStatus } catch { $status = 0 }
$charging = ($status -ge 6 -and $status -le 9)
$ac = ($status -eq 2 -or $status -eq 3 -or $charging)

$minutes = 0
try { $minutes = [int]$b.EstimatedRunTime } catch { $minutes = 0 }
# 71582788 = unknown
if ($minutes -lt 0 -or $minutes -gt 60000) { $minutes = 0 }

$out = @{
  hasBattery = $true
  percent    = $pct
  charging   = $charging
  ac         = $ac
  minutes    = $minutes
}
$out | ConvertTo-Json -Compress
