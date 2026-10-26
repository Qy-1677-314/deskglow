# Explorer "New" menu. ASCII only: Windows PowerShell 5 reads non-BOM files
# with the OEM codepage, and a broken comment can kill the script.
param(
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DgShellNew {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int LoadString(IntPtr hInstance, uint uID, StringBuilder lpBuffer, int nBufferMax);
}
"@

$libCache = @{}

function Clean-Label([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return '' }
  $s = $text -replace '\(&[A-Za-z0-9]\)', ''
  $s = $s -replace '&', ''
  return ($s -replace '\s+', ' ').Trim()
}

function Load-Res([string]$spec) {
  if ([string]::IsNullOrWhiteSpace($spec)) { return '' }
  $spec = $spec.Trim()
  if ($spec -notmatch '^@(.+),(-?\d+)\s*$') { return (Clean-Label $spec) }
  $dll = [Environment]::ExpandEnvironmentVariables($Matches[1].Trim())
  $id = [int]$Matches[2]
  if ($id -lt 0) { $id = -$id }
  if (-not [System.IO.Path]::IsPathRooted($dll)) {
    $try = Join-Path $env:SystemRoot ("System32\" + $dll)
    if (Test-Path -LiteralPath $try) { $dll = $try }
  }
  if (-not $libCache.ContainsKey($dll)) {
    $libCache[$dll] = [DgShellNew]::LoadLibraryEx($dll, [IntPtr]::Zero, 0x22)
  }
  $h = $libCache[$dll]
  if ($h -eq [IntPtr]::Zero) { return '' }
  $sb = New-Object System.Text.StringBuilder 1024
  $n = [DgShellNew]::LoadString($h, [uint32]$id, $sb, $sb.Capacity)
  if ($n -le 0) { return '' }
  return (Clean-Label $sb.ToString())
}

function Resolve-Label([string]$menuText, [string]$progId) {
  $fromMenu = Load-Res $menuText
  if ($fromMenu -and $fromMenu -notmatch '^@') { return $fromMenu }
  if ($progId) {
    $pk = "Registry::HKEY_CLASSES_ROOT\$progId"
    if (Test-Path -LiteralPath $pk) {
      $item = Get-Item -LiteralPath $pk
      $friendly = Load-Res ([string]$item.GetValue('FriendlyTypeName'))
      if ($friendly -and $friendly -notmatch '^@') { return $friendly }
      $def = Clean-Label ([string]$item.GetValue(''))
      if ($def) { return $def }
    }
  }
  return ''
}

function Has-Name($names, [string]$name) {
  foreach ($x in @($names)) { if ($x -eq $name) { return $true } }
  return $false
}

function Read-ShellNew([string]$keyPath, [string]$className, [string]$progId) {
  if (-not (Test-Path -LiteralPath $keyPath)) { return $null }
  $k = Get-Item -LiteralPath $keyPath
  $names = @()
  try { $names = @($k.GetValueNames()) } catch { $names = @() }
  $fileName = ''
  $command = ''
  $menuText = ''
  $itemName = ''
  $handler = ''
  $data = ''
  $nullFile = $false
  if (Has-Name $names 'FileName') { $fileName = [string]$k.GetValue('FileName') }
  if (Has-Name $names 'Command') { $command = [string]$k.GetValue('Command') }
  if (Has-Name $names 'MenuText') { $menuText = [string]$k.GetValue('MenuText') }
  if (Has-Name $names 'ItemName') { $itemName = [string]$k.GetValue('ItemName') }
  if (Has-Name $names 'Handler') { $handler = [string]$k.GetValue('Handler') }
  if (Has-Name $names 'NullFile') { $nullFile = $true }
  if (Has-Name $names 'Data') {
    $raw = $k.GetValue('Data')
    if ($raw -is [byte[]] -and $raw.Length -gt 0 -and $raw.Length -le 1048576) {
      $data = [Convert]::ToBase64String($raw)
    }
  }
  $noEmpty = $false
  $isFolder = $false
  $cfg = $keyPath + '\Config'
  if (Test-Path -LiteralPath $cfg) {
    $ck = Get-Item -LiteralPath $cfg
    $cn = @()
    try { $cn = @($ck.GetValueNames()) } catch { $cn = @() }
    if (Has-Name $cn 'NoEmptyFile') { $noEmpty = $true }
    if (Has-Name $cn 'IsFolder') { $isFolder = $true }
  }
  $stem = Load-Res $itemName
  if ($stem -match '^@') { $stem = '' }
  $label = Resolve-Label $menuText $progId
  $hasHandler = $false
  if ($handler) { $hasHandler = $true }
  return @{
    className = $className
    progId = $progId
    label = $label
    stem = $stem
    fileName = $fileName
    data = $data
    command = $command
    nullFile = $nullFile
    noEmpty = $noEmpty
    isFolder = $isFolder
    handler = $hasHandler
  }
}

$order = @()
$orderKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Discardable\PostSetup\ShellNew'
if (Test-Path -LiteralPath $orderKey) {
  $rawOrder = (Get-Item -LiteralPath $orderKey).GetValue('Classes')
  if ($rawOrder -is [string]) { $order = @($rawOrder) }
  elseif ($rawOrder) { $order = @($rawOrder) }
}
if (-not $order -or $order.Count -eq 0) {
  $order = @('.txt', '.rtf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.zip', '.bmp', '.png', 'Folder')
}

$entries = New-Object System.Collections.Generic.List[object]
foreach ($cls in $order) {
  if (-not $cls) { continue }
  if ([string]$cls -eq 'Folder') { continue }
  $extKey = "Registry::HKEY_CLASSES_ROOT\$cls"
  if (-not (Test-Path -LiteralPath $extKey)) { continue }
  $extItem = Get-Item -LiteralPath $extKey
  $direct = $extKey + '\ShellNew'
  $directRow = Read-ShellNew $direct $cls ([string]$extItem.GetValue(''))
  if ($null -ne $directRow) { [void]$entries.Add($directRow) }
  foreach ($child in @(Get-ChildItem -LiteralPath $extKey)) {
    $name = [string]$child.PSChildName
    if (-not $name -or $name -eq 'ShellNew') { continue }
    $row = Read-ShellNew ($extKey + '\' + $name + '\ShellNew') $cls $name
    if ($null -ne $row) { [void]$entries.Add($row) }
  }
}

$json = @{ order = @($order); entries = @($entries.ToArray()) } | ConvertTo-Json -Depth 5 -Compress
$parent = Split-Path -Parent $OutFile
if ($parent -and -not (Test-Path -LiteralPath $parent)) {
  New-Item -ItemType Directory -Path $parent | Out-Null
}
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
exit 0
