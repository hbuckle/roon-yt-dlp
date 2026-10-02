#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Removes the Roon Streamer Windows service and its firewall rules.
.DESCRIPTION
    The install directory is left in place (this script may be running from
    it), as is %ProgramData%\RoonStreamer, which holds the Roon pairing and
    logs. Delete them by hand for a full removal.
#>
$ErrorActionPreference = 'Stop'

$serviceExe = Join-Path $PSScriptRoot 'RoonStreamer.exe'
if (Get-Service -Name RoonStreamer -ErrorAction SilentlyContinue) {
    & $serviceExe stop | Out-Host
    & $serviceExe uninstall | Out-Host
}
Get-NetFirewallRule -Group 'Roon Streamer' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

Write-Host 'Roon Streamer service removed.'
Write-Host "Not removed: $PSScriptRoot and $(Join-Path $env:ProgramData 'RoonStreamer')"
