# LeebertyPDF - keep the vendored PDF.js bundles runnable on older Chromium
#
#   powershell -ExecutionPolicy Bypass -File tools\sync-vendor.ps1
#
# PDF.js 6.x is compiled against the newest V8 and calls JavaScript APIs that
# are missing from the runtime bundled with some Electron releases
# (Map.prototype.getOrInsertComputed, Math.sumPrecise, Promise.try, ...).
# The main thread, the viewer and the worker each run in their own V8 context,
# so the shim block is prepended to every vendored bundle that needs it.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vendor = Join-Path $root 'src\renderer\vendor\pdfjs'
$shims = Join-Path $root 'assets\vendor-shims.js'

if (-not (Test-Path $shims)) { throw "Missing shim source: $shims" }

$block = Get-Content $shims -Raw -Encoding UTF8
$marker = 'LUMEN_VENDOR_SHIMS'

$targets = @('pdf.worker.min.mjs', 'pdf.min.mjs', 'pdf_viewer.mjs')
foreach ($name in $targets) {
  $path = Join-Path $vendor $name
  if (-not (Test-Path $path)) { continue }
  $text = Get-Content $path -Raw -Encoding UTF8
  if ($text.StartsWith($marker) -or $text.Substring(0, [Math]::Min(400, $text.Length)).Contains($marker)) {
    Write-Host ("  {0}: shims already present" -f $name)
    continue
  }
  $out = $block + "`n" + $text
  [IO.File]::WriteAllText($path, $out, (New-Object Text.UTF8Encoding($false)))
  Write-Host ("  {0}: shims injected" -f $name)
}
