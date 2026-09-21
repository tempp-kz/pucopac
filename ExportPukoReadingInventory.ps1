#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [string]$OutputFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = $PSScriptRoot
$Exporter = Join-Path $ProjectRoot "tools\export-puko-reading-inventory.mjs"

if (-not $OutputFile) {
    $ProjectParent = Split-Path -Path $ProjectRoot -Parent
    $OutputFile = Join-Path $ProjectParent "puko-reading-inventory.json"
}

if (-not (Test-Path -LiteralPath $Exporter -PathType Leaf)) {
    throw "Reading inventory exporter was not found: $Exporter"
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw "Node.js was not found."
}

& $NodeCommand.Source $Exporter `
    "--source" $SourceRoot `
    "--output" $OutputFile

if ($LASTEXITCODE -ne 0) {
    throw "Reading inventory export failed. Exit code: $LASTEXITCODE"
}
