#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,

    [string]$OutputRoot,

    [switch]$Publish
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = $PSScriptRoot
$Builder = Join-Path $ProjectRoot "tools\build-puko.mjs"
$IdMap = Join-Path $ProjectRoot "data\opac-id-map.json"

if (-not $OutputRoot) {
    if ($Publish) {
        $OutputRoot = Join-Path $ProjectRoot "content"
    }
    else {
        $OutputRoot = Join-Path $ProjectRoot "content-preview"
    }
}

if (-not (Test-Path -LiteralPath $Builder -PathType Leaf)) {
    throw "Builder was not found: $Builder"
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw "Node.js was not found."
}

$NodeArguments = @($Builder, "--source", $SourceRoot, "--output", $OutputRoot, "--id-map", $IdMap)

if ($Publish) {
    $NodeArguments += "--publish"
}

& $NodeCommand.Source @NodeArguments
if ($LASTEXITCODE -ne 0) {
    throw "Puko OPAC build failed. Exit code: $LASTEXITCODE"
}
