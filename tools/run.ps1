# LeebertyPDF - development launcher
#
#   .\tools\run.ps1                 start the reader (via LeebertyPDF.exe)
#   .\tools\run.ps1 -Dev            start with DevTools
#   .\tools\run.ps1 -Raw -File a.pdf  bypass the exe and use electron.exe directly
#   .\tools\run.ps1 -Samples        regenerate the test corpus (needs Python)
#   .\tools\run.ps1 -SelfTest       drive the automated UI smoke test
#   .\tools\run.ps1 -Build          build the portable package into dist\
#   .\tools\run.ps1 -Launcher       rebuild LeebertyPDF.exe only
#
# The launcher exe clears ELECTRON_RUN_AS_NODE itself; this script also clears
# the variables when it invokes the Electron runtime directly.

param(
  [switch]$Dev,
  [switch]$Samples,
  [switch]$SelfTest,
  [string]$Files = '',
  [switch]$Build,
  [switch]$Launcher,
  [switch]$Raw,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electron = Join-Path $root '_vendor\electron\electron.exe'
$launcherExe = Join-Path $root 'LeebertyPDF.exe'

if (-not (Test-Path $electron)) {
  throw "Electron binary not found at $electron"
}

foreach ($name in @('ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'LUMEN_TOOL', 'LUMEN_SELFTEST', 'LUMEN_SELFTEST_FILES')) {
  if (Test-Path "Env:\$name") { Remove-Item "Env:\$name" -Force }
}

Set-Location $root

if ($Samples) {
  $python = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
  if (-not (Test-Path $python)) { $python = 'python' }
  & $python (Join-Path $root 'tools\make_samples.py')
  exit $LASTEXITCODE
}

if ($SelfTest) {
  $env:LUMEN_SELFTEST = '1'
  $env:LUMEN_SELFTEST_FILES = $Files
  & $electron $root
  exit $LASTEXITCODE
}

if ($Build) {
  $buildArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'tools\build.ps1'))
  if ($Out) { $buildArgs += @('-Out', $Out) }
  & powershell @buildArgs
  exit $LASTEXITCODE
}

if ($Launcher) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\build-launcher.ps1')
  exit $LASTEXITCODE
}

# normal start: prefer the launcher exe, fall back to the raw runtime
$fileList = @()
if ($Files) { $fileList = $Files.Split(';') }

if ((Test-Path $launcherExe) -and -not $Raw -and -not $Dev) {
  if ($fileList.Count) { & $launcherExe @fileList } else { & $launcherExe }
  exit $LASTEXITCODE
}

$appArgs = @($root)
if ($Dev) { $appArgs += '--dev' }
if ($fileList.Count) { $appArgs += $fileList }
& $electron @appArgs
