# Indify 扩展打包脚本
# 用法: pwsh -File tools/package-extension.ps1
# 产物: dist/indify-extension-<version>.zip(不含 mock-bridge.mjs 与开发文件)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$extDir = Join-Path $root "extension"
$manifest = Get-Content (Join-Path $extDir "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$outDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force $outDir | Out-Null
$outZip = Join-Path $outDir "indify-extension-$version.zip"

# 打包前清理旧产物
if (Test-Path $outZip) { Remove-Item $outZip -Force }

$tmp = Join-Path $env:TEMP "indify-ext-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  # 复制扩展文件,排除 mock 与开发文件
  Copy-Item (Join-Path $extDir "manifest.json") $tmp
  Copy-Item (Join-Path $extDir "sidepanel.html") $tmp
  Copy-Item (Join-Path $extDir "sidepanel.js") $tmp
  Copy-Item (Join-Path $extDir "service-worker.js") $tmp
  Copy-Item (Join-Path $extDir "content-script.js") $tmp
  Copy-Item (Join-Path $extDir "README.md") $tmp
  Compress-Archive -Path "$tmp\*" -DestinationPath $outZip -Force
  Write-Host "✅ 已打包: $outZip"
  Get-Item $outZip | Select-Object Name, @{n="KB"; e={[math]::Round($_.Length/1KB,1)}}
} finally {
  Remove-Item -Recurse -Force $tmp
}
