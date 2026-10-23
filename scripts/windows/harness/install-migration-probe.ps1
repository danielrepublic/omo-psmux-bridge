# install-migration-probe.ps1 -- exercises ONLY the rename/upgrade functions of
# install.ps1, without running the installer or writing the user PATH.
#
# WHY THIS SHAPE. install.ps1's main body writes HKCU\Environment, so it cannot be
# executed in a regression test. The upgrade decisions, though, are pure:
#
#   * which PATH entries are foreign (and must still be refused);
#   * how the old opencode-psmux-bridge entry is replaced by the new
#     omo-psmux-bridge entry without duplicates;
#   * whether legacy state files are copied without overwriting or deleting.
#
# The probe parses install.ps1 with the PowerShell AST, compiles only those named
# functions, and calls them against sandbox data. If a function is renamed or
# deleted the extraction fails loudly rather than passing vacuously.
#
# The cases that matter:
#   * the shipped upgrade put the legacy entry FIRST; the new entry must still
#     be first and there must be exactly one owner;
#   * a legacy entry that a user moved is removed too, and the new entry still
#     becomes first rather than being appended;
#   * every unrelated bridge bin directory is still refused;
#   * state is copied on first upgrade, existing new-root state wins, the old
#     tree is never modified, and a second run is a no-op.
param(
    [string] $InstallPs1 = '',
    [string] $WorkDir = ''
)
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($WorkDir)) { $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ('omo-install-migration-probe-' + [Guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$report = Join-Path $WorkDir 'install-migration-report.txt'
$log = New-Object System.Collections.Generic.List[string]
$script:Pass = 0
$script:Fail = 0

function Say { param([string] $Text) $log.Add($Text) }
function Sep { param([char] $Char = '=') Say ((' ' * 78).Replace(' ', $Char)) }
function Save-Report { [System.IO.File]::WriteAllText($report, ($log -join "`r`n") + "`r`n") }
function Assert {
    param([bool] $Ok, [string] $Name, [string] $Detail = '')
    if ($Ok) { $script:Pass++ } else { $script:Fail++ }
    Say ('  ASSERT ' + $(if ($Ok) { 'PASS' } else { 'FAIL' }) + '  ' + $Name + $(if ($Detail -ne '') { '  [' + $Detail + ']' } else { '' }))
}
trap {
    Say ('PROBE-ERROR: ' + $_.Exception.GetType().FullName + ' :: ' + $_.Exception.Message)
    Say ('PROBE-ERROR at: ' + ($_.InvocationInfo.PositionMessage -replace '[^\x20-\x7E]', '?'))
    Say ('ASSERT TOTALS (at trap): pass=' + $script:Pass + ' fail=' + $script:Fail)
    Save-Report
    exit 3
}

# Copy-LegacyState reports failures through the installer's Write-Line. The
# probe supplies its own sink so the extracted function has no undeclared
# dependency and a failed copy is visible in the report instead of throwing a
# second, unrelated error.
function Write-Line { param([string] $Text) Say ('    ' + $Text) }

# --------------------------------------------------------------------------- AST extraction

function Get-TrustedFunctions {
    param([string] $Path, [string[]] $Names)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref] $tokens, [ref] $errors)
    if ($errors -and $errors.Count -gt 0) {
        throw ('parse failed in ' + $Path + ': ' + $errors[0].Message)
    }
    $defs = @()
    $nodes = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
    foreach ($want in $Names) {
        $hit = @($nodes | Where-Object { $_.Name -eq $want })
        if ($hit.Count -ne 1) { throw ('expected exactly one function named ' + $want + ', found ' + $hit.Count) }
        $defs += $hit[0].Extent.Text
    }
    return [pscustomobject]@{ Count = $defs.Count; Source = ($defs -join "`n") }
}

Sep '='
Say 'INSTALL MIGRATION PROBE (pure upgrade functions; installer main never compiled)'
$installFns = Get-TrustedFunctions -Path $InstallPs1 -Names @(
    'Test-BridgeBinEntry',
    'Get-SamePath',
    'Get-ForeignBridgeBinEntries',
    'Get-MigratedUserPath',
    'Copy-LegacyState'
)
Say ('  extracted from install.ps1: ' + $installFns.Count + ' functions')
Assert -Ok ($installFns.Count -eq 5) -Name 'install.ps1: the five migration functions were found by AST extraction'

. ([scriptblock]::Create($installFns.Source))
Assert -Ok ($null -ne (Get-Command Get-MigratedUserPath -ErrorAction SilentlyContinue)) -Name 'the extracted functions are callable in this scope'

# =========================================================================== PATH shape

Sep '-'
Say 'PATH: legacy entry replaced first, never duplicated'

$Root = 'C:\Users\Probe\AppData\Local'
$NewBin = $Root + '\omo-psmux-bridge\bin'
$OldBin = $Root + '\opencode-psmux-bridge\bin'
$Win = 'C:\Windows'
$Tools = 'C:\Tools'

function Check-Path {
    param(
        [string] $Label,
        [string[]] $Entries,
        [string] $ExpectJoined,
        [int] $ExpectLegacy,
        [int] $ExpectTargetDuplicates
    )
    $plan = Get-MigratedUserPath -Entries $Entries -Target $NewBin -LegacyTarget $OldBin
    $joined = (@($plan.Entries) -join '|')
    Assert -Ok ($joined -eq $ExpectJoined) -Name ('path: ' + $Label) -Detail ('got=' + $joined)
    Assert -Ok ($plan.LegacyReplaced -eq $ExpectLegacy) -Name ('path legacy-replaced: ' + $Label) -Detail ('got=' + $plan.LegacyReplaced)
    Assert -Ok ($plan.TargetDuplicatesRemoved -eq $ExpectTargetDuplicates) -Name ('path target-duplicates: ' + $Label) -Detail ('got=' + $plan.TargetDuplicatesRemoved)
}

Check-Path -Label 'shipped upgrade shape: legacy first' `
    -Entries @($OldBin, $Win, $Tools) `
    -ExpectJoined ($NewBin + '|' + $Win + '|' + $Tools) `
    -ExpectLegacy 1 -ExpectTargetDuplicates 0

Check-Path -Label 'legacy moved down: new is still first, other order preserved' `
    -Entries @($Win, $OldBin, $Tools) `
    -ExpectJoined ($NewBin + '|' + $Win + '|' + $Tools) `
    -ExpectLegacy 1 -ExpectTargetDuplicates 0

Check-Path -Label 'duplicate legacy and target entries collapse to one' `
    -Entries @($OldBin, $Win, $NewBin, $Tools, $OldBin) `
    -ExpectJoined ($NewBin + '|' + $Win + '|' + $Tools) `
    -ExpectLegacy 2 -ExpectTargetDuplicates 1

Check-Path -Label 'fresh install: only the new entry is added' `
    -Entries @($Win, $Tools) `
    -ExpectJoined ($NewBin + '|' + $Win + '|' + $Tools) `
    -ExpectLegacy 0 -ExpectTargetDuplicates 0

Check-Path -Label 'new already first plus a legacy straggler' `
    -Entries @($NewBin, $Win, $OldBin) `
    -ExpectJoined ($NewBin + '|' + $Win) `
    -ExpectLegacy 1 -ExpectTargetDuplicates 1

# =========================================================================== refusal

Sep '-'
Say 'REFUSAL: only the exact legacy default is an upgrade source'

$foreignCases = @(
    [pscustomobject]@{ Label = 'legacy default is allowed'; Entries = @($OldBin, $Win); Expected = @() }
    [pscustomobject]@{ Label = 'new target is allowed'; Entries = @($NewBin, $Win); Expected = @() }
    [pscustomobject]@{ Label = 'another profile legacy dir is foreign'; Entries = @('C:\Users\Other\AppData\Local\opencode-psmux-bridge\bin'); Expected = @('C:\Users\Other\AppData\Local\opencode-psmux-bridge\bin') }
    [pscustomobject]@{ Label = 'another profile new dir is foreign'; Entries = @('C:\Users\Other\AppData\Local\omo-psmux-bridge\bin'); Expected = @('C:\Users\Other\AppData\Local\omo-psmux-bridge\bin') }
    [pscustomobject]@{ Label = 'a hand-made bridge copy is foreign'; Entries = @('D:\tools\omo-psmux-bridge\bin'); Expected = @('D:\tools\omo-psmux-bridge\bin') }
    [pscustomobject]@{ Label = 'a name-prefixed directory is NOT bridge-owned'; Entries = @('D:\tools\not-omo-psmux-bridge\bin', 'D:\tools\omo-psmux-bridge\bin-extra'); Expected = @() }
)
foreach ($case in $foreignCases) {
    $got = @(Get-ForeignBridgeBinEntries -Entries $case.Entries -Target $NewBin -LegacyTarget $OldBin)
    $gotJoined = ($got -join '|')
    $wantJoined = (@($case.Expected) -join '|')
    Assert -Ok ($gotJoined -eq $wantJoined) -Name ('foreign: ' + $case.Label) -Detail ('got=' + $gotJoined + ' want=' + $wantJoined)
}

$custom = @(Get-ForeignBridgeBinEntries -Entries @($OldBin) -Target ('D:\custom\omo-psmux-bridge\bin') -LegacyTarget '')
Assert -Ok ($custom.Count -eq 1) -Name 'foreign: a custom target does NOT get the legacy-default exception' -Detail ('got=' + ($custom -join '|'))

# =========================================================================== state copy

Sep '-'
Say 'STATE: copy-if-absent, old tree untouched, second run is a no-op'

$stateRoot = Join-Path $WorkDir 'sandbox'
if (Test-Path -LiteralPath $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force }
$oldRoot = Join-Path $stateRoot 'opencode-psmux-bridge'
$newRoot = Join-Path $stateRoot 'omo-psmux-bridge'
$oldState = Join-Path $oldRoot 'state'
$oldBinState = Join-Path $oldRoot 'bin\state'
$newState = Join-Path $newRoot 'state'
$newBinState = Join-Path $newRoot 'bin\state'
New-Item -ItemType Directory -Force -Path $oldState, $oldBinState, $newState, $newBinState | Out-Null

$oldCollision = Join-Path $oldState 'pane-collision.jsonl'
$oldNewFile = Join-Path $oldState 'pane-legacy-only.jsonl'
$oldCallLog = Join-Path $oldBinState 'shim-calls.jsonl'
$newWins = Join-Path $newState 'pane-collision.jsonl'
$newOwn = Join-Path $newState 'pane-new-only.jsonl'
[System.IO.File]::WriteAllText($oldCollision, "old-collision`n")
[System.IO.File]::WriteAllText($oldNewFile, "old-legacy-only`n")
[System.IO.File]::WriteAllText($oldCallLog, "old-call-log`n")
[System.IO.File]::WriteAllText($newWins, "new-wins`n")
[System.IO.File]::WriteAllText($newOwn, "new-own`n")

$first = Copy-LegacyState -LegacyRoot $oldRoot -NewRoot $newRoot
Assert -Ok ($first.Copied -eq 2) -Name 'state: two legacy files copied on first upgrade' -Detail ('got=' + $first.Copied)
Assert -Ok ($first.Skipped -eq 1) -Name 'state: the colliding file is skipped, not overwritten' -Detail ('got=' + $first.Skipped)
Assert -Ok ($first.Failed -eq 0) -Name 'state: no copy failed' -Detail ('got=' + $first.Failed)

$collisionText = (Get-Content -LiteralPath $newWins -Raw)
$legacyOnlyText = (Get-Content -LiteralPath (Join-Path $newState 'pane-legacy-only.jsonl') -Raw)
$callLogText = (Get-Content -LiteralPath (Join-Path $newBinState 'shim-calls.jsonl') -Raw)
$newOwnText = (Get-Content -LiteralPath $newOwn -Raw)
Assert -Ok ($collisionText -eq "new-wins`n") -Name 'state: existing new-root file is preserved byte-for-byte' -Detail ('got=' + $collisionText.Trim())
Assert -Ok ($legacyOnlyText -eq "old-legacy-only`n") -Name 'state: missing legacy state is preserved' -Detail ('got=' + $legacyOnlyText.Trim())
Assert -Ok ($callLogText -eq "old-call-log`n") -Name 'state: legacy bin\state call log is preserved' -Detail ('got=' + $callLogText.Trim())
Assert -Ok ($newOwnText -eq "new-own`n") -Name 'state: unrelated new-root state is untouched' -Detail ('got=' + $newOwnText.Trim())

Assert -Ok ((Get-Content -LiteralPath $oldCollision -Raw) -eq "old-collision`n") -Name 'state: old colliding file is not modified'
Assert -Ok ((Get-Content -LiteralPath $oldNewFile -Raw) -eq "old-legacy-only`n") -Name 'state: old copied file is not moved or deleted'
Assert -Ok ((Get-Content -LiteralPath $oldCallLog -Raw) -eq "old-call-log`n") -Name 'state: old call log is not moved or deleted'

$second = Copy-LegacyState -LegacyRoot $oldRoot -NewRoot $newRoot
Assert -Ok ($second.Copied -eq 0) -Name 'state: a second run copies nothing'
Assert -Ok ($second.Skipped -eq 3) -Name 'state: a second run skips all three legacy files'
Assert -Ok ($second.Failed -eq 0) -Name 'state: a second run fails nothing'
Assert -Ok ((Get-Content -LiteralPath $oldCollision -Raw) -eq "old-collision`n") -Name 'state: a second run still leaves the old tree untouched'

$emptyOld = Join-Path $stateRoot 'empty-opencode-psmux-bridge'
$emptyNew = Join-Path $stateRoot 'empty-omo-psmux-bridge'
New-Item -ItemType Directory -Force -Path $emptyOld, $emptyNew | Out-Null
$none = Copy-LegacyState -LegacyRoot $emptyOld -NewRoot $emptyNew
Assert -Ok ($none.Copied -eq 0 -and $none.Skipped -eq 0 -and $none.Failed -eq 0) -Name 'state: a legacy root with no state directories is harmless'

$aliasParent = Join-Path $stateRoot 'alias-parent'
New-Item -ItemType Directory -Force -Path $aliasParent | Out-Null
$aliasOld = Join-Path $aliasParent '..\opencode-psmux-bridge'
$aliasNew = Join-Path $stateRoot 'alias-new'
$alias = Copy-LegacyState -LegacyRoot $aliasOld -NewRoot $aliasNew
Assert -Ok ($alias.Copied -eq 3 -and $alias.Failed -eq 0) -Name 'state: source aliases do not corrupt destination paths'
Assert -Ok ((Get-Content -LiteralPath (Join-Path $aliasNew 'state\pane-legacy-only.jsonl') -Raw) -eq "old-legacy-only`n") -Name 'state: aliased source preserves the relative filename'
Assert -Ok ((Get-Content -LiteralPath (Join-Path $aliasNew 'bin\state\shim-calls.jsonl') -Raw) -eq "old-call-log`n") -Name 'state: aliased source preserves bin state'

Remove-Item -LiteralPath $stateRoot -Recurse -Force

# =========================================================================== totals

Sep '='
Say ('ASSERT TOTALS: pass=' + $script:Pass + ' fail=' + $script:Fail)
Save-Report
Write-Host ('INSTALL-MIGRATION-PROBE: pass=' + $script:Pass + ' fail=' + $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
exit 0
