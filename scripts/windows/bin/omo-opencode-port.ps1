<#
.SYNOPSIS
    psmux bridge - `opencode` port wrapper helper.

.DESCRIPTION
    Mirrors the Linux reference implementation at ~/.bashrc (the `opencode()`
    function plus `_omo_pick_port`), but performs the port probe with a real
    bind instead of a liveness check.

    Decision order (mirrors the bash reference EXACTLY):
      1. TMUX unset/empty                     -> exec real opencode, unchanged.
      2. any arg is --port | --port=* | -h | --help | -v | --version
                                              -> exec real opencode, unchanged.
      3. first arg is one of the passthrough subcommands
                                              -> exec real opencode, unchanged.
      4. OPENCODE_PORT is all digits (incl. "0") -> use it verbatim.
      5. otherwise bind 127.0.0.1:<n> for n in 7801..7901, close the listener
         on the FIRST success, and exec real opencode with BOTH
         `--port <n>` and OPENCODE_PORT=<n>.
      6. if 7801..7901 is exhausted -> print a clear error and exit non-zero
         WITHOUT launching anything.

    Reservation protocol: bind -> close -> exec, with AT MOST ONE retry from the
    next port. A .cmd cannot hold a socket open across an exec, so the reserved
    port is unguarded from the instant the probe closes until the instant the
    child binds it. Another process can take the port in that window, so the
    wrapper watches for that and recovers:

      a. PRE-FLIGHT RE-CHECK. The port is re-probed with a real bind
         IMMEDIATELY BEFORE the exec. If it is gone, no child is launched at
         all; the retry port is chosen instead. Costs one bind, before any
         child exists, so it cannot collide with anything.
      b. BOUNDED LIVENESS WAIT. After the exec the wrapper watches the reserved
         port until one of three things is established:
           * the child owns it -> healthy: stop watching and wait for the child
             to exit, exactly as this wrapper always did;
           * the child exited -> the pre-existing exit-status rules decide
             whether the failure was EADDRINUSE-equivalent;
           * the port is held by a process that is NOT our child -> the child was
             starved of the port it was reserved, so it is terminated at once
             (the fact is already proven; there is nothing to wait out) and the
             ONE permitted retry runs.
         When ownership cannot be read at all, $BindWaitMs is the deadline: one
         definitive bind probe then decides. Held by somebody => starved, retry.
         Free => not a steal, so keep waiting exactly as before.

    Why the trigger cannot be the child's exit status: real opencode, handed a
    port that somebody already holds, does not exit and prints nothing - it
    stays alive indefinitely having written 0 bytes. A WaitForExit() therefore
    never returns and any exit-status test is unreachable by construction.
    That was measured, not assumed: the port was stolen 88 ms after the first
    child appeared, retry_message_count came back 0, and the child was still
    alive and silent at 15 s. See
    .omo/evidence/task-7-realbin-omo-psmux-windows-parity.txt section C2a,
    and .omo/evidence/task-23-omo-psmux-windows-parity.txt.

    Two invariants the liveness wait keeps:
      * It never probes by BINDING. A bind probe is a real acquisition of the
        port, so probing with one while the child is racing for the same port
        could hand the child an EADDRINUSE - the exact failure this code exists
        to prevent. The wait therefore reads the OS listener table
        (IPGlobalProperties.GetActiveTcpListeners, then Get-NetTCPConnection for
        the owning pid), which is read-only and cannot take the port away from
        anybody. Binding remains the only free-ness oracle and is only ever
        done before a child exists.
      * A child is terminated only on POSITIVE evidence that it does not own
        the port reserved for it. A port that nobody is listening on at the
        deadline is NOT evidence of a steal - a slow-starting or server-less
        opencode looks exactly like that - so the wrapper keeps waiting instead
        of killing a healthy session.

.NOTES
    All wrapper diagnostics go to STDERR so that stdout stays byte-identical to
    the real opencode in every case (the bash reference writes them to stdout;
    stderr is a deliberate, strictly safer deviation and does not alter any
    decision the reference makes).
#>

$ErrorActionPreference = 'Stop'

$PortMin = 7801
$PortMax = 7901

# Bounded liveness wait. Measured on this host: a healthy opencode takes
# 1756-1834 ms from process creation to owning its reserved port (n=6, see
# .omo/evidence/task-23-omo-psmux-windows-parity.txt section 3). $BindWaitMs
# is the deadline after which a port that is held but whose owner cannot be
# established is treated as stolen and the single retry is spent. It is only
# ever reached when ownership cannot be read at all; when it can be read, a
# steal is detected the moment the foreign owner appears. 10 s is ~5x the
# worst healthy bind latency measured here, so even with attribution broken no
# healthy child is at risk, and it caps the silent-hang window at 10 s instead
# of forever.
$BindPollMs = 250
$BindWaitMs = 10000

# Exact subcommand list from ~/.bashrc (case `case "${1:-}" in ...`).
$PassthroughSubcommands = @(
    'completion', 'acp', 'mcp', 'attach', 'run', 'debug', 'providers', 'auth',
    'agent', 'upgrade', 'uninstall', 'serve', 'web', 'models', 'stats', 'export',
    'import', 'github', 'pr', 'session', 'plugin', 'plug', 'db'
)

# Exact short-circuit flag list from ~/.bashrc (case "$a" in --port|--port=*|-h|--help|-v|--version).
$PassthroughFlags = @('--port', '-h', '--help', '-v', '--version')

$MsgExhausted = '[opencode-wrapper] no free port in 7801-7901; refusing to start'

function Write-Err([string]$message) {
    [Console]::Error.WriteLine($message)
}

<#
.SYNOPSIS
    Convert a single argument to its Windows command-line (CommandLineToArgvW
    inverse) representation. This is the lossless quoting algorithm: no cmd.exe
    metacharacter expansion, no PowerShell re-parsing.
#>
function ConvertTo-CommandLineArgument {
    param([AllowNull()][AllowEmptyString()][string]$Value)

    if ($null -eq $Value) { return '""' }
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * ($backslashes * 2 + 1))
            [void]$sb.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$sb.Append('\' * $backslashes)
            $backslashes = 0
        }
        [void]$sb.Append($ch)
    }
    [void]$sb.Append('\' * ($backslashes * 2))
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Join-CommandLineArguments {
    param([string[]]$ArgumentList)
    $parts = @()
    foreach ($a in $ArgumentList) { $parts += (ConvertTo-CommandLineArgument $a) }
    return ($parts -join ' ')
}

<#
.SYNOPSIS
    Locate a Windows PowerShell host for the opencode.ps1 fallback branch.
    Handles the 32-bit-on-64-bit System32 redirection (Sysnative).
#>
function Find-PowerShellHost {
    $root = $env:SystemRoot
    if (-not $root) { $root = 'C:\Windows' }
    $candidates = @()
    if ($env:PROCESSOR_ARCHITEW6432) {
        $candidates += (Join-Path $root 'Sysnative\WindowsPowerShell\v1.0\powershell.exe')
    }
    $candidates += (Join-Path $root 'System32\WindowsPowerShell\v1.0\powershell.exe')
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    $cmd = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

<#
.SYNOPSIS
    Resolve the REAL opencode, never this wrapper.

.DESCRIPTION
    Resolution order, each step skipping this wrapper's own directory so the
    wrapper cannot resolve itself once todo 8 puts the bridge bin dir first on
    PATH:
      1. <APPDATA>\npm\node_modules\opencode-ai\bin\opencode.exe - the payload
         every npm shim on this host execs (verified: opencode.cmd,
         opencode.ps1 and the extensionless shim all point here).
      2. A quoted *.exe path parsed out of the npm shims, with $basedir /
         %~dp0 / %dp0% resolved against the npm root.
      3. PATH scan, preferring opencode.exe, then opencode.cmd, then
         opencode.ps1.

    Returns a PSCustomObject with Path and Kind ('exe' | 'cmd' | 'ps1'), or
    $null. Kind selects the launch form, because CreateProcess cannot execute
    .cmd/.ps1 directly.
#>
function Resolve-RealOpencode {
    $selfDir = ''
    try { $selfDir = [System.IO.Path]::GetDirectoryName($PSCommandPath) } catch { $selfDir = '' }
    if (-not $selfDir) { $selfDir = [System.IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path) }

    $exes = New-Object System.Collections.ArrayList
    $cmds = New-Object System.Collections.ArrayList
    $ps1s = New-Object System.Collections.ArrayList

    $npmRoot = ''
    if ($env:APPDATA) { $npmRoot = Join-Path $env:APPDATA 'npm' }

    if ($npmRoot -and (Test-Path -LiteralPath $npmRoot)) {
        $payload = Join-Path $npmRoot 'node_modules\opencode-ai\bin\opencode.exe'
        if (Test-Path -LiteralPath $payload) { [void]$exes.Add($payload) }

        foreach ($shimName in @('opencode.cmd', 'opencode.ps1', 'opencode')) {
            $shimPath = Join-Path $npmRoot $shimName
            if (-not (Test-Path -LiteralPath $shimPath)) { continue }
            $text = ''
            try { $text = [System.IO.File]::ReadAllText($shimPath) } catch { continue }
            foreach ($m in [regex]::Matches($text, '"([^"]*opencode[^"]*\.exe)"')) {
                $rel = $m.Groups[1].Value
                $rel = $rel -replace '^\$\{?basedir\}?[/\\]', ''
                $rel = $rel -replace '^%~dp0[/\\]', ''
                $rel = $rel -replace '^%dp0%[/\\]', ''
                $candidate = Join-Path $npmRoot ($rel -replace '/', '\')
                if ((Test-Path -LiteralPath $candidate) -and (-not $exes.Contains($candidate))) {
                    [void]$exes.Add($candidate)
                }
            }
        }
    }

    # PATH scan, excluding our own directory.
    $pathDirs = @()
    if ($env:PATH) { $pathDirs = $env:PATH.Split(';') }
    foreach ($d in $pathDirs) {
        if ([string]::IsNullOrWhiteSpace($d)) { continue }
        $norm = $d.TrimEnd('\', '/')
        if ($selfDir -and ($norm -ieq $selfDir.TrimEnd('\', '/'))) { continue }
        $exeCandidate = Join-Path $norm 'opencode.exe'
        if ((-not $exes.Contains($exeCandidate)) -and (Test-Path -LiteralPath $exeCandidate)) { [void]$exes.Add($exeCandidate) }
        $cmdCandidate = Join-Path $norm 'opencode.cmd'
        if ((-not $cmds.Contains($cmdCandidate)) -and (Test-Path -LiteralPath $cmdCandidate)) { [void]$cmds.Add($cmdCandidate) }
        $ps1Candidate = Join-Path $norm 'opencode.ps1'
        if ((-not $ps1s.Contains($ps1Candidate)) -and (Test-Path -LiteralPath $ps1Candidate)) { [void]$ps1s.Add($ps1Candidate) }
    }

    foreach ($c in $exes) { return (New-Object psobject -Property @{ Path = $c; Kind = 'exe' }) }
    foreach ($c in $cmds) { return (New-Object psobject -Property @{ Path = $c; Kind = 'cmd' }) }
    foreach ($c in $ps1s) { return (New-Object psobject -Property @{ Path = $c; Kind = 'ps1' }) }
    return $null
}

<#
.SYNOPSIS
    REAL bind probe: try to LISTEN on 127.0.0.1:$Port with
    SO_EXCLUSIVEADDRUSE, then close immediately. This is the only accepted
    free-ness probe - never netstat / Get-NetTCPConnection / ss / lsof.

.DESCRIPTION
    Only ever called BEFORE a child exists (port selection and the pre-flight
    re-check). While a child is running it would be a real acquisition of the
    port and could race the child's own bind, so the liveness wait uses
    Test-PortHasListener / Get-ListenerOwnerPid instead.
#>
function Test-PortBindable {
    param([int]$Port)
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse('127.0.0.1')), $Port
        # Without this, Windows lets a second bind succeed on an in-use port and
        # the probe would lie. Must be set before Start().
        $listener.ExclusiveAddressUse = $true
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) {
            try { $listener.Stop() } catch { }
        }
    }
}

function Find-FreePort {
    param([int]$From, [int]$To = $PortMax)
    for ($p = $From; $p -le $To; $p++) {
        if (Test-PortBindable $p) { return $p }
    }
    return $null
}

<#
.SYNOPSIS
    Is ANY process listening on $Port? Read-only, no bind, no elevation.

.DESCRIPTION
    Returns 1 (yes), 0 (no - positively nobody), or -1 (cannot tell). Used as the
    cheap gate in front of the (much more expensive) owning-pid lookup, so the
    latter is only paid for once something is actually listening.
#>
function Test-PortHasListener {
    param([int]$Port)
    $eps = $null
    try {
        $eps = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    } catch {
        return -1
    }
    if ($null -eq $eps) { return -1 }
    foreach ($e in $eps) {
        if ([int]$e.Port -eq $Port) { return 1 }
    }
    return 0
}

<#
.SYNOPSIS
    Which pid owns the listening socket on $Port?

.DESCRIPTION
    Returns the owning pid, or 0 when the query succeeds and nobody owns it, or
    -1 when the query itself failed. $OurPid, when supplied, short-circuits: a
    socket owned by our own child is returned immediately, so the common case
    never pays for the ancestry walk.

    This is NOT a free-ness probe - free-ness is Test-PortBindable's job, and
    it is established before this is ever called. This answers a different
    question: who holds a port that is already known to be held. Get-NetTCPConnection
    is the only unprivileged source of that on this host (verified unelevated in
    task 7: it returns OwningProcess).
#>
function Get-ListenerOwnerPid {
    param([int]$Port, [int]$OurPid = 0)
    $rows = $null
    try {
        $rows = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
    } catch {
        return -1
    }
    if ($null -eq $rows) { return -1 }
    $fallback = 0
    foreach ($r in $rows) {
        $op = 0
        try { $op = [int]$r.OwningProcess } catch { continue }
        if ($op -le 0) { continue }
        if ($OurPid -gt 0 -and $op -eq $OurPid) { return $op }
        if ($fallback -eq 0) { $fallback = $op }
    }
    if ($fallback -gt 0) { return $fallback }
    return 0
}

<#
.SYNOPSIS
    Is $Pid our own child, or something our own child spawned?

.DESCRIPTION
    Returns 1 (ours), 0 (definitively not ours - the ancestry walk completed and
    never reached our child) or -1 (cannot tell - the walk failed). Needed only
    for the Kind='cmd'/'ps1' launch forms, where the process we started is
    cmd.exe/powershell.exe and the socket belongs to opencode.exe below it. The
    -1 result matters: without it, a failed ancestry query would make our own
    healthy child look like a foreign thief and get it killed.
#>
function Test-PidInOurTree {
    # NOT $Pid: $PID is a read-only automatic variable and must not be shadowed.
    param([int]$OwnerPid, [int]$OurPid, [bool]$AllowWalk = $true)
    if ($OwnerPid -le 0) { return 0 }
    if ($OurPid -gt 0 -and $OwnerPid -eq $OurPid) { return 1 }
    # When we started the payload DIRECTLY (Kind='exe'), the process we started
    # is the only thing in our subtree that can own a listening socket, so a
    # different owner is definitively foreign. Skipping the walk here is not
    # just an optimisation: each level is a Win32_Process CIM query, and the
    # first CIM call in a fresh process costs seconds. Measured: leaving the
    # walk on the hot path pushed steal recovery from ~0.3 s to ~15 s.
    if (-not $AllowWalk) { return 0 }
    $cur = $OwnerPid
    for ($depth = 0; $depth -lt 8; $depth++) {
        $parent = 0
        try {
            $w = @(Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $cur) -ErrorAction Stop)
        } catch {
            return -1
        }
        if ($w.Count -eq 0) { return 0 }
        try { $parent = [int]$w[0].ParentProcessId } catch { return -1 }
        if ($parent -le 0) { return 0 }
        if ($OurPid -gt 0 -and $parent -eq $OurPid) { return 1 }
        $cur = $parent
    }
    return 0
}

<#
.SYNOPSIS
    Terminate the process we started, plus anything it spawned, and nothing else.

.DESCRIPTION
    Only ever called on a process handle we created ourselves, so a bare
    opencode.exe belonging to the user's own session cannot be reached. Never a
    name-based sweep. Children are killed before their parent, because a parent's
    death can re-parent (and thereby hide) its children.
#>
function Stop-OwnedProcessTree {
    param($Proc, [bool]$NeedTree = $true)
    if (-not $Proc) { return }
    $root = $Proc.Id
    # BFS set, so the kill order is deepest-descendant-first; always contains at
    # least our own handle, whether or not the snapshot below succeeds.
    $pending = New-Object System.Collections.ArrayList
    [void]$pending.Add($root)
    if ($NeedTree) {
        # Expensive: enumerating every process on the host. Only worth it when
        # our handle is not the socket owner, i.e. the cmd/ps1 launch forms.
        try {
            $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
            for ($round = 0; $round -lt 8; $round++) {
                $added = $false
                foreach ($w in $all) {
                    $wpid = 0; $wpar = 0
                    try { $wpid = [int]$w.ProcessId; $wpar = [int]$w.ParentProcessId } catch { continue }
                    if ($wpid -le 0 -or $wpid -eq $root) { continue }
                    if ($pending -contains $wpar -and (-not $pending.Contains($wpid))) {
                        [void]$pending.Add($wpid)
                        $added = $true
                    }
                }
                if (-not $added) { break }
            }
        } catch {
            # If the snapshot is unavailable, killing our own handle is still
            # correct for Kind='exe', which is the only form that reaches here
            # without $NeedTree being set anyway.
        }
    }
    $deepestFirst = @($pending)
    [array]::Reverse($deepestFirst)
    foreach ($k in $deepestFirst) {
        try { Stop-Process -Id $k -Force -ErrorAction Stop } catch { }
    }
    try { if (-not $Proc.HasExited) { [void]$Proc.WaitForExit(5000) } } catch { }
}

<#
.SYNOPSIS
    Launch the real opencode, inheriting stdin/stdout/stderr so the TUI keeps
    its console, and return its exit code. Unconditional wait: used by every
    passthrough path, where no port was reserved and nothing is watched.
#>
function Start-RealOpencode {
    param($Real, [string[]]$ArgumentList, [AllowNull()][string]$PortEnv)

    $launch = New-OpencodeProcess $Real $ArgumentList $PortEnv
    if (-not $launch.Ok) { return $launch.ExitCode }
    $launch.Proc.WaitForExit()
    return $launch.ExitCode
}

<#
.SYNOPSIS
    Start the real opencode and return the live Process object WITHOUT waiting.

.DESCRIPTION
    The launch half of Start-RealOpencode, factored out so the reserved-port path
    can watch the child instead of blocking on it. The launch form itself is
    unchanged: same ProcessStartInfo, same inherited handles, same OPENCODE_PORT.

    Returns @{ Ok = $true; Proc = <Process> } or @{ Ok = $false; ExitCode = n }.
#>
function New-OpencodeProcess {
    param($Real, [string[]]$ArgumentList, [AllowNull()][string]$PortEnv)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $false
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false

    switch ($Real.Kind) {
        'exe' {
            $psi.FileName = $Real.Path
            $psi.Arguments = (Join-CommandLineArguments $ArgumentList)
        }
        'cmd' {
            # CreateProcess cannot run a .cmd: go through cmd.exe /s /c.
            $comspec = $env:ComSpec
            if (-not $comspec) { $comspec = 'cmd.exe' }
            $psi.FileName = $comspec
            $psi.Arguments = '/d /s /c ""' + $Real.Path + '"' + (Join-CommandLineArguments $ArgumentList) + '"'
        }
        'ps1' {
            # CreateProcess cannot run a .ps1: go through powershell -File.
            $hostExe = Find-PowerShellHost
            if (-not $hostExe) {
                Write-Err '[opencode-wrapper] cannot resolve opencode.ps1 host: no powershell.exe found'
                return @{ Ok = $false; ExitCode = 126 }
            }
            $psi.FileName = $hostExe
            $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $Real.Path + '"' + (Join-CommandLineArguments $ArgumentList)
        }
        default {
            Write-Err ("[opencode-wrapper] unsupported real-opencode kind: " + $Real.Kind)
            return @{ Ok = $false; ExitCode = 126 }
        }
    }

    if ($PortEnv) { $psi.EnvironmentVariables['OPENCODE_PORT'] = $PortEnv }

    $proc = $null
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        Write-Err ("[opencode-wrapper] failed to start " + $Real.Path + ": " + $_.Exception.Message)
        return @{ Ok = $false; ExitCode = 126 }
    }
    if (-not $proc) {
        Write-Err ("[opencode-wrapper] failed to start " + $Real.Path)
        return @{ Ok = $false; ExitCode = 126 }
    }
    return @{ Ok = $true; Proc = $proc }
}

<#
.SYNOPSIS
    The bounded liveness wait: decide whether the child took the port it was
    reserved, failed, or is being starved of it.

.DESCRIPTION
    Returns one of three states:
      Exited  - the child is gone; ExitCode is its exit code. The caller then
                applies the pre-existing exit-status rules.
      Settled - the child owns the port (healthy), or nothing about the port
                proves otherwise (nobody is listening, or the port is held but
                its owner cannot be read and a bind probe at the deadline says
                the port is free). Either way this is NOT a steal, so the child
                is left alone and waited on exactly as before. A hang here is
                the pre-existing behaviour, not a new one.
      Stolen  - the port is held by a process that is not our child, proven
                either by ownership (fires at once) or by the deadline bind
                probe (fires after $BindWaitMs when ownership was unreadable).
                Owner is the foreign pid, or -1 when it is unknown.

    Never binds: see Test-PortHasListener. Never kills: killing is the caller's
    decision, so the single retry stays in one place.
#>
function Wait-ChildPortOutcome {
    param($Proc, [int]$Port, [bool]$NeedTree = $true)

    $ourPid = $Proc.Id
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastOwner = -1
    while ($true) {
        if ($Proc.HasExited) {
            return @{ State = 'Exited'; ExitCode = $Proc.ExitCode; Owner = 0 }
        }

        $held = Test-PortHasListener $Port
        if ($held -ne 0) {
            # Something is listening on the reserved port. Who?
            $owner = Get-ListenerOwnerPid $Port $ourPid
            if ($owner -gt 0) { $lastOwner = $owner }
            if ($owner -gt 0) {
                $ours = Test-PidInOurTree $owner $ourPid $NeedTree
                if ($ours -eq 1) {
                    # PROVEN healthy: our own child owns the reserved port. Stop
                    # watching and behave exactly as the pre-fix wrapper did.
                    $Proc.WaitForExit()
                    return @{ State = 'Settled'; ExitCode = $Proc.ExitCode; Owner = $owner }
                }
                if ($ours -eq 0) {
                    # PROVEN starved: a foreign process owns the port this child
                    # was reserved, so the child can never serve on it. No need
                    # to wait out $BindWaitMs for a fact that is already proven.
                    return @{ State = 'Stolen'; ExitCode = $null; Owner = $owner }
                }
                # $ours -eq -1: cannot tell whose socket this is. Not evidence
                # either way - fall through to the deadline.
            }
            # $owner -le 0: the port is held (or may be held) and the owner
            # cannot be read. Also not evidence - fall through to the deadline.
        }
        # $held -eq 0: nobody is listening at all. A child that has not bound
        # yet, or never will (server-less opencode), looks exactly like this, so
        # it is NOT a steal and must not be treated as one.

        if ($sw.ElapsedMilliseconds -ge $BindWaitMs) {
            # Deadline with the reservation still unproven. One definitive
            # free-ness bind probe decides it. Safe at this point: 10 s after
            # exec the child has either bound long ago or is never going to, so
            # there is no bind race left to lose.
            if (Test-PortBindable $Port) {
                $Proc.WaitForExit()
                return @{ State = 'Settled'; ExitCode = $Proc.ExitCode; Owner = 0 }
            }
            # Held by somebody, and never proven to be our child. Bounded
            # recovery beats an unbounded silent hang: spend the one retry.
            return @{ State = 'Stolen'; ExitCode = $null; Owner = $lastOwner }
        }
        Start-Sleep -Milliseconds $BindPollMs
    }
}

# --------------------------------------------------------------------------
# argv normalisation (hostile-input tolerant: never crash on odd argv)
# --------------------------------------------------------------------------
$Argv = @()
foreach ($a in $args) {
    if ($null -eq $a) { $Argv += '' } else { $Argv += ([string]$a) }
}

$Real = Resolve-RealOpencode
if (-not $Real) {
    Write-Err '[opencode-wrapper] could not resolve the real opencode (searched APPDATA\npm and PATH, excluding this wrapper directory)'
    exit 127
}

$Tmux = ''
if ($null -ne $env:TMUX) { $Tmux = [string]$env:TMUX }

function Invoke-Passthrough {
    return (Start-RealOpencode $Real $Argv $null)
}

# 1. outside tmux -> unchanged
if ([string]::IsNullOrEmpty($Tmux)) {
    exit (Invoke-Passthrough)
}

# 2. any-arg short circuit (case-sensitive, exactly like the bash `case`)
$Passthrough = $false
foreach ($a in $Argv) {
    if ($PassthroughFlags -ccontains $a) { $Passthrough = $true; break }
    if ($a.StartsWith('--port=')) { $Passthrough = $true; break }
}
if ($Passthrough) { exit (Invoke-Passthrough) }

# 3. first-arg subcommand short circuit
if ($Argv.Count -gt 0 -and $PassthroughSubcommands -ccontains $Argv[0]) {
    exit (Invoke-Passthrough)
}

# 4. explicit OPENCODE_PORT (all digits, including "0" - mirrors the bash
#    `case "$port" in ''|*[!0-9]*) port=""` test, which accepts "0")
$PortText = ''
if ($null -ne $env:OPENCODE_PORT) { $PortText = [string]$env:OPENCODE_PORT }
$Reserved = $false
$Port = $null
if ($PortText -match '^[0-9]+$') {
    $Port = $PortText
} else {
    $Port = Find-FreePort $PortMin
    if ($null -eq $Port) {
        Write-Err $MsgExhausted
        exit 1
    }
    $Reserved = $true
}

Write-Err ("[opencode-wrapper] tmux detected -> starting opencode with --port " + $Port)

$FirstPort = $Port
$ExitCode = 1

# 5. bind-close-exec, with AT MOST ONE retry from the next port
for ($attempt = 1; $attempt -le 2; $attempt++) {
    if ($attempt -gt 1) {
        if (-not $Reserved) { break }
        $next = Find-FreePort ([int]$FirstPort + 1)
        if ($null -eq $next) {
            Write-Err $MsgExhausted
            exit 1
        }
        $Port = [string]$next
        Write-Err ("[opencode-wrapper] port " + $FirstPort + " was taken (EADDRINUSE) -> retrying once with --port " + $Port)
    }

    # Pre-flight re-check: the reservation was probed before the stderr line
    # above and is unguarded until the child binds it. Re-probe immediately
    # before exec so a port lost in that gap costs a retry instead of a doomed
    # child. On the last attempt there is no retry left, so refuse to start.
    if ($Reserved -and -not (Test-PortBindable ([int]$Port))) {
        if ($attempt -ge 2) {
            Write-Err $MsgExhausted
            exit 1
        }
        continue
    }

    if (-not $Reserved) {
        # No reservation was made, so there is nothing to watch and nothing to
        # recover: identical to the pre-fix behaviour, down to not polling.
        $ExitCode = Start-RealOpencode $Real (@('--port', [string]$Port) + $Argv) ([string]$Port)
        break
    }

    $launch = New-OpencodeProcess $Real (@('--port', [string]$Port) + $Argv) ([string]$Port)
    if (-not $launch.Ok) { exit $launch.ExitCode }

    $NeedTree = ($Real.Kind -ne 'exe')
    $outcome = Wait-ChildPortOutcome $launch.Proc ([int]$Port) $NeedTree
    if ($outcome.State -eq 'Stolen') {
        if ($outcome.Owner -gt 0) {
            Write-Err ("[opencode-wrapper] port " + $Port + " is held by pid " + $outcome.Owner + ", not by the child it was reserved for -> child terminated")
        } else {
            Write-Err ("[opencode-wrapper] port " + $Port + " is held but its owner could not be identified within " + $BindWaitMs + " ms -> child terminated")
        }
        Stop-OwnedProcessTree $launch.Proc $NeedTree
        if ($attempt -ge 2) {
            Write-Err $MsgExhausted
            exit 1
        }
        continue
    }

    $ExitCode = $outcome.ExitCode
    if ($ExitCode -eq 0) { break }
    if (-not $Reserved) { break }
    if (Test-PortBindable ([int]$Port)) {
        # Port is free again: the non-zero exit was NOT an EADDRINUSE.
        break
    }
    # Port is now owned by somebody else: EADDRINUSE-equivalent -> retry once.
}

exit $ExitCode