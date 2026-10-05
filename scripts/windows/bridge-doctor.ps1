<#
.SYNOPSIS
    opencode-psmux bridge doctor -- read-only preflight that names WHICH silent
    failure is responsible for a subagent pane that never appears.

.DESCRIPTION
    When OmO spawns a subagent pane on Windows, exactly three mechanisms make
    it vanish with no error at all:

      GATE 1  PATH   `findVerifiedTmuxPath` (omo dist/index.js:9071-9083) resolves
                      the literal name `tmux` and requires `-V` to exit 0. If the
                      real psmux `tmux.exe` wins PATH resolution the bridge is
                      never used; if the bridge bin directory is absent the gate
                      logs "[spawnTmuxPane] SKIP: tmux not found" (index.js:8391).
      GATE 3  PORT   `isServerRunning` (index.js:8267-8294) fetches
                      `GET /global/health` and treats anything that is not `ok` as
                      "not running", logging "[spawnTmuxPane] SKIP: server not
                      running" (index.js:8387). `resolveServerUrl`
                      (index.js:150702-150706) falls back to `http://localhost:4096`
                      when OPENCODE_PORT is unset and the host server URL carries
                      port 0.
      GATE 0  CONFIG `[opencode].tmux.enabled` defaults to FALSE
                      (index.js:26719), which is why a stock Windows OmO produces
                      zero panes and no error.
      GATE 2  STALE  a psmux server is long-lived and its panes inherit ITS
                      environment; the client-side attach never transmits one. A
                      server started before the bridge existed cannot have the
                      bridge on its PATH, no matter what the shell has.

    This command reports all of them in one screen with one exit code.

    THE STALE-SERVER CHECK IS A HEURISTIC, NOT A PROOF.
    A server's environment is not queryable from a client, so the only
    non-connecting lever available is the modification time of the session's
    `<ns>__<name>.port` registry file compared against the installed shim's
    modification time. The check labels every one of its own lines
    `(heuristic)` and always prints its `false_negative=` condition.

    GUARANTEES -- what this command will never do:
      * it never writes to the registry, the filesystem PATH, or any config;
      * it never starts, signals, or kills a psmux server, session, or pane;
      * it never executes bin\tmux.exe (it stats and hashes it, nothing more);
      * it never enumerates the environment. It reads at most three named
        variables (OPENCODE_PORT, OPENCODE_SERVER, PSMUX_DATA_DIR) and reduces
        OPENCODE_SERVER to scheme://host:port before printing it, so a token
        embedded in a URL query string cannot reach the screen.

.PARAMETER BinDir
    Bridge bin directory. Defaults to the directory this script lives in.

.PARAMETER Session
    psmux session name for the stale-server check. Defaults to the content of
    `<data dir>\last_session`, then to `default`.

.PARAMETER Namespace
    psmux namespace for the stale-server check. Defaults to `default`.

.PARAMETER DataDir
    psmux data directory. Defaults to $env:PSMUX_DATA_DIR, then
    %USERPROFILE%\.psmux.

.PARAMETER ConfigPath
    OmO config. Defaults to %USERPROFILE%\.omo\omo.jsonc. Exists so the config
    check can be pointed at a scratch copy without touching the live file.

.PARAMETER ExpectedShimSha256
    sha256 the installed shim is expected to carry. A mismatch is reported as a
    NOTE, never as a failure: the shim is rebuilt during development, so its hash
    is expected to move.

.PARAMETER FrozenOmoVersion
    The version CONTRACT.md is frozen against. Reported on every run. This is
    5.1.18. CONTRACT.md section 0.1 states 5.1.17 "is not installed and must
    never be cited"; see check 5 for why the version-string comparison alone is
    insufficient and the line-anchor check is the load-bearing guard.

.PARAMETER KnownEquivalentOmoVersions
    Versions whose cited line numbers this repo has verified to be identical.
    A version in this set satisfies the version half of check 5 ONLY together
    with a clean line-anchor run.

.PARAMETER HealthTimeoutMs
    Per-probe HTTP timeout. Kept small: the whole run must stay under 10 s.

.NOTES
    Exit codes -- one per failing check, so a caller can branch on the cause:
        0   all checks passed
        1   unexpected internal error (see INTERNAL-ERROR at the tail)
        10  check 1 failed: bridge bin directory does not own `tmux` on PATH
        20  check 2 failed: STALE-SERVER (heuristic)
        30  check 3 failed: no OpenCode port resolution
        40  check 4 failed: [opencode].tmux.enabled is not true
        50  check 5 failed: installed OmO package drifted off the frozen version
      When more than one check fails, the LOWEST code is returned (the codes are
      assigned in report order, so the lowest code IS the first fault) and every
      failure is still printed.

    Timestamps ending in `Z` are UTC instants. `Z` is used rather than a numeric
    offset because PowerShell's `zzz` format specifier renders a UTC DateTime
    with the LOCAL offset, which prints a self-contradictory value such as
    `2026-10-03T08:40:51+08:00` for the instant 08:40:51Z. Do not "fix" that by
    hand: read the `Z` lines.

    All output is ASCII. This host's console codepage is BIG5, so a non-ASCII
    character would be mangled or lost on the way out.
#>
[CmdletBinding()]
param(
    [string] $BinDir,
    [string] $Session,
    [string] $Namespace = 'default',
    [string] $DataDir,
    [string] $ConfigPath,
    [string] $ExpectedShimSha256 = '9EA5E733FD78F4EA966A85A5CF062D1113C644FEFF80AD3B3084574c2BA2A858',
    [string] $FrozenOmoVersion = '5.1.18',
    [string[]] $KnownEquivalentOmoVersions = @('5.1.17', '5.1.18'),
    [int]    $HealthTimeoutMs = 2000
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::ASCII } catch { }

$script:Clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:exitCode = 0
$script:Failures = New-Object System.Collections.Generic.List[int]

# --------------------------------------------------------------------------- output
#
# NOTE ON CALL SHAPE, learned the hard way: every one of these is called as
#   Write-Line -Text ('a' + $b)
# with the concatenation PARENTHESISED. In PowerShell command mode
#   Write-Line 'a' + $b
# is three arguments -- 'a', '+', $b -- so `+` binds to -Prefix and the line
# renders as `+a` with the concatenated value silently dropped. That is the same
# argument-boundary class as recorded failure mode I-15/T-12c, reached from the
# other direction: not a shell splitting an argument, but PowerShell splitting an
# expression.

function Write-Line {
    param([string] $Text = '', [string] $Prefix = '       ')
    [Console]::Out.WriteLine($Prefix + $Text)
}

function Write-Rule { param([char] $C = '=') [Console]::Out.WriteLine((' ' * 70).Replace(' ', $C)) }

function Write-Verdict {
    param([string] $State, [int] $Number, [string] $Title)
    [Console]::Out.WriteLine('[' + $State + '] ' + $Number + ' ' + $Title)
}

function Write-Note  { param([string] $Text) Write-Line -Prefix '  NOTE  ' -Text $Text }
function Write-Warn  { param([string] $Text) Write-Line -Prefix '  WARN  ' -Text $Text }
function Write-Fix   { param([string] $Text) Write-Line -Prefix '  FIX   ' -Text $Text }
function Write-Cause { param([string] $Text) Write-Line -Prefix '  CAUSE ' -Text $Text }

# Trim to a single line and force ASCII, so a value from a file or an exception
# message can never corrupt the output or trip the BIG5 console.
function As-AsciiLine {
    param([string] $Text, [int] $Max = 200)
    if ($null -eq $Text) { return '' }
    $t = ($Text -replace "`r", ' ' -replace "`n", ' ' -replace "`t", ' ').Trim()
    $t = [System.Text.RegularExpressions.Regex]::Replace($t, '[^\x20-\x7E]', '?')
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) + '...' }
    return $t
}

# UTC instants get a literal Z. Never use zzz on a UTC DateTime here.
function Get-IsoUtc {
    param([datetime] $Value)
    return $Value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
}

# --------------------------------------------------------------------------- helpers

function Get-NormalizedPath {
    param([string] $Path)
    if ([string]::IsNullOrEmpty($Path)) { return '' }
    return $Path.Trim().TrimEnd('\', '/').Replace('/', '\')
}

function Get-SamePath {
    param([string] $A, [string] $B)
    return [string]::Equals((Get-NormalizedPath $A), (Get-NormalizedPath $B), [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-PathEntries {
    param([string] $Raw)
    if ([string]::IsNullOrEmpty($Raw)) { return @() }
    return @($Raw -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Test-BridgeBinEntry {
    param([string] $Entry)
    return [bool] ((Get-NormalizedPath $Entry) -imatch '(?i)[\\/](opencode-psmux-bridge)[\\/]bin$')
}

function Get-Sha256 {
    param([string] $Path)
    $h = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return [string]$h.Hash
}

# Reduce a URL to scheme://host[:port]/path with every query, fragment and
# userinfo dropped. The doctor never needs those, and they are where a token
# would live.
function Get-SafeUrlShape {
    param([string] $Url)
    if ([string]::IsNullOrEmpty($Url)) { return '<unset>' }
    try {
        $u = [System.Uri]$Url
        $s = $u.Scheme + '://' + $u.Host
        if (-not $u.IsDefaultPort) { $s = $s + ':' + [string]$u.Port }
        $p = $u.AbsolutePath
        if ($null -ne $p -and $p -ne '/' -and $p -ne '') { $s = $s + $p }
        return (As-AsciiLine -Text $s -Max 100)
    } catch {
        return '<set, unparseable as a URL; value withheld>'
    }
}

# A single raw HTTP GET over a fresh socket. Returns a hashtable with
#   Status  int    HTTP status, 0 when no status line came back
#   Body    string first 200 bytes of the body
#   Error   string '' when the socket produced a status line
# Proxy is disabled explicitly: the machine has VPN/filter drivers installed and
# a proxied loopback request can be dropped instead of refused.
#
# Only ports already known to be LISTENING are ever handed here. This host DROPS
# a connect to a closed loopback port (measured: a raw GET to 127.0.0.1:4096
# returns connect-timeout after the full budget, not ECONNREFUSED), so a blind
# probe of a dead port costs the whole timeout and would blow the 10 s budget.
function Invoke-RawHttpGet {
    param([string] $Host_, [int] $Port, [string] $Path, [int] $TimeoutMs = 2000)
    $r = @{ Status = 0; Body = ''; Error = '' }
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($Host_, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            $r.Error = 'connect-timeout'
            return $r
        }
        $client.EndConnect($iar)
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $stream.WriteTimeout = $TimeoutMs
        $req = 'GET ' + $Path + " HTTP/1.1`r`n" +
               'Host: ' + $Host_ + ':' + $Port + "`r`n" +
               "Accept: */*`r`n" +
               "Connection: close`r`n" +
               "User-Agent: opencode-psmux-bridge-doctor`r`n`r`n"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($req)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        $buf = New-Object byte[] 8192
        $sb = New-Object System.Text.StringBuilder
        $budget = [System.Diagnostics.Stopwatch]::StartNew()
        while ($budget.ElapsedMilliseconds -lt $TimeoutMs) {
            $n = 0
            try { $n = $stream.Read($buf, 0, $buf.Length) }
            catch { $r.Error = 'read-' + $_.Exception.GetType().Name; break }
            if ($n -le 0) { break }
            [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $n))
            if ($sb.Length -gt 4096) { break }
        }
        $txt = $sb.ToString()
        $sep = $txt.IndexOf("`r`n`r`n")
        if ($sep -gt 0) {
            $head = $txt.Substring(0, $txt.IndexOf("`r`n"))
            $body = $txt.Substring($sep + 4)
            if ($head -match 'HTTP/1\.[01] ([0-9]{3})') { $r.Status = [int]$Matches[1] } else { $r.Error = 'no-status-line' }
            $r.Body = As-AsciiLine -Text $body -Max 200
        } else {
            $r.Error = 'no-header-terminator'
            $r.Body = As-AsciiLine -Text $txt -Max 120
        }
    } catch {
        $r.Error = As-AsciiLine -Text ($_.Exception.GetType().Name + ': ' + $_.Exception.Message) -Max 120
    } finally {
        if ($null -ne $client) { try { $client.Close() } catch { } }
    }
    return $r
}

# Loopback listeners with the owning process name. Read-only: Get-NetTCPConnection
# reads the OS listener table and never acquires anything. Called exactly ONCE
# per run and its cost is measured into the report -- it is the slowest thing
# this command does (measured 1.6-2.2 s on this host).
function Get-LoopbackListeners {
    $result = @()
    try {
        $rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
    } catch {
        return $result
    }
    $names = @{}
    foreach ($row in $rows) {
        $addr = [string]$row.LocalAddress
        if ($addr -ne '127.0.0.1' -and $addr -ne '::1') { continue }
        $procId = 0
        if ($null -ne $row.OwningProcess) { $procId = [int]$row.OwningProcess }
        if (-not $names.ContainsKey($procId)) {
            try { $names[$procId] = (Get-Process -Id $procId -ErrorAction Stop).ProcessName }
            catch { $names[$procId] = '<exited>' }
        }
        $result += [pscustomobject]@{ Address = $addr; Port = [int]$row.LocalPort; Pid = $procId; Name = [string]$names[$procId] }
    }
    return $result
}

# JSONC -> JSON. Comment-aware AND string-aware: a naive stripper eats the `//`
# inside the `https://` of `$schema`, which would truncate the whole document.
#
# The lookahead cast MUST be [char]. `[Text]$Text[$i + 1]` does not mean
# "System.Text"; `[Text]` alone does not resolve to a type on this host
# (`[type]Text` throws "Unable to find type"), so the cast throws a RuntimeException
# and this function dies on the first character of any non-empty document --
# which made check 4 report every config as `unparseable`.
function Remove-JsoncComments {
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
    return $sb.ToString()
}

# Read only the wanted 1-based line numbers in one streaming pass. Used to prove
# the contract's frozen line numbers still resolve in the INSTALLED bundle, which
# catches a drift that a version string alone would hide.
#
# Returns a [hashtable] and NOTHING else on every path, so the caller never has
# to defend against $null.
function Get-SelectedLines {
    param([string] $Path, [int[]] $Wanted)
    $res = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $res }
    $max = 0
    foreach ($w in $Wanted) { if ($w -gt $max) { $max = $w } }
    $reader = $null
    try {
        $reader = New-Object System.IO.StreamReader -ArgumentList @($Path)
        $n = 0
        while ($n -lt $max) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { break }
            $n++
            if ($Wanted -contains $n) { $res[$n] = $line.Trim() }
        }
    } finally {
        if ($null -ne $reader) { try { $reader.Close() } catch { } }
    }
    return $res
}

# --------------------------------------------------------------------------- setup

if ([string]::IsNullOrEmpty($BinDir)) { $BinDir = $PSScriptRoot }
if ([string]::IsNullOrEmpty($BinDir) -and -not [string]::IsNullOrEmpty($MyInvocation.MyCommand.Path)) {
    $BinDir = [System.IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path)
}
if ([string]::IsNullOrEmpty($BinDir)) { $BinDir = Join-Path $env:LOCALAPPDATA 'opencode-psmux-bridge\bin' }
$BinDir = Get-NormalizedPath $BinDir
$ShimPath = Join-Path $BinDir 'tmux.exe'

if ([string]::IsNullOrEmpty($DataDir)) {
    if (-not [string]::IsNullOrEmpty($env:PSMUX_DATA_DIR)) { $DataDir = $env:PSMUX_DATA_DIR }
    else { $DataDir = Join-Path $env:USERPROFILE '.psmux' }
}
if ([string]::IsNullOrEmpty($ConfigPath)) { $ConfigPath = Join-Path $env:USERPROFILE '.omo\omo.jsonc' }

if ([string]::IsNullOrEmpty($Session)) {
    $lastSessionFile = Join-Path $DataDir 'last_session'
    $Session = 'default'
    if (Test-Path -LiteralPath $lastSessionFile) {
        try {
            $raw = [System.IO.File]::ReadAllText($lastSessionFile).Trim()
            if ($raw -ne '') { $Session = (As-AsciiLine -Text $raw -Max 80) }
        } catch { }
    }
}

function Add-Failure {
    param([int] $CheckNumber, [int] $Code)
    $script:Failures.Add($Code)
    if ($Code -lt $script:exitCode -or $script:exitCode -eq 0) { $script:exitCode = $Code }
}

# --------------------------------------------------------------------------- banner

Write-Rule
Write-Line -Text (' opencode-psmux bridge doctor  --  read-only preflight') -Prefix ''
Write-Line -Text (' run_at_utc=' + (Get-IsoUtc (Get-Date)) + '  run_at_local=' + (Get-Date).ToString("yyyy-MM-dd'T'HH:mm:sszzz") + '  host=' + $env:COMPUTERNAME + '  powershell=' + $PSVersionTable.PSVersion.ToString())
Write-Line -Text ' READ-ONLY: writes nothing, kills nothing, fixes nothing, starts nothing.'
Write-Line -Text ' No credential is printed: 3 named variables are read, none is enumerated.'
Write-Line -Text ' Exit map: 0=all-pass 10=PATH 20=STALE-SERVER(heuristic) 30=PORT 40=CONFIG 50=VERSION'
Write-Rule

try {

# =========================================================================== CHECK 1
# Is the bridge bin directory the FIRST PATH entry that can resolve the literal
# name `tmux`, and is tmux.exe present with its hash?

Write-Verdict '....' 1 'PATH ownership of the literal name `tmux`'
$shimExists = Test-Path -LiteralPath $ShimPath -PathType Leaf
$shimHash = ''
$shimSize = 0
$shimMtime = $null
$firstResolver = ''
$firstResolverIndex = -1
$binIndexEffective = -1
$binIndexUser = -1
$shadowsTmux = @()

$processEntries = @(Get-PathEntries ([Environment]::GetEnvironmentVariable('Path', 'Process')))
$userRaw = ''
try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    if ($null -ne $k) {
        $userRaw = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $k.Close()
    }
} catch { }
$userEntries = @(Get-PathEntries $userRaw)

for ($i = 0; $i -lt $processEntries.Count; $i++) {
    $e = $processEntries[$i]
    if (Get-SamePath $e $BinDir) { if ($binIndexEffective -lt 0) { $binIndexEffective = $i } }
    if (Test-BridgeBinEntry $e) { $shadowsTmux += $e }
    foreach ($cand in @('tmux.exe', 'tmux.cmd', 'tmux.bat')) {
        $f = Join-Path $e $cand
        if ((Test-Path -LiteralPath $f -PathType Leaf) -and $firstResolverIndex -lt 0) {
            $firstResolver = $f; $firstResolverIndex = $i
        }
    }
}
for ($i = 0; $i -lt $userEntries.Count; $i++) {
    if (Get-SamePath $userEntries[$i] $BinDir) { if ($binIndexUser -lt 0) { $binIndexUser = $i } }
}

Write-Line -Text ('bin_dir=' + $BinDir)
Write-Line -Text ('bin_dir_exists=' + (Test-Path -LiteralPath $BinDir))
Write-Line -Text ('process_path_entries=' + $processEntries.Count + '  user_path_entries=' + $userEntries.Count)
Write-Line -Text ('bin_dir_index_in_effective_path=' + $binIndexEffective + '  bin_dir_index_in_user_path=' + $binIndexUser)
Write-Line -Text ('first_path_entry_resolving_tmux=' + $(if ($firstResolverIndex -ge 0) { $firstResolver } else { '<none>' }))
if ($shimExists) {
    $shimItem = Get-Item -LiteralPath $ShimPath
    $shimSize = [int64]$shimItem.Length
    $shimMtime = $shimItem.LastWriteTimeUtc
    Write-Line -Text ('tmux.exe_present=yes  bytes=' + $shimSize + '  mtime_utc=' + (Get-IsoUtc $shimMtime))
    try { $shimHash = Get-Sha256 $ShimPath } catch { $shimHash = 'HASH-FAILED:' + (As-AsciiLine $_.Exception.Message) }
    Write-Line -Text ('tmux.exe_sha256=' + $shimHash)
    Write-Line -Text ('tmux.exe_expected_sha256=' + $ExpectedShimSha256)
    if ($shimHash -ceq $ExpectedShimSha256) {
        Write-Line -Text 'tmux.exe_sha256_match=YES (contract-recorded value, unmodified original)'
    } else {
        Write-Note  -Text 'tmux.exe_sha256_match=NO -- the shim is rebuilt during development, so its hash is'
        Write-Note  -Text 'expected to move. This is reported, never treated as a fault.'
    }
} else {
    Write-Line -Text 'tmux.exe_present=NO'
}

if ($shadowsTmux.Count -gt 0) {
    Write-Warn  -Text ('another opencode-psmux-bridge\bin is on the PATH: ' + ($shadowsTmux -join ' | '))
    Write-Cause -Text 'two directories owning the tmux/psmux names is a silent-failure factory'
}

$check1Ok = $shimExists -and (Get-SamePath $firstResolver $ShimPath)
if ($check1Ok) {
    Write-Verdict 'PASS ' 1 'PATH ownership of the literal name `tmux`'
    Write-Line -Text '       OmO finds `tmux` at the bridge, not at the real psmux.'
} else {
    Write-Verdict 'FAIL ' 1 'PATH ownership of the literal name `tmux`'
    if (-not $shimExists) {
        Write-Cause -Text 'no tmux.exe in the bridge bin directory'
        Write-Fix   -Text ('restore it: copy the compiled shim to ' + $ShimPath)
    }
    if (-not (Get-SamePath $firstResolver $ShimPath)) {
        Write-Cause -Text ('the first PATH entry that resolves `tmux` is ' + $firstResolver)
        Write-Cause -Text ('the bridge bin directory is not first (effective index ' + $binIndexEffective + ')')
        Write-Fix   -Text 're-run install.ps1, then OPEN A NEW SHELL (the PATH change is not retroactive)'
        Write-Fix   -Text 'never run this doctor from a shell started before the install'
    }
    Write-Line -Text ''
    Add-Failure -CheckNumber 1 -Code 10
}

# =========================================================================== CHECK 2
# STALE-SERVER (heuristic).

Write-Verdict '....' 2 'STALE-SERVER (heuristic)'
Write-Line -Text ('data_dir=' + $DataDir + '  exists=' + (Test-Path -LiteralPath $DataDir))
Write-Line -Text ('namespace=' + $Namespace + '  session=' + $Session)

$portFile = $null
$portCandidates = @()
if (Test-Path -LiteralPath $DataDir) {
    $exact = Join-Path $DataDir ($Namespace + '__' + $Session + '.port')
    if (Test-Path -LiteralPath $exact -PathType Leaf) {
        $portCandidates += $exact
    } else {
        $prefix = $Namespace + '__'
        $portCandidates += @(Get-ChildItem -LiteralPath $DataDir -Filter '*.port' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } |
            ForEach-Object { $_.FullName } |
            Sort-Object)
    }
}
if ($portCandidates.Count -gt 0) { $portFile = $portCandidates[0] }

Write-Line -Text 'A psmux server keeps its own environment for its whole life and its panes'
Write-Line -Text 'inherit THAT environment; a client attach never transmits one. A server'
Write-Line -Text 'started before the bridge existed therefore cannot have the bridge on its'
Write-Line -Text 'PATH, whatever the shell has. That is not observable directly, so the'
Write-Line -Text 'only non-connecting lever is file modification time:'
Write-Line -Text '  (heuristic) .port file OLDER than bin\tmux.exe => the server predates the bridge.'
Write-Line -Text 'Every line of this check is HEURISTIC and is never reported as proof.'

if ($null -eq $portFile) {
    Write-Line -Text 'registry_entry=NONE -- no live session for this namespace/session, so there is'
    Write-Line -Text 'no running server that could be stale. The check does not apply.'
    Write-Verdict 'PASS ' 2 'STALE-SERVER (heuristic) -- no live session to be stale'
    Write-Line -Text '       (heuristic) (absence of a fault is not proof that a server is healthy)'
} elseif ($null -eq $shimMtime) {
    Write-Line -Text ('registry_entry=' + (Split-Path $portFile -Leaf))
    Write-Line -Text 'comparison=SKIPPED (heuristic) -- no shim mtime to compare against.'
    Write-Verdict 'PASS ' 2 'STALE-SERVER (heuristic) -- not comparable, check 1 owns this fault'
    Write-Line -Text '       (heuristic) the missing shim is reported by check 1, not here.'
} else {
    if ($portCandidates.Count -gt 1) {
        $oldest = $portFile
        foreach ($extra in $portCandidates) {
            if ((Get-Item -LiteralPath $extra).LastWriteTimeUtc -lt (Get-Item -LiteralPath $oldest).LastWriteTimeUtc) { $oldest = $extra }
        }
        $portFile = $oldest
        Write-Line -Text ('  (heuristic) ' + $portCandidates.Count + ' sessions share namespace `' + $Namespace + '`; the OLDEST decides:')
        foreach ($extra in $portCandidates) {
            $ei = Get-Item -LiteralPath $extra
            Write-Line -Text ('    ' + (Split-Path $extra -Leaf) + ' mtime_utc=' + (Get-IsoUtc $ei.LastWriteTimeUtc))
        }
    }
    $portItem = Get-Item -LiteralPath $portFile
    $portMtime = $portItem.LastWriteTimeUtc
    $portValue = ''
    try { $portValue = [System.IO.File]::ReadAllText($portFile).Trim() } catch { $portValue = '<unreadable>' }
    Write-Line -Text ('registry_entry=' + (Split-Path $portFile -Leaf) + '  port=' + $portValue)
    Write-Line -Text ('  (heuristic) A=' + (Split-Path $portFile -Leaf) + '  mtime_utc=' + (Get-IsoUtc $portMtime))
    Write-Line -Text ('  (heuristic) B=' + (Split-Path $ShimPath -Leaf) + '  mtime_utc=' + (Get-IsoUtc $shimMtime))
    $deltaSec = ($shimMtime - $portMtime).TotalSeconds
    Write-Line -Text ('  (heuristic) delta (B - A) = ' + [Math]::Round($deltaSec, 3) + ' s')
    if ($deltaSec -gt 0) {
        Write-Verdict 'FAIL ' 2 'STALE-SERVER (heuristic)'
        Write-Line -Text ('       (heuristic) ' + (Split-Path $portFile -Leaf) + ' is OLDER than bin\tmux.exe by ' + [Math]::Round($deltaSec, 0) + ' s,')
        Write-Line -Text '       (heuristic) so the running server was started before the bridge existed and'
        Write-Line -Text '       cannot have the bridge on its PATH. Its panes will fail the tmux gate'
        Write-Line -Text '       and vanish with no error. This is an inference from two mtimes, not a probe.'
        Write-Cause -Text 'the psmux server outlived the bridge install'
        Write-Fix   -Text ('kill it and start a fresh one:  psmux kill-server -t ' + $Session)
        Write-Fix   -Text ('or, if the session must survive, route it through a private namespace:')
        Write-Fix   -Text ('    psmux -L ' + $Namespace + ' ...   (panes then resolve their own PATH)')
        Write-Line -Text ''
        Add-Failure -CheckNumber 2 -Code 20
    } else {
        Write-Verdict 'PASS ' 2 'STALE-SERVER (heuristic)'
        Write-Line -Text ('       (heuristic) the session registry entry is ' + [Math]::Round((-1 * $deltaSec), 0) + ' s NEWER than the shim,')
        Write-Line -Text '       (heuristic) so this server was not started before the bridge install, as far'
        Write-Line -Text '       (heuristic) as mtime can tell.'
    }
}
# The spec requires the false-negative condition in ONE line, and it must be
# present on every run whether this check passed or failed.
Write-Line -Text 'false_negative=(heuristic) a server started after the install but before a PATH change will NOT be detected.'
Write-Line -Text 'false_positive=(heuristic) if the shim is REBUILT while a healthy server runs, the shim'
Write-Line -Text '                (heuristic) mtime moves forward and that server looks stale. Re-check with a'
Write-Line -Text '                (heuristic) fresh server before acting on a FAIL.'

# Residue is EXPECTED. psmux's reaper lives inside the server process (300 s), so
# `instances\` and `servers\` survive every dead server and are not a fault.
$residue = @()
if (Test-Path -LiteralPath $DataDir) {
    foreach ($d in @('instances', 'servers')) {
        $dp = Join-Path $DataDir $d
        if (Test-Path -LiteralPath $dp -PathType Container) {
            $n = @(Get-ChildItem -LiteralPath $dp -Force -ErrorAction SilentlyContinue).Count
            $residue += ($d + '\=' + $n + ' entries')
        }
    }
}
if ($residue.Count -gt 0) {
    # NOTE the parentheses. Unparenthesised, `+` binds to -Prefix (see the note
    # above Write-Line) and the residue values are silently dropped.
    Write-Line -Text ('psmux residue present (EXPECTED, not a fault): ' + ($residue -join '  '))
    Write-Line -Text '  psmux reaps it from inside a running server, every 300 s; nothing reaps it'
    Write-Line -Text '  once every server is dead. kill-session removes <ns>__<n>.{key,pid,port,sid}'
    Write-Line -Text '  and deliberately leaves instances\ and servers\ behind.'
}

# =========================================================================== CHECK 3
# Port resolution. Pass = OPENCODE_PORT is set, OR a listening endpoint answers
# GET /global/health on the port OmO would use.

Write-Verdict '....' 3 'OpenCode port resolution (GET /global/health)'
$envPortRaw = ''
if (-not [string]::IsNullOrEmpty($env:OPENCODE_PORT)) { $envPortRaw = [string]$env:OPENCODE_PORT }
if ([string]::IsNullOrEmpty($envPortRaw)) {
    $u = [Environment]::GetEnvironmentVariable('OPENCODE_PORT', 'User')
    if (-not [string]::IsNullOrEmpty($u)) { $envPortRaw = [string]$u }
}
$envPort = 0
$envPortValid = $false
if ($envPortRaw -match '^[0-9]{1,5}$') {
    $n = [int]$envPortRaw
    if ($n -ge 1 -and $n -le 65535) { $envPort = $n; $envPortValid = $true }
}
# omo dist/index.js:150704 -- `configuredPort ? Number(configuredPort) : 4096`.
$FallbackPort = 4096
Write-Line -Text ('OPENCODE_PORT=' + $(if ($envPortValid) { [string]$envPort } elseif ([string]::IsNullOrEmpty($envPortRaw)) { '<unset>' } else { '<' + (As-AsciiLine $envPortRaw -Max 40) + '> (not a usable port)' }))
Write-Line -Text ('OPENCODE_SERVER=' + (Get-SafeUrlShape $env:OPENCODE_SERVER) + '  (query/fragment/userinfo withheld)')
Write-Line -Text ('fallback_port_used_by_omo=' + $FallbackPort + ' (index.js:150704, when OPENCODE_PORT is unset)')

# Only ports the OS says are LISTENING are probed. This host DROPS a connect to a
# closed loopback port instead of refusing it, so a blind probe of a dead port
# costs the full timeout and would blow the 10 s budget.
$listenerClock = [System.Diagnostics.Stopwatch]::StartNew()
$listeners = @(Get-LoopbackListeners)
$listenerMs = $listenerClock.ElapsedMilliseconds
Write-Line -Text ('loopback_listeners=' + $listeners.Count + '  listener_table_read_ms=' + $listenerMs)
$probePort = 0
$probeLabel = ''
$healthOk = $false
$healthStatus = 0
$healthError = ''

if ($envPortValid) {
    $probePort = $envPort
    $probeLabel = 'OPENCODE_PORT'
} else {
    $inBand = @($listeners | Where-Object { $_.Port -eq $FallbackPort })
    $owner = @($listeners | Where-Object { $_.Name -like 'opencode*' })
    if ($inBand.Count -gt 0) { $probePort = $FallbackPort; $probeLabel = 'omo-fallback' }
    elseif ($owner.Count -gt 0) { $probePort = [int]($owner | Select-Object -First 1).Port; $probeLabel = 'opencode-listener' }
}

if ($probePort -gt 0) {
    $health = Invoke-RawHttpGet -Host_ '127.0.0.1' -Port $probePort -Path '/global/health' -TimeoutMs $HealthTimeoutMs
    $healthStatus = $health.Status
    $healthError = $health.Error
    if ($healthStatus -ge 200 -and $healthStatus -lt 300) { $healthOk = $true }
    Write-Line -Text ('probed http://127.0.0.1:' + $probePort + '/global/health  (' + $probeLabel + ')')
    Write-Line -Text ('  http_status=' + $(if ($healthStatus -gt 0) { [string]$healthStatus } else { 'none' }) + '  transport=' + $(if ($healthError -eq '') { 'ok' } else { $healthError }))
    if ($health.Body -ne '') { Write-Line -Text ('  body=[' + $health.Body + ']') }
    $ocListeners = @($listeners | Where-Object { $_.Name -like 'opencode*' })
    if ($ocListeners.Count -gt 0) {
        foreach ($ol in $ocListeners) {
            Write-Line -Text ('opencode listener: ' + $ol.Address + ':' + $ol.Port + ' pid=' + $ol.Pid + ' name=' + $ol.Name)
        }
    }
    if (-not $healthOk -and $healthStatus -gt 0) {
        Write-Warn  -Text ('the OpenCode server on ' + $probePort + ' answered HTTP ' + $healthStatus + ' to /global/health')
        Write-Cause -Text 'omo isServerRunning (index.js:8267-8294) accepts only `response.ok`, so a'
        Write-Cause -Text 'non-2xx reads as "not running" and every pane is skipped with'
        Write-Cause -Text '"[spawnTmuxPane] SKIP: server not running" (index.js:8387).'
        Write-Warn  -Text 'this is a property of the OpenCode server build, separate from port'
        Write-Warn  -Text 'resolution; it is reported, and it does not change this check verdict.'
    }
} else {
    Write-Line -Text ('probed NOTHING -- OPENCODE_PORT is unset, nothing listens on the OmO fallback')
    Write-Line -Text ('port ' + $FallbackPort + ', and no opencode process holds a loopback port.')
}

$check3Ok = $envPortValid -or $healthOk
if ($check3Ok) {
    Write-Verdict 'PASS ' 3 'OpenCode port resolution'
    if ($envPortValid -and -not $healthOk) {
        Write-Line -Text ('OPENCODE_PORT=' + $envPort + ' is set, so OmO resolves a concrete server URL')
        Write-Line -Text ('instead of falling back to http://localhost:' + $FallbackPort + '.')
        if ($healthStatus -gt 0) {
            Write-Warn  -Text ('set, but /global/health answered HTTP ' + $healthStatus + ' on that port. OmO will still')
            Write-Warn  -Text 'skip every pane. Read the WARN above; this verdict is about RESOLUTION.'
        } else {
            Write-Warn  -Text ('set, but nothing answered /global/health on port ' + $probePort + ' (' + $healthError + ').')
        }
    } elseif ($healthOk) {
        Write-Line -Text ('a listening OpenCode health endpoint answers HTTP ' + $healthStatus + ' on port ' + $probePort + '.')
    }
    Write-Line -Text '       verdict = port RESOLUTION is not your silent cause (see any WARN above)'
} else {
    Write-Verdict 'FAIL ' 3 'OpenCode port resolution'
    Write-Cause -Text ('OPENCODE_PORT is unset and no OpenCode health endpoint answered on port ' + $FallbackPort + '.')
    Write-Cause -Text 'omo would resolve http://localhost:4096, fetch /global/health, get nothing,'
    Write-Cause -Text 'and skip every pane with no user-visible error.'
    Write-Fix   -Text 'start the server with an explicit port and export it for the same shell:'
    Write-Fix   -Text '  set OPENCODE_PORT=<n>   then   opencode --port <n>'
    Write-Fix   -Text 'opencode prints this remedy itself (index.js:150712, issue #3963).'
    Write-Line -Text ''
    Add-Failure -CheckNumber 3 -Code 30
}

# =========================================================================== CHECK 4
# Does the config contain [opencode].tmux.enabled == true?

Write-Verdict '....' 4 'OmO config [opencode].tmux.enabled'
Write-Line -Text ('config=' + $ConfigPath + '  exists=' + (Test-Path -LiteralPath $ConfigPath -PathType Leaf))
$configKey = '[opencode].tmux.enabled'
$configOk = $false
$configState = 'missing'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Write-Line -Text 'the config file does not exist, so [opencode].tmux.enabled is at its default.'
} else {
    $cfgItem = Get-Item -LiteralPath $ConfigPath
    Write-Line -Text ('bytes=' + $cfgItem.Length + '  mtime_utc=' + (Get-IsoUtc $cfgItem.LastWriteTimeUtc))
    $raw = ''
    try { $raw = [System.IO.File]::ReadAllText($ConfigPath) } catch { $raw = '' }
    $json = $null
    $parseError = ''
    try {
        $stripped = Remove-JsoncComments $raw
        $json = $stripped | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $parseError = As-AsciiLine -Text $_.Exception.Message -Max 160
        $json = $null
    }
    if ($null -eq $json) {
        $configState = 'unparseable'
        Write-Line -Text ('jsonc_parse=FAILED  ' + $parseError)
    } else {
        Write-Line -Text ('jsonc_parse=OK  stripped_bytes=' + (Remove-JsoncComments $raw).Length + ' of ' + $raw.Length + '  (comment+string aware; a `https://` in $schema survives)')
        $opencodeNode = $json.PSObject.Properties['[opencode]']
        if ($null -eq $opencodeNode) {
            $configState = 'no-opencode-node'
            Write-Line -Text 'key=[opencode] is ABSENT from the document, so tmux is at its default.'
        } else {
            $tmuxNode = $opencodeNode.Value.PSObject.Properties['tmux']
            if ($null -eq $tmuxNode) {
                $configState = 'no-tmux-node'
                Write-Line -Text 'key=[opencode].tmux is ABSENT, so tmux is at its default.'
            } else {
                Write-Line -Text 'tmux keys as configured:'
                foreach ($p in $tmuxNode.Value.PSObject.Properties) {
                    $v = $p.Value
                    if ($v -is [string]) { $v = '"' + $v + '"' } elseif ($v -is [bool]) { $v = [string]$v }
                    Write-Line -Text ('  [opencode].tmux.' + $p.Name + ' = ' + $v)
                }
                $enabledNode = $tmuxNode.Value.PSObject.Properties['enabled']
                if ($null -eq $enabledNode) {
                    $configState = 'enabled-absent'
                    Write-Line -Text 'key=[opencode].tmux.enabled is ABSENT, so it defaults to false.'
                } else {
                    $configState = 'set'
                    if ($enabledNode.Value -is [bool] -and $enabledNode.Value) {
                        $configOk = $true
                        Write-Line -Text '[opencode].tmux.enabled = true   (observed literally in the parsed document)'
                    } else {
                        Write-Line -Text ('[opencode].tmux.enabled = ' + (As-AsciiLine -Text ([string]$enabledNode.Value) -Max 40) + '   (type=' + $enabledNode.Value.GetType().Name + ')')
                    }
                }
            }
        }
    }
}

if ($configOk) {
    Write-Verdict 'PASS ' 4 'OmO config [opencode].tmux.enabled'
    Write-Line -Text '       gate one is open: OmO will attempt to spawn panes.'
} else {
    Write-Verdict 'FAIL ' 4 'OmO config [opencode].tmux.enabled'
    Write-Cause -Text ('key ' + $configKey + ' is not true (state: ' + $configState + ') in ' + $ConfigPath)
    Write-Cause -Text 'omo reads [opencode].tmux.enabled with default(false) (index.js:26719), so a'
    Write-Cause -Text 'false value is not an error -- it silently produces zero panes.'
    Write-Fix   -Text ('set ' + $configKey + ' = true in ' + $ConfigPath)
    Write-Fix   -Text 'this doctor does not edit the config for you, on purpose.'
    Write-Line -Text ''
    Add-Failure -CheckNumber 4 -Code 40
}

# =========================================================================== CHECK 5
# Does the installed OmO package still match the contract's frozen version?
#
# The drift detector that does NOT trust the version string: the contract's cited
# line numbers must still resolve, in the INSTALLED bundle, to the same
# constructs. That is the load-bearing half of this check.
#
# Stored as an ARRAY OF OBJECTS, not an [ordered] dictionary. `$od[8227]` on an
# OrderedDictionary is the POSITIONAL indexer, so an out-of-range line number
# yields $null rather than throwing; the next line then called
# `$null.Replace('*','')`, raised InvokeMethodOnNull, and aborted the whole script
# at check 5 with exit 1 before any summary was printed.

Write-Verdict '....' 5 'OmO package version drift'
Write-Line -Text ('contract_frozen_version=' + $FrozenOmoVersion + '  (CONTRACT.md section 0.1)')
Write-Line -Text ('known_equivalent_versions=' + ($KnownEquivalentOmoVersions -join ',') + '  (same line numbers verified)')

$pkgRoot = Join-Path $env:USERPROFILE '.cache\opencode\packages'
$pkgPath = ''
$installedVersion = ''
$candidates = @()
$latestPkg = Join-Path $pkgRoot 'oh-my-openagent@latest\node_modules\oh-my-openagent\package.json'
if (Test-Path -LiteralPath $latestPkg) { $candidates += $latestPkg }
if (Test-Path -LiteralPath $pkgRoot) {
    foreach ($d in @(Get-ChildItem -LiteralPath $pkgRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
        if ($d.Name -like 'oh-my-openagent*') {
            $p = Join-Path $d.FullName 'node_modules\oh-my-openagent\package.json'
            if (Test-Path -LiteralPath $p) { $candidates += $p }
        }
    }
}
# Dedupe: the `@latest` probe above and the directory scan below name the same
# file, and the same path printed twice reads as two different installations.
$seen = @{}
$candidates = @($candidates | Where-Object { $k = (Get-NormalizedPath $_); if ($seen.ContainsKey($k)) { $false } else { $seen[$k] = $true; $true } })
foreach ($p in $candidates) {
    $v = ''
    try {
        $j = [System.IO.File]::ReadAllText($p) | ConvertFrom-Json -ErrorAction Stop
        if ($null -ne $j.PSObject.Properties['version']) { $v = [string]$j.version }
    } catch { }
    Write-Line -Text ('candidate=' + $p + '  version=' + $(if ($v -ne '') { $v } else { '<unreadable>' }))
    if ($pkgPath -eq '' -and $v -ne '') { $pkgPath = $p; $installedVersion = $v }
}

$anchors = @(
    [pscustomobject]@{ Line = 8227;  Text = 'function isInsideTmuxEnvironment(environment) {' }
    [pscustomobject]@{ Line = 8267;  Text = 'async function isServerRunning(serverUrl, options = {}) {' }
    [pscustomobject]@{ Line = 8279;  Text = 'const healthUrl = new URL("/global/health", serverUrl).toString();' }
    [pscustomobject]@{ Line = 8385;  Text = 'const serverRunning = await deps.isServerRunning(serverUrl);' }
    [pscustomobject]@{ Line = 8390;  Text = 'const tmux = await deps.getTmuxPath();' }
    [pscustomobject]@{ Line = 9071;  Text = 'async function findVerifiedTmuxPath() {' }
    [pscustomobject]@{ Line = 9077;  Text = 'const verifyProc = spawn([path, "-V"], {' }
    [pscustomobject]@{ Line = 9083;  Text = 'if (verifyExitCode !== 0) {' }
    [pscustomobject]@{ Line = 26719; Text = 'enabled: z48.boolean().default(false),' }
    [pscustomobject]@{ Line = 150702; Text = 'function resolveServerUrl(rawServerUrl, env, log) {' }
    [pscustomobject]@{ Line = 150712; Text = 'log("[tmux-session-manager] ctx.serverUrl has port 0; falling back. "' }
)
$indexPath = ''
if ($pkgPath -ne '') { $indexPath = Join-Path (Split-Path $pkgPath -Parent) 'dist\index.js' }
$driftLines = @()
$anchorHits = 0
if ($indexPath -ne '' -and (Test-Path -LiteralPath $indexPath)) {
    Write-Line -Text ('bundle=' + $indexPath)
    $want = @($anchors | ForEach-Object { [int]$_.Line })
    $got = Get-SelectedLines -Path $indexPath -Wanted $want
    Write-Line -Text ('anchors_requested=' + $want.Count + '  anchors_returned=' + $got.Count)
    foreach ($a in $anchors) {
        $n = [int]$a.Line
        if (-not $got.ContainsKey($n)) {
            $driftLines += ('line ' + $n + ' is past the end of the bundle (expected `' + $a.Text + '`)')
        } elseif (([string]$got[$n]).StartsWith($a.Text, [System.StringComparison]::Ordinal)) {
            # Ordinal StartsWith, NOT -like. An anchor is source text and may contain
            # `[` `]` -- `-like` would read `[tmux-session-manager]` as a character
            # class, and the `-` inside it makes that an invalid range, so -like
            # throws WildcardPatternException on the very anchor that proves the
            # silent-failure path still exists.
            $anchorHits++
            Write-Line -Text ('  anchor_ok  L' + $n + ': ' + $a.Text)
        } else {
            $driftLines += ('line ' + $n + ' drifted: expected `' + $a.Text + '`, found `' + (As-AsciiLine -Text $got[$n] -Max 90) + '`')
        }
    }
    Write-Line -Text ('frozen_line_anchors_resolved=' + $anchorHits + '/' + $anchors.Count)
} else {
    Write-Line -Text 'bundle=NOT-FOUND -- line-number drift cannot be checked'
    $driftLines += 'the OmO dist bundle was not found at ' + $indexPath
}

$versionKnown = $false
$versionBasis = 'version-not-found'
if ($installedVersion -ne '') {
    if ($installedVersion -ceq $FrozenOmoVersion) {
        $versionKnown = $true
        $versionBasis = 'version-equality (equals the frozen version exactly)'
    } elseif ($KnownEquivalentOmoVersions -contains $installedVersion) {
        $versionKnown = $true
        $versionBasis = 'version-equivalence (a verified line-identical build, NOT the frozen string)'
    } else {
        $versionBasis = 'version-outside-known-set'
    }
}
Write-Line -Text ('installed_version=' + $(if ($installedVersion -ne '') { $installedVersion } else { '<not found>' }))
Write-Line -Text ('verdict_basis=' + $versionBasis)
if ($installedVersion -ne '' -and $versionKnown -and $installedVersion -ne $FrozenOmoVersion) {
    Write-Note  -Text ('installed ' + $installedVersion + ' is NOT the version CONTRACT.md freezes (' + $FrozenOmoVersion + ').')
    Write-Note  -Text ('It is accepted only because every one of the ' + $anchors.Count + ' cited line anchors resolves')
    Write-Note  -Text 'in the installed bundle (see frozen_line_anchors_resolved above). CONTRACT.md'
    Write-Note  -Text 'section 0.1 forbids citing ' + $installedVersion + ' as the frozen version; it is cited'
    Write-Note  -Text 'here only as an observed package.json value.'
}

if ($installedVersion -ne '' -and $versionKnown -and $driftLines.Count -eq 0) {
    Write-Verdict 'PASS ' 5 'OmO package version drift'
    Write-Line -Text ('       the installed bundle still answers to every contract citation (' + $versionBasis + ').')
} else {
    Write-Verdict 'FAIL ' 5 'OmO package version drift'
    if ($installedVersion -eq '') {
        Write-Cause -Text ('no installed oh-my-openagent package.json was readable under ' + $pkgRoot)
    } elseif (-not $versionKnown) {
        Write-Cause -Text ('installed version ' + $installedVersion + ' is neither the frozen ' + $FrozenOmoVersion)
        Write-Cause -Text ('nor a verified line-identical build (' + ($KnownEquivalentOmoVersions -join ',') + ')')
        Write-Cause -Text 'the contract is frozen against ' + $FrozenOmoVersion + ', whose line numbers this check'
        Write-Cause -Text 're-verifies against the bundle actually installed.'
    }
    foreach ($d in $driftLines) { Write-Cause -Text $d }
    Write-Fix   -Text 're-derive the contract citations against the installed version, then update'
    Write-Fix   -Text 'the frozen version. Todo 21 owns that table; do not widen it to silence this.'
    Write-Line -Text ''
    Add-Failure -CheckNumber 5 -Code 50
}

# --------------------------------------------------------------------------- summary

Write-Rule
$passed = 5 - $script:Failures.Count
Write-Line -Text ('RESULT: ' + $passed + '/5 checks PASS   failures=' + $script:Failures.Count)
Write-Line -Text ('passed=' + $passed + '  failed=' + $script:Failures.Count)
if ($script:Failures.Count -gt 0) {
    Write-Line -Text ('first_failing_check_code=' + $script:exitCode)
    Write-Line -Text 'exit code map: 10=PATH 20=STALE-SERVER(heuristic) 30=PORT 40=CONFIG 50=VERSION'
}
if ($script:exitCode -eq 0) { Write-Line -Text 'verdict=PASS' }
else { Write-Line -Text ('verdict=FAIL code=' + $script:exitCode) }
Write-Line -Text ('elapsed_ms=' + $script:Clock.ElapsedMilliseconds)
Write-Line -Text ('exit=' + $script:exitCode)
Write-Rule

} catch {
    # A doctor that dies mid-report is the worst possible failure mode: the exit
    # code becomes PowerShell's 1, which collides with nothing but explains
    # nothing. Report it as INTERNAL-ERROR with the type and where it happened.
    Write-Rule
    Write-Line -Text 'INTERNAL-ERROR: the doctor could not complete a check.'
    Write-Line -Text ('  exception=' + $_.Exception.GetType().FullName)
    Write-Line -Text ('  message=' + (As-AsciiLine -Text $_.Exception.Message -Max 300))
    Write-Line -Text ('  at=' + (As-AsciiLine -Text $_.InvocationInfo.PositionMessage -Max 300))
    Write-Line -Text ('  script_line=' + $_.InvocationInfo.ScriptLineNumber)
    Write-Line -Text '  this is a DEFECT in the doctor, not a verdict about your setup.'
    Write-Line -Text ('elapsed_ms=' + $script:Clock.ElapsedMilliseconds)
    Write-Line -Text 'verdict=FAIL code=1'
    Write-Line -Text 'exit=1'
    Write-Rule
    $script:exitCode = 1
}

exit $script:exitCode