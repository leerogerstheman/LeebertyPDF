# LeebertyPDF - install / uninstall for the current user
#
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Uninstall
#
# Copies the portable build into the install directory, creates Start Menu and
# desktop shortcuts and registers a .pdf open-with entry. Everything is
# per-user, so no administrator rights are required.

param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\LeebertyPDF",
  [switch]$Uninstall,
  [switch]$NoFileAssoc,
  [switch]$NoDesktopIcon
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exeName = 'LeebertyPDF.exe'
$progId = 'LeebertyPDF.Document'
$appName = 'LeebertyPDF'

function Remove-Shortcut([string]$path) {
  if (Test-Path $path) { Remove-Item $path -Force }
}

function Remove-RegistryKey([string]$path) {
  if (Test-Path $path) { Remove-Item $path -Recurse -Force }
}

function Stop-RunningApp {
  Get-Process -Name 'LeebertyPDF', 'electron' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, 'OrdinalIgnoreCase') } |
    ForEach-Object { $_.Kill(); Start-Sleep -Milliseconds 250 }
}

function New-AppShortcut([string]$linkPath, [string]$exe, [string]$workDir) {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($linkPath)
  $sc.TargetPath = $exe
  $sc.WorkingDirectory = $workDir
  $sc.IconLocation = "$exe,0"
  $sc.Description = 'LeebertyPDF reader'
  $sc.Save()
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
  Write-Host "Uninstalling $appName ..." -ForegroundColor Cyan
  Stop-RunningApp
  Remove-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) "$appName.lnk")
  Remove-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) "$appName.lnk")
  Remove-RegistryKey "HKCU:\Software\Classes\$progId"
  Remove-RegistryKey 'HKCU:\Software\Classes\.pdf\OpenWithProgids'
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Host 'Uninstalled. User data remains in %APPDATA%\LeebertyPDF.' -ForegroundColor Green
  exit 0
}

# Clean up the previous product name so two copies cannot both answer for .pdf.
function Remove-LegacyInstall {
  $legacyDir = Join-Path $env:LOCALAPPDATA 'Programs\LumenPDF'
  Stop-RunningApp
  if (Test-Path $legacyDir) {
    Remove-Item $legacyDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed the previous install: $legacyDir"
  }
  foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    $lnk = Join-Path $dir 'Lumen PDF.lnk'
    if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue }
  }
  foreach ($key in @('HKCU:\Software\Classes\LumenPDF.Document')) {
    if (Test-Path $key) { Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $openWith = 'HKCU:\Software\Classes\.pdf\OpenWithProgids'
  if (Test-Path $openWith) {
    Remove-ItemProperty -Path $openWith -Name 'LumenPDF.Document' -ErrorAction SilentlyContinue
  }
}

# ------------------------------------------------------------------ install
if (-not (Test-Path (Join-Path $root '_vendor\electron\electron.exe'))) {
  throw 'Electron runtime not found (_vendor\electron\electron.exe).'
}
if (-not (Test-Path (Join-Path $root 'dist\LeebertyPDF.exe'))) {
  Write-Host 'Building the portable package first ...' -ForegroundColor Cyan
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\build.ps1')
}

Write-Host "Installing into $InstallDir ..." -ForegroundColor Cyan
Remove-LegacyInstall
Stop-RunningApp
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $root 'dist\*') $InstallDir -Recurse -Force

$exe = Join-Path $InstallDir $exeName

# shortcuts ---------------------------------------------------------------
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) "$appName.lnk"
New-AppShortcut $startMenu $exe $InstallDir
Write-Host "Start Menu shortcut: $startMenu"

if (-not $NoDesktopIcon) {
  $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$appName.lnk"
  New-AppShortcut $desktop $exe $InstallDir
  Write-Host "Desktop shortcut: $desktop"
}

# file association --------------------------------------------------------
if (-not $NoFileAssoc) {
  $classes = 'HKCU:\Software\Classes'
  New-Item -Force -Path "$classes\$progId" | Out-Null
  Set-ItemProperty -Path "$classes\$progId" -Name '(default)' -Value 'PDF Document'
  New-Item -Force -Path "$classes\$progId\DefaultIcon" | Out-Null
  Set-ItemProperty -Path "$classes\$progId\DefaultIcon" -Name '(default)' -Value "$exe,0"
  New-Item -Force -Path "$classes\$progId\shell\open\command" | Out-Null
  Set-ItemProperty -Path "$classes\$progId\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""

  New-Item -Force -Path "$classes\.pdf" | Out-Null
  New-Item -Force -Path "$classes\.pdf\OpenWithProgids" | Out-Null
  Set-ItemProperty -Path "$classes\.pdf\OpenWithProgids" -Name $progId -Value ([byte[]]@()) -Type Binary
  Write-Host 'Registered .pdf open-with entry (choose LeebertyPDF under "Open with").'
}

Write-Host ''
Write-Host "Installed: $exe" -ForegroundColor Green
