# Build KortixCapture.msi from staged release binaries (WiX v5).
#
#   pwsh installer/windows/build-msi.ps1 -Stage target/release -Version v0.4.2 -Out dist/KortixCapture.msi
#
# -Stage holds kortix-capture.exe, kortix-capture-engine.exe, kortix-backend.exe,
# onnxruntime.dll and privacy-runtime-notices.txt. -Version is the release tag;
# an MSI keeps only major.minor.build, so a pre-release suffix is dropped.
param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$wixVersion = '5.0.2'

if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    dotnet tool install --global wix --version $wixVersion | Out-Host
    $env:PATH = "$env:PATH;$env:USERPROFILE\.dotnet\tools"
}
wix extension add -g "WixToolset.Util.wixext/$wixVersion" | Out-Host

$msiVersion = ($Version -replace '^v', '') -replace '[-+].*$', ''
if ($msiVersion -notmatch '^\d+\.\d+\.\d+$') { throw "version $Version is not major.minor.build" }
$stageDir = (Resolve-Path $Stage).Path
foreach ($f in 'kortix-capture.exe', 'kortix-capture-engine.exe', 'kortix-backend.exe', 'onnxruntime.dll', 'privacy-runtime-notices.txt') {
    if (-not (Test-Path (Join-Path $stageDir $f))) { throw "missing $f in $stageDir" }
}
New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null

wix build -arch x64 -ext WixToolset.Util.wixext `
    -d "StageDir=$stageDir" -d "Version=$msiVersion" -d "IconFile=$PSScriptRoot\..\..\assets\icons\app.ico" `
    -o $Out "$PSScriptRoot\kortix-capture.wxs"
if ($LASTEXITCODE -ne 0) { throw "wix build failed ($LASTEXITCODE)" }
Get-Item $Out | Select-Object FullName, Length | Format-List
