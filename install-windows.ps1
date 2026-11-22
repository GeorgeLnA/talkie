# Installs (or updates) Talkie on Windows. Usage, in PowerShell:
#   irm https://raw.githubusercontent.com/GeorgeLnA/talkie/main/install-windows.ps1 | iex
$ErrorActionPreference = 'Stop'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$url = "https://github.com/GeorgeLnA/talkie/releases/latest/download/Talkie-Setup-$arch.exe"
$out = Join-Path $env:TEMP 'Talkie-Setup.exe'
Write-Host "Downloading Talkie..."
Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
Unblock-File $out
Start-Process $out
