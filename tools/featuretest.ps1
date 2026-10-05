# LeebertyPDF - full feature sweep
#
#   powershell -ExecutionPolicy Bypass -File tools\featuretest.ps1
#
# Runs tools\featuretest.js inside the real main process: it drives the running
# reader through every commonly used feature (one assertion each) and writes
# artifacts\feature-report.json.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electron = Join-Path $root '_vendor\electron\electron.exe'

foreach ($name in @('ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'LUMEN_TOOL')) {
  if (Test-Path "Env:\$name") { Remove-Item "Env:\$name" -Force }
}

$env:LUMEN_FEATURETEST = '1'
try {
  & $electron $root
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:\LUMEN_FEATURETEST -ErrorAction SilentlyContinue
}

$report = Join-Path $root 'artifacts\feature-report.json'
if (Test-Path $report) {
  $r = Get-Content $report -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ''
  if ($r.failed -eq 0 -and $r.consoleErrors.Count -eq 0) {
    Write-Host ("ALL PASS - {0}/{0} checks, no console errors" -f $r.total) -ForegroundColor Green
  } else {
    Write-Host ("{0}/{1} passed, {2} failed, {3} console errors" -f $r.passed, $r.total, $r.failed, $r.consoleErrors.Count) -ForegroundColor Yellow
    foreach ($x in $r.results) {
      if (-not $x.ok) { Write-Host ("  FAIL [{0}] {1}: {2}" -f $x.area, $x.name, $x.info) -ForegroundColor Red }
    }
  }
  Write-Host ("report: {0}" -f $report)
}
exit $code
