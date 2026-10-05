# LeebertyPDF - build the launcher executable
#
#   powershell -ExecutionPolicy Bypass -File tools\build-launcher.ps1
#
# Compiles tools\launcher.cs into LeebertyPDF.exe and places it both in the
# checkout root (development layout, the normal way to start the app) and in
# dist\ (portable layout). tools\build.ps1 calls this too.

param(
  [string[]]$Targets = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src = Join-Path $root 'tools\launcher.cs'
$icon = Join-Path $root 'assets\icon.ico'

if (-not (Test-Path $src)) { throw "Missing launcher source: $src" }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe not found; install .NET Framework 4.x to build the launcher.' }

if (-not $Targets -or $Targets.Count -eq 0) {
  $Targets = @($root, (Join-Path $root 'dist'))
}

foreach ($dir in $Targets) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $exe = Join-Path $dir 'LeebertyPDF.exe'
  $iconArg = if (Test-Path $icon) { "/win32icon:$icon" } else { $null }
  $cmdArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:anycpu')
  if ($iconArg) { $cmdArgs += $iconArg }
  $cmdArgs += @("/out:$exe", $src)
  & $csc @cmdArgs
  if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed for $exe" }
  $size = (Get-Item $exe).Length
  Write-Host ("  {0}  ({1:N0} bytes)" -f $exe, $size)
}

Write-Host 'Launcher built.' -ForegroundColor Green
