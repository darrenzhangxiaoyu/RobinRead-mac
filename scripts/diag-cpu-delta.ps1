$prev = @{}
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 3
  $now = @{}
  Get-Process RobinRead -ErrorAction SilentlyContinue | ForEach-Object { $now[$_.Id] = [math]::Round($_.CPU, 1) }
  $parts = @()
  foreach ($k in $now.Keys) {
    $d = if ($prev.ContainsKey($k)) { [math]::Round($now[$k] - $prev[$k], 1) } else { 'n' }
    $parts += ("{0}:{1}" -f $k, $d)
  }
  if ($parts.Count) { Write-Output ((Get-Date -Format HHmmss) + ' ' + ($parts -join ' ')) }
  $prev = $now
}
