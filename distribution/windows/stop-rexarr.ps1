# Stops rexarr processes started from this install (used by the installer on upgrade and uninstall).
param([Parameter(Mandatory = $true)][string]$AppDir)

$runtime = Join-Path $AppDir 'runtime'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtime, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
