# LeebertyPDF - feature probe for the eraser and the reflow view
#
#   powershell -ExecutionPolicy Bypass -File tools\featureprobe.ps1
#
# Drives tools\featureprobe.js inside the real main process: it creates
# annotations, erases one with the independent eraser, then reflows a text
# document and an image-heavy document. Screenshots land in artifacts\.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electron = Join-Path $root '_vendor\electron\electron.exe'

foreach ($name in @('ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'LUMEN_TOOL')) {
  if (Test-Path "Env:\$name") { Remove-Item "Env:\$name" -Force }
}

$env:LUMEN_FEATUREPROBE = '1'
try {
  & $electron $root
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:\LUMEN_FEATUREPROBE -ErrorAction SilentlyContinue
}

$report = Join-Path $root 'artifacts\feature-probe.json'
if (Test-Path $report) {
  $r = Get-Content $report -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ''
  foreach ($item in $r.results) {
    $d = $item.data
    switch ($item.name) {
      'independent eraser' {
        $ok = ($d.afterCreate -eq 2) -and ($d.afterErase -eq 1) -and $d.markerShown
        $tag = if ($ok) { 'PASS' } else { 'FAIL' }
        Write-Host ("  {0}  eraser: storage {1} -> {2} -> erase -> {3}; marker {4}; paired {5}/{6}" -f `
          $tag, $d.before, $d.afterCreate, $d.afterErase, $d.markerShown, $d.paired.withStorage, $d.paired.nodes)
      }
      'reflow' {
        $ok = ($d.articles -gt 0) -and ($d.paragraphs -gt 0) -and $d.backToPaged
        $tag = if ($ok) { 'PASS' } else { 'FAIL' }
        Write-Host ("  {0}  reflow: {1} articles / {2} paragraphs / {3} headings in {4} ms; typography {5} -> {6}" -f `
          $tag, $d.articles, $d.paragraphs, $d.headings, $d.totalMs, $d.firstFontSize, $d.fontSizeAfter)
      }
      default {
        $ok = $d.figures -gt 0
        $tag = if ($ok) { 'PASS' } else { 'FAIL' }
        Write-Host ("  {0}  figures: {1} extracted ({2})" -f $tag, $d.figures, ($d.canvasSizes -join ', '))
      }
    }
  }
  Write-Host ("report: {0}" -f $report)
}
exit $code
