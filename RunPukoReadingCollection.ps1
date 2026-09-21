#requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$Execute,

    [string]$SourceRoot,

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

if (-not $SourceRoot) {
    $SourceRoot = Join-Path $ProjectParent "obsidian\ぷ庫"
}

$InventoryFile = Join-Path $ProjectParent "puko-reading-inventory.json"
$OutputFile = Join-Path $ProjectParent "puko-reading-candidates.json"

$Exporter = Join-Path $ProjectRoot "ExportPukoReadingInventory.ps1"
$Collector = Join-Path $ProjectRoot "CollectPukoReadingCandidates.ps1"

if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "Source folder was not found: $SourceRoot"
}

Write-Output "=== PUKO READING INVENTORY ==="
Write-Output "Source: $SourceRoot"
Write-Output ""

& $Exporter `
    -SourceRoot $SourceRoot `
    -OutputFile $InventoryFile

Write-Output ""
Write-Output "=== PUKO READING CANDIDATES ==="
Write-Output ""

$CollectArguments = @{
    InventoryFile     = $InventoryFile
    OutputFile        = $OutputFile
    BatchSize         = $BatchSize
    DailyRequestLimit = $DailyRequestLimit
    DelaySeconds      = $DelaySeconds
}

if ($Execute) {
    $CollectArguments["Execute"] = $true
}

& $Collector @CollectArguments

Write-Output ""
if ($Execute) {
    Write-Output "Puko reading collection finished."
}
else {
    Write-Output "Puko reading collection dry-run finished. No NDL request was sent."
}

Write-Output "Inventory: $InventoryFile"
Write-Output "Candidates: $OutputFile"
