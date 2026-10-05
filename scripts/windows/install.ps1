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

.PARAMETER BinDir
    Directory to put on the PATH. Defaults to the directory this script lives in,
    which is the bridge bin directory in a real installation.

.OUTPUTS
    ASCII `KEY=VALUE` lines prefixed `[install]`, suitable for grepping.

.NOTES
    Exit codes: 0 installed or already correct, 2 refused, 1 unexpected error.
#>
[CmdletBinding()]
param(
    [string] $BinDir = $PSScriptRoot
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

# --------------------------------------------------------------------------- main

$target = [System.IO.Path]::GetFullPath($BinDir).TrimEnd('\')

Write-Line ('[install] bin_dir=' + $target)
Write-Line ('[install] bin_dir_exists=' + (Test-Path -LiteralPath $target))
if (-not (Test-Path -LiteralPath $target)) {
    Write-Line '[install] RESULT=FAILED'
    Write-Line '[install] reason=bin_dir_missing'
    exit 1
}

$machineBefore = Get-MachinePathFingerprint

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
exit 0
