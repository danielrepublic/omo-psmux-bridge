<#
.SYNOPSIS
    Remove exactly one opencode-psmux-bridge bin directory entry from the USER PATH.

.DESCRIPTION
    The exact inverse of install.ps1. It removes ONLY the bridge bin entry, in
    whatever position it holds, and leaves every other entry in its original
    order. It never touches the machine (HKLM) PATH and never uses `setx`.

    It does NOT delete the bridge directory. It REPORTS whether the directory
    could be deleted right now, by attempting an exclusive open of every file in
    it and by listing any running process whose image lives inside it, and it
    lists the files that refused.

    This file duplicates the registry helpers from install.ps1 on purpose:
    uninstall must keep working even if a shared helper module is missing or was
    removed by an earlier uninstall.

.PARAMETER BinDir
    Directory to remove from the PATH. Defaults to the directory this script
    lives in, which is the bridge bin directory in a real installation.

.OUTPUTS
    ASCII `KEY=VALUE` lines prefixed `[uninstall]`, suitable for grepping.

.NOTES
    Exit codes: 0 removed or already absent, 1 unexpected error.
#>
[CmdletBinding()]
param(
    [string] $BinDir
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Write-Line {
    param([string] $Text)
    [Console]::Out.WriteLine($Text)
}

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
        $key.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::$Kind)
    } finally {
        $key.Close()
    }
}

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

function Get-SamePath {
    param([string] $A, [string] $B)
    $na = $A.Trim().TrimEnd('\', '/').Replace('/', '\')
    $nb = $B.Trim().TrimEnd('\', '/').Replace('/', '\')
    return [string]::Equals($na, $nb, [System.StringComparison]::OrdinalIgnoreCase)
}

# Can the directory be deleted right now? Probe by exclusive-open, never by
# guessing. A file that cannot be opened for ReadWrite with FileShare.None is
# held by some other handle.
function Test-DirectoryDeletable {
    param([string] $Dir)
    $report = [ordered]@{
        dir = $Dir
        dir_exists = (Test-Path -LiteralPath $Dir)
        files_probed = 0
        locked_files = @()
        processes_in_dir = @()
        deletable = $false
    }
    if (-not $report.dir_exists) {
        $report.deletable = $true
        $report.note = 'directory does not exist'
        return [pscustomobject]$report
    }

    $prefix = $Dir.TrimEnd('\') + '\'
    $report.processes_in_dir = @(
        Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
            } |
            ForEach-Object { [string]$_.ProcessId + ':' + [string]$_.Name + ':' + [string]$_.ExecutablePath }
    )

    $locked = @()
    foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Recurse -Force -File -ErrorAction SilentlyContinue)) {
        $report.files_probed = $report.files_probed + 1
        $handle = $null
        try {
            $handle = [System.IO.File]::Open($f.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch {
            $locked += ($f.FullName + ' :: ' + $_.Exception.GetType().Name)
        } finally {
            if ($null -ne $handle) { $handle.Dispose() }
        }
    }
    $report.locked_files = $locked
    $report.deletable = ($locked.Count -eq 0) -and (@($report.processes_in_dir).Count -eq 0)
    return [pscustomobject]$report
}

# --------------------------------------------------------------------------- main

# Resolve the bin directory HERE, in the body.  Do NOT default $BinDir to
# $PSScriptRoot in the param block: when this script is invoked via
# Start-Process -File with a pre-quoted array ArgumentList, PowerShell
# evaluates the param default $PSScriptRoot to an empty string even though
# $PSScriptRoot is correctly set in the body.  Resolving here avoids that
# quirk and keeps GetFullPath from being handed an empty string.
if ([string]::IsNullOrEmpty($BinDir)) {
    $BinDir = $PSScriptRoot
}
if ([string]::IsNullOrEmpty($BinDir) -and -not [string]::IsNullOrEmpty($MyInvocation.MyCommand.Path)) {
    $BinDir = [System.IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path)
}
if ([string]::IsNullOrEmpty($BinDir)) {
    Write-Line '[uninstall] RESULT=FAILED'
    Write-Line '[uninstall] reason=bindir_unavailable'
    exit 1
}
try {
    $target = [System.IO.Path]::GetFullPath($BinDir).TrimEnd('\')
} catch {
    Write-Line '[uninstall] RESULT=FAILED'
    Write-Line ('[uninstall] reason=bindir_invalid: ' + $_.Exception.Message)
    exit 1
}

Write-Line ('[uninstall] bin_dir=' + $target)

$machineBefore = Get-MachinePathFingerprint

$before = Read-UserEnvRaw 'Path'
$beforeSha = Get-StringSha256 $before.Raw
$entries = @(Split-PathEntries $before.Raw)

Write-Line ('[uninstall] user_path_kind=' + $before.Kind)
Write-Line ('[uninstall] user_path_sha256_before=' + $beforeSha)
Write-Line ('[uninstall] user_path_bytes_before=' + $before.Raw.Length)
Write-Line ('[uninstall] user_path_entries_before=' + $entries.Count)
Write-Line ('[uninstall] user_path_raw_before=' + $before.Raw)

$kept = @($entries | Where-Object { -not (Get-SamePath $_ $target) })
$removed = $entries.Count - $kept.Count
Write-Line ('[uninstall] entries_removed=' + $removed)
Write-Line ('[uninstall] entries_kept=' + $kept.Count)
$i = 0
foreach ($e in $entries) {
    $keptIt = -not (Get-SamePath $e $target)
    Write-Line ('[uninstall] before[' + $i + ']=' + $e + ' kept=' + $keptIt)
    $i = $i + 1
}

if ($removed -eq 0) {
    Write-Line '[uninstall] changed=no'
    Write-Line '[uninstall] RESULT=ALREADY_ABSENT'
} else {
    $newRaw = if ($kept.Count -eq 0) { '' } else { ($kept -join ';') }
    Write-UserEnvRaw -Name 'Path' -Value $newRaw -Kind $before.Kind
    Write-Line '[uninstall] changed=yes'
    Write-Line '[uninstall] RESULT=REMOVED'
}

# --- verify by re-reading the registry ----------------------------------------
$after = Read-UserEnvRaw 'Path'
$afterEntries = @(Split-PathEntries $after.Raw)
$stillThere = @($afterEntries | Where-Object { Get-SamePath $_ $target })
Write-Line ('[uninstall] verify_kind=' + $after.Kind)
Write-Line ('[uninstall] verify_kind_preserved=' + [bool]($after.Kind -eq $before.Kind))
Write-Line ('[uninstall] verify_entries=' + $afterEntries.Count)
Write-Line ('[uninstall] verify_bridge_entries_remaining=' + $stillThere.Count)
Write-Line ('[uninstall] user_path_sha256_after=' + (Get-StringSha256 $after.Raw))
Write-Line ('[uninstall] user_path_bytes_after=' + $after.Raw.Length)
Write-Line ('[uninstall] user_path_raw_after=' + $after.Raw)

$machineAfter = Get-MachinePathFingerprint
Write-Line ('[uninstall] machine_path_unchanged=' + ($machineAfter -eq $machineBefore))

Write-Line ('[uninstall] ' + (Get-BroadcastResult))
Write-Line '[uninstall] note=a_new_shell_is_required_for_the_change_to_be_visible'

# --- can the directory be deleted? --------------------------------------------
$probe = Test-DirectoryDeletable $target
Write-Line ('[uninstall] dir_exists=' + $probe.dir_exists)
Write-Line ('[uninstall] files_probed=' + $probe.files_probed)
Write-Line ('[uninstall] locked_file_count=' + @($probe.locked_files).Count)
foreach ($l in @($probe.locked_files)) { Write-Line ('[uninstall] locked_file=' + $l) }
Write-Line ('[uninstall] processes_in_dir_count=' + @($probe.processes_in_dir).Count)
foreach ($p in @($probe.processes_in_dir)) { Write-Line ('[uninstall] process_in_dir=' + $p) }
Write-Line ('[uninstall] directory_deletable=' + $probe.deletable)
if ($probe.deletable) {
    Write-Line '[uninstall] directory_delete_hint=none_required_you_may_delete_it'
} else {
    Write-Line '[uninstall] directory_delete_hint=blocked_close_the_listed_processes_then_delete_manually'
}

Write-Line '[uninstall] directory_deleted=no_by_design_this_script_reports_only'

if ($stillThere.Count -ne 0 -or ($machineAfter -ne $machineBefore)) {
    Write-Line '[uninstall] RESULT=FAILED'
    exit 1
}
exit 0
