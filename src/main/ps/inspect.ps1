param(
  [Parameter(Mandatory=$true)][string]$Payload,
  [Parameter(Mandatory=$true)][string]$Out
)

$ErrorActionPreference = 'SilentlyContinue'
$items = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$result = @()

foreach ($it in $items) {
  $p = [string]$it.path
  $o = [ordered]@{
    path      = $p
    name      = [System.IO.Path]::GetFileNameWithoutExtension($p)
    target    = ''
    args      = ''
    iconFile  = ''
    iconIndex = 0
    kind      = 'file'
  }

  if ($p -match '\.lnk$') {
    $o.kind = 'shortcut'
    $sc = $ws.CreateShortcut($p)
    if ($sc) {
      $o.target = [string]$sc.TargetPath
      $o.args = [string]$sc.Arguments
      $loc = [string]$sc.IconLocation
      if ($loc -and $loc -ne ',0') {
        $parts = $loc.Split(',')
        $o.iconFile = $parts[0]
        if ($parts.Count -gt 1) { [int]::TryParse($parts[1], [ref]$null) | Out-Null; $o.iconIndex = [int]$parts[1] }
      }
    }
  }
  elseif ($p -match '\.url$') {
    $o.kind = 'url'
    $lines = Get-Content -LiteralPath $p -Encoding UTF8
    foreach ($l in $lines) {
      if ($l -match '^\s*URL\s*=\s*(.+)$') { $o.target = $Matches[1].Trim() }
      elseif ($l -match '^\s*IconFile\s*=\s*(.+)$') { $o.iconFile = $Matches[1].Trim() }
      elseif ($l -match '^\s*IconIndex\s*=\s*(-?\d+)$') { $o.iconIndex = [int]$Matches[1] }
    }
  }
  elseif (Test-Path -LiteralPath $p -PathType Container) {
    $o.kind = 'folder'
    $o.target = $p
  }
  else {
    $o.kind = 'file'
    $o.target = $p
    $ext = [System.IO.Path]::GetExtension($p).ToLower()
    if ($ext -in @('.doc', '.docx')) { $o.iconFile = "$env:ProgramFiles\Microsoft Office\root\Office16\WINWORD.EXE" }
  }

  $result += $o
}

$json = ConvertTo-Json -InputObject $result -Depth 4 -Compress
if (@($result).Count -eq 0) { $json = '[]' }
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
