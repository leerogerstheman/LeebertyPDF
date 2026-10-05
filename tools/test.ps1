# LeebertyPDF - automated smoke test
#
#   powershell -ExecutionPolicy Bypass -File tools\test.ps1
#   powershell -ExecutionPolicy Bypass -File tools\test.ps1 -Files "a.pdf;b.pdf"
#
# Copies the development control probe into the renderer, runs the reader with
# LUMEN_SELFTEST so tools/selftest.js drives the real UI, then removes the probe
# again and prints the report summary.

param(
  [string]$Files = '',
  [switch]$KeepProbe
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electron = Join-Path $root '_vendor\electron\electron.exe'
$probeSrc = Join-Path $root 'tools\bare-control.dev.js'
$probeDst = Join-Path $root 'src\renderer\bare-control.js'
$artifacts = Join-Path $root 'artifacts'

foreach ($name in @('ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'LUMEN_TOOL')) {
  if (Test-Path "Env:\$name") { Remove-Item "Env:\$name" -Force }
}

if (-not $Files) {
  $default = Join-Path $root 'samples\sample-small.pdf'
  if (Test-Path $default) { $Files = $default }
}

New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
Copy-Item $probeSrc $probeDst -Force

$env:LUMEN_SELFTEST = '1'
$env:LUMEN_SELFTEST_FILES = $Files

try {
  & $electron $root
} finally {
  if (-not $KeepProbe) { Remove-Item $probeDst -Force -ErrorAction SilentlyContinue }
  Remove-Item Env:\LUMEN_SELFTEST -ErrorAction SilentlyContinue
  Remove-Item Env:\LUMEN_SELFTEST_FILES -ErrorAction SilentlyContinue
}

$reportPath = Join-Path $artifacts 'report.json'
if (Test-Path $reportPath) {
  $report = Get-Content $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ''
  if ($report.errors.Count -eq 0) {
    Write-Host 'PASS - no renderer errors' -ForegroundColor Green
  } else {
    Write-Host ("FAIL - {0} renderer error(s)" -f $report.errors.Count) -ForegroundColor Red
    $report.errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  }
  Write-Host ("report: {0}" -f $reportPath)
  Get-ChildItem $artifacts -Filter *.png | Select-Object Name, Length | Format-Table -AutoSize
} else {
  Write-Host 'No report produced.' -ForegroundColor Red
}
