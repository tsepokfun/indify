# Indify extension packaging script
# Usage: pwsh -File tools/package-extension.ps1
# Output: dist/indify-extension-<version>.zip (no mock-bridge.mjs, no dev files)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$extDir = Join-Path $root "extension"
$manifest = Get-Content (Join-Path $extDir "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$outDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force $outDir | Out-Null
$outZip = Join-Path $outDir "indify-extension-$version.zip"
if (Test-Path $outZip) { Remove-Item $outZip -Force }
$tmp = Join-Path $env:TEMP ("indify-ext-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  $names = @("manifest.json","sidepanel.html","sidepanel.js","service-worker.js","content-script.js","README.md")
  foreach ($name in $names) {
    Copy-Item -LiteralPath (Join-Path $extDir $name) -Destination (Join-Path $tmp $name) -Force
    if (-not (Test-Path (Join-Path $tmp $name))) { throw "copy failed: $name" }
  }
  Compress-Archive -Path "$tmp\*" -DestinationPath $outZip -Force
  Write-Host "OK packaged: $outZip"
  Get-Item $outZip | Select-Object Name, @{n="KB"; e={[math]::Round($_.Length/1KB,1)}}
} finally {
  Remove-Item -Recurse -Force $tmp
}
