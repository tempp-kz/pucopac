#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [string]$OutputRoot,

    [string]$IdMapPath,

    [string]$TargetsFile,

    [switch]$Publish
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = $PSScriptRoot
$Builder = Join-Path $ProjectRoot "tools\build-puko.mjs"
if (-not $IdMapPath) {
    $IdMapPath = Join-Path $ProjectRoot "data\opac-id-map.json"
}

if (-not $OutputRoot) {
    if ($Publish) {
        $OutputRoot = Join-Path $ProjectRoot "content"
    }
    else {
        $OutputRoot = Join-Path $ProjectRoot "content-preview"
    }
}

if ($TargetsFile) {
    if (-not (Test-Path -LiteralPath $TargetsFile -PathType Leaf)) {
        throw "Targets file was not found: $TargetsFile"
    }

    $TargetsFile = (Resolve-Path -LiteralPath $TargetsFile).Path
}

if (-not (Test-Path -LiteralPath $Builder -PathType Leaf)) {
    throw "Builder was not found: $Builder"
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw "Node.js was not found."
}

$NodeArguments = @($Builder, "--source", $SourceRoot, "--output", $OutputRoot, "--id-map", $IdMapPath)

if ($TargetsFile) {
    $NodeArguments += @("--targets-file", $TargetsFile)
}

if ($Publish) {
    $NodeArguments += "--publish"
}

& $NodeCommand.Source @NodeArguments
if ($LASTEXITCODE -ne 0) {
    throw "Puko OPAC build failed. Exit code: $LASTEXITCODE"
}
