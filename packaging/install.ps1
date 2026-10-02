#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs (or upgrades) the Roon Streamer Windows service.
.DESCRIPTION
    Copies the package to the install directory, registers and starts the
    service with WinSW, and adds Windows Firewall rules for roon-streamer.exe:
      - inbound TCP on the HTTP port (control page from other devices)
      - inbound UDP (Roon Core discovery replies)
    Run from the unzipped package folder in an elevated PowerShell.
#>
param(
    [string] $InstallDir = (Join-Path $env:ProgramFiles 'RoonStreamer'),
    [int]    $Port = 8081
)
$ErrorActionPreference = 'Stop'

$serviceExe = Join-Path $InstallDir 'RoonStreamer.exe'
$files = 'roon-streamer.exe', 'RoonStreamer.exe', 'RoonStreamer.xml', 'uninstall.ps1', 'README-service.md'

# Upgrade: stop and remove the existing service before replacing files.
if (Get-Service -Name RoonStreamer -ErrorAction SilentlyContinue) {
    Write-Host 'Stopping existing service...'
    & $serviceExe stop | Out-Host
    & $serviceExe uninstall | Out-Host
}

$source = (Resolve-Path $PSScriptRoot).Path
New-Item -ItemType Directory -Force $InstallDir | Out-Null
if ($source -ne (Resolve-Path $InstallDir).Path) {
    Write-Host "Copying files to $InstallDir"
    foreach ($f in $files) { Copy-Item (Join-Path $source $f) $InstallDir -Force }
}

New-Item -ItemType Directory -Force (Join-Path $env:ProgramData 'RoonStreamer') | Out-Null

$program = Join-Path $InstallDir 'roon-streamer.exe'
Get-NetFirewallRule -Group 'Roon Streamer' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Group 'Roon Streamer' -DisplayName 'Roon Streamer (control page)' `
    -Direction Inbound -Program $program -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
New-NetFirewallRule -Group 'Roon Streamer' -DisplayName 'Roon Streamer (Roon discovery)' `
    -Direction Inbound -Program $program -Protocol UDP -Action Allow | Out-Null

Write-Host 'Installing service...'
& $serviceExe install | Out-Host
& $serviceExe start | Out-Host

Write-Host ''
Write-Host "Installed. Control page: http://$($env:COMPUTERNAME):$Port/"
Write-Host 'Next: in Roon, go to Settings > Extensions, enable "Roon Connect Stream Example", and choose a zone in its settings.'
Write-Host "Logs: $(Join-Path $env:ProgramData 'RoonStreamer\logs')"
