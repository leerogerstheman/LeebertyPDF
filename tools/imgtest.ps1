# LeebertyPDF - image-heavy UI probe
#
#   powershell -ExecutionPolicy Bypass -File tools\imgtest.ps1
#
# Opens every sample in samples\images through the real reader and measures
# first paint, full-document paint, canvas memory, thumbnails and editor round
# trips, writing artifacts\img\report.json plus screenshots.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electron = Join-Path $root '_vendor\electron\electron.exe'

foreach ($name in @('ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'LUMEN_TOOL')) {
  if (Test-Path "Env:\$name") { Remove-Item "Env:\$name" -Force }
}

$env:LUMEN_IMGTEST = '1'
try {
  & $electron $root
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:\LUMEN_IMGTEST -ErrorAction SilentlyContinue
}

$report = Join-Path $root 'artifacts\img\report.json'
if (Test-Path $report) {
  $r = Get-Content $report -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ''
  Write-Host ("{0} files measured, {1} console errors" -f $r.rows.Count, $r.errors.Count)
  Write-Host ("report: {0}" -f $report)
}
exit $code
