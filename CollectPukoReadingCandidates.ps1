#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InventoryFile,
    [string]$OutputFile,
    [string]$CacheDirectory,
    [string]$StateFile,
    [switch]$Execute,
    [ValidateRange(1, 20)]
    [int]$BatchSize = 10,
    [ValidateRange(1, 100)]
    [int]$DailyRequestLimit = 50,
    [ValidateRange(30, 3600)]
    [int]$DelaySeconds = 30
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = $PSScriptRoot
$ProjectParent = Split-Path -Path $ProjectRoot -Parent
$Collector = Join-Path $ProjectRoot "tools\collect-puko-reading-candidates.mjs"

if (-not $InventoryFile) {
    $InventoryFile = Join-Path $ProjectParent "puko-reading-inventory.json"
}
if (-not $OutputFile) {
    $OutputFile = Join-Path $ProjectParent "puko-reading-candidates.json"
}
if (-not $CacheDirectory) {
    $CacheDirectory = Join-Path $env:LOCALAPPDATA "PukoReadingAudit\cache"
}
if (-not $StateFile) {
    $StateFile = Join-Path $env:LOCALAPPDATA "PukoReadingAudit\batch-state.json"
}

if (-not (Test-Path -LiteralPath $Collector -PathType Leaf)) {
    throw "Candidate collector was not found: $Collector"
}
if (-not (Test-Path -LiteralPath $InventoryFile -PathType Leaf)) {
    throw "Reading inventory was not found: $InventoryFile"
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw "Node.js was not found."
}

$Arguments = @(
    $Collector,
    "--inventory", $InventoryFile,
    "--output", $OutputFile,
    "--cache", $CacheDirectory,
    "--state", $StateFile,
    "--batch-size", [string]$BatchSize,
    "--daily-request-limit", [string]$DailyRequestLimit,
    "--delay-ms", [string]($DelaySeconds * 1000)
)
if ($Execute) {
    $Arguments += @("--execute", "true")
}

& $NodeCommand.Source @Arguments

if ($LASTEXITCODE -ne 0) {
    throw "Reading candidate collection failed. Exit code: $LASTEXITCODE"
}

if ($Execute -and (Test-Path -LiteralPath $OutputFile -PathType Leaf)) {
    $ArchiveFile = [System.IO.Path]::ChangeExtension($OutputFile, ".zip")
    Compress-Archive -LiteralPath $OutputFile -DestinationPath $ArchiveFile -Force

    Write-Output ""
    Write-Output "Candidate archive: $ArchiveFile"
}
