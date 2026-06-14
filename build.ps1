param(
    [string]$Version = "1.0.0"
)

$distDir = "dist"
$zipName = "ChangeStream-v$Version.zip"

if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Path $distDir | Out-Null

$files = @(
    "manifest.json",
    "popup.html",
    "popup.js",
    "content.js",
    "content.css",
    "background.js",
    "mse-delay.js"
)
$dirs = @("lib", "icons")

foreach ($f in $files) {
    if (Test-Path $f) { Copy-Item $f "$distDir/" }
}
foreach ($d in $dirs) {
    if (Test-Path $d) { Copy-Item $d "$distDir/" -Recurse }
}

$zipPath = "$distDir/$zipName"
Compress-Archive -Path "$distDir/*" -DestinationPath $zipPath -Force

Write-Host "Built: $zipPath"
Write-Host "Size: $([math]::Round((Get-Item $zipPath).Length / 1KB, 1)) KB"
