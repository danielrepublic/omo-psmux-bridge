<#
.SYNOPSIS
    Put the omo-psmux-bridge bin directory FIRST on the USER PATH.

.DESCRIPTION
    One reversible machine change: exactly one entry prepended to the *user* PATH.

    Rules this script enforces, in this order:
      * The machine (HKLM) PATH is never opened for writing. Its raw value is
        hashed before and after and the run FAILS if it changed.
      * `setx` is never used: it truncates at 1024 characters and silently
        rewrites REG_SZ over REG_EXPAND_SZ.
      * The registry value kind is preserved, so a REG_EXPAND_SZ PATH stays one.
      * Idempotent: running it twice leaves exactly one entry, first.
      * It REFUSES (exit 2, writes nothing to PATH) if a *different* bridge bin
        directory is already on the PATH, because owning the
        `psmux`/`tmux`/`opencode` names from two directories at once is a
        silent-failure factory.
      * It upgrades an installation made before the project rename: a legacy
        opencode-psmux-bridge\bin user PATH entry is replaced by the new entry
        (never duplicated), and legacy state files are copied into the new root
        without overwriting anything already there. The legacy directory is
        retained; a running psmux server is never stopped or otherwise touched.
      * `setx`-free, no `~/.psmux.conf` touch, no machine PATH touch.

.PARAMETER SourceRoot
    Directory to copy the payload from. Defaults to the parent of this script's
    own directory, which is correct for an extracted release zip and an
    already-installed tree alike.

.PARAMETER InstallRoot
    Directory to install into. Defaults to %LOCALAPPDATA%\omo-psmux-bridge,
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
    # for an extracted release zip (omo-psmux-bridge\bin\install.ps1) and for
    # an already-installed tree (%LOCALAPPDATA%\omo-psmux-bridge\bin\...).
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
# `omo-psmux-bridge\bin` or the pre-rename `opencode-psmux-bridge\bin`,
# regardless of which user profile it lives in. Recognizing BOTH names is what
# lets an in-place upgrade identify the old owner instead of refusing it as a
# foreign install; every other bridge bin directory is still foreign.
function Test-BridgeBinEntry {
    param([string] $Entry)
    $norm = $Entry.Trim().TrimEnd('\', '/')
    return [bool] ($norm -imatch '(?i)[\\/](?:omo-psmux-bridge|opencode-psmux-bridge)[\\/]bin$')
}

function Get-SamePath {
    param([string] $A, [string] $B)
    $na = $A.Trim().TrimEnd('\', '/').Replace('/', '\')
    $nb = $B.Trim().TrimEnd('\', '/').Replace('/', '\')
    return [string]::Equals($na, $nb, [System.StringComparison]::OrdinalIgnoreCase)
}

# A bridge bin entry is foreign when it is neither the target this run is
# installing into nor the exact legacy default that a default-root upgrade is
# replacing. Keeping this as a named function makes the refusal rule testable
# without a registry: the native harness feeds it lists and asserts the answer.
function Get-ForeignBridgeBinEntries {
    param(
        [string[]] $Entries,
        [string] $Target,
        [string] $LegacyTarget = ''
    )
    return @($Entries | Where-Object {
        (Test-BridgeBinEntry $_) -and
        -not (Get-SamePath $_ $Target) -and
        -not ((-not [string]::IsNullOrEmpty($LegacyTarget)) -and (Get-SamePath $_ $LegacyTarget))
    })
}

# Build the new user PATH list, keeping the invariants that make the bridge
# own its command names:
#   * the new target is FIRST, exactly as every earlier installer left it;
#   * every occurrence of the target is removed before it is prepended, so an
#     idempotent re-run cannot create duplicates;
#   * every occurrence of the legacy target is removed too, so an upgrade from
#     opencode-psmux-bridge leaves ONE owner, not two;
#   * every other entry keeps its relative order.
# This is a pure function so the native harness can exercise the upgrade shape
# without writing a registry value.
function Get-MigratedUserPath {
    param(
        [string[]] $Entries,
        [string] $Target,
        [string] $LegacyTarget = ''
    )
    $kept = New-Object System.Collections.ArrayList
    $targetDuplicates = 0
    $legacyReplaced = 0
    foreach ($entry in @($Entries)) {
        if (Get-SamePath $entry $Target) {
            $targetDuplicates++
            continue
        }
        if ((-not [string]::IsNullOrEmpty($LegacyTarget)) -and (Get-SamePath $entry $LegacyTarget)) {
            $legacyReplaced++
            continue
        }
        [void]$kept.Add($entry)
    }
    return [pscustomobject]@{
        Entries                 = @($Target) + $kept.ToArray()
        TargetDuplicatesRemoved = $targetDuplicates
        LegacyReplaced          = $legacyReplaced
    }
}

# Copy the pre-rename installation's state into the new root.
#
# State is the one thing an upgrade must not lose: `state\` holds the per-pane
# helper traces and `bin\state\shim-calls.jsonl` is the shim's call log. Both
# live under the installation root, so they move with it.
#
# Copy-if-absent, recursively:
#   * a file already present in the new root is NEVER overwritten, so an
#     interrupted run, a re-run, or state created by the new install wins;
#   * nothing under the old root is moved or deleted. A psmux server started
#     before the upgrade may still hold files there, and this installer never
#     stops a psmux session. The old directory is left for the user to remove
#     after those sessions are closed.
function Copy-LegacyState {
    param(
        [string] $LegacyRoot,
        [string] $NewRoot
    )
    $copied = 0
    $skipped = 0
    $failed = 0
    $pairs = @(
        [pscustomobject]@{ From = (Join-Path $LegacyRoot 'state'); To = (Join-Path $NewRoot 'state') }
        [pscustomobject]@{ From = (Join-Path (Join-Path $LegacyRoot 'bin') 'state'); To = (Join-Path (Join-Path $NewRoot 'bin') 'state') }
    )
    $pending = New-Object 'System.Collections.Generic.Queue[object]'
    foreach ($pair in $pairs) { $pending.Enqueue($pair) }
    while ($pending.Count -gt 0) {
        $pair = $pending.Dequeue()
        if (-not (Test-Path -LiteralPath $pair.From -PathType Container)) { continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $pair.From -Force -ErrorAction Stop)) {
            # Enumeration expands 8.3 aliases; source-prefix lengths need not
            # match FullName. Build destinations from entry names instead.
            $dest = Join-Path $pair.To $file.Name
            if ($file.PSIsContainer) {
                $pending.Enqueue([pscustomobject]@{ From = $file.FullName; To = $dest })
                continue
            }
            if (Test-Path -LiteralPath $dest) {
                $skipped++
                continue
            }
            try {
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
                Copy-Item -LiteralPath $file.FullName -Destination $dest -ErrorAction Stop
                $copied++
            } catch {
                $failed++
                Write-Line ('[install] legacy_state_failed=' + $file.FullName + ' reason=' + $_.Exception.Message)
            }
        }
    }
    return [pscustomobject]@{ Copied = $copied; Skipped = $skipped; Failed = $failed }
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

# The OPENCODE configuration file: the one that declares plugins. This is NOT the
# file that carries tmux.enabled -- see Get-OmoConfigPath for that, and the
# distinction is the whole reason both functions exist.
#
# Confusing the two is not a style problem. `tmux.enabled` is read by
#   isTmuxIntegrationEnabled(pluginConfig)  -> pluginConfig.tmux?.enabled ?? false
# (index.js:141385-141386), and pluginConfig is the `[opencode]` block of the OMO
# config chain (index.js:88402-88405, appendViews(..., block, "[opencode].")).
# Probing the opencode config for a top-level "tmux" block therefore reports on a
# key that is never read, in a file that never carries it, so the installer could
# print TRUE while panes still did not appear, or FALSE on a fully working setup.
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

# The OMO user config file -- the one that actually gates subagent panes.
#
# Resolved exactly the way the installed bundle resolves it, so this installer
# cannot advise about a file OmO never opens:
#
#   index.js:86113  function resolveHomeDir(env = process.env) {
#   index.js:86114    const homeDir = env.HOME ?? env.USERPROFILE ?? process.cwd();
#   index.js:86123  function detectUserOmoJsonPath(env, fileSystem) {
#   index.js:86125    const jsoncPath = join34(configDir, "omo.jsonc");
#   index.js:86126    if (fileSystem.existsSync(jsoncPath)) return jsoncPath;
#   index.js:86128    const jsonPath = join34(configDir, "omo.json");
#   index.js:86129    return fileSystem.existsSync(jsonPath) ? jsonPath : jsoncPath;
#
# `join34` is node's `path.join` under the bundle's own import alias. The alias
# suffix is a bundler artefact (a name collision renumbered it at 5.1.40), so it
# carries no meaning; it is quoted as the bundle actually spells it.
#
# `??` is NULL coalescing, not truthiness: an EMPTY HOME still wins over
# USERPROFILE. -not [string]::IsNullOrEmpty would diverge here, so this tests
# $null exactly as the bundle does. Returns '' only when no home is derivable.
function Get-OmoConfigPath {
    $homeDir = ''
    if ($null -ne $env:HOME) { $homeDir = $env:HOME }
    elseif ($null -ne $env:USERPROFILE) { $homeDir = $env:USERPROFILE }
    else { $homeDir = (Get-Location).Path }
    if ([string]::IsNullOrEmpty($homeDir)) { return '' }
    $configDir = Join-Path $homeDir '.omo'
    $jsoncPath = Join-Path $configDir 'omo.jsonc'
    if (Test-Path -LiteralPath $jsoncPath) { return $jsoncPath }
    $jsonPath = Join-Path $configDir 'omo.json'
    if (Test-Path -LiteralPath $jsonPath) { return $jsonPath }
    # Neither exists: report the path OmO expects, so the advice names a real
    # location instead of an empty string.
    return $jsoncPath
}

# JSONC -> plain JSON, as a parse-ready string.
#
# Two transforms, both required for a truthful answer and neither optional:
#
#   * Comments. The old probe was a raw regex over the raw text, so a config whose
#     only match was the line
#         // "[opencode]" "tmux" "enabled" true
#     reported TRUE. That decoy is not hypothetical -- commented-out config is the
#     normal way a user disables a setting. Stripping must be STRING-aware, or the
#     `//` inside the `https://` of a `$schema` value eats the rest of the document.
#   * Trailing commas. They are legal in JSONC and ConvertFrom-Json in Windows
#     PowerShell 5.1 rejects them, so without this an ordinary omo.jsonc reports
#     UNPARSEABLE and the installer tells a correctly configured user to go fix a
#     file that is already right.
#
# The comment lexer is the same algorithm the doctor uses; it is repeated rather
# than shared because the installer must run before anything is installed, so it
# cannot depend on the doctor being present.
function ConvertTo-PlainJsonText {
    param([string] $Text)

    $sb = New-Object System.Text.StringBuilder $Text.Length
    $inString = $false; $inLine = $false; $inBlock = $false; $escaped = $false
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $c = [char]$Text[$i]
        $n = [char]0
        if ($i + 1 -lt $Text.Length) { $n = [char]$Text[$i + 1] }
        if ($inLine) {
            if ($c -eq "`n") { $inLine = $false; [void]$sb.Append($c) }
            continue
        }
        if ($inBlock) {
            if ($c -eq '*' -and $n -eq '/') { $inBlock = $false; $i++ }
            elseif ($c -eq "`n") { [void]$sb.Append($c) }
            continue
        }
        if ($inString) {
            [void]$sb.Append($c)
            if ($escaped) { $escaped = $false }
            elseif ($c -eq '\') { $escaped = $true }
            elseif ($c -eq '"') { $inString = $false }
            continue
        }
        if ($c -eq '"') { $inString = $true; [void]$sb.Append($c); continue }
        if ($c -eq '/' -and $n -eq '/') { $inLine = $true; $i++; continue }
        if ($c -eq '/' -and $n -eq '*') { $inBlock = $true; $i++; continue }
        [void]$sb.Append($c)
    }

    # Second pass: drop a comma that is followed only by whitespace and then a
    # closing brace or bracket. Still string-aware -- a comma inside a string
    # value is content, not punctuation.
    $plain = New-Object System.Text.StringBuilder $sb.Length
    $inString = $false; $escaped = $false
    for ($i = 0; $i -lt $sb.Length; $i++) {
        $c = [char]$sb[$i]
        if ($inString) {
            [void]$plain.Append($c)
            if ($escaped) { $escaped = $false }
            elseif ($c -eq '\') { $escaped = $true }
            elseif ($c -eq '"') { $inString = $false }
            continue
        }
        if ($c -eq '"') { $inString = $true; [void]$plain.Append($c); continue }
        if ($c -eq ',') {
            $j = $i + 1
            while ($j -lt $sb.Length -and [char]::IsWhiteSpace([char]$sb[$j])) { $j++ }
            if ($j -lt $sb.Length) {
                $next = [char]$sb[$j]
                if ($next -eq '}' -or $next -eq ']') { continue }
            }
        }
        [void]$plain.Append($c)
    }
    return $plain.ToString()
}

# Whether the OMO config turns the tmux integration on, read as
# `[opencode]` -> `tmux` -> `enabled` from the PARSED document.
#
# Six honest answers, each of which is a different thing to tell the user:
#
#   NO_CONFIG   no omo config file was found at all
#   UNREADABLE  a config exists but could not be read from disk
#   UNPARSEABLE a config exists and is not valid JSONC
#   ABSENT      parsed fine, but no `[opencode]`, or no `tmux`, or no `enabled`
#   FALSE       present and explicitly false
#   TRUE        present and explicitly true
#
# Only a real JSON boolean true counts. `"enabled": "true"` is a STRING, the
# loader's `pluginConfig.tmux?.enabled ?? false` would read it as falsy, and
# telling the user their panes should work would be the exact silent failure this
# whole check exists to prevent.
function Read-OmoTmuxEnabled {
    param([string] $Path)

    if ([string]::IsNullOrEmpty($Path)) { return 'NO_CONFIG' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'NO_CONFIG' }
    $text = ''
    try {
        $text = [System.IO.File]::ReadAllText($Path)
    } catch {
        return 'UNREADABLE'
    }

    $json = $null
    try {
        $json = (ConvertTo-PlainJsonText -Text $text) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return 'UNPARSEABLE'
    }
    if ($null -eq $json) { return 'UNPARSEABLE' }

    $opencodeNode = $json.PSObject.Properties['[opencode]']
    if ($null -eq $opencodeNode) { return 'ABSENT' }
    $tmuxNode = $opencodeNode.Value.PSObject.Properties['tmux']
    if ($null -eq $tmuxNode) { return 'ABSENT' }
    $enabledNode = $tmuxNode.Value.PSObject.Properties['enabled']
    if ($null -eq $enabledNode) { return 'ABSENT' }
    if ($enabledNode.Value -is [bool]) {
        if ($enabledNode.Value) { return 'TRUE' }
        return 'FALSE'
    }
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
#                 in -- a release zip (omo-psmux-bridge\bin\install.ps1), the
#                 repository (scripts\windows\bin\install.ps1), and an
#                 already-installed tree.
#   $InstallRoot  where the payload is going, and the only directory that goes on
#                 PATH. %LOCALAPPDATA%\omo-psmux-bridge, which is also the
#                 path the shim derives its own state\ directory from, so the two
#                 must agree or the call log lands somewhere nobody looks.
#
# The pre-rename root, %LOCALAPPDATA%\opencode-psmux-bridge, is a REAL shipped
# contract: every release through v5.1.43-1 installed there. It is not a guess
# and it is not optional. It is read only when this is a default-root install, so
# an explicit -InstallRoot keeps the old "refuse a different bridge on PATH"
# behaviour instead of silently rewriting a custom layout.
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
$defaultInstallRoot = ''
if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
    $defaultInstallRoot = Join-Path $env:LOCALAPPDATA 'omo-psmux-bridge'
}
if ([string]::IsNullOrEmpty($InstallRoot)) {
    if ([string]::IsNullOrEmpty($defaultInstallRoot)) {
        Write-Line '[install] RESULT=FAILED'
        Write-Line '[install] reason=localappdata_unavailable'
        Write-Line '[install] detail=neither -InstallRoot nor %LOCALAPPDATA% is set, so the install location is undetermined. Pass -InstallRoot explicitly.'
        exit 1
    }
    $InstallRoot = $defaultInstallRoot
}

try {
    $installRootFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $target = [System.IO.Path]::GetFullPath((Join-Path $installRootFull 'bin')).TrimEnd('\')
    $installRuntime = Join-Path $installRootFull 'runtime'
    $sourceBinFull = [System.IO.Path]::GetFullPath((Join-Path $SourceRoot 'bin')).TrimEnd('\')
    $sourceRuntimeFull = [System.IO.Path]::GetFullPath((Join-Path $SourceRoot 'runtime')).TrimEnd('\')

    $isDefaultInstallRoot = $false
    if (-not [string]::IsNullOrEmpty($defaultInstallRoot)) {
        $isDefaultInstallRoot = Get-SamePath $installRootFull ([System.IO.Path]::GetFullPath($defaultInstallRoot).TrimEnd('\'))
    }
    $legacyInstallRoot = ''
    $legacyTarget = ''
    if ($isDefaultInstallRoot -and -not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
        $legacyInstallRoot = Join-Path $env:LOCALAPPDATA 'opencode-psmux-bridge'
        $legacyTarget = [System.IO.Path]::GetFullPath((Join-Path $legacyInstallRoot 'bin')).TrimEnd('\')
    }
} catch {
    Write-Line '[install] RESULT=FAILED'
    Write-Line ('[install] reason=path_invalid: ' + $_.Exception.Message)
    exit 1
}

Write-Line ('[install] source_root=' + $SourceRoot)
Write-Line ('[install] install_root=' + $installRootFull)
Write-Line ('[install] bin_dir=' + $target)
if (-not [string]::IsNullOrEmpty($legacyInstallRoot)) {
    Write-Line ('[install] legacy_root=' + $legacyInstallRoot)
    Write-Line ('[install] legacy_root_exists=' + (Test-Path -LiteralPath $legacyInstallRoot -PathType Container))
    Write-Line ('[install] legacy_bin_dir=' + $legacyTarget)
} else {
    Write-Line '[install] legacy_migration=not_applicable'
}

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

$opencodeConfigPath = Get-OpencodeConfigPath
Write-Line ('[install] opencode_config=' + $(if ($opencodeConfigPath -eq '') { '<none found>' } else { $opencodeConfigPath }))

# tmux.enabled is NOT in the opencode config. It is the `[opencode]` block of the
# OMO config chain, so it is probed there -- see Read-OmoTmuxEnabled.
$omoConfigPath = Get-OmoConfigPath
$omoConfigExists = (-not [string]::IsNullOrEmpty($omoConfigPath)) -and (Test-Path -LiteralPath $omoConfigPath -PathType Leaf)
$omoConfigRule = 'neither omo.jsonc nor omo.json exists; this is the path OmO expects (index.js:86129)'
if ($omoConfigExists) {
    $sibling = ''
    if ((Split-Path $omoConfigPath -Leaf) -eq 'omo.jsonc') { $sibling = Join-Path (Split-Path $omoConfigPath -Parent) 'omo.json' }
    else { $sibling = Join-Path (Split-Path $omoConfigPath -Parent) 'omo.jsonc' }
    if (Test-Path -LiteralPath $sibling -PathType Leaf) { $omoConfigRule = 'both omo.jsonc and omo.json exist; OmO reads omo.jsonc (index.js:86126)' }
    else { $omoConfigRule = 'omo.' + ((Split-Path $omoConfigPath -Leaf) -replace '^omo\.', '') + ' exists (index.js:86126,86129)' }
}
$tmuxEnabled = Read-OmoTmuxEnabled -Path $omoConfigPath
Write-Line ('[install] omo_config=' + $(if ($omoConfigPath -eq '') { '<no home derivable>' } else { $omoConfigPath }))
Write-Line ('[install] omo_config_exists=' + $omoConfigExists)
Write-Line ('[install] omo_config_rule=' + $omoConfigRule)
Write-Line ('[install] prereq_tmux_enabled=' + $tmuxEnabled + '  (read from omo config [opencode].tmux.enabled, index.js:141385-141386)')

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

# --- migrate state from the pre-rename installation ----------------------------
# Runs after the payload is in place and before the PATH change. State is only
# copied, never moved or deleted, so a psmux server that is still running from
# the old tree keeps every file it holds. If one copy fails, the install still
# proceeds: the old root retains the original, and the failure is named above.
if (-not [string]::IsNullOrEmpty($legacyInstallRoot) -and (Test-Path -LiteralPath $legacyInstallRoot -PathType Container)) {
    Write-Line '[install] step=legacy_migration'
    $legacyState = Copy-LegacyState -LegacyRoot $legacyInstallRoot -NewRoot $installRootFull
    Write-Line ('[install] legacy_state_copied=' + $legacyState.Copied)
    Write-Line ('[install] legacy_state_skipped_existing=' + $legacyState.Skipped)
    Write-Line ('[install] legacy_state_failed=' + $legacyState.Failed)
    Write-Line '[install] legacy_state_policy=copy_if_absent_never_overwrite'
    Write-Line '[install] legacy_root_retained=yes'
    Write-Line '[install] legacy_root_delete_hint=close any psmux sessions still using it, then delete manually; this installer never stops a session'
} elseif (-not [string]::IsNullOrEmpty($legacyInstallRoot)) {
    Write-Line '[install] legacy_migration=no_legacy_install'
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
# Exactly ONE exception is allowed: the legacy bin directory that this default
# root install is replacing. Anything else -- a second profile's bridge, a
# hand-made copy, or a legacy entry when a custom -InstallRoot was requested --
# is still refused, unchanged from the pre-rename contract.
$legacyEntries = @()
if (-not [string]::IsNullOrEmpty($legacyTarget)) {
    $legacyEntries = @($entries | Where-Object { Get-SamePath $_ $legacyTarget })
}
Write-Line ('[install] existing_legacy_entries=' + $legacyEntries.Count)

$foreign = @(Get-ForeignBridgeBinEntries -Entries $entries -Target $target -LegacyTarget $legacyTarget)
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

# --- build the new list: target first; old target and legacy target removed ----
# The target goes at index 0, which is where every previous installer put its
# own bin directory. On the shipped upgrade path the legacy entry was also at
# index 0, so this replaces it in place; if a user had moved it, the new entry
# still becomes first (the shadowing contract) and every other entry keeps its
# relative order.
$pathPlan = Get-MigratedUserPath -Entries $entries -Target $target -LegacyTarget $legacyTarget
$newList = @($pathPlan.Entries)
$newRaw = ($newList -join ';')

Write-Line ('[install] legacy_path_entries_replaced=' + $pathPlan.LegacyReplaced)
Write-Line ('[install] duplicate_target_entries_removed=' + $pathPlan.TargetDuplicatesRemoved)
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
$legacyRemaining = @()
if (-not [string]::IsNullOrEmpty($legacyTarget)) {
    $legacyRemaining = @($afterEntries | Where-Object { Get-SamePath $_ $legacyTarget })
}
$first = if ($afterEntries.Count -gt 0) { $afterEntries[0] } else { '' }

Write-Line ('[install] verify_kind=' + $after.Kind)
Write-Line ('[install] verify_kind_preserved=' + [bool]($after.Kind -eq $before.Kind))
Write-Line ('[install] verify_entries=' + $afterEntries.Count)
Write-Line ('[install] verify_matching_entries=' + $matching.Count)
Write-Line ('[install] verify_legacy_entries_remaining=' + $legacyRemaining.Count)
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

if (($matching.Count -ne 1) -or ($legacyRemaining.Count -ne 0) -or -not (Get-SamePath $first $target) -or ($machineAfter -ne $machineBefore)) {
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
# OmO and is the one the user also edits and comments, so a programmatic edit is a
# rewrite with a real chance of damaging it. And a setting applied silently is a
# setting the user never learns exists, so the next time it matters -- after an
# OmO update, or on a second machine -- they have nothing to fall back on.
# Printing the line and letting them paste it keeps the knowledge and the file.
if ($tmuxEnabled -ne 'TRUE') {
    Write-Line ''
    Write-Line '[install] =================================================================='
    Write-Line '[install] ONE SETTING LEFT TO DO -- the install is complete without it,'
    Write-Line '[install] but subagent panes will NOT appear until it is set.'
    Write-Line '[install] =================================================================='
if (-not $omoConfigExists) {
        Write-Line ('[install] No OmO config file was found. OmO reads tmux.enabled from its own')
        Write-Line ('[install] user config, which it looks for at:')
        Write-Line ('[install]   ' + $omoConfigPath)
        Write-Line ('[install] Create that file with this inside its top-level object:')
    } else {
        Write-Line ('[install] file=' + $omoConfigPath)
        Write-Line ('[install] current_tmux_enabled=' + $tmuxEnabled)
        Write-Line ('[install] Add this inside its top-level "[opencode]" object:')
    }
    Write-Line '[install]'
    Write-Line '[install]     "[opencode]": { "tmux": { "enabled": true } }'
    Write-Line '[install]'
    Write-Line '[install] This key belongs to OmO, not to opencode, and it defaults to false, so'
    Write-Line '[install] a missing pane is otherwise indistinguishable from a broken install.'
    Write-Line '[install] The file is NOT necessarily the one named above: OmO reads'
    Write-Line '[install] $HOME/.omo/omo.jsonc when it exists, else omo.json, and it also merges'
    Write-Line '[install] project layers and a profile block (index.js:86113-86129, 88402-88405).'
    Write-Line '[install] If you set it and panes still do not appear, run'
    Write-Line '[install] bin\bridge-doctor.cmd  -- it is read-only and names which gate is'
    Write-Line '[install] responsible, and it reports the same file-resolution rules as this.'
    Write-Line '[install] =================================================================='
    Write-Line ''
}

Write-Line '[install] next=open a NEW terminal window (a running shell keeps its old PATH), then run: psmux'
exit 0
