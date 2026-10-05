# LeebertyPDF - portable build
#
#   powershell -ExecutionPolicy Bypass -File tools\build.ps1
#   powershell -ExecutionPolicy Bypass -File tools\build.ps1 -Out D:\Somewhere\LeebertyPDF
#
# Produces dist\: LeebertyPDF.exe (a tiny launcher) plus app\ payload and the
# Electron runtime. The result is fully self-contained and portable.

param(
  [string]$Out = '',
  [switch]$SkipLauncher
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Out) { $Out = Join-Path $root 'dist' }

$electronSrc = Join-Path $root '_vendor\electron'
if (-not (Test-Path (Join-Path $electronSrc 'electron.exe'))) {
  throw "Electron runtime missing: $electronSrc\electron.exe"
}

Write-Host "Build output: $Out" -ForegroundColor Cyan

# 0. make sure the vendored PDF.js bundles carry the runtime shims ----------
Write-Host 'Syncing vendored PDF.js shims ...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\sync-vendor.ps1')

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# 1. Electron runtime ------------------------------------------------------
Write-Host 'Copying Electron runtime ...'
$runtimeFiles = @(
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll',
  'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'resources.pak',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
  'vulkan-1.dll', 'LICENSE', 'LICENSES.chromium.html', 'version'
)
foreach ($f in $runtimeFiles) {
  $src = Join-Path $electronSrc $f
  if (Test-Path $src) { Copy-Item $src $Out -Force }
}
Copy-Item (Join-Path $electronSrc 'locales') $Out -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'resources') | Out-Null

# 2. application payload ---------------------------------------------------
$appDir = Join-Path $Out 'resources\app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Write-Host 'Copying application files ...'
Copy-Item (Join-Path $root 'package.json') $appDir -Force
Copy-Item (Join-Path $root 'src') $appDir -Recurse -Force
Copy-Item (Join-Path $root 'assets') $appDir -Recurse -Force
if (Test-Path (Join-Path $root 'LICENSE')) { Copy-Item (Join-Path $root 'LICENSE') $appDir -Force }
if (Test-Path (Join-Path $root 'README.md')) { Copy-Item (Join-Path $root 'README.md') $appDir -Force }

# strip development-only helpers from the shipped renderer
Remove-Item (Join-Path $appDir 'src\renderer\bare-control.js') -Force -ErrorAction SilentlyContinue

# 3. launcher --------------------------------------------------------------
$runtimeTarget = Join-Path $Out 'electron.exe'
Copy-Item (Join-Path $electronSrc 'electron.exe') $runtimeTarget -Force

if (-not $SkipLauncher) {
  Write-Host 'Compiling launcher LeebertyPDF.exe ...'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\build-launcher.ps1') -Targets $Out, $root
  if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
  Remove-Item (Join-Path $Out 'LICENSE') -ErrorAction SilentlyContinue
}

# 4. summary ---------------------------------------------------------------
$size = (Get-ChildItem $Out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ''
Write-Host ("Done: {0}  ({1:N1} MB)" -f $Out, ($size / 1MB)) -ForegroundColor Green
Get-ChildItem $Out | Select-Object Name, Length | Format-Table -AutoSize
