<#
.SYNOPSIS
    Builds dist\RoonStreamer.zip: the service compiled to a single exe with
    `deno compile`, WinSW and the install scripts. ffmpeg, ffprobe and yt-dlp
    are not included.
.PARAMETER Deno
    deno executable to build with (2.9 or later). Defaults to deno on PATH,
    then deno.exe in the repo root.
#>
param(
    [string] $Deno,
    [string] $WinSWVersion = 'v2.12.0',
    # SHA256 of WinSW-x64.exe for $WinSWVersion; update both together.
    [string] $WinSWSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not $Deno) {
    $Deno = (Get-Command deno -ErrorAction SilentlyContinue).Source
    if (-not $Deno) { $Deno = Join-Path $root 'deno.exe' }
}

& $Deno install
if ($LASTEXITCODE) { throw 'deno install failed' }
& $Deno task compile
if ($LASTEXITCODE) { throw 'deno compile failed' }

# WinSW is downloaded once and cached in build\.
$cache = Join-Path $root 'build'
New-Item -ItemType Directory -Force $cache | Out-Null
$winsw = Join-Path $cache "WinSW-x64-$WinSWVersion.exe"
if (-not (Test-Path $winsw)) {
    $url = "https://github.com/winsw/winsw/releases/download/$WinSWVersion/WinSW-x64.exe"
    Write-Host "Downloading $url"
    Invoke-WebRequest $url -OutFile $winsw
}
$hash = (Get-FileHash -Algorithm SHA256 $winsw).Hash
if ($hash -ne $WinSWSha256) {
    Remove-Item -Force $winsw
    throw "WinSW download has SHA256 $hash, expected $WinSWSha256"
}

$stage = Join-Path $root 'dist\RoonStreamer'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

Copy-Item (Join-Path $root 'dist\roon-streamer.exe') $stage
Copy-Item $winsw (Join-Path $stage 'RoonStreamer.exe')
Copy-Item (Join-Path $root 'packaging\*') $stage

$zip = Join-Path $root 'dist\RoonStreamer.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip

$denoVersion = (& $Deno --version | Select-Object -First 1)
Write-Host "Built $zip ($denoVersion, WinSW $WinSWVersion)"
