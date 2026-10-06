<#
.SYNOPSIS
    Put the opencode-psmux-bridge bin directory FIRST on the USER PATH.

.DESCRIPTION
    One reversible machine change: exactly one entry prepended to the *user* PATH.

    Rules this script enforces, in this order:
      * The machine (HKLM) PATH is never opened for writing. Its raw value is
        hashed before and after and the run FAILS if it changed.
      * `setx` is never used: it truncates at 1024 characters and silently
        rewrites REG_SZ over REG_EXPAND_SZ.
      * The registry value kind is preserved, so a REG_EXPAND_SZ PATH stays one.
      * Idempotent: running it twice leaves exactly one entry, first.
      * It REFUSES (exit 2, writes nothing) if a *different*
        opencode-psmux-bridge\bin directory is already on the PATH, because
        owning the `psmux`/`tmux`/`opencode` names from two directories at once
        is a silent-failure factory.
      * `setx`-free, no `~/.psmux.conf` touch, no machine PATH touch.

.PARAMETER SourceRoot
    Directory to copy the payload from. Defaults to the parent of this script's
    own directory, which is correct for an extracted release zip and an
    already-installed tree alike.

.PARAMETER InstallRoot
    Directory to install into. Defaults to %LOCALAPPDATA%\opencode-psmux-bridge,
    which is also the path the shim derives its own state directory from.

.OUTPUTS
    ASCII `KEY=VALUE` lines prefixed `[install]`, suitable for grepping.

.NOTES
    Exit codes: 0 installed or already correct, 2 refused, 1 unexpected error.
#>
[CmdletBinding()]
param(
    # Where the payload currently is: the directory holding bin\ and runtime\.
    # Defaults to the parent of this script's own directory, which is correct both
    # for an extracted release zip (opencode-psmux-bridge\bin\install.ps1) and for
    # an already-installed tree (%LOCALAPPDATA%\opencode-psmux-bridge\bin\...).
    [string] $SourceRoot,

    # Where the payload is going. Defaults to the documented install location,
    # which is also the path the shim derives its own state directory from.
    [string] $InstallRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------- helpers

function Write-Line {
    param([string] $Text)
    # ASCII only: this host's console codepage is big5.
    [Console]::Out.WriteLine($Text)
}

# Read a user-scope environment value WITHOUT expanding %VAR% references, and
# report the registry value kind so a write can put it back unchanged.
function Read-UserEnvRaw {
    param([string] $ValueName = 'Path')
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    if ($null -eq $key) {
        return [pscustomobject]@{ Exists = $false; Raw = ''; Kind = 'String' }
    }
    try {
        $names = @($key.GetValueNames())
        if ($names -notcontains $ValueName) {
            return [pscustomobject]@{ Exists = $false; Raw = ''; Kind = 'String' }
        }
        $raw = [string]$key.GetValue($ValueName, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind = [string]$key.GetValueKind($ValueName)
        return [pscustomobject]@{ Exists = $true; Raw = $raw; Kind = $kind }
    } finally {
        $key.Close()
    }
}

function Write-UserEnvRaw {
    param([string] $Name, [string] $Value, [string] $Kind)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($null -eq $key) { throw 'cannot open HKCU\Environment for writing' }
    try {
        $valueKind = [Microsoft.Win32.RegistryValueKind]::$Kind
        $key.SetValue($Name, $Value, $valueKind)
    } finally {
        $key.Close()
    }
}

# Machine PATH: hashed for the before/after proof. NEVER opened for writing.
function Get-MachinePathFingerprint {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $false)
    if ($null -eq $key) { return 'UNREADABLE' }
    try {
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        $key.Close()
    }
    return (Get-StringSha256 $raw) + ' len=' + $raw.Length
}

function Get-StringSha256 {
    param([string] $Text)
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Get-BroadcastResult {
    try {
        if (-not ('Bridge.Win32.NativeMethods' -as [type])) {
            Add-Type -Namespace 'Bridge.Win32' -Name 'NativeMethods' -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
        }
        $result = [UIntPtr]::Zero
        [void] [Bridge.Win32.NativeMethods]::SendMessageTimeout(
            [IntPtr] 0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref] $result)
        return 'broadcast=SENDMSG_BROADCAST_OK'
    } catch {
        return 'broadcast=FAILED:' + $_.Exception.GetType().Name
    }
}

function Split-PathEntries {
    param([string] $Raw)
    if ([string]::IsNullOrEmpty($Raw)) { return @() }
    return @($Raw -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

# A bridge bin entry is anything whose last two segments are
# `opencode-psmux-bridge\bin`, regardless of which user profile it lives in.
function Test-BridgeBinEntry {
    param([string] $Entry)
    $norm = $Entry.Trim().TrimEnd('\', '/')
    return [bool] ($norm -imatch '(?i)[\\/](opencode-psmux-bridge)[\\/]bin$')
}

function Get-SamePath {
    param([string] $A, [string] $B)
    $na = $A.Trim().TrimEnd('\', '/').Replace('/', '\')
    $nb = $B.Trim().TrimEnd('\', '/').Replace('/', '\')
    return [string]::Equals($na, $nb, [System.StringComparison]::OrdinalIgnoreCase)
}

# --------------------------------------------------------------------------- prerequisites
# ---------------------------------------------------------------------------
#
# Three things must already be on the machine, and none of them is installed here:
# psmux, opencode, and the OmO plugin. This archive ships a translator and nothing
# else, so a missing prerequisite is the difference between "it works" and "the
# panes never appear and nothing says why".
#
# These checks REPORT rather than REFUSE. They exist to turn a silent failure into
# a loud one, and a check that refuses to install because it guessed wrong would be
# a new silent failure: a psmux installed somewhere this script does not know about
# is still a working psmux.

# Where psmux lives, resolved the way the shim resolves it: the registry first,
# then the installer's default directory. A `%VAR%` reference in the registry value
# is expanded, because it can legitimately hold one.
#
# The returned object always carries the same properties. Under
# Set-StrictMode -Version 2.0 a missing property is a terminating error, and a
# helper whose shape depends on which branch produced it is a trap for whoever
# reads it next.
function Get-PsmuxBackend {
    $dirs = @()

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\psmux', $false)
    if ($null -ne $key) {
        try {
            $value = [string]$key.GetValue('InstallDir', '')
            if (-not [string]::IsNullOrEmpty($value)) {
                $expanded = [Environment]::ExpandEnvironmentVariables($value)
                $dirs += $expanded
                Write-Line ('[install] prereq_psmux_registry=' + $expanded)
            }
        } finally {
            $key.Close()
        }
    } else {
        Write-Line '[install] prereq_psmux_registry=absent'
    }

    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        $dirs += (Join-Path $env:LOCALAPPDATA 'psmux')
    }

    foreach ($dir in $dirs) {
        # psmux.exe before tmux.exe, for the reason the shim gives: if the bridge
        # was ever dropped into the psmux directory, the tmux.exe there IS the
        # bridge, and running it would resolve to itself.
        foreach ($name in @('psmux.exe', 'tmux.exe', 'pmux.exe')) {
            $candidate = Join-Path $dir $name
            if (Test-Path -LiteralPath $candidate) {
                return [pscustomobject]@{
                    Found    = $true
                    Binary   = $candidate
                    Dir      = $dir
                    LookedIn = $dirs
                }
            }
        }
    }

    return [pscustomobject]@{
        Found    = $false
        Binary   = ''
        Dir      = ''
        LookedIn = $dirs
    }
}

# The opencode configuration file: where the OmO plugin is declared and where
# tmux.enabled lives. Returns '' when there is none, which is a legitimate state
# for a machine that has opencode installed but not yet configured.
function Get-OpencodeConfigPath {
    $roots = @()
    if (-not [string]::IsNullOrEmpty($env:USERPROFILE)) {
        $roots += (Join-Path $env:USERPROFILE '.config\opencode')
    }
    if (-not [string]::IsNullOrEmpty($env:APPDATA)) {
        $roots += (Join-Path $env:APPDATA 'opencode')
    }
    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        $roots += (Join-Path $env:LOCALAPPDATA 'opencode')
    }
    foreach ($root in $roots) {
        foreach ($name in @('opencode.jsonc', 'opencode.json')) {
            $candidate = Join-Path $root $name
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return ''
}

# Whether the opencode config turns the tmux integration on.
#
# A TEXTUAL probe, deliberately not a JSONC parse. `opencode.jsonc` is JSON with
# comments and trailing commas; parsing it properly needs a real parser, and a
# hand-rolled one that is confidently wrong is worse than a probe that admits what
# it knows. Only two facts matter here: is there a tmux block, and does its
# `enabled` read true. Five honest answers:
#
#   NO_CONFIG  no opencode config found at all
#   UNREADABLE a config exists but could not be read
#   ABSENT     a config exists, with no tmux block, or none with enabled in it
#   FALSE      a tmux block exists and its enabled is false
#   TRUE       a tmux block exists and its enabled is true
#
# The 400-character bound on the block body stops an unrelated `enabled` further
# down the file from being read as this one.
function Read-TmuxEnabled {
    param([string] $Path)

    if ([string]::IsNullOrEmpty($Path)) { return 'NO_CONFIG' }
    try {
        $text = [System.IO.File]::ReadAllText($Path)
    } catch {
        return 'UNREADABLE'
    }

    $block = [regex]::Match($text, '"tmux"\s*:\s*\{(?<body>[^}]{0,400})\}')
    if (-not $block.Success) { return 'ABSENT' }

    $enabled = [regex]::Match($block.Groups['body'].Value, '"enabled"\s*:\s*(true|false)', 'IgnoreCase')
    if (-not $enabled.Success) { return 'ABSENT' }
    if ($enabled.Groups[1].Value -eq 'true') { return 'TRUE' }
    return 'FALSE'
}

# --------------------------------------------------------------------------- main

# Resolve the roots HERE, in the body, not in the param block. The reason is a
# PowerShell quirk rather than a style choice: when this script is invoked via
# Start-Process -File with a pre-quoted array ArgumentList, a param-block default
# of $PSScriptRoot evaluates to an EMPTY STRING even though $PSScriptRoot is
# correctly set in the body. Resolving here avoids that, and keeps GetFullPath from
# ever being handed an empty string.
#
# There are TWO roots, and keeping them apart is the whole point:
#
#   $SourceRoot   where the payload is right now. The parent of this script's own
#                 directory, which is correct for all three shapes this script runs
#                 in -- a release zip (opencode-psmux-bridge\bin\install.ps1), the
#                 repository (scripts\windows\bin\install.ps1), and an
#                 already-installed tree.
#   $InstallRoot  where the payload is going, and the only directory that goes on
#                 PATH. %LOCALAPPDATA%\opencode-psmux-bridge, which is also the
#                 path the shim derives its own state\ directory from, so the two
#                 must agree or the call log lands somewhere nobody looks.
if ([string]::IsNullOrEmpty($SourceRoot)) {
    $SourceRoot = $PSScriptRoot
}
if (-not [string]::IsNullOrEmpty($SourceRoot)) {
    $SourceRoot = Split-Path -Parent $SourceRoot
}
if ([string]::IsNullOrEmpty($SourceRoot) -and -not [string]::IsNullOrEmpty($MyInvocation.MyCommand.Path)) {
    $SourceRoot = Split-Path -Parent ([System.IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path))
}
if ([string]::IsNullOrEmpty($SourceRoot)) {
    Write-Line '[install] RESULT=FAILED'
    Write-Line '[install] reason=sourceroot_unavailable'
    exit 1
}
if ([string]::IsNullOrEmpty($InstallRoot)) {
    if ([string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        Write-Line '[install] RESULT=FAILED'
        Write-Line '[install] reason=localappdata_unavailable'
        Write-Line '[install] detail=neither -InstallRoot nor %LOCALAPPDATA% is set, so the install location is undetermined. Pass -InstallRoot explicitly.'
        exit 1
    }
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'opencode-psmux-bridge'
}

try {
    $installRootFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $target = [System.IO.Path]::GetFullPath((Join-Path $installRootFull 'bin')).TrimEnd('\')
    $installRuntime = Join-Path $installRootFull 'runtime'
    $sourceBinFull = [System.IO.Path]::GetFullPath((Join-Path $SourceRoot 'bin')).TrimEnd('\')
    $sourceRuntimeFull = [System.IO.Path]::GetFullPath((Join-Path $SourceRoot 'runtime')).TrimEnd('\')
} catch {
    Write-Line '[install] RESULT=FAILED'
    Write-Line ('[install] reason=path_invalid: ' + $_.Exception.Message)
    exit 1
}

Write-Line ('[install] source_root=' + $SourceRoot)
Write-Line ('[install] install_root=' + $installRootFull)
Write-Line ('[install] bin_dir=' + $target)

# --- the payload must be complete before anything is written ------------------
# Checked as a manifest rather than by copying and hoping: a zip extracted one
# level too shallow still has a bin\, and the missing runtime\ helper would then
# be discovered by the first subagent pane silently dying.
$requiredPayload = @(
    (Join-Path $sourceBinFull 'tmux.exe')
    (Join-Path $sourceBinFull 'install.ps1')
    (Join-Path $sourceBinFull 'psmux.cmd')
    (Join-Path $sourceBinFull 'opencode.cmd')
    (Join-Path $sourceBinFull 'bridge-doctor.ps1')
    (Join-Path $sourceRuntimeFull 'Start-PaneFromDescriptor.ps1')
)
$missingPayload = @($requiredPayload | Where-Object { -not (Test-Path -LiteralPath $_) })
Write-Line ('[install] payload_files_checked=' + $requiredPayload.Count)
Write-Line ('[install] payload_files_missing=' + $missingPayload.Count)
if ($missingPayload.Count -gt 0) {
    foreach ($missing in $missingPayload) { Write-Line ('[install] payload_missing=' + $missing) }
    Write-Line '[install] RESULT=FAILED'
    Write-Line '[install] reason=payload_incomplete'
    Write-Line ('[install] detail=the payload should have been extracted so that bin\ and runtime\ are SIBLINGS. Re-extract the zip; you have ' + $SourceRoot + ' as the source root.')
    exit 1
}

# --- prerequisites, reported ---------------------------------------------------
# Run BEFORE any machine change, so a missing prerequisite costs the user nothing.
$psmux = Get-PsmuxBackend
Write-Line ('[install] prereq_psmux_found=' + $psmux.Found)
if ($psmux.Found) {
    Write-Line ('[install] prereq_psmux_binary=' + $psmux.Binary)
} else {
    Write-Line ('[install] prereq_psmux_looked_in=' + ($psmux.LookedIn -join ' | '))
    Write-Line '[install] prereq_psmux_action=install psmux 3.3.8 or newer, then re-run. The bridge cannot work without it.'
}

$opencodeCmd = Get-Command 'opencode' -ErrorAction SilentlyContinue
Write-Line ('[install] prereq_opencode_found=' + ($null -ne $opencodeCmd))
if ($null -ne $opencodeCmd) {
    Write-Line ('[install] prereq_opencode_path=' + $opencodeCmd.Source)
} else {
    Write-Line '[install] prereq_opencode_action=install opencode, then re-run. Note that after this install the bridge bin directory is first on PATH, so `where opencode` will name this script''s own opencode.cmd wrapper.'
}

$configPath = Get-OpencodeConfigPath
$tmuxEnabled = Read-TmuxEnabled -Path $configPath
Write-Line ('[install] opencode_config=' + $(if ($configPath -eq '') { '<none found>' } else { $configPath }))
Write-Line ('[install] prereq_tmux_enabled=' + $tmuxEnabled)

$machineBefore = Get-MachinePathFingerprint

# --- stage the payload ---------------------------------------------------------
# Skipped when source and destination are the same directory, which is what a
# re-run from an already-installed tree looks like. In that case there is nothing
# to copy and the PATH work below is the whole job.
$isSelfCopy = Get-SamePath $sourceBinFull $target

if ($isSelfCopy) {
    Write-Line '[install] step=stage'
    Write-Line '[install] stage_skipped=already_installed_at_target'
} else {
    Write-Line '[install] step=stage'
    Write-Line ('[install] stage_from=' + $sourceBinFull)
    Write-Line ('[install] stage_to=' + $target)

    # Per-file backup rather than moving the tree aside. Moving it would create a
    # window in which the bridge does not exist at all -- and this script may be
    # re-run while a psmux server is live and holding files under state\. Copying
    # each file to a backup first means the tree is never absent, so a failure
    # restores individual files and an interrupted run leaves a working bridge.
    $backupRoot = Join-Path $env:TEMP ('omo-psmux-bridge-backup-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
    $restore = New-Object System.Collections.ArrayList
    $plan = @(
        [pscustomobject]@{ From = $sourceBinFull; To = $target }
        [pscustomobject]@{ From = $sourceRuntimeFull; To = $installRuntime }
    )

    try {
        foreach ($pair in $plan) {
            if (-not (Test-Path -LiteralPath $pair.From)) {
                throw ('source directory absent: ' + $pair.From)
            }
            New-Item -ItemType Directory -Force -Path $pair.To | Out-Null
            foreach ($file in (Get-ChildItem -LiteralPath $pair.From -File)) {
                $dest = Join-Path $pair.To $file.Name
                if (Test-Path -LiteralPath $dest) {
                    $relative = $pair.To.Substring($installRootFull.Length).TrimStart('\')
                    $bak = Join-Path (Join-Path $backupRoot $relative) $file.Name
                    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bak) | Out-Null
                    Copy-Item -LiteralPath $dest -Destination $bak -Force
                    [void]$restore.Add([pscustomobject]@{ Live = $dest; Backup = $bak })
                }
                Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
                Write-Line ('[install] staged=' + $file.Name + ' bytes=' + $file.Length)
            }
        }
    } catch {
        Write-Line ('[install] stage_failed=' + $_.Exception.Message)
        foreach ($item in $restore) {
            try {
                Copy-Item -LiteralPath $item.Backup -Destination $item.Live -Force
                Write-Line ('[install] restored=' + $item.Live)
            } catch {
                Write-Line ('[install] restore_failed=' + $item.Live + ' reason=' + $_.Exception.Message)
                Write-Line ('[install] backup_kept_at=' + $item.Backup)
            }
        }
        Write-Line '[install] RESULT=FAILED'
        Write-Line '[install] reason=stage_failed_rolled_back'
        Write-Line ('[install] detail=the install root was left as it was found; no PATH change was attempted. Backup copies, if any, are under ' + $backupRoot)
        exit 1
    }

    # The backup has served its purpose once every file is in place. Removing it is
    # best-effort: a leftover temp directory is untidy, not dangerous, and failing
    # the install over it would be worse.
    try {
        Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction Stop
        Write-Line '[install] backup_removed=yes'
    } catch {
        Write-Line ('[install] backup_removed=no path=' + $backupRoot)
    }
}

# --- smoke test the staged shim -------------------------------------------------
# The staged binary answering -V proves two things at once: the file is a runnable
# Windows executable and not a truncated download, and the shim can find its
# backend. A non-zero exit here is reported but does NOT roll the staging back,
# because a missing psmux is a prerequisite problem rather than a bad package, and
# the PATH step below still has to run so the doctor can explain it properly.
$stagedShim = Join-Path $target 'tmux.exe'
if (-not (Test-Path -LiteralPath $stagedShim)) {
    Write-Line '[install] RESULT=FAILED'
    Write-Line ('[install] reason=staged_shim_missing: ' + $stagedShim)
    exit 1
}
$shimInfo = Get-Item -LiteralPath $stagedShim
Write-Line ('[install] staged_shim_bytes=' + $shimInfo.Length)
Write-Line ('[install] staged_shim_sha256=' + (Get-FileHash -LiteralPath $stagedShim -Algorithm SHA256).Hash)

$shimVersion = ''
try {
    $shimVersion = ((& $stagedShim -V 2>&1) | Out-String).Trim()
    $shimExit = $LASTEXITCODE
} catch {
    $shimExit = -1
    $shimVersion = $_.Exception.Message
}
Write-Line ('[install] smoke_-V_exit=' + $shimExit)
Write-Line ('[install] smoke_-V=' + ($shimVersion -replace "`r?`n", ' / '))
if ($shimExit -eq 0) {
    Write-Line '[install] smoke_result=PASS'
} else {
    Write-Line '[install] smoke_result=FAIL'
    Write-Line '[install] smoke_note=the staged files are in place and the PATH change below will still be made. Run bin\bridge-doctor.cmd after installing: it names which of its four gates is responsible.'
}


$before = Read-UserEnvRaw 'Path'
$beforeSha = Get-StringSha256 $before.Raw
Write-Line ('[install] user_path_kind=' + $before.Kind)
Write-Line ('[install] user_path_sha256_before=' + $beforeSha)
Write-Line ('[install] user_path_bytes_before=' + $before.Raw.Length)
Write-Line ('[install] user_path_entries_before=' + @(Split-PathEntries $before.Raw).Count)

$entries = @(Split-PathEntries $before.Raw)

# --- refusal: a DIFFERENT bridge bin directory is already on the PATH ----------
$foreign = @($entries | Where-Object { (Test-BridgeBinEntry $_) -and -not (Get-SamePath $_ $target) })
if ($foreign.Count -gt 0) {
    Write-Line ('[install] RESULT=REFUSED')
    Write-Line '[install] reason=foreign_bridge_bin_on_path'
    foreach ($f in $foreign) { Write-Line ('[install] foreign_entry=' + $f) }
    Write-Line ('[install] user_path_sha256_after=' + $beforeSha)
    Write-Line ('[install] machine_path_unchanged=' + ((Get-MachinePathFingerprint) -eq $machineBefore))
    exit 2
}

$mine = @($entries | Where-Object { Get-SamePath $_ $target })
Write-Line ('[install] existing_matching_entries=' + $mine.Count)

# --- build the new list: every occurrence of our entry removed, ours at index 0 -
$kept = @($entries | Where-Object { -not (Get-SamePath $_ $target) })
$newList = @($target) + $kept
$newRaw = ($newList -join ';')

Write-Line ('[install] user_path_entries_after=' + $newList.Count)
Write-Line ('[install] user_path_sha256_computed=' + (Get-StringSha256 $newRaw))

if ($newRaw -ceq $before.Raw) {
    Write-Line '[install] RESULT=ALREADY_CORRECT'
    Write-Line '[install] changed=no'
} else {
    Write-UserEnvRaw -Name 'Path' -Value $newRaw -Kind $before.Kind
    Write-Line '[install] changed=yes'
    Write-Line '[install] RESULT=INSTALLED'
}

# --- verify by re-reading from the registry, not from the value we just wrote ---
$after = Read-UserEnvRaw 'Path'
$afterEntries = @(Split-PathEntries $after.Raw)
$matching = @($afterEntries | Where-Object { Get-SamePath $_ $target })
$first = if ($afterEntries.Count -gt 0) { $afterEntries[0] } else { '' }

Write-Line ('[install] verify_kind=' + $after.Kind)
Write-Line ('[install] verify_kind_preserved=' + [bool]($after.Kind -eq $before.Kind))
Write-Line ('[install] verify_entries=' + $afterEntries.Count)
Write-Line ('[install] verify_matching_entries=' + $matching.Count)
Write-Line ('[install] verify_first_entry=' + $first)
Write-Line ('[install] verify_first_is_bin_dir=' + (Get-SamePath $first $target))
Write-Line ('[install] user_path_sha256_after=' + (Get-StringSha256 $after.Raw))
Write-Line ('[install] user_path_bytes_after=' + $after.Raw.Length)
Write-Line ('[install] user_path_net_user_after=' + [Environment]::GetEnvironmentVariable('Path', 'User'))

$machineAfter = Get-MachinePathFingerprint
Write-Line ('[install] machine_path_fingerprint_before=' + $machineBefore)
Write-Line ('[install] machine_path_fingerprint_after=' + $machineAfter)
Write-Line ('[install] machine_path_unchanged=' + ($machineAfter -eq $machineBefore))

Write-Line ('[install] ' + (Get-BroadcastResult))
Write-Line '[install] note=a_new_shell_is_required_for_the_change_to_be_visible'

if (($matching.Count -ne 1) -or -not (Get-SamePath $first $target) -or ($machineAfter -ne $machineBefore)) {
    Write-Line '[install] RESULT=FAILED'
    Write-Line '[install] reason=post_write_verification_failed'
    exit 1
}

# --- the one setting the user has to make themselves ---------------------------
# Reported, never written, and the refusal to write it is deliberate.
#
# `[opencode].tmux.enabled` defaults to FALSE in the OmO plugin. With it off the
# plugin never attempts to spawn a pane at all, so the symptom is zero subagent
# panes and no error anywhere -- a correct installation that looks broken. It is
# the single most common way this project fails to appear to work.
#
# This script could set the key. It does not, for two reasons. The file belongs to
# opencode and the key is one line inside a JSONC document that may carry comments
# and trailing commas, so a programmatic edit is a rewrite with a real chance of
# damaging a file the user also cares about. And a setting applied silently is a
# setting the user never learns exists, so the next time it matters -- after an
# opencode update, or on a second machine -- they have nothing to fall back on.
# Printing the line and letting them paste it keeps the knowledge and the file.
if ($tmuxEnabled -ne 'TRUE') {
    Write-Line ''
    Write-Line '[install] =================================================================='
    Write-Line '[install] ONE SETTING LEFT TO DO -- the install is complete without it,'
    Write-Line '[install] but subagent panes will NOT appear until it is set.'
    Write-Line '[install] =================================================================='
    if ($configPath -eq '') {
        Write-Line '[install] No opencode config file was found. In your opencode config'
        Write-Line '[install] (opencode.json / opencode.jsonc) make sure the plugin is'
        Write-Line '[install] declared and add:'
    } else {
        Write-Line ('[install] file=' + $configPath)
        Write-Line '[install] current_tmux_enabled=' + $tmuxEnabled
        Write-Line '[install] Add this inside the top-level object:'
    }
    Write-Line '[install]'
    Write-Line '[install]     "tmux": { "enabled": true }'
    Write-Line '[install]'
    Write-Line '[install] The OmO plugin defaults this to false and reports nothing when'
    Write-Line '[install] it is off, so a missing pane is otherwise indistinguishable from'
    Write-Line '[install] a broken install. If you set it and panes still do not appear,'
    Write-Line '[install] run  bin\bridge-doctor.cmd  -- it is read-only and names which'
    Write-Line '[install] of its four gates is responsible.'
    Write-Line '[install] =================================================================='
    Write-Line ''
}

Write-Line '[install] next=open a NEW terminal window (a running shell keeps its old PATH), then run: psmux'
exit 0
