#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$SourceRoot = "C:\Dropbox\tumura\よもう\obsidian\ぷ庫",
    [string]$BaselinePath,
    [string]$IdMapPath,
    [switch]$ApplyRenameCandidates,
    [switch]$RunPreviewBuild,
    [string]$PreviewOutputRoot,
    [switch]$RunPublishBuild,
    [string]$ContentOutputRoot,
    [switch]$RunGitAudit,
    [switch]$TestBaselineUpdate,
    [switch]$DailyUpdate,
    [switch]$SkipDropboxConfirmation,
    [string]$CommitMessage
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = $PSScriptRoot
$BaselinePathWasSpecified = $PSBoundParameters.ContainsKey("BaselinePath")

if (-not $BaselinePath) {
    if ($DailyUpdate) {
        $BaselinePath = Join-Path $env:LOCALAPPDATA "PukoUpdate\state\opac-source-state.json"
    }
    else {
        $BaselinePath = Join-Path $ProjectRoot "data\opac-source-state.json"
    }
}
if (-not $IdMapPath) {
    $IdMapPath = Join-Path $ProjectRoot "data\opac-id-map.json"
}

$LogRoot = Join-Path $env:LOCALAPPDATA "PukoUpdate\logs"
New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $LogRoot "UpdatePuko-$Stamp.log"
$IdMapChanged = $false
$BaselineChanged = $false
$PreviewBuilt = $false
$PublishBuilt = $false
$TreesIdentical = $false
$SourceChanged = $false
$ContentChanged = "NOT_CHECKED"
$GitAuditPassed = $false
$GitStageCreated = $false
$GitCommitCreated = $false
$Pushed = $false
$ResumePendingPush = $false
$ManagedDirtyAtStart = $false
$BuildStatePath = Join-Path $env:LOCALAPPDATA "PukoUpdate\state\opac-build-state.json"
$BuildStateChanged = $false
$BuildMode = "NOT_SELECTED"
$BuildStateReason = "NOT_CHECKED"
$BuildFingerprintInfo = $null
$ImpactPlanPath = $null
$ImpactPlan = $null
$FailureStage = "UNHANDLED_ERROR"
$BuildStateUpdateStarted = $false
$ApprovedDeletionCount = 0

function Write-Log {
    param([string]$Text = "")
    Write-Host $Text
    Add-Content -LiteralPath $LogPath -Value $Text -Encoding UTF8
}

function Get-TreeHashMap {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        throw "比較対象フォルダがありません: $Root"
    }

    $ResolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    $Map = @{}

    Get-ChildItem -LiteralPath $ResolvedRoot -Recurse -File |
        ForEach-Object {
            $Relative = $_.FullName.Substring($ResolvedRoot.Length).
                TrimStart('\').
                Replace('\', '/')

            $Map[$Relative] = (
                Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
            ).Hash.ToLower()
        }

    return $Map
}

function Assert-SourceSnapshotUnchanged {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,

        [Parameter(Mandatory = $true)]
        [string[]]$Roots,

        [Parameter(Mandatory = $true)]
        [hashtable]$ExpectedRecords
    )

    $Now = @{}

    foreach ($Root in $Roots) {
        $RootPath = Join-Path $SourceRoot $Root

        if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
            continue
        }

        foreach ($File in Get-ChildItem -LiteralPath $RootPath -Recurse -File -Filter "*.md") {
            $Relative = $File.FullName.
                Substring($SourceRoot.Length).
                TrimStart("\").
                Replace("\", "/")

            if ($Now.ContainsKey($Relative)) {
                throw "原典再検査で重複パスを検出しました: $Relative"
            }

            $Now[$Relative] = (
                Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256
            ).Hash.ToLower()
        }
    }

    if ($Now.Count -ne $ExpectedRecords.Count) {
        throw "処理中に原典件数が変化しました: 開始時=$($ExpectedRecords.Count) 現在=$($Now.Count)"
    }

    foreach ($RelativePath in $ExpectedRecords.Keys) {
        if (-not $Now.ContainsKey($RelativePath)) {
            throw "処理中に原典ファイルが消失または移動しました: $RelativePath"
        }

        if (
            [string]$Now[$RelativePath] -ne
            [string]$ExpectedRecords[$RelativePath].sha256
        ) {
            throw "処理中に原典ファイルが変更されました: $RelativePath"
        }
    }

    foreach ($RelativePath in $Now.Keys) {
        if (-not $ExpectedRecords.ContainsKey($RelativePath)) {
            throw "処理中に新しい原典ファイルが追加されました: $RelativePath"
        }
    }
}

function Push-MainAndVerify {
    param(
        [Parameter(Mandatory = $true)]
        [object]$GitCommand,

        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    Write-Log ""
    Write-Log "=== GIT PUSH ==="

    & $GitCommand.Source -C $ProjectRoot push origin main

    if ($LASTEXITCODE -ne 0) {
        throw "Git push に失敗しました。ローカルcommitは作成済みです。"
    }

    & $GitCommand.Source -C $ProjectRoot fetch --quiet origin main

    if ($LASTEXITCODE -ne 0) {
        throw "push後のorigin/main再確認に失敗しました"
    }

    $AfterPushSyncText = (
        & $GitCommand.Source `
            -C $ProjectRoot `
            rev-list --left-right --count origin/main...HEAD |
        Out-String
    ).Trim()

    if ($LASTEXITCODE -ne 0) {
        throw "push後の同期状態確認に失敗しました"
    }

    $AfterPushParts = @($AfterPushSyncText -split '\s+')

    if (
        $AfterPushParts.Count -ne 2 -or
        [int]$AfterPushParts[0] -ne 0 -or
        [int]$AfterPushParts[1] -ne 0
    ) {
        throw "push後もローカルmainとorigin/mainが一致していません: $AfterPushSyncText"
    }

    Write-Log "PUSH_VERIFIED=True"
}

function Write-SourceBaseline {
    param(
        [hashtable]$CurrentRecords,
        [object]$CurrentIdMap
    )

    $BaselineDirectory = Split-Path -Parent $BaselinePath

    if ([string]::IsNullOrWhiteSpace($BaselineDirectory)) {
        throw "基準表の保存先ディレクトリを決定できません: $BaselinePath"
    }

    New-Item -ItemType Directory -Path $BaselineDirectory -Force | Out-Null

    $StateRecords = New-Object System.Collections.Generic.List[object]

    foreach ($RelativePath in ($CurrentRecords.Keys | Sort-Object)) {
        $IdProperty = $CurrentIdMap.records.PSObject.Properties[$RelativePath]

        if ($null -eq $IdProperty) {
            throw "基準表更新時にOPAC_IDが見つかりません: $RelativePath"
        }

        $StateRecords.Add([PSCustomObject]@{
            relativePath = $RelativePath
            opacId       = [string]$IdProperty.Value
            sha256       = [string]$CurrentRecords[$RelativePath].sha256
        })
    }

    $NewState = [ordered]@{
        version     = 1
        generatedAt = (Get-Date).ToString("o")
        records     = $StateRecords.ToArray()
    }

    $TempBaseline = Join-Path `
        (Split-Path -Parent $BaselinePath) `
        ("opac-source-state.update-" + $PID + ".json")

    $BaselineBackupRoot = Join-Path $env:LOCALAPPDATA "PukoUpdate\backups\$Stamp"
    New-Item -ItemType Directory -Path $BaselineBackupRoot -Force | Out-Null

    $BaselineBackup = Join-Path $BaselineBackupRoot "opac-source-state.json"

    if (Test-Path -LiteralPath $BaselinePath -PathType Leaf) {
        Copy-Item -LiteralPath $BaselinePath -Destination $BaselineBackup
    }

    try {
        $Json = $NewState | ConvertTo-Json -Depth 10
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

        [System.IO.File]::WriteAllText(
            $TempBaseline,
            $Json + [Environment]::NewLine,
            $Utf8NoBom
        )

        $TestState = Get-Content -LiteralPath $TempBaseline -Raw -Encoding UTF8 |
            ConvertFrom-Json

        if (@($TestState.records).Count -ne $CurrentRecords.Count) {
            throw "基準表の件数検証に失敗しました"
        }

        foreach ($Record in $TestState.records) {
            $IdProperty = $CurrentIdMap.records.PSObject.Properties[[string]$Record.relativePath]

            if ($null -eq $IdProperty -or
                [string]$IdProperty.Value -ne [string]$Record.opacId) {
                throw "基準表のID検証に失敗しました: $($Record.relativePath)"
            }
        }

        Move-Item -LiteralPath $TempBaseline -Destination $BaselinePath -Force
    }
    catch {
        if (Test-Path -LiteralPath $TempBaseline) {
            Remove-Item -LiteralPath $TempBaseline -Force
        }

        if (Test-Path -LiteralPath $BaselineBackup) {
            Copy-Item -LiteralPath $BaselineBackup -Destination $BaselinePath -Force
        }

        throw
    }

    return [PSCustomObject]@{
        Count  = $StateRecords.Count
        Backup = $BaselineBackup
    }
}

function Get-BuildFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $FingerprintVersion = 1

    $RequiredFiles = @(
        "BuildPuko.ps1",
        "UpdatePuko.ps1",
        "tools/build-puko.mjs",
        "tools/plan-puko-impact.mjs",
        "data/ndc10-labels.json"
    )

    $NodeCommand = Get-Command node -ErrorAction SilentlyContinue

    if (-not $NodeCommand) {
        throw "build fingerprint計算に必要なNode.jsが見つかりません"
    }

    $NodeVersionOutput = & $NodeCommand.Source --version

    if ($LASTEXITCODE -ne 0) {
        throw "Node.jsバージョンを取得できません"
    }

    $NodeVersion = (
        $NodeVersionOutput |
        Out-String
    ).Trim()

    $PowerShellVersion = $PSVersionTable.PSVersion.ToString()

    $Inputs = New-Object System.Collections.Generic.List[object]
    $Material = New-Object System.Collections.Generic.List[string]

    $Material.Add(
        "fingerprint-version=$FingerprintVersion"
    )

    $Material.Add(
        "node-version=$NodeVersion"
    )

    $Material.Add(
        "powershell-version=$PowerShellVersion"
    )

    foreach ($RelativePath in $RequiredFiles) {
        $NativeRelativePath = $RelativePath.Replace(
            "/",
            [System.IO.Path]::DirectorySeparatorChar
        )

        $FilePath = Join-Path $ProjectRoot $NativeRelativePath

        if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
            throw "build fingerprint対象ファイルがありません: $RelativePath"
        }

        $Hash = (
            Get-FileHash `
                -LiteralPath $FilePath `
                -Algorithm SHA256
        ).Hash.ToLowerInvariant()

        $Inputs.Add([PSCustomObject]@{
            path   = $RelativePath
            sha256 = $Hash
        })

        $Material.Add(
            "${RelativePath}=$Hash"
        )
    }

    $CanonicalText = (
        $Material.ToArray() -join "`n"
    ) + "`n"

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $Bytes = $Utf8NoBom.GetBytes($CanonicalText)

    $Sha = [System.Security.Cryptography.SHA256]::Create()

    try {
        $Digest = $Sha.ComputeHash($Bytes)
    }
    finally {
        $Sha.Dispose()
    }

    $Fingerprint = (
        [System.BitConverter]::ToString($Digest)
    ).Replace("-", "").ToLowerInvariant()

    return [PSCustomObject]@{
        Version           = $FingerprintVersion
        Fingerprint       = $Fingerprint
        NodeVersion       = $NodeVersion
        PowerShellVersion = $PowerShellVersion
        Inputs            = $Inputs.ToArray()
    }
}

function Get-BuildStateStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StatePath
    )

    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        return [PSCustomObject]@{
            Exists = $false
            Valid  = $false
            Reason = "MISSING"
            State  = $null
        }
    }

    try {
        $State = Get-Content `
            -LiteralPath $StatePath `
            -Raw `
            -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        return [PSCustomObject]@{
            Exists = $true
            Valid  = $false
            Reason = "INVALID_JSON"
            State  = $null
        }
    }

    if (
        $State.version -ne 1 -or
        $State.fingerprintVersion -ne 1 -or
        [string]$State.fingerprint -notmatch '^[0-9a-fA-F]{64}$'
    ) {
        return [PSCustomObject]@{
            Exists = $true
            Valid  = $false
            Reason = "INVALID_SCHEMA"
            State  = $State
        }
    }

    return [PSCustomObject]@{
        Exists = $true
        Valid  = $true
        Reason = "OK"
        State  = $State
    }
}

function Write-BuildState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StatePath,

        [Parameter(Mandatory = $true)]
        [object]$FingerprintInfo,

        [string]$BackupRoot
    )

    $StateDirectory = Split-Path -Parent $StatePath

    if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
        throw "build state保存先ディレクトリを決定できません: $StatePath"
    }

    New-Item `
        -ItemType Directory `
        -Path $StateDirectory `
        -Force |
        Out-Null

    $BackupPath = $null

    if (
        $BackupRoot -and
        (Test-Path -LiteralPath $StatePath -PathType Leaf)
    ) {
        New-Item `
            -ItemType Directory `
            -Path $BackupRoot `
            -Force |
            Out-Null

        $BackupPath = Join-Path `
            $BackupRoot `
            "opac-build-state.json"

        Copy-Item `
            -LiteralPath $StatePath `
            -Destination $BackupPath `
            -Force
    }

    $NewState = [ordered]@{
        version           = 1
        generatedAt       = (Get-Date).ToString("o")
        fingerprintVersion = [int]$FingerprintInfo.Version
        fingerprint       = [string]$FingerprintInfo.Fingerprint
        nodeVersion       = [string]$FingerprintInfo.NodeVersion
        powershellVersion = [string]$FingerprintInfo.PowerShellVersion
        inputs            = @($FingerprintInfo.Inputs)
    }

    $TempState = Join-Path `
        $StateDirectory `
        ("opac-build-state.update-" + $PID + ".json")

    try {
        $Json = $NewState | ConvertTo-Json -Depth 10
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

        [System.IO.File]::WriteAllText(
            $TempState,
            $Json + [Environment]::NewLine,
            $Utf8NoBom
        )

        $TestStatus = Get-BuildStateStatus -StatePath $TempState

        if (-not $TestStatus.Valid) {
            throw "保存前のbuild state検証に失敗しました: $($TestStatus.Reason)"
        }

        if (
            [string]$TestStatus.State.fingerprint -ne
            [string]$FingerprintInfo.Fingerprint
        ) {
            throw "保存前のbuild fingerprint再検証に失敗しました"
        }

        Move-Item `
            -LiteralPath $TempState `
            -Destination $StatePath `
            -Force
    }
    catch {
        if (Test-Path -LiteralPath $TempState) {
            Remove-Item -LiteralPath $TempState -Force
        }

        if (
            $BackupPath -and
            (Test-Path -LiteralPath $BackupPath -PathType Leaf)
        ) {
            Copy-Item `
                -LiteralPath $BackupPath `
                -Destination $StatePath `
                -Force
        }

        throw
    }

    return [PSCustomObject]@{
        Path   = $StatePath
        Backup = $BackupPath
    }
}
function Stop-WithLog {
    param(
        [string]$Stage,
        [string]$Reason
    )

    Write-Log ""
    Write-Log "RESULT=STOP"
    Write-Log "STAGE=$Stage"
    Write-Log "REASON=$Reason"
    Write-Log "SOURCE_CHANGED=$SourceChanged"
    Write-Log "ID_MAP_CHANGED=$IdMapChanged"
    Write-Log "BASELINE_CHANGED=$BaselineChanged"
    Write-Log "CONTENT_CHANGED=$ContentChanged"
    Write-Log "BUILD_MODE=$BuildMode"
    Write-Log "BUILD_STATE_REASON=$BuildStateReason"
    Write-Log "BUILD_STATE_CHANGED=$BuildStateChanged"
    Write-Log "GIT_COMMIT_CREATED=$GitCommitCreated"
    Write-Log "PUSHED=$Pushed"
    Write-Log ""
    Write-Log "更新を停止しました。"
    Write-Log "このログをChatGPTに渡して確認してください。"
    Write-Log "LOG=$LogPath"
}

try {
    Write-Log "ぷ庫OPAC更新チェック"
    Write-Log "START=$(Get-Date -Format o)"
    Write-Log "SOURCE_ROOT=$SourceRoot"
    Write-Log ""

    Write-Log "BASELINE_PATH=$BaselinePath"

    if ($DailyUpdate) {
        if (
            $RunPreviewBuild -or
            $RunPublishBuild -or
            $RunGitAudit -or
            $TestBaselineUpdate
        ) {
            Stop-WithLog `
                "PRECHECK" `
                "DailyUpdate と開発・試験用オプションは同時に指定できません"
            exit 1
        }

        if (
            -not $BaselinePathWasSpecified -and
            -not (Test-Path -LiteralPath $BaselinePath -PathType Leaf)
        ) {
            $LegacyBaseline = Join-Path $ProjectRoot "data\opac-source-state.json"

            if (Test-Path -LiteralPath $LegacyBaseline -PathType Leaf) {
                $BaselineDirectory = Split-Path -Parent $BaselinePath
                New-Item -ItemType Directory -Path $BaselineDirectory -Force | Out-Null
                Copy-Item -LiteralPath $LegacyBaseline -Destination $BaselinePath

                Write-Log "BASELINE_MIGRATED=True"
                Write-Log "BASELINE_MIGRATED_FROM=$LegacyBaseline"
                Write-Log "BASELINE_MIGRATED_TO=$BaselinePath"
            }
        }
    }

    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        Stop-WithLog "PRECHECK" "原典ルートが見つかりません"
        exit 1
    }

    if (-not (Test-Path -LiteralPath $BaselinePath -PathType Leaf)) {
        Stop-WithLog "PRECHECK" "基準状態表が見つかりません"
        exit 1
    }

    if (-not (Test-Path -LiteralPath $IdMapPath -PathType Leaf)) {
        Stop-WithLog "PRECHECK" "IDマップが見つかりません"
        exit 1
    }

    $Roots = @(
        "01 一般書籍",
        "03 シリーズ 出版社順",
        "05 古典 著者出生地分類",
        "07 外国語書籍",
        "11 著者"
    )

    $Baseline = Get-Content -LiteralPath $BaselinePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $IdMap = Get-Content -LiteralPath $IdMapPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if ($Baseline.version -ne 1 -or $null -eq $Baseline.records) {
        Stop-WithLog "PRECHECK" "基準状態表の形式が不正です"
        exit 1
    }

    if ($IdMap.version -ne 1 -or $null -eq $IdMap.records) {
        Stop-WithLog "PRECHECK" "IDマップの形式が不正です"
        exit 1
    }

    $Previous = @{}
    foreach ($Record in $Baseline.records) {
        if ($Previous.ContainsKey([string]$Record.relativePath)) {
            Stop-WithLog "PRECHECK" "基準状態表に重複パスがあります: $($Record.relativePath)"
            exit 1
        }
        $Previous[[string]$Record.relativePath] = $Record
    }

    $Current = @{}

    foreach ($Root in $Roots) {
        $RootPath = Join-Path $SourceRoot $Root
        if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
            continue
        }

        foreach ($File in Get-ChildItem -LiteralPath $RootPath -Recurse -File -Filter "*.md") {
            $Relative = $File.FullName.Substring($SourceRoot.Length).TrimStart("\").Replace("\", "/")

            if ($Current.ContainsKey($Relative)) {
                Stop-WithLog "SOURCE_SCAN" "原典パスが重複しています: $Relative"
                exit 1
            }

            $Current[$Relative] = [PSCustomObject]@{
                relativePath = $Relative
                sha256 = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLower()
            }
        }
    }

    $NewPaths = @(
        $Current.Keys |
        Where-Object { -not $Previous.ContainsKey($_) } |
        Sort-Object
    )

    $MissingPaths = @(
        $Previous.Keys |
        Where-Object { -not $Current.ContainsKey($_) } |
        Sort-Object
    )

    $ChangedSamePath = @(
        $Current.Keys |
        Where-Object {
            $Previous.ContainsKey($_) -and
            [string]$Previous[$_].sha256 -ne [string]$Current[$_].sha256
        } |
        Sort-Object
    )

    $MissingByHash = @{}
    foreach ($Path in $MissingPaths) {
        $Hash = [string]$Previous[$Path].sha256
        if (-not $MissingByHash.ContainsKey($Hash)) {
            $MissingByHash[$Hash] = New-Object System.Collections.Generic.List[string]
        }
        $MissingByHash[$Hash].Add($Path)
    }

    $NewByHash = @{}
    foreach ($Path in $NewPaths) {
        $Hash = [string]$Current[$Path].sha256
        if (-not $NewByHash.ContainsKey($Hash)) {
            $NewByHash[$Hash] = New-Object System.Collections.Generic.List[string]
        }
        $NewByHash[$Hash].Add($Path)
    }

    $RenameCandidates = New-Object System.Collections.Generic.List[object]
    $Ambiguous = New-Object System.Collections.Generic.List[object]
    $MatchedOld = @{}
    $MatchedNew = @{}

    $SharedHashes = @(
        $MissingByHash.Keys |
        Where-Object { $NewByHash.ContainsKey($_) }
    )

    foreach ($Hash in $SharedHashes) {
        $OldList = @($MissingByHash[$Hash])
        $NewList = @($NewByHash[$Hash])

        if ($OldList.Count -eq 1 -and $NewList.Count -eq 1) {
            $OldPath = $OldList[0]
            $NewPath = $NewList[0]

            $RenameCandidates.Add([PSCustomObject]@{
                opacId = [string]$Previous[$OldPath].opacId
                from = $OldPath
                to = $NewPath
                sha256 = $Hash
            })

            $MatchedOld[$OldPath] = $true
            $MatchedNew[$NewPath] = $true
        }
        else {
            $Ambiguous.Add([PSCustomObject]@{
                sha256 = $Hash
                oldPaths = $OldList
                newPaths = $NewList
            })

            foreach ($Path in $OldList) {
                $MatchedOld[$Path] = $true
            }
            foreach ($Path in $NewList) {
                $MatchedNew[$Path] = $true
            }
        }
    }

    $NewSources = @(
        $NewPaths |
        Where-Object { -not $MatchedNew.ContainsKey($_) }
    )

    $DeletionCandidates = @(
        $MissingPaths |
        Where-Object { -not $MatchedOld.ContainsKey($_) }
    )

    $SourceChanged = (
        $ChangedSamePath.Count -gt 0 -or
        $RenameCandidates.Count -gt 0 -or
        $NewSources.Count -gt 0 -or
        $DeletionCandidates.Count -gt 0 -or
        $Ambiguous.Count -gt 0
    )

    Write-Log "=== CURRENT STATE ==="
    Write-Log "CURRENT_SOURCE=$($Current.Count)"
    Write-Log "BASELINE=$($Previous.Count)"
    Write-Log "ID_MAP=$(@($IdMap.records.PSObject.Properties).Count)"
    Write-Log ""
    Write-Log "CHANGED_SAME_PATH=$($ChangedSamePath.Count)"
    Write-Log "RENAME_MOVE_CANDIDATES=$($RenameCandidates.Count)"
    Write-Log "NEW_SOURCES=$($NewSources.Count)"
    Write-Log "DELETION_CANDIDATES=$($DeletionCandidates.Count)"
    Write-Log "AMBIGUOUS_HASH_GROUPS=$($Ambiguous.Count)"

    if ($ChangedSamePath.Count -gt 0) {
        Write-Log ""
        Write-Log "=== CONTENT CHANGES ==="
        foreach ($Path in $ChangedSamePath) {
            Write-Log "CHANGED: $Path"
        }
    }

    if ($RenameCandidates.Count -gt 0) {
        Write-Log ""
        Write-Log "=== RENAME / MOVE CANDIDATES ==="
        foreach ($Item in $RenameCandidates) {
            Write-Log "OPAC_ID=$($Item.opacId)"
            Write-Log "FROM=$($Item.from)"
            Write-Log "TO=$($Item.to)"
            Write-Log "SHA256_MATCH=True"
            Write-Log ""
        }
    }

    if ($NewSources.Count -gt 0) {
        Write-Log ""
        Write-Log "=== NEW SOURCES ==="
        foreach ($Path in $NewSources) {
            Write-Log "NEW: $Path"
        }
    }

    if ($DeletionCandidates.Count -gt 0) {
        Write-Log ""
        Write-Log "=== DELETION CANDIDATES ==="
        foreach ($Path in $DeletionCandidates) {
            Write-Log "DELETED_OR_MISSING: $Path"
        }
    }

    if ($Ambiguous.Count -gt 0) {
        Write-Log ""
        Write-Log "=== AMBIGUOUS RENAME / MOVE ==="

        foreach ($Group in $Ambiguous) {
            Write-Log "SHA256=$($Group.sha256)"
            foreach ($Path in $Group.oldPaths) {
                Write-Log "OLD: $Path"
            }
            foreach ($Path in $Group.newPaths) {
                Write-Log "NEW: $Path"
            }
            Write-Log ""
        }

        Stop-WithLog "RENAME_DETECTION" "改名・移動候補を一意に決定できない組があります"
        exit 2
    }

    if ($DailyUpdate) {
        if ($DeletionCandidates.Count -gt 0) {
            Write-Log ""
            Write-Log "DELETION_APPROVAL_REQUIRED=True"
        }

        $ExpectedIdMapPath = Join-Path $ProjectRoot "data\opac-id-map.json"

        if (
            [System.IO.Path]::GetFullPath($IdMapPath) -ne
            [System.IO.Path]::GetFullPath($ExpectedIdMapPath)
        ) {
            Stop-WithLog `
                "PRECHECK" `
                "DailyUpdateではプロジェクト内の正式IDマップ以外は使用できません"
            exit 1
        }

        $GitCommand = Get-Command git -ErrorAction SilentlyContinue

        if (-not $GitCommand) {
            Stop-WithLog "GIT_PREFLIGHT" "Git が見つかりません"
            exit 10
        }

        $GitPrefix = (
            & $GitCommand.Source -C $ProjectRoot rev-parse --show-prefix |
            Out-String
        ).Trim()

        if ($LASTEXITCODE -ne 0) {
            Stop-WithLog "GIT_PREFLIGHT" "Git作業ツリーを確認できません"
            exit 10
        }

        if (-not [string]::IsNullOrWhiteSpace($GitPrefix)) {
            Stop-WithLog `
                "GIT_PREFLIGHT" `
                "UpdatePuko.ps1 がGitリポジトリ直下にありません"
            exit 10
        }

        foreach ($RequiredTrackedFile in @(
            "BuildPuko.ps1",
            "UpdatePuko.ps1",
            "tools/build-puko.mjs",
            "tools/plan-puko-impact.mjs",
            "data/ndc10-labels.json"
        )) {
            & $GitCommand.Source `
                -C $ProjectRoot `
                ls-files --error-unmatch -- $RequiredTrackedFile *> $null

            if ($LASTEXITCODE -ne 0) {
                Stop-WithLog `
                    "GIT_PREFLIGHT" `
                    "更新ツールがGit管理されていません: $RequiredTrackedFile"
                exit 10
            }
        }

        $CurrentBranch = (
            & $GitCommand.Source -C $ProjectRoot branch --show-current |
            Out-String
        ).Trim()

        if ($LASTEXITCODE -ne 0 -or $CurrentBranch -ne "main") {
            Stop-WithLog `
                "GIT_PREFLIGHT" `
                "DailyUpdateはmainブランチでのみ実行できます: CURRENT=$CurrentBranch"
            exit 10
        }

        & $GitCommand.Source -C $ProjectRoot diff --cached --quiet
        $StagedExit = $LASTEXITCODE

        if ($StagedExit -eq 1) {
            Stop-WithLog `
                "GIT_PREFLIGHT" `
                "既にstage済みの変更があります。自動処理には混在させません。"
            exit 10
        }
        elseif ($StagedExit -ne 0) {
            throw "Git index の確認に失敗しました"
        }

        & $GitCommand.Source `
            -C $ProjectRoot `
            diff --quiet -- . `
            ':(exclude)content/**' `
            ':(exclude)data/opac-id-map.json'

        $OutsideDiffExit = $LASTEXITCODE

        if ($OutsideDiffExit -eq 1) {
            Stop-WithLog `
                "GIT_PREFLIGHT" `
                "contentとIDマップ以外に追跡済みの変更があります"
            exit 10
        }
        elseif ($OutsideDiffExit -ne 0) {
            throw "Git差分の確認に失敗しました"
        }

        $InitialManagedStatus = @(
            & $GitCommand.Source `
                -C $ProjectRoot `
                -c core.quotepath=false `
                status --porcelain=v1 --untracked-files=all -- `
                content `
                data/opac-id-map.json
        )

        if ($LASTEXITCODE -ne 0) {
            throw "DailyUpdate開始時の公開対象Git status取得に失敗しました"
        }

        $ManagedDirtyAtStart = ($InitialManagedStatus.Count -gt 0)
        Write-Log "MANAGED_DIRTY_AT_START=$ManagedDirtyAtStart"
        Write-Log "MANAGED_DIRTY_AT_START_COUNT=$($InitialManagedStatus.Count)"

        Write-Log ""
        Write-Log "=== GIT REMOTE PREFLIGHT ==="

        & $GitCommand.Source -C $ProjectRoot fetch --quiet origin main

        if ($LASTEXITCODE -ne 0) {
            Stop-WithLog `
                "GIT_PREFLIGHT" `
                "origin/main の取得に失敗しました。ネットワークまたはGit設定を確認してください。"
            exit 10
        }

        $SyncText = (
            & $GitCommand.Source `
                -C $ProjectRoot `
                rev-list --left-right --count origin/main...HEAD |
            Out-String
        ).Trim()

        if ($LASTEXITCODE -ne 0) {
            throw "ローカルmainとorigin/mainの比較に失敗しました"
        }

        $SyncParts = @($SyncText -split '\s+')

        if ($SyncParts.Count -ne 2) {
            throw "Git同期状態を解析できません: $SyncText"
        }

        $Behind = [int]$SyncParts[0]
        $Ahead = [int]$SyncParts[1]

        Write-Log "GIT_BEHIND=$Behind"
        Write-Log "GIT_AHEAD=$Ahead"

        if ($Behind -ne 0) {
            Stop-WithLog `
                "GIT_PREFLIGHT" `
                "origin/main側に未取得のcommitがあります: BEHIND=$Behind AHEAD=$Ahead"
            exit 10
        }

        if ($Ahead -gt 1) {
            Stop-WithLog `
                "GIT_PREFLIGHT" `
                "ローカルmainが複数commit先行しています。自動再開しません: AHEAD=$Ahead"
            exit 10
        }

        if ($Ahead -eq 1) {
            # push失敗からの再開候補。
            # 作業ツリーの公開対象に未commit差分があれば自動再開しない。
            & $GitCommand.Source `
                -C $ProjectRoot `
                diff --quiet -- `
                content `
                data/opac-id-map.json

            $PendingManagedDiffExit = $LASTEXITCODE

            if ($PendingManagedDiffExit -eq 1) {
                Stop-WithLog `
                    "GIT_PREFLIGHT" `
                    "未push commitに加えてcontentまたはIDマップの未commit変更があります"
                exit 10
            }
            elseif ($PendingManagedDiffExit -ne 0) {
                throw "未push commit再開時の作業ツリー確認に失敗しました"
            }

            # 先行commitが公開対象以外を変更していないことを確認。
            & $GitCommand.Source `
                -C $ProjectRoot `
                diff --quiet origin/main..HEAD -- . `
                ':(exclude)content/**' `
                ':(exclude)data/opac-id-map.json'

            $PendingOutsideDiffExit = $LASTEXITCODE

            if ($PendingOutsideDiffExit -eq 1) {
                Stop-WithLog `
                    "GIT_PREFLIGHT" `
                    "未push commitに公開対象外の変更が含まれています"
                exit 10
            }
            elseif ($PendingOutsideDiffExit -ne 0) {
                throw "未push commitの範囲確認に失敗しました"
            }

            # 先行commitが実際に公開対象を変更していることも確認。
            & $GitCommand.Source `
                -C $ProjectRoot `
                diff --quiet origin/main..HEAD -- `
                content `
                data/opac-id-map.json

            $PendingManagedCommitExit = $LASTEXITCODE

            if ($PendingManagedCommitExit -eq 0) {
                Stop-WithLog `
                    "GIT_PREFLIGHT" `
                    "先行commitにOPAC公開対象の変更がありません"
                exit 10
            }
            elseif ($PendingManagedCommitExit -ne 1) {
                throw "未push commitの公開対象差分確認に失敗しました"
            }

            $ResumePendingPush = $true

            Write-Log "PENDING_PUSH_RECOVERY=True"
        }

        if (-not $SkipDropboxConfirmation) {
            Write-Log ""
            $DropboxAnswer = Read-Host "Dropbox同期を停止しましたか？ [Y/N]"

            if ($DropboxAnswer -notmatch '^[Yy]$') {
                Stop-WithLog `
                    "DROPBOX_CONFIRMATION" `
                    "Dropbox同期停止を確認できなかったため処理を開始しません"
                exit 11
            }
        }

        Write-Log "DAILY_PREFLIGHT=PASS"
    }

    if ($DailyUpdate -and $DeletionCandidates.Count -gt 0) {
        $ValidatedDeletions = New-Object System.Collections.Generic.List[object]

        foreach ($Path in $DeletionCandidates) {
            $OldRecord = $Previous[$Path]

            if ($null -eq $OldRecord) {
                Stop-WithLog "DELETION_APPLY" "baselineから削除候補を取得できません: $Path"
                exit 5
            }

            $OpacId = [string]$OldRecord.opacId
            $ExpectedPrefix = if ($Path.StartsWith("11 著者/")) { "A" } else { "B" }

            if ($OpacId -notmatch "^$ExpectedPrefix\d+$") {
                Stop-WithLog "DELETION_APPLY" "削除候補のOPAC_IDが不正です: OPAC_ID=$OpacId PATH=$Path"
                exit 5
            }

            $OldProperty = $IdMap.records.PSObject.Properties[$Path]

            if ($null -ne $OldProperty -and [string]$OldProperty.Value -ne $OpacId) {
                Stop-WithLog "DELETION_APPLY" "削除候補のIDマップが一致しません: EXPECTED=$OpacId ACTUAL=$($OldProperty.Value) PATH=$Path"
                exit 5
            }

            $OtherSameIdPaths = @(
                $IdMap.records.PSObject.Properties |
                    Where-Object {
                        [string]$_.Value -eq $OpacId -and
                        [string]$_.Name -ne $Path
                    } |
                    ForEach-Object { [string]$_.Name }
            )

            if ($OtherSameIdPaths.Count -gt 0) {
                Stop-WithLog "DELETION_APPLY" "削除対象OPAC_IDが別パスにも存在します: OPAC_ID=$OpacId PATHS=$($OtherSameIdPaths -join ',')"
                exit 5
            }

            Write-Log ""
            Write-Log "削除候補"
            Write-Log "OPAC_ID=$OpacId"
            Write-Log "PATH=$Path"

            $ExpectedAnswer = "DELETE $OpacId"
            $Answer = Read-Host "削除を承認する場合は $ExpectedAnswer と入力"

            if ([string]$Answer -cne $ExpectedAnswer) {
                Stop-WithLog "DELETION_CONFIRMATION" "利用者が削除を明示承認しなかったため停止しました"
                exit 5
            }

            $ValidatedDeletions.Add([PSCustomObject]@{
                path = $Path
                opacId = $OpacId
                mapEntryExists = ($null -ne $OldProperty)
            })
        }

        if ($ValidatedDeletions.Count -gt 0) {
            $BackupRoot = Join-Path $env:LOCALAPPDATA "PukoUpdate\backups\$Stamp"
            New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null

            $BackupIdMap = Join-Path $BackupRoot (Split-Path -Leaf $IdMapPath)
            Copy-Item -LiteralPath $IdMapPath -Destination $BackupIdMap -Force

            $BeforeCount = @($IdMap.records.PSObject.Properties).Count
            $RemovedMapEntries = 0

            foreach ($Item in $ValidatedDeletions) {
                if ($Item.mapEntryExists) {
                    $IdMap.records.PSObject.Properties.Remove([string]$Item.path)
                    $RemovedMapEntries++
                }
            }

            $TempIdMap = Join-Path `
                (Split-Path -Parent $IdMapPath) `
                ("opac-id-map.delete-" + $PID + ".json")

            try {
                $Json = $IdMap | ConvertTo-Json -Depth 100
                $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

                [System.IO.File]::WriteAllText(
                    $TempIdMap,
                    $Json + [Environment]::NewLine,
                    $Utf8NoBom
                )

                $TestMap = Get-Content -LiteralPath $TempIdMap -Raw -Encoding UTF8 |
                    ConvertFrom-Json

                $ExpectedCount = $BeforeCount - $RemovedMapEntries

                if (@($TestMap.records.PSObject.Properties).Count -ne $ExpectedCount) {
                    throw "削除後のIDマップ件数が想定と一致しません"
                }

                foreach ($Item in $ValidatedDeletions) {
                    if ($null -ne $TestMap.records.PSObject.Properties[[string]$Item.path]) {
                        throw "削除対象パスがIDマップに残っています: $($Item.path)"
                    }

                    $SameIdAfter = @(
                        $TestMap.records.PSObject.Properties |
                            Where-Object { [string]$_.Value -eq [string]$Item.opacId }
                    )

                    if ($SameIdAfter.Count -gt 0) {
                        throw "削除対象OPAC_IDがIDマップに残っています: $($Item.opacId)"
                    }
                }

                Move-Item -LiteralPath $TempIdMap -Destination $IdMapPath -Force
            }
            catch {
                if (Test-Path -LiteralPath $TempIdMap) {
                    Remove-Item -LiteralPath $TempIdMap -Force
                }

                Copy-Item -LiteralPath $BackupIdMap -Destination $IdMapPath -Force
                throw
            }

            if ($RemovedMapEntries -gt 0) {
                $IdMapChanged = $true
            }

            $ApprovedDeletionCount = $ValidatedDeletions.Count

            Write-Log ""
            Write-Log "DELETIONS_APPROVED=$ApprovedDeletionCount"
            Write-Log "ID_MAP_ENTRIES_REMOVED=$RemovedMapEntries"
            Write-Log "ID_MAP_BACKUP=$BackupIdMap"
        }
    }

    if (($ApplyRenameCandidates -or $DailyUpdate) -and $RenameCandidates.Count -gt 0) {
        $ValidatedRenames = New-Object System.Collections.Generic.List[object]
        $AlreadyMigratedRenames = New-Object System.Collections.Generic.List[object]

        foreach ($Item in $RenameCandidates) {
            $OldProperty = $IdMap.records.PSObject.Properties[$Item.from]
            $NewProperty = $IdMap.records.PSObject.Properties[$Item.to]

            $OldPrefix = if ($Item.from.StartsWith("11 著者/")) { "A" } else { "B" }
            $NewPrefix = if ($Item.to.StartsWith("11 著者/")) { "A" } else { "B" }

            if ($OldPrefix -ne $NewPrefix) {
                Stop-WithLog "RENAME_APPLY" "書籍と著者をまたぐ移動はできません"
                exit 3
            }

            if ([string]$Item.opacId -notmatch "^$OldPrefix\d+$") {
                Stop-WithLog "RENAME_APPLY" "OPAC_IDの種別がパスと一致しません: $($Item.opacId)"
                exit 3
            }

            # 初回状態:
            # 旧パスに期待するIDがあり、新パスにはまだIDがない。
            if ($null -ne $OldProperty -and
                [string]$OldProperty.Value -eq [string]$Item.opacId -and
                $null -eq $NewProperty) {

                Write-Log ""
                Write-Log "改名・移動候補"
                Write-Log "OPAC_ID=$($Item.opacId)"
                Write-Log "旧: $($Item.from)"
                Write-Log "新: $($Item.to)"

                $Answer = Read-Host "このIDを新パスへ引き継ぎますか？ [Y/N]"

                if ($Answer -notmatch '^[Yy]$') {
                    Stop-WithLog "RENAME_CONFIRMATION" "利用者がID引継ぎを承認しなかったため停止しました"
                    exit 4
                }

                $ValidatedRenames.Add($Item)
                continue
            }

            # 再開可能状態:
            # 旧パスのIDは既に消え、新パスに期待する同じIDがある。
            if ($null -eq $OldProperty -and
                $null -ne $NewProperty -and
                [string]$NewProperty.Value -eq [string]$Item.opacId) {

                Write-Log ""
                Write-Log "改名・移動のID引継ぎは既に完了しています"
                Write-Log "OPAC_ID=$($Item.opacId)"
                Write-Log "旧: $($Item.from)"
                Write-Log "新: $($Item.to)"

                $AlreadyMigratedRenames.Add($Item)
                continue
            }

            # 上記以外は、二重登録・ID不一致・欠落などの異常状態。
            $OldValue = if ($null -eq $OldProperty) {
                "<none>"
            }
            else {
                [string]$OldProperty.Value
            }

            $NewValue = if ($null -eq $NewProperty) {
                "<none>"
            }
            else {
                [string]$NewProperty.Value
            }

            Stop-WithLog `
                "RENAME_APPLY" `
                "改名・移動候補のID状態が想定外です: OLD_ID=$OldValue NEW_ID=$NewValue FROM=$($Item.from) TO=$($Item.to)"
            exit 3
        }

        if ($ValidatedRenames.Count -gt 0) {
            $BackupRoot = Join-Path $env:LOCALAPPDATA "PukoUpdate\backups\$Stamp"
            New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null

            $BackupIdMap = Join-Path $BackupRoot (Split-Path -Leaf $IdMapPath)
            Copy-Item -LiteralPath $IdMapPath -Destination $BackupIdMap

            $BeforeCount = @($IdMap.records.PSObject.Properties).Count

            foreach ($Item in $ValidatedRenames) {
                $IdMap.records.PSObject.Properties.Remove($Item.from)
                $IdMap.records | Add-Member `
                    -NotePropertyName $Item.to `
                    -NotePropertyValue $Item.opacId
            }

            $TempIdMap = Join-Path `
                (Split-Path -Parent $IdMapPath) `
                ("opac-id-map.update-" + $PID + ".json")

            try {
                $Json = $IdMap | ConvertTo-Json -Depth 100
                $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

                [System.IO.File]::WriteAllText(
                    $TempIdMap,
                    $Json + [Environment]::NewLine,
                    $Utf8NoBom
                )

                $TestMap = Get-Content -LiteralPath $TempIdMap -Raw -Encoding UTF8 |
                    ConvertFrom-Json

                if (@($TestMap.records.PSObject.Properties).Count -ne $BeforeCount) {
                    throw "IDマップの件数が変化しました"
                }

                foreach ($Item in $ValidatedRenames) {
                    if ($null -ne $TestMap.records.PSObject.Properties[$Item.from]) {
                        throw "旧パスがIDマップに残っています: $($Item.from)"
                    }

                    $TestNewProperty =
                        $TestMap.records.PSObject.Properties[$Item.to]

                    if ($null -eq $TestNewProperty -or
                        [string]$TestNewProperty.Value -ne [string]$Item.opacId) {
                        throw "新パスへのID引継ぎ検証に失敗しました: $($Item.to)"
                    }
                }

                Move-Item -LiteralPath $TempIdMap -Destination $IdMapPath -Force
            }
            catch {
                if (Test-Path -LiteralPath $TempIdMap) {
                    Remove-Item -LiteralPath $TempIdMap -Force
                }

                Copy-Item -LiteralPath $BackupIdMap -Destination $IdMapPath -Force
                throw
            }

            $IdMapChanged = $true

            Write-Log ""
            Write-Log "RENAMES_APPLIED=$($ValidatedRenames.Count)"
            Write-Log "ID_MAP_BACKUP=$BackupIdMap"
        }
        else {
            Write-Log ""
            Write-Log "RENAMES_APPLIED=0"
        }

        Write-Log "RENAMES_ALREADY_MIGRATED=$($AlreadyMigratedRenames.Count)"
    }
    if ($DailyUpdate) {
        $BuildScript = Join-Path $ProjectRoot "BuildPuko.ps1"
        $PlannerScript = Join-Path $ProjectRoot "tools\plan-puko-impact.mjs"
        $DailyContentOutput = Join-Path $ProjectRoot "content"

        if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
            throw "BuildPuko.ps1 が見つかりません: $BuildScript"
        }

        if (-not (Test-Path -LiteralPath $PlannerScript -PathType Leaf)) {
            throw "plan-puko-impact.mjs が見つかりません: $PlannerScript"
        }

        $BuildFingerprintInfo = Get-BuildFingerprint `
            -ProjectRoot $ProjectRoot

        $BuildStateStatus = Get-BuildStateStatus `
            -StatePath $BuildStatePath

        Write-Log ""
        Write-Log "=== BUILD MODE SELECTION ==="
        Write-Log "BUILD_STATE_PATH=$BuildStatePath"
        Write-Log "BUILD_FINGERPRINT=$($BuildFingerprintInfo.Fingerprint)"
        Write-Log "BUILD_STATE_STATUS=$($BuildStateStatus.Reason)"

        $BuildMode = "FULL"

        if ($ApprovedDeletionCount -gt 0) {
            $BuildStateReason = "APPROVED_DELETION_FULL_BUILD"
        }
        elseif ($ManagedDirtyAtStart) {
            $BuildStateReason = "MANAGED_DIRTY_AT_START"
        }
        elseif (-not (Test-Path -LiteralPath $DailyContentOutput -PathType Container)) {
            $BuildStateReason = "CONTENT_MISSING"
        }
        elseif (-not $BuildStateStatus.Valid) {
            $BuildStateReason = $BuildStateStatus.Reason
        }
        elseif (
            [string]$BuildStateStatus.State.fingerprint -ne
            [string]$BuildFingerprintInfo.Fingerprint
        ) {
            $BuildStateReason = "FINGERPRINT_MISMATCH"
        }
        else {
            $BuildStateReason = "FINGERPRINT_MATCH"

            Assert-SourceSnapshotUnchanged `
                -SourceRoot $SourceRoot `
                -Roots $Roots `
                -ExpectedRecords $Current

            $ImpactPlanPath = Join-Path `
                $env:TEMP `
                ("puko-impact-plan-" + $PID + "-" + $Stamp + ".json")

            if (Test-Path -LiteralPath $ImpactPlanPath) {
                Remove-Item -LiteralPath $ImpactPlanPath -Force
            }

            $NodeCommand = Get-Command node -ErrorAction SilentlyContinue

            if (-not $NodeCommand) {
                throw "impact planner実行に必要なNode.jsが見つかりません"
            }

            & $NodeCommand.Source `
                $PlannerScript `
                $SourceRoot `
                $DailyContentOutput `
                $BaselinePath `
                --json-out `
                $ImpactPlanPath

            if ($LASTEXITCODE -ne 0) {
                throw "impact planner の実行に失敗しました。Exit code: $LASTEXITCODE"
            }

            if (-not (Test-Path -LiteralPath $ImpactPlanPath -PathType Leaf)) {
                throw "impact planner JSON が生成されませんでした: $ImpactPlanPath"
            }

            try {
                $ImpactPlan = Get-Content `
                    -LiteralPath $ImpactPlanPath `
                    -Raw `
                    -Encoding UTF8 |
                    ConvertFrom-Json
            }
            catch {
                throw "impact planner JSON を読み取れません: $($_.Exception.Message)"
            }

            $RequiredPlanProperties = @(
                "version",
                "currentSource",
                "baseline",
                "write",
                "delete",
                "warnings",
                "fullBuildRecommended",
                "status"
            )

            foreach ($PropertyName in $RequiredPlanProperties) {
                if (
                    -not (
                        $ImpactPlan.PSObject.Properties.Name `
                            -contains $PropertyName
                    )
                ) {
                    throw "impact planner JSON に必須項目がありません: $PropertyName"
                }
            }

            if ([int]$ImpactPlan.version -ne 1) {
                throw "impact planner JSON のversionが不正です: $($ImpactPlan.version)"
            }

            if ([int]$ImpactPlan.currentSource -ne $Current.Count) {
                throw "impact plannerとDailyUpdateの原典件数が一致しません: PLANNER=$($ImpactPlan.currentSource) DAILY=$($Current.Count)"
            }

            if ([int]$ImpactPlan.baseline -ne $Previous.Count) {
                throw "impact plannerとDailyUpdateのbaseline件数が一致しません: PLANNER=$($ImpactPlan.baseline) DAILY=$($Previous.Count)"
            }

            Assert-SourceSnapshotUnchanged `
                -SourceRoot $SourceRoot `
                -Roots $Roots `
                -ExpectedRecords $Current

            $PlanWarnings = @($ImpactPlan.warnings)
            $PlanWrite = @($ImpactPlan.write)
            $PlanDelete = @($ImpactPlan.delete)
            $PlanStatus = [string]$ImpactPlan.status
            $PlanFullRecommended = [bool]$ImpactPlan.fullBuildRecommended

            Write-Log "PLAN_STATUS=$PlanStatus"
            Write-Log "PLAN_WARNINGS=$($PlanWarnings.Count)"
            Write-Log "PLAN_WRITE=$($PlanWrite.Count)"
            Write-Log "PLAN_DELETE=$($PlanDelete.Count)"
            Write-Log "PLAN_FULL_BUILD_RECOMMENDED=$PlanFullRecommended"

            if (
                $PlanStatus -eq "DIFF_PLAN_OK" -and
                $PlanWarnings.Count -eq 0 -and
                -not $PlanFullRecommended
            ) {
                $BuildMode = "DIFF"
                $BuildStateReason = "FINGERPRINT_MATCH_DIFF_PLAN_OK"
            }
            elseif (
                $PlanStatus -eq "FULL_BUILD" -or
                $PlanFullRecommended -or
                (
                    $PlanStatus -eq "DIFF_PLAN_OK" -and
                    $PlanWarnings.Count -gt 0
                )
            ) {
                $BuildMode = "FULL"

                if ($PlanWarnings.Count -gt 0) {
                    $BuildStateReason = "PLANNER_WARNINGS"
                }
                else {
                    $BuildStateReason = "PLANNER_FULL_BUILD"
                }
            }
            else {
                Stop-WithLog `
                    "IMPACT_PLANNER" `
                    "impact plannerが自動Build可能な状態を返しませんでした: STATUS=$PlanStatus WARNINGS=$($PlanWarnings.Count)"
                exit 12
            }
        }

        $IdMapHashBeforeDaily = (
            Get-FileHash -LiteralPath $IdMapPath -Algorithm SHA256
        ).Hash

        Write-Log "BUILD_MODE=$BuildMode"
        Write-Log "BUILD_STATE_REASON=$BuildStateReason"
        Write-Log ""
        Write-Log "=== DAILY PUBLISH BUILD ==="
        Write-Log "CONTENT_OUTPUT=$DailyContentOutput"
        Write-Log "PUBLISH_BUILD_STARTED=True"

        try {
            if ($BuildMode -eq "DIFF") {
                & $BuildScript `
                    -SourceRoot $SourceRoot `
                    -OutputRoot $DailyContentOutput `
                    -IdMapPath $IdMapPath `
                    -TargetsFile $ImpactPlanPath `
                    -Publish
            }
            elseif ($BuildMode -eq "FULL") {
                & $BuildScript `
                    -SourceRoot $SourceRoot `
                    -OutputRoot $DailyContentOutput `
                    -IdMapPath $IdMapPath `
                    -Publish
            }
            else {
                throw "未定義のBuild modeです: $BuildMode"
            }
        }
        finally {
            if (
                $ImpactPlanPath -and
                (Test-Path -LiteralPath $ImpactPlanPath)
            ) {
                Remove-Item -LiteralPath $ImpactPlanPath -Force
            }
        }

        $PublishBuilt = $true
        Write-Log "PUBLISH_BUILD_SUCCEEDED=True"

        Write-Log ""
        Write-Log "=== SOURCE SNAPSHOT RECHECK ==="

        Assert-SourceSnapshotUnchanged `
            -SourceRoot $SourceRoot `
            -Roots $Roots `
            -ExpectedRecords $Current

        Write-Log "SOURCE_SNAPSHOT_UNCHANGED=True"

        $IdMap = Get-Content `
            -LiteralPath $IdMapPath `
            -Raw `
            -Encoding UTF8 |
            ConvertFrom-Json

        if ($IdMap.version -ne 1 -or $null -eq $IdMap.records) {
            throw "Build後のIDマップ形式が不正です"
        }

        $IdMapCountAfterBuild = @(
            $IdMap.records.PSObject.Properties
        ).Count

        if ($IdMapCountAfterBuild -ne $Current.Count) {
            throw "Build後のIDマップ件数が原典件数と一致しません: ID=$IdMapCountAfterBuild SOURCE=$($Current.Count)"
        }

        $IdMapHashAfterDaily = (
            Get-FileHash -LiteralPath $IdMapPath -Algorithm SHA256
        ).Hash

        if ($IdMapHashBeforeDaily -ne $IdMapHashAfterDaily) {
            $IdMapChanged = $true
        }

        Write-Log "ID_MAP_AFTER_BUILD=$IdMapCountAfterBuild"

        # Buildによって許可範囲外の追跡済みファイルが
        # 変更されていないことを再確認する。
        & $GitCommand.Source -C $ProjectRoot diff --cached --quiet
        $PostBuildStagedExit = $LASTEXITCODE

        if ($PostBuildStagedExit -eq 1) {
            throw "Build中に予期しないstage済み変更が発生しました"
        }
        elseif ($PostBuildStagedExit -ne 0) {
            throw "Build後のGit index確認に失敗しました"
        }

        & $GitCommand.Source `
            -C $ProjectRoot `
            diff --quiet -- . `
            ':(exclude)content/**' `
            ':(exclude)data/opac-id-map.json'

        $PostBuildOutsideExit = $LASTEXITCODE

        if ($PostBuildOutsideExit -eq 1) {
            throw "Build中にcontentとIDマップ以外の追跡済みファイルが変更されました"
        }
        elseif ($PostBuildOutsideExit -ne 0) {
            throw "Build後のGit差分確認に失敗しました"
        }

        $ManagedStatus = @(
            & $GitCommand.Source `
                -C $ProjectRoot `
                -c core.quotepath=false `
                status --porcelain=v1 --untracked-files=all -- `
                content `
                data/opac-id-map.json
        )

        if ($LASTEXITCODE -ne 0) {
            throw "公開対象のGit status取得に失敗しました"
        }

        $ContentChanged = ($ManagedStatus.Count -gt 0)
        $GitAuditPassed = $true

        Write-Log ""
        Write-Log "=== DAILY GIT AUDIT ==="
        Write-Log "MANAGED_GIT_CHANGES=$($ManagedStatus.Count)"
        Write-Log "GIT_WHITELIST_AUDIT=PASS"

        if ($ResumePendingPush) {
            if ($ContentChanged) {
                throw "未push commit作成後に原典または生成結果が変化しています。自動再開しません。"
            }

            Write-Log ""
            Write-Log "=== PENDING PUSH RECOVERY ==="

            $PendingCommitHash = (
                & $GitCommand.Source -C $ProjectRoot rev-parse HEAD |
                Out-String
            ).Trim()

            Write-Log "PENDING_COMMIT=$PendingCommitHash"

            Push-MainAndVerify `
                -GitCommand $GitCommand `
                -ProjectRoot $ProjectRoot

            $Pushed = $true
            Write-Log "PENDING_PUSH_RECOVERED=True"
        }
        elseif ($ContentChanged) {
            Write-Log ""
            Write-Log "=== GIT STAGE ==="

            & $GitCommand.Source `
                -C $ProjectRoot `
                add -A -- `
                content `
                data/opac-id-map.json

            if ($LASTEXITCODE -ne 0) {
                throw "Git stage に失敗しました"
            }

            $GitStageCreated = $true

            # stage済み範囲がcontentとIDマップだけかGit自身に確認させる。
            & $GitCommand.Source `
                -C $ProjectRoot `
                diff --cached --quiet -- . `
                ':(exclude)content/**' `
                ':(exclude)data/opac-id-map.json'

            $UnexpectedStageExit = $LASTEXITCODE

            if ($UnexpectedStageExit -eq 1) {
                throw "許可範囲外のファイルがstageされています"
            }
            elseif ($UnexpectedStageExit -ne 0) {
                throw "stage範囲の検証に失敗しました"
            }

            & $GitCommand.Source `
                -C $ProjectRoot `
                diff --cached --quiet -- `
                content `
                data/opac-id-map.json

            $ManagedStageExit = $LASTEXITCODE

            if ($ManagedStageExit -eq 0) {
                throw "Git statusには変更がありますがstage差分がありません"
            }
            elseif ($ManagedStageExit -ne 1) {
                throw "stage済み差分の確認に失敗しました"
            }

            $StagedNames = @(
                & $GitCommand.Source `
                    -C $ProjectRoot `
                    -c core.quotepath=false `
                    diff --cached --name-only -- `
                    content `
                    data/opac-id-map.json
            )

            Write-Log "STAGED_FILES=$($StagedNames.Count)"

            if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
                $CommitMessage = "Update OPAC " + (Get-Date -Format "yyyy-MM-dd HH:mm")
            }

            Write-Log ""
            Write-Log "=== GIT COMMIT ==="
            Write-Log "COMMIT_MESSAGE=$CommitMessage"

            & $GitCommand.Source `
                -C $ProjectRoot `
                commit -m $CommitMessage

            if ($LASTEXITCODE -ne 0) {
                throw "Git commit に失敗しました"
            }

            $GitCommitCreated = $true

            $CommitHash = (
                & $GitCommand.Source -C $ProjectRoot rev-parse HEAD |
                Out-String
            ).Trim()

            Write-Log "COMMIT=$CommitHash"

            Push-MainAndVerify `
                -GitCommand $GitCommand `
                -ProjectRoot $ProjectRoot

            $Pushed = $true
        }
        else {
            Write-Log ""
            Write-Log "Git公開差分はありません。commit/pushは不要です。"
        }

        # push中に原典が編集されていないことを最後にもう一度確認する。
        Write-Log ""
        Write-Log "=== FINAL SOURCE SNAPSHOT RECHECK ==="

        Assert-SourceSnapshotUnchanged `
            -SourceRoot $SourceRoot `
            -Roots $Roots `
            -ExpectedRecords $Current

        Write-Log "FINAL_SOURCE_SNAPSHOT_UNCHANGED=True"

        $FinalBuildFingerprintInfo = Get-BuildFingerprint `
            -ProjectRoot $ProjectRoot

        if (
            [string]$FinalBuildFingerprintInfo.Fingerprint -ne
            [string]$BuildFingerprintInfo.Fingerprint
        ) {
            throw "DailyUpdate中にbuild fingerprint対象が変更されました。baseline/build stateは更新しません。"
        }

        Write-Log "FINAL_BUILD_FINGERPRINT_UNCHANGED=True"

        # Build後に再読込した最新IDマップを使い、
        # 公開成功後の状態だけを次回基準表として保存する。
        $BaselineResult = Write-SourceBaseline `
            -CurrentRecords $Current `
            -CurrentIdMap $IdMap

        $BaselineChanged = $true

        $BuildStateBackupRoot = Join-Path `
            $env:LOCALAPPDATA `
            "PukoUpdate\backups\$Stamp"

        $FailureStage = "BUILD_STATE_UPDATE"
        $BuildStateUpdateStarted = $true
        Write-Log "BUILD_STATE_UPDATE_STARTED=True"
        Write-Log "PUSHED=$Pushed"
        Write-Log "BASELINE_CHANGED=$BaselineChanged"

        $BuildStateResult = Write-BuildState `
            -StatePath $BuildStatePath `
            -FingerprintInfo $FinalBuildFingerprintInfo `
            -BackupRoot $BuildStateBackupRoot

        $BuildStateChanged = $true
        Write-Log "BUILD_STATE_UPDATED=True"
        $FailureStage = "FINAL_RESULT"

        Write-Log "BUILD_STATE_SAVED=True"
        Write-Log "BUILD_STATE_SAVED_PATH=$($BuildStateResult.Path)"
        if ($BuildStateResult.Backup) {
            Write-Log "BUILD_STATE_BACKUP=$($BuildStateResult.Backup)"
        }

        Write-Log ""
        Write-Log "=== DAILY UPDATE RESULT ==="
        Write-Log "RESULT=SUCCESS"
        Write-Log "SOURCE_CHANGED=$SourceChanged"
        Write-Log "ID_MAP_CHANGED=$IdMapChanged"
        Write-Log "BASELINE_CHANGED=$BaselineChanged"
        Write-Log "PUBLISH_BUILD_SUCCEEDED=$PublishBuilt"
        Write-Log "CONTENT_CHANGED=$ContentChanged"
        Write-Log "BUILD_MODE=$BuildMode"
        Write-Log "BUILD_STATE_REASON=$BuildStateReason"
        Write-Log "BUILD_STATE_CHANGED=$BuildStateChanged"
        Write-Log "GIT_AUDIT_PASSED=$GitAuditPassed"
        Write-Log "GIT_COMMIT_CREATED=$GitCommitCreated"
        Write-Log "PUSHED=$Pushed"
        Write-Log "BASELINE_RECORDS=$($BaselineResult.Count)"
        Write-Log "BASELINE_BACKUP=$($BaselineResult.Backup)"
        Write-Log ""
        Write-Log "ぷ庫OPACの日常更新が正常に完了しました。"
        Write-Log "LOG=$LogPath"

        exit 0
    }

    if ($RunPreviewBuild) {
        $BuildScript = Join-Path $ProjectRoot "BuildPuko.ps1"

        if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
            throw "BuildPuko.ps1 が見つかりません: $BuildScript"
        }

        if (-not $PreviewOutputRoot) {
            $PreviewOutputRoot = Join-Path $ProjectRoot "content-preview"
        }

        Write-Log ""
        Write-Log "=== PREVIEW BUILD ==="
        Write-Log "PREVIEW_OUTPUT=$PreviewOutputRoot"
        Write-Log "PREVIEW_BUILD_STARTED=True"

        & $BuildScript `
            -SourceRoot $SourceRoot `
            -OutputRoot $PreviewOutputRoot `
            -IdMapPath $IdMapPath

        $PreviewBuilt = $true

        Write-Log "PREVIEW_BUILD_SUCCEEDED=True"
    }

    if ($RunPublishBuild) {
        if (-not $RunPreviewBuild) {
            throw "正式Buildには同一実行内のpreview Buildが必要です。-RunPreviewBuild も指定してください。"
        }

        $BuildScript = Join-Path $ProjectRoot "BuildPuko.ps1"

        if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
            throw "BuildPuko.ps1 が見つかりません: $BuildScript"
        }

        if (-not $ContentOutputRoot) {
            $ContentOutputRoot = Join-Path $ProjectRoot "content"
        }

        Write-Log ""
        Write-Log "=== PUBLISH BUILD ==="
        Write-Log "CONTENT_OUTPUT=$ContentOutputRoot"
        Write-Log "PUBLISH_BUILD_STARTED=True"

        & $BuildScript `
            -SourceRoot $SourceRoot `
            -OutputRoot $ContentOutputRoot `
            -IdMapPath $IdMapPath `
            -Publish

        $PublishBuilt = $true
        Write-Log "PUBLISH_BUILD_SUCCEEDED=True"

        Write-Log ""
        Write-Log "=== PREVIEW / CONTENT EXACT COMPARE ==="

        $PreviewMap = Get-TreeHashMap -Root $PreviewOutputRoot
        $ContentMap = Get-TreeHashMap -Root $ContentOutputRoot

        $AllPaths = @(
            $PreviewMap.Keys
            $ContentMap.Keys
        ) | Sort-Object -Unique

        $OnlyPreview = @(
            $AllPaths | Where-Object {
                $PreviewMap.ContainsKey($_) -and
                -not $ContentMap.ContainsKey($_)
            }
        )

        $OnlyContent = @(
            $AllPaths | Where-Object {
                $ContentMap.ContainsKey($_) -and
                -not $PreviewMap.ContainsKey($_)
            }
        )

        $HashMismatch = @(
            $AllPaths | Where-Object {
                $PreviewMap.ContainsKey($_) -and
                $ContentMap.ContainsKey($_) -and
                $PreviewMap[$_] -ne $ContentMap[$_]
            }
        )

        Write-Log "PREVIEW_FILES=$($PreviewMap.Count)"
        Write-Log "CONTENT_FILES=$($ContentMap.Count)"
        Write-Log "ONLY_PREVIEW=$($OnlyPreview.Count)"
        Write-Log "ONLY_CONTENT=$($OnlyContent.Count)"
        Write-Log "HASH_MISMATCH=$($HashMismatch.Count)"

        if (
            $OnlyPreview.Count -gt 0 -or
            $OnlyContent.Count -gt 0 -or
            $HashMismatch.Count -gt 0
        ) {
            if ($OnlyPreview.Count -gt 0) {
                Write-Log "--- ONLY PREVIEW ---"
                $OnlyPreview |
                    Select-Object -First 20 |
                    ForEach-Object { Write-Log $_ }
            }

            if ($OnlyContent.Count -gt 0) {
                Write-Log "--- ONLY CONTENT ---"
                $OnlyContent |
                    Select-Object -First 20 |
                    ForEach-Object { Write-Log $_ }
            }

            if ($HashMismatch.Count -gt 0) {
                Write-Log "--- HASH MISMATCH ---"
                $HashMismatch |
                    Select-Object -First 20 |
                    ForEach-Object { Write-Log $_ }
            }

            throw "preview と content が完全一致しません"
        }

        $TreesIdentical = $true
        Write-Log "TREES_IDENTICAL=True"
    }

    if ($RunGitAudit) {
        Write-Log ""
        Write-Log "=== GIT WHITELIST AUDIT ==="

        $GitCommand = Get-Command git -ErrorAction SilentlyContinue
        if (-not $GitCommand) {
            throw "Git が見つかりません"
        }

        & $GitCommand.Source -C $ProjectRoot rev-parse --is-inside-work-tree *> $null
        if ($LASTEXITCODE -ne 0) {
            throw "プロジェクトフォルダがGit作業ツリーではありません: $ProjectRoot"
        }

        $AllowedExact = @(
            "BuildPuko.ps1",
            "UpdatePuko.ps1",
            "tools/build-puko.mjs",
            "data/opac-id-map.json",
            "data/opac-source-state.json"
        )

        $AllowedPrefix = @(
            "content/"
        )

        $StatusLines = @(
            & $GitCommand.Source `
                -C $ProjectRoot `
                -c core.quotepath=false `
                status --porcelain=v1
        )

        if ($LASTEXITCODE -ne 0) {
            throw "git status の取得に失敗しました"
        }

        $AllowedChanges = New-Object System.Collections.Generic.List[string]
        $IgnoredUntracked = New-Object System.Collections.Generic.List[string]
        $BlockedChanges = New-Object System.Collections.Generic.List[string]
        $ContentChanges = New-Object System.Collections.Generic.List[string]

        foreach ($Line in $StatusLines) {
            if ([string]::IsNullOrWhiteSpace($Line) -or $Line.Length -lt 4) {
                continue
            }

            $Code = $Line.Substring(0, 2)
            $RawPath = $Line.Substring(3).Trim()

            # rename表記の場合は旧・新の両方を検査する。
            $Paths = @($RawPath)
            if ($RawPath.Contains(" -> ")) {
                $Paths = @($RawPath -split ' -> ', 2)
            }

            $AllAllowed = $true

            foreach ($StatusPath in $Paths) {
                $Allowed = ($AllowedExact -contains $StatusPath)

                if (-not $Allowed) {
                    foreach ($Prefix in $AllowedPrefix) {
                        if ($StatusPath.StartsWith($Prefix)) {
                            $Allowed = $true
                            break
                        }
                    }
                }

                if (-not $Allowed) {
                    $AllAllowed = $false
                }
            }

            if ($AllAllowed) {
                $AllowedChanges.Add("$Code $RawPath")

                if (
                    @($Paths | Where-Object { $_.StartsWith("content/") }).Count -gt 0
                ) {
                    $ContentChanges.Add("$Code $RawPath")
                }
            }
            elseif ($Code -eq "??") {
                # コミット対象外の未追跡ファイルは無視する。
                $IgnoredUntracked.Add("$Code $RawPath")
            }
            else {
                # 追跡済みの想定外変更は自動更新を停止する。
                $BlockedChanges.Add("$Code $RawPath")
            }
        }

        Write-Log "ALLOWED_CHANGES=$($AllowedChanges.Count)"
        Write-Log "BLOCKED_TRACKED_CHANGES=$($BlockedChanges.Count)"
        Write-Log "IGNORED_UNTRACKED=$($IgnoredUntracked.Count)"
        Write-Log "CONTENT_GIT_CHANGES=$($ContentChanges.Count)"

        if ($AllowedChanges.Count -gt 0) {
            Write-Log ""
            Write-Log "--- ALLOWED GIT CHANGES ---"
            foreach ($Item in $AllowedChanges) {
                Write-Log $Item
            }
        }

        if ($BlockedChanges.Count -gt 0) {
            Write-Log ""
            Write-Log "--- BLOCKED TRACKED CHANGES ---"

            $BlockedChanges |
                Select-Object -First 20 |
                ForEach-Object { Write-Log $_ }

            throw "Gitに想定外の追跡済み変更があります。自動処理を停止しました。"
        }

        $ContentChanged = ($ContentChanges.Count -gt 0)
        $GitAuditPassed = $true

        Write-Log "GIT_WHITELIST_AUDIT=PASS"
    }

    if ($TestBaselineUpdate) {
        $BaselineResult = Write-SourceBaseline `
            -CurrentRecords $Current `
            -CurrentIdMap $IdMap

        $BaselineChanged = $true

        Write-Log ""
        Write-Log "BASELINE_TEST_UPDATE=True"
        Write-Log "BASELINE_RECORDS=$($BaselineResult.Count)"
        Write-Log "BASELINE_BACKUP=$($BaselineResult.Backup)"
    }

    Write-Log ""
    Write-Log "RESULT=READY"
    Write-Log "STAGE=CHANGE_DETECTION"
    Write-Log "SOURCE_CHANGED=$SourceChanged"
    Write-Log "ID_MAP_CHANGED=$IdMapChanged"
    Write-Log "BASELINE_CHANGED=$BaselineChanged"
    Write-Log "PREVIEW_BUILD_SUCCEEDED=$PreviewBuilt"
    Write-Log "PUBLISH_BUILD_SUCCEEDED=$PublishBuilt"
    Write-Log "TREES_IDENTICAL=$TreesIdentical"
    Write-Log "CONTENT_CHANGED=$ContentChanged"
    Write-Log "GIT_AUDIT_PASSED=$GitAuditPassed"
    Write-Log "GIT_COMMIT_CREATED=False"
    Write-Log "PUSHED=False"
    Write-Log ""
    if ($IdMapChanged -and $BaselineChanged) {
        Write-Log "IDマップと基準表を更新しました。"
        Write-Log "原典ファイル自体は変更していません。"
    }
    elseif ($IdMapChanged) {
        Write-Log "改名・移動確認によりIDマップを更新しました。"
        Write-Log "原典ファイル自体は変更していません。"
    }
    elseif ($BaselineChanged) {
        Write-Log "基準表を現在の原典・IDマップ状態へ更新しました。"
        Write-Log "原典ファイルとIDマップは変更していません。"
    }
    elseif ($PublishBuilt -and $TreesIdentical) {
        Write-Log "preview Buildと正式content Buildを生成し、完全一致を確認しました。"
        Write-Log "原典ファイル自体は変更していません。"
    }
    elseif ($PreviewBuilt) {
        Write-Log "preview Buildを生成しました。"
        Write-Log "原典ファイルとIDマップは変更していません。"
    }
    else {
        Write-Log "現在の版では検査だけを行いました。データファイルは変更していません。"
    }
    Write-Log "LOG=$LogPath"
}
catch {
    if (
        $ImpactPlanPath -and
        (Test-Path -LiteralPath $ImpactPlanPath)
    ) {
        Remove-Item `
            -LiteralPath $ImpactPlanPath `
            -Force `
            -ErrorAction SilentlyContinue
    }

    if ($DailyUpdate -and $GitStageCreated -and -not $GitCommitCreated) {
        $CleanupGit = Get-Command git -ErrorAction SilentlyContinue

        if ($CleanupGit) {
            & $CleanupGit.Source `
                -C $ProjectRoot `
                reset -q HEAD -- `
                content `
                data/opac-id-map.json *> $null
        }
    }

    Write-Log ""
    Write-Log "RESULT=STOP"
    Write-Log "STAGE=$FailureStage"
    Write-Log "REASON=$($_.Exception.Message)"
    Write-Log "SOURCE_CHANGED=$SourceChanged"
    Write-Log "ID_MAP_CHANGED=$IdMapChanged"
    Write-Log "BASELINE_CHANGED=$BaselineChanged"
    Write-Log "CONTENT_CHANGED=$ContentChanged"
    Write-Log "BUILD_MODE=$BuildMode"
    Write-Log "BUILD_STATE_REASON=$BuildStateReason"
    Write-Log "BUILD_STATE_UPDATE_STARTED=$BuildStateUpdateStarted"
    Write-Log "BUILD_STATE_UPDATED=$BuildStateChanged"
    Write-Log "BUILD_STATE_CHANGED=$BuildStateChanged"
    Write-Log "GIT_AUDIT_PASSED=$GitAuditPassed"
    Write-Log "GIT_COMMIT_CREATED=$GitCommitCreated"
    Write-Log "PUSHED=$Pushed"
    Write-Log ""
    Write-Log "予期しないエラーで停止しました。"
    Write-Log "このログをChatGPTに渡して確認してください。"
    Write-Log "LOG=$LogPath"
    exit 99
}
