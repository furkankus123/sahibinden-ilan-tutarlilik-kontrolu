<#
    build.ps1 — assembles both distributables from src/.

      dist\sahibinden-tutarsizlik-dedektoru.user.js   (single-file userscript)
      extension\src\*.js                              (shared modules, copied)

    No Node, no npm, no toolchain. Run from the project root:

        powershell -ExecutionPolicy Bypass -File .\build.ps1
#>

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Files shared by BOTH builds, concatenated in dependency order.
$sharedModules = @(
    'detector.js',
    'site-adapters.js',
    'queue.js',
    'content-core.js'
)

function Read-Src([string]$name) {
    Get-Content -LiteralPath (Join-Path $root "src\$name") -Raw -Encoding UTF8
}

# Always write UTF-8 WITHOUT a BOM: a BOM before "// ==UserScript==" stops
# Tampermonkey from recognising the metadata block.
function Write-Utf8NoBom([string]$path, [string]$content) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# --------------------------------------------------------------------------
# 1. Userscript
# --------------------------------------------------------------------------
Write-Host 'Building userscript...' -ForegroundColor Cyan

$parts = New-Object System.Collections.Generic.List[string]
$parts.Add((Read-Src 'userscript-header.txt'))

foreach ($m in $sharedModules) {
    $parts.Add("`n/* ===== src/$m ".PadRight(78, '=') + " */`n")
    $parts.Add((Read-Src $m))
}

# Inline the stylesheet as a JS string constant the glue reads.
#
# The [string] cast is load-bearing: Get-Content returns a string decorated with
# PSPath/PSDrive/... note properties, and ConvertTo-Json would serialise those
# too, producing an OBJECT literal. The glue's `typeof === 'string'` check would
# then fail and the userscript would inject no styles at all — silently.
$css = [string](Get-Content -LiteralPath (Join-Path $root 'src\styles.css') -Raw -Encoding UTF8)
$cssJson = ConvertTo-Json -InputObject $css
$parts.Add("`n/* ===== src/styles.css ".PadRight(78, '=') + " */`n")
$parts.Add("const LID_INLINE_CSS = $cssJson;`n")

$parts.Add("`n/* ===== src/userscript-glue.js ".PadRight(78, '=') + " */`n")
$parts.Add((Read-Src 'userscript-glue.js'))

$userscript = ($parts -join "`n")
$userscriptPath = Join-Path $root 'dist\sahibinden-tutarsizlik-dedektoru.user.js'
Write-Utf8NoBom $userscriptPath $userscript

$lines = ($userscript -split "`n").Count
Write-Host "  -> dist\sahibinden-tutarsizlik-dedektoru.user.js ($lines lines)" -ForegroundColor Green

# --------------------------------------------------------------------------
# 2. Extension — copy the shared modules so there is one source of truth
# --------------------------------------------------------------------------
Write-Host 'Syncing extension modules...' -ForegroundColor Cyan

$extSrc = Join-Path $root 'extension\src'
if (-not (Test-Path $extSrc)) { New-Item -ItemType Directory -Force -Path $extSrc | Out-Null }

foreach ($m in ($sharedModules + 'styles.css')) {
    Copy-Item -LiteralPath (Join-Path $root "src\$m") -Destination (Join-Path $extSrc $m) -Force
    Write-Host "  -> extension\src\$m" -ForegroundColor Green
}

# --------------------------------------------------------------------------
# 3. Sanity checks — catch the mistakes that silently break a userscript
# --------------------------------------------------------------------------
$first = (Get-Content -LiteralPath $userscriptPath -TotalCount 1 -Encoding UTF8)
if ($first -ne '// ==UserScript==') {
    throw "First line must be '// ==UserScript==' but was '$first'"
}
if ($userscript -notmatch '// ==/UserScript==') {
    throw 'Metadata block is not closed.'
}
$bom = [System.IO.File]::ReadAllBytes($userscriptPath)[0..2]
if ($bom[0] -eq 0xEF -and $bom[1] -eq 0xBB -and $bom[2] -eq 0xBF) {
    throw 'Output starts with a UTF-8 BOM; Tampermonkey will not parse the metadata.'
}
if ($userscript -notmatch '(?m)^const LID_INLINE_CSS = "') {
    throw 'LID_INLINE_CSS is not a JS string literal; the styles would never be injected.'
}
if ($userscript -match 'PSParentPath') {
    throw 'PowerShell note properties leaked into the output.'
}

# --------------------------------------------------------------------------
# 4. Extension — validate every file the manifest references, then zip
# --------------------------------------------------------------------------
Write-Host 'Packaging extension...' -ForegroundColor Cyan

$extDir = Join-Path $root 'extension'
$manifestPath = Join-Path $extDir 'manifest.json'

# Read as UTF-8 explicitly: Windows PowerShell would otherwise decode the
# Turkish characters as ANSI and mangle the name shown in the Web Store.
$manifest = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($manifestPath)) | ConvertFrom-Json

$referenced = @($manifest.background.service_worker)
$referenced += $manifest.icons.PSObject.Properties.Value
$referenced += $manifest.action.default_popup
$referenced += $manifest.action.default_icon.PSObject.Properties.Value
foreach ($cs in $manifest.content_scripts) {
    $referenced += $cs.js
    $referenced += $cs.css
}

$missing = @()
foreach ($rel in ($referenced | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path (Join-Path $extDir $rel))) { $missing += $rel }
}
if ($missing.Count -gt 0) {
    throw "manifest.json references files that do not exist: $($missing -join ', ')"
}

# popup.html loads popup.js, which the manifest does not list.
if (-not (Test-Path (Join-Path $extDir 'src\popup.js'))) { throw 'Missing src\popup.js' }

$zipPath = Join-Path $root "dist\extension-v$($manifest.version).zip"
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Built entry by entry rather than with Compress-Archive, which in Windows
# PowerShell 5.1 writes entry names with BACKSLASHES. The ZIP spec mandates
# forward slashes, and Chrome then fails to resolve icons/ and src/ inside the
# package. Do not "simplify" this back to Compress-Archive.
$fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
$prefixLen = $extDir.Length + 1
$entryCount = 0
try {
    foreach ($file in (Get-ChildItem -Recurse -File -LiteralPath $extDir | Sort-Object FullName)) {
        $rel = $file.FullName.Substring($prefixLen).Replace('\', '/')
        $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $stream = $entry.Open()
        try {
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally {
            $stream.Dispose()
        }
        $entryCount++
    }
} finally {
    $archive.Dispose()
    $fs.Dispose()
}

# Verify the package the store will actually receive.
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$names = $zip.Entries | ForEach-Object { $_.FullName }
$zip.Dispose()

if ($names -notcontains 'manifest.json') {
    throw 'manifest.json is not at the root of the zip.'
}
$backslashed = $names | Where-Object { $_ -like '*\*' }
if ($backslashed) {
    throw "Zip entries use backslashes, which Chrome cannot resolve: $($backslashed -join ', ')"
}
foreach ($rel in ($referenced | Where-Object { $_ } | Select-Object -Unique)) {
    $want = $rel.Replace('\', '/')
    if ($names -notcontains $want) { throw "Zip is missing a manifest-referenced file: $want" }
}

$kb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "  -> dist\extension-v$($manifest.version).zip ($entryCount files, $kb KB)" -ForegroundColor Green

Write-Host "`nBuild OK." -ForegroundColor Green
Write-Host 'Tests:     http://localhost:8777/tests/detector-tests.html'
Write-Host 'Install:   chrome://extensions -> Developer mode -> Load unpacked -> extension\'
Write-Host 'Publish:   upload dist\extension-v' -NoNewline; Write-Host "$($manifest.version).zip to the Chrome Web Store"
