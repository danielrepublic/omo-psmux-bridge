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

    Exit-noise suppression
    ----------------------
    opencode's TUI switches to the EXTERNAL HTTP transport whenever --port,
    --hostname or mdns is active (packages/opencode/src/cli/cmd/tui.ts:
    `const external = hasArg("--port") || hasArg("--hostname") ||
    network.mdns === true`). Every launch this wrapper controls adds --port, so
    it creates that condition by design. On a clean TUI exit, opencode 1.19.4
    aborts the in-flight HTTP/SSE work and Bun's default unhandled-rejection
    reporter prints a DOMException dump on stderr:

        AbortError: The operation was aborted.
        DOMException { ...all 25 legacy error constants... }
              at B:/~BUN/root/chunk-*.js:2

    That report is a normal exit, not a failure, and it lands on the console
    AFTER the TUI has handed the screen back, so it is the first thing the user
    sees at the shell prompt. `BUN_OPTIONS=--unhandled-rejections=none` does NOT
    suppress it: opencode's build bakes execArgv through --compile-exec-argv,
    and a standalone binary built that way ignores BUN_OPTIONS. Measured, not
    assumed: the same flag DOES suppress a Bun fixture built with
    `bun build --compile` (no execArgv) and DOES NOT suppress that fixture once
    it is rebuilt with `--compile-exec-argv='--use-system-ca --'`, which is the
    shape opencode ships. NODE_OPTIONS, --preload and a bare argv flag are
    ignored for the same reason.

    Therefore the external-transport launches (where THIS WRAPPER adds --port,
    or the caller supplied --port, --hostname or --mdns) capture the child's
    stderr with RedirectStandardError and replay it after the child exits, with
    exactly that report removed. stdout, stdin and the console stay inherited,
    so the TUI still renders normally. Passthrough subcommands (serve, run,
    attach, ...) are NOT captured: their stderr is a live operator surface, and
    buffering it would be worse than the noise this workaround removes.

    Retirement condition: drop the capture when the upstream TUI registers a
    process-level unhandledRejection handler (or stops aborting HTTP on a clean
    exit), verified in a release. Do not infer it from a version number.

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

# opencode options that consume the NEXT argv element as their value. Needed only
# to find the first POSITIONAL argument without mistaking an option value for a
# subcommand. Drawn from `opencode --help` (1.19.4); `--opt=value` forms are
# detected by the '=' and never consume the next element.
$ArgumentValueOptions = @(
    '--log-level', '--port', '--hostname', '--mdns-domain', '--cors',
    '--model', '-m', '--session', '-s', '--prompt', '--agent', '--replay-limit'
)

$MsgExhausted = '[opencode-wrapper] no free port in 7801-7901; refusing to start'

function Write-Err([string]$message) {
    [Console]::Error.WriteLine($message)
}

<#
.SYNOPSIS
    Remove Bun's unhandled-DOMException report from captured stderr.

.DESCRIPTION
    The report has exactly one shape in opencode 1.19.4 / Bun 1.4.4:

        AbortError: The operation was aborted.
        DOMException {
          ...fields...
        }
              at <bunfs>/chunk-*.js:2

    The object body is the part that makes it unreadable (25 legacy constants),
    so the whole block, plus the one location line Bun appends, is dropped. The
    match is anchored to a line start and requires the `DOMException {` second
    line, so ordinary stderr that merely mentions "AbortError" is preserved.
    `[regex]::Replace` replaces every occurrence, which matters if more than one
    request aborts during shutdown.

    An unterminated report (the child died mid-write) is left alone rather than
    guessed at: a partial block is indistinguishable from a log line that starts
    with the same text, and keeping it is visible while swallowing a real log is
    not.
#>
function Remove-BunAbortReport {
    param([AllowNull()][string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $pattern = '(?ms)^AbortError: The operation was aborted\.?[ \t]*\r?\nDOMException \{[ \t]*\r?\n.*?^\}[ \t]*(?:\r?\n|$)(?:^[ \t]+at [^\r\n]*(?:\r?\n|$))?'
    return [regex]::Replace($Text, $pattern, '')
}

<#
.SYNOPSIS
    Start draining a redirected stderr pipe without blocking the caller.

.DESCRIPTION
    `ReadAsync` is started immediately and advanced only when the pending task
    has already completed. Nothing in this file ever blocks on a read: the port
    watch loop and the exit path call Update-StderrCapture and move on. That is
    what keeps a child that writes more than the pipe buffer (4 KiB) from
    deadlocking while this wrapper is waiting for it.

    stderr is decoded as UTF-8 because every launch form ends in a Bun
    executable, and Bun writes UTF-8 bytes. Replay re-encodes the same way, so a
    UTF-8 diagnostic that is not part of the abort report survives byte-for-byte
    (see Write-CapturedStderr).
#>
function New-StderrCapture {
    param($Proc)

    $reader = $Proc.StandardError
    $buffer = New-Object char[] 4096
    return @{
        Reader = $reader
        Buffer = $buffer
        Pending = $reader.ReadAsync($buffer, 0, $buffer.Length)
        Text = New-Object System.Text.StringBuilder
        Open = $true
        Written = $false
    }
}

<#
.SYNOPSIS
    Append every already-completed read to the capture. Never waits.
#>
function Update-StderrCapture {
    param($Capture)

    if (-not $Capture -or -not $Capture.Open) { return }
    while ($Capture.Pending.IsCompleted) {
        $read = 0
        try {
            $read = [int]$Capture.Pending.Result
        } catch {
            # A disposed or broken pipe is the normal end of the capture.
            $Capture.Open = $false
            return
        }
        if ($read -le 0) {
            $Capture.Open = $false
            return
        }
        [void]$Capture.Text.Append($Capture.Buffer, 0, $read)
        try {
            $Capture.Pending = $Capture.Reader.ReadAsync($Capture.Buffer, 0, $Capture.Buffer.Length)
        } catch {
            # MUST leave the loop here. $Capture.Pending still holds the PREVIOUS,
            # already-completed read, so without this return the while condition
            # is immediately true again, the same bytes are appended again, and
            # the next ReadAsync throws again: an unbounded spin that grows Text
            # forever.
            $Capture.Open = $false
            return
        }
    }
}

<#
.SYNOPSIS
    Drain what is left and return the captured text.

.DESCRIPTION
    $GraceMs bounds how long a pipe held open by a grandchild can delay the
    wrapper after the child itself has exited. It is reached only when no EOF
    arrives; the common case returns as soon as the child's handle closes.
#>
function Complete-StderrCapture {
    param($Capture, [int]$GraceMs = 1000)

    if (-not $Capture) { return '' }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($Capture.Open -and $sw.ElapsedMilliseconds -lt $GraceMs) {
        Update-StderrCapture $Capture
        if ($Capture.Open) { Start-Sleep -Milliseconds 20 }
    }
    Update-StderrCapture $Capture
    try { $Capture.Reader.Dispose() } catch { }
    return $Capture.Text.ToString()
}

<#
.SYNOPSIS
    Wait for a child to exit while keeping its captured stderr drained.

.DESCRIPTION
    A blocking WaitForExit() would stop draining the pipe, so a child that logs
    more than the pipe buffer during the session would block forever. When there
    is no capture, the blocking wait is kept exactly as before.
#>
function Wait-ProcessWithCapture {
    param($Proc, $Capture)

    if (-not $Capture) {
        $Proc.WaitForExit()
        return
    }
    while (-not $Proc.HasExited) {
        Start-SleepDraining $Capture 100
    }
    Update-StderrCapture $Capture
}

<#
.SYNOPSIS
    Sleep in short slices, draining the capture between them.

.DESCRIPTION
    A single Start-Sleep would let a chatty child fill the 4 KiB pipe buffer and
    block before the next drain, which looks exactly like the silent hang this
    wrapper's port watch exists to avoid. Slicing at 25 ms keeps the pipe moving
    while preserving the caller's total wait.
#>
function Start-SleepDraining {
    param($Capture, [int]$Milliseconds)

    if (-not $Capture) {
        Start-Sleep -Milliseconds $Milliseconds
        return
    }
    $remaining = $Milliseconds
    while ($remaining -gt 0) {
        Update-StderrCapture $Capture
        $slice = [Math]::Min(25, $remaining)
        Start-Sleep -Milliseconds $slice
        $remaining -= $slice
    }
    Update-StderrCapture $Capture
}

<#
.SYNOPSIS
    Replay captured stderr, minus Bun's abort report, exactly once.
#>
function Write-CapturedStderr {
    param($Capture)

    if (-not $Capture -or $Capture.Written) { return }
    $Capture.Written = $true
    $text = Remove-BunAbortReport (Complete-StderrCapture $Capture)
    if ([string]::IsNullOrEmpty($text)) { return }
    # Write raw UTF-8 bytes to fd 2 instead of [Console]::Error.Write: the latter
    # re-encodes through the console code page, which can turn a UTF-8 diagnostic
    # into the exact mojibake this wrapper is supposed to avoid.
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
    $stderr = [Console]::OpenStandardError()
    try {
        $stderr.Write($bytes, 0, $bytes.Length)
        $stderr.Flush()
    } catch {
        # Nothing left to write to (the console or pipe is gone). The child has
        # already exited and its exit code is the contract, not this replay.
    }
}

<#
.SYNOPSIS
    Return the first POSITIONAL argv element, skipping options and their values.

.DESCRIPTION
    `--log-level debug` and `--prompt run` put a word on the command line that
    also happens to be a passthrough subcommand name. A raw scan for
    $PassthroughSubcommands therefore classified a perfectly ordinary TUI launch
    as a server/run process and left the abort report unfiltered:

        opencode --log-level debug --port 41235      # 'debug' is NOT the subcommand
        opencode --port 41239 --prompt run           # 'run' is the PROMPT

    Option arity is the missing information: the word after --log-level/--prompt
    (and the other value-taking options) is a value, not a positional. `--opt=value`
    is one element and consumes nothing. `--` ends option parsing, so the next
    element is positional even when it starts with '-'.

    Returns $null when argv has no positional (opencode's default TUI command).
#>
function Get-FirstPositionalArgument {
    param([string[]]$ArgumentList)

    for ($i = 0; $i -lt $ArgumentList.Count; $i++) {
        $a = $ArgumentList[$i]
        if ($a -ceq '--') {
            if ($i + 1 -lt $ArgumentList.Count) { return $ArgumentList[$i + 1] }
            return $null
        }
        if ($a.Length -gt 0 -and $a[0] -eq '-') {
            # --opt=value is a single element; --opt VALUE consumes the next one.
            if ($a.Contains('=')) { continue }
            if ($ArgumentValueOptions -ccontains $a) { $i++ }
            continue
        }
        return $a
    }
    return $null
}

<#
.SYNOPSIS
    Does this argv put the TUI on the external HTTP transport that produces the
    Bun abort report on exit?

.DESCRIPTION
    `--port`, `--hostname` and `--mdns` are the triggers the TUI itself uses to
    choose its external transport.

    A passthrough subcommand as the FIRST POSITIONAL means the process is not the
    interactive TUI (serve/run/attach/...), so its stderr must stay live and is
    never captured. The positional is resolved with option arity
    (Get-FirstPositionalArgument), not by scanning every element:
    `--log-level debug` supplies the VALUE `debug`, and `--prompt run` supplies
    the VALUE `run`; neither is a subcommand. The first positional is also not
    required to be argv[0], so global options before a real subcommand are
    handled, e.g. `opencode --log-level debug serve --port 1234` still resolves
    to `serve` and keeps the server's logs live.
#>
function Test-ExternalTuiLaunch {
    param([string[]]$ArgumentList)

    $first = Get-FirstPositionalArgument $ArgumentList
    if ($first -and ($PassthroughSubcommands -ccontains $first)) { return $false }
    foreach ($a in $ArgumentList) {
        if ($a -ceq '--port' -or $a.StartsWith('--port=')) { return $true }
        if ($a -ceq '--hostname' -or $a.StartsWith('--hostname=')) { return $true }
        if ($a -ceq '--mdns') { return $true }
    }
    return $false
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
    Launch the real opencode, inheriting stdin/stdout so the TUI keeps its
    console, and return its exit code. Unconditional wait: used by every
    passthrough path, where no port was reserved and nothing is watched.

.DESCRIPTION
    $CaptureStderr selects the exit-noise workaround: stderr is redirected and
    replayed after the child exits, minus Bun's abort report. It is set only
    when the launch uses opencode's external HTTP transport (see
    Test-ExternalTuiLaunch). When it is false, stderr is inherited exactly as
    before.
#>
function Start-RealOpencode {
    param($Real, [string[]]$ArgumentList, [AllowNull()][string]$PortEnv, [bool]$CaptureStderr = $false)

    $launch = New-OpencodeProcess $Real $ArgumentList $PortEnv $CaptureStderr
    if (-not $launch.Ok) { return $launch.ExitCode }
    Wait-ProcessWithCapture $launch.Proc $launch.StderrCapture
    Write-CapturedStderr $launch.StderrCapture
    # Read the exit code off the PROCESS, not off $launch: the success shape of
    # New-OpencodeProcess is @{ Ok = $true; Proc = ... } and carries no
    # ExitCode key. This script does not run under Set-StrictMode, so reading
    # the absent key returned $null and every passthrough path exited 0,
    # reporting success for an opencode that crashed or rejected its arguments.
    return $launch.Proc.ExitCode
}

<#
.SYNOPSIS
    Start the real opencode and return the live Process object WITHOUT waiting.

.DESCRIPTION
    The launch half of Start-RealOpencode, factored out so the reserved-port path
    can watch the child instead of blocking on it. The launch form itself is
    unchanged except for the opt-in stderr capture: same ProcessStartInfo, same
    inherited stdin/stdout, same OPENCODE_PORT.

    Returns @{ Ok = $true; Proc = <Process>; StderrCapture = <capture or $null> }
    or @{ Ok = $false; ExitCode = n }.
#>
function New-OpencodeProcess {
    param($Real, [string[]]$ArgumentList, [AllowNull()][string]$PortEnv, [bool]$CaptureStderr = $false)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $false
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $CaptureStderr
    if ($CaptureStderr) {
        # Every launch form ends in a Bun executable, and Bun writes UTF-8 to a
        # redirected stderr. Decoding with the console code page would turn a
        # non-ASCII diagnostic into mojibake on replay.
        $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    }

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
    $capture = $null
    if ($CaptureStderr) { $capture = New-StderrCapture $proc }
    return @{ Ok = $true; Proc = $proc; StderrCapture = $capture }
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
    param($Proc, [int]$Port, [bool]$NeedTree = $true, $Capture = $null)

    $ourPid = $Proc.Id
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastOwner = -1
    while ($true) {
        # Keep the redirected stderr pipe drained for the whole session. Doing
        # this here, and in Wait-ProcessWithCapture below, is what makes the
        # capture safe for a child that logs more than the pipe buffer.
        Update-StderrCapture $Capture
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
                    Wait-ProcessWithCapture $Proc $Capture
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
                Wait-ProcessWithCapture $Proc $Capture
                return @{ State = 'Settled'; ExitCode = $Proc.ExitCode; Owner = 0 }
            }
            # Held by somebody, and never proven to be our child. Bounded
            # recovery beats an unbounded silent hang: spend the one retry.
            return @{ State = 'Stolen'; ExitCode = $null; Owner = $lastOwner }
        }
        Start-SleepDraining $Capture $BindPollMs
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
    # A caller-supplied --port puts the TUI on the same external HTTP transport
    # that the auto-port path uses, so it produces the same abort report on
    # exit. A passthrough subcommand (serve/run/attach/...) keeps its live
    # stderr: Test-ExternalTuiLaunch returns false for those.
    return (Start-RealOpencode $Real $Argv $null (Test-ExternalTuiLaunch $Argv))
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
        # The launch still adds --port, so it still needs the abort-report
        # filter ($true).
        $ExitCode = Start-RealOpencode $Real (@('--port', [string]$Port) + $Argv) ([string]$Port) $true
        break
    }

    $launch = New-OpencodeProcess $Real (@('--port', [string]$Port) + $Argv) ([string]$Port) $true
    if (-not $launch.Ok) { exit $launch.ExitCode }

    $NeedTree = ($Real.Kind -ne 'exe')
    $outcome = Wait-ChildPortOutcome $launch.Proc ([int]$Port) $NeedTree $launch.StderrCapture
    if ($outcome.State -eq 'Stolen') {
        if ($outcome.Owner -gt 0) {
            Write-Err ("[opencode-wrapper] port " + $Port + " is held by pid " + $outcome.Owner + ", not by the child it was reserved for -> child terminated")
        } else {
            Write-Err ("[opencode-wrapper] port " + $Port + " is held but its owner could not be identified within " + $BindWaitMs + " ms -> child terminated")
        }
        Stop-OwnedProcessTree $launch.Proc $NeedTree
        Write-CapturedStderr $launch.StderrCapture
        if ($attempt -ge 2) {
            Write-Err $MsgExhausted
            exit 1
        }
        continue
    }

    Write-CapturedStderr $launch.StderrCapture
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