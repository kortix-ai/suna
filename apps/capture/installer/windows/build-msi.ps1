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

# Microsoft's WebView2 bootstrapper (the MSI runs it when the runtime is missing).
$webview2 = Join-Path ([System.IO.Path]::GetTempPath()) 'MicrosoftEdgeWebview2Setup.exe'
if (-not (Test-Path $webview2)) {
    Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $webview2 -MaximumRetryCount 3 -RetryIntervalSec 5
}
$sig = Get-AuthenticodeSignature $webview2
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    Remove-Item $webview2 -Force
    throw "the WebView2 bootstrapper is not signed by Microsoft: $($sig.Status) $($sig.SignerCertificate.Subject)"
}

wix build -arch x64 -ext WixToolset.Util.wixext `
    -d "StageDir=$stageDir" -d "Version=$msiVersion" -d "WebView2Setup=$webview2" -d "IconFile=$PSScriptRoot\..\..\assets\icons\windows\app.ico" `
    -o $Out "$PSScriptRoot\kortix-capture.wxs"
if ($LASTEXITCODE -ne 0) { throw "wix build failed ($LASTEXITCODE)" }
Get-Item $Out | Select-Object FullName, Length | Format-List
