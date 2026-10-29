param(
    [string] $BridgeBin = '',
    [string] $HarnessDir = '',
    [string] $WorkDir = '',
    [string] $NodeExe = '',
    [string] $LiveConfigPath = '',
    [string] $LiveDataDir = '',
    [string] $ReportPath = ''
)
$ErrorActionPreference = 'Stop'
# Portable defaults: every path derives from the environment or from this
# script's own location. Nothing machine-specific is baked in; pass explicit
# values when the layout differs from the standard install.
if ([string]::IsNullOrEmpty($HarnessDir)) {
    if (-not [string]::IsNullOrEmpty($PSScriptRoot)) { $HarnessDir = $PSScriptRoot }
    else { $HarnessDir = (Get-Location).Path }
}
if ([string]::IsNullOrEmpty($BridgeBin)) {
    $cand = @()
    if (-not [string]::IsNullOrEmpty($env:LOCALAPPDATA)) { $cand += (Join-Path $env:LOCALAPPDATA 'omo-psmux-bridge\bin') }
    $repoBin = Join-Path (Split-Path $HarnessDir -Parent) 'bin'
    if (Test-Path -LiteralPath (Join-Path $repoBin 'bridge-doctor.ps1')) { $cand += $repoBin }
    foreach ($c in $cand) {
        if ($BridgeBin -eq '' -and (Test-Path -LiteralPath (Join-Path $c 'bridge-doctor.ps1'))) { $BridgeBin = $c }
    }
    if ($BridgeBin -eq '' -and $cand.Count -gt 0) { $BridgeBin = $cand[0] }
}
if ([string]::IsNullOrEmpty($WorkDir)) { $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) 'omo-doctor-cases' }
if ([string]::IsNullOrEmpty($NodeExe)) {
    $found = $null
    try { $found = (Get-Command node -ErrorAction Stop).Source } catch { }
    if ($null -ne $found) { $NodeExe = $found }
    elseif (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') { $NodeExe = 'C:\Program Files\nodejs\node.exe' }
    else { $NodeExe = 'node' }
}
if ([string]::IsNullOrEmpty($LiveConfigPath)) { $LiveConfigPath = Join-Path $env:USERPROFILE '.omo\omo.jsonc' }
if ([string]::IsNullOrEmpty($LiveDataDir)) {
    if (-not [string]::IsNullOrEmpty($env:PSMUX_DATA_DIR)) { $LiveDataDir = $env:PSMUX_DATA_DIR }
    else { $LiveDataDir = Join-Path $env:USERPROFILE '.psmux' }
}
if ([string]::IsNullOrEmpty($ReportPath)) { $ReportPath = Join-Path $WorkDir 'harness-report.txt' }
$src = $HarnessDir
$bridgeBin = $BridgeBin
$work = $WorkDir
$node = $NodeExe
$driver = Join-Path $src 'doctor-invoke.cjs'
$report = $ReportPath
$doctorSrc = Join-Path $bridgeBin 'bridge-doctor.ps1'
$psExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

# The version the synthetic bundles below are pinned to, read from the doctor
# under test so the two cannot disagree. The doctor in turn reads it from
# scripts/contract/pins.json's omo.verifiedAgainst.
$doctorText = [System.IO.File]::ReadAllText($doctorSrc)
$cm = [regex]::Match($doctorText, "\`$FrozenOmoVersion\s*=\s*'([^']+)'")
$contractVersion = $(if ($cm.Success) { $cm.Groups[1].Value } else { '<unknown>' })

# The doctor's own anchor table, read back out of the script. The synthetic
# bundles are generated FROM this, so a fixture can never accidentally encode an
# older table than the one the doctor enforces; the harness then asserts its own
# count below, so wholesale drift is still caught here rather than absorbed.
$anchorRe = [regex]"\[pscustomobject\]@\{\s*Line\s*=\s*(\d+);\s*Text\s*=\s*'((?:[^']|'')*)'\s*\}"
$anchorTable = @()
foreach ($m in $anchorRe.Matches($doctorText)) {
    $anchorTable += [pscustomobject]@{ Line = [int]$m.Groups[1].Value; Text = $m.Groups[2].Value.Replace("''", "'") }
}

# The anchor line case C corrupts, DERIVED from the table above rather than
# hardcoded. A hardcoded line number is a silent no-op the moment the doctor is
# re-anchored: the synthetic bundle would then corrupt a line the doctor no
# longer checks, case C would still exit 50 for the wrong reason, and the
# drift detector would look tested while testing nothing. The anchor is picked
# by its TEXT -- the `[opencode].tmux.enabled` default, the one anchor that
# proves the config gate -- so the choice survives a re-anchoring, and the
# assertion below can name the same line and text it corrupts.
$driftAnchorRows = @($anchorTable | Where-Object { $_.Text -like '*default(false)*' })
$driftAnchorLine = 0
$driftAnchorText = ''
if ($driftAnchorRows.Count -eq 1) {
    $driftAnchorLine = [int]$driftAnchorRows[0].Line
    $driftAnchorText = [string]$driftAnchorRows[0].Text
}

$totalClock = [System.Diagnostics.Stopwatch]::StartNew()
$log = New-Object System.Collections.Generic.List[string]
$script:Pass = 0
$script:Fail = 0
$script:Skipped = 0

# Always flush the log, even on an unhandled harness error, so a capture is never
# lost. A harness that dies with the evidence only in its variables has produced
# nothing.
trap {
    Say ('HARNESS-ERROR: ' + $_.Exception.GetType().FullName + ' :: ' + $_.Exception.Message)
    Say ('HARNESS-ERROR at: ' + ($_.InvocationInfo.PositionMessage -replace '[^\x20-\x7E]', '?'))
    Say ('ASSERT TOTALS (at trap): pass=' + $script:Pass + '  fail=' + $script:Fail + '  skip=' + $script:Skipped)
    Save-Report
    Write-Host ('HARNESS-ERROR, report still written: ' + $_.Exception.Message)
    exit 3
}

# NOTE the names: `R` and `Rule` are NOT safe helper names in PowerShell. `r` is
# the built-in alias for Invoke-History and PowerShell refuses to let a function
# shadow it, so `R ('x')` invoked Invoke-History instead and threw
# "cannot find history for command line id 'x'". Use Say/Sep.
function Say { param([string] $Text) $log.Add($Text) }
function Sep { param([char] $Char = '=') Say ((' ' * 78).Replace(' ', $Char)) }
function Save-Report {
    New-Item -ItemType Directory -Force -Path (Split-Path $report -Parent) | Out-Null
    [System.IO.File]::WriteAllText($report, ($log -join "`r`n") + "`r`n")
}
function Assert {
    param([bool] $Ok, [string] $Name, [string] $Detail = '')
    if ($Ok) { $script:Pass++ } else { $script:Fail++ }
    $tail = ''
    if ($Detail -ne '') { $tail = '  [' + $Detail + ']' }
    Say ('  ASSERT ' + $(if ($Ok) { 'PASS' } else { 'FAIL' }) + '  ' + $Name + $tail)
}
function Skip-Case {
    param([string] $Name, [string] $Reason)
    $script:Skipped++
    Say ('  SKIP   ' + $Name + '  [' + $Reason + ']')
}

# --------------------------------------------------------------------------- helpers

function New-Dir { param([string] $Path) New-Item -ItemType Directory -Force -Path $Path | Out-Null; return $Path }

function Write-File {
    param([string] $Path, [string] $Text)
    # Out-Null matters: without it New-Dir's return value joins this function's
    # output, the caller binds an ARRAY to $Path, and the first thing that does
    # something typed with that path reports "the path format is not supported".
    New-Dir (Split-Path $Path -Parent) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text)
    return $Path
}

# Reserve a loopback port and release it. Not race-free in principle, but the
# only use is "a port nothing is listening on", and the caller re-checks.
function Get-FreeLoopbackPort {
    $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, 0)
    $l.Start()
    $p = ([System.Net.IPEndPoint]$l.LocalEndpoint).Port
    $l.Stop()
    return $p
}

function Get-VerdictLines {
    param([string] $Text, [string] $State)
    $res = @()
    foreach ($ln in @($Text -split "`r?`n")) {
        if ($ln -match ('^\[' + $State + ' \] (\d) (.*)$')) {
            $res += [pscustomobject]@{ N = [int]$Matches[1]; Title = $Matches[2].Trim() }
        }
    }
    return @($res)
}

function Get-WarnLines {
    param([string] $Text)
    $res = @()
    foreach ($ln in @($Text -split "`r?`n")) {
        if ($ln -match '^\s*WARN\s\s(.*)$') { $res += $Matches[1].Trim() }
    }
    return @($res)
}

# Re-quote for Start-Process. The doctor is invoked through the node driver, which
# takes a real argv array, so nothing here depends on this quoting today -- it is
# here so a future path containing a space cannot silently re-open recorded failure
# mode I-15/T-12c (Start-Process -ArgumentList joins its array into one command
# line that the child re-parses).
function Quote-Argv {
    param([string[]] $Items)
    $q = @()
    foreach ($it in $Items) {
        if ($it -match '[\s"]') { $q += ('"' + $it.Replace('"', '\"') + '"') } else { $q += $it }
    }
    return $q
}

function Invoke-Case {
    param(
        [string] $Name,
        [hashtable] $EnvOverrides,
        [string[]] $DoctorArgs,
        [int] $ExpectExit
    )
    $out = Join-Path $work ($Name + '.doctor.out')
    $err = Join-Path $work ($Name + '.doctor.err')
    $drv = Join-Path $work ($Name + '.driver.out')
    $drvErr = Join-Path $work ($Name + '.driver.err')
    foreach ($f in @($out, $err, $drv, $drvErr)) { Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue }

    $envJson = $EnvOverrides | ConvertTo-Json -Compress
    $argv = @($driver, (Join-Path $fixtureBin 'bridge-doctor.ps1'), $out, $err, $envJson) + $DoctorArgs

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $null = Start-Process -FilePath $node -ArgumentList (Quote-Argv $argv) -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $drv -RedirectStandardError $drvErr
    $sw.Stop()

    $j = $null
    if (Test-Path -LiteralPath $drv) {
        $t = [System.IO.File]::ReadAllText($drv).Trim()
        if ($t -ne '') { $j = $t | ConvertFrom-Json }
    }
    $doctorText = ''
    if (Test-Path -LiteralPath $out) { $doctorText = [System.IO.File]::ReadAllText($out) }
    $doctorErr = ''
    if (Test-Path -LiteralPath $err) { $doctorErr = [System.IO.File]::ReadAllText($err) }

    $actual = -1
    $nodeWall = -1
    if ($null -ne $j) {
        if ($null -ne $j.status) { $actual = [int]$j.status }
        $nodeWall = [int]$j.wallMs
    }
    $outLines = @($doctorText -split "`r?`n" | Where-Object { $_.Trim() -ne '' }).Count

    Sep '-'
    Say ('CASE ' + $Name)
    Say ('  cmd            : powershell -NoProfile -ExecutionPolicy Bypass -File FIXTUREBIN\bridge-doctor.ps1 ' + ($DoctorArgs -join ' '))
    Say ('  env overrides  : ' + $envJson)
    Say ('  exit           : expected=' + $ExpectExit + '  actual=' + $actual)
    Say ('  wall clock     : harness=' + $sw.ElapsedMilliseconds + 'ms   node=' + $nodeWall + 'ms')
    Say ('  doctor_stdout  : bytes=' + $doctorText.Length + '  lines=' + $outLines)
    Say ('  doctor_stderr  : bytes=' + $doctorErr.Length + '  ' + $(if ($doctorErr -eq '') { '(empty)' } else { 'NON-EMPTY -- see file' }))
    Say ('  node_argv      : ' + $(if ($null -ne $j) { ($j.argv -join ' ') } else { 'n/a' }))

    return [pscustomobject]@{
        Name = $Name; Expect = $ExpectExit; Actual = $actual
        Text = $doctorText; Err = $doctorErr
        WallMs = $sw.ElapsedMilliseconds; NodeWallMs = $nodeWall
        OutBytes = $doctorText.Length; OutLines = $outLines
        OutPath = $out; ErrPath = $err
    }
}

# =========================================================================== fixtures
#
# THE HARNESS OWNS EVERYTHING IT NEEDS.
#
# The previous harness built its happy path out of live machine state: a live
# opencode loopback port, a live `omo.jsonc` with tmux enabled, a live
# `p14probe__m.port`, and a live 86 MB compiled shim. Every one of those is absent
# on a machine that is not currently mid-session, so `Skip-Case` fired and the
# most important case -- the healthy one -- was usually the one that never ran.
#
# Everything below is manufactured under $WorkDir instead. The doctor is still
# read-only; the fixtures are the harness's own setup, created before the run and
# torn down after, and the read-only proof at the end shows the live registry,
# live config, live PATH and live bridge bin are byte-identical across it all.

New-Dir $work | Out-Null

# --- fixture bin: the doctor under test plus a stub shim ---------------------
#
# The doctor stats and hashes bin\tmux.exe and NEVER EXECUTES IT (stated in its
# own .DESCRIPTION), so a 60-byte stub is a complete stand-in for the real 86 MB
# compiled binary and makes the harness runnable without a Bun cross-build.
$fixtureBin = New-Dir (Join-Path $work 'fixture-bin')
Copy-Item -LiteralPath $doctorSrc -Destination (Join-Path $fixtureBin 'bridge-doctor.ps1') -Force
$shimStub = Write-File (Join-Path $fixtureBin 'tmux.exe') "bridge-doctor-harness shim stub`nnot a multiplexer; never executed`n"
$shimHash = (Get-FileHash -LiteralPath $shimStub -Algorithm SHA256).Hash
$shimBytes = (Get-Item -LiteralPath $shimStub).Length

# A genuinely DIFFERENT bridge bin dir, named with the LEGACY project name so
# that this case proves the doctor still recognizes a pre-rename directory as a
# second owner. The doctor's `Test-BridgeBinEntry` must match both names, and
# the self-match skip must not swallow this one.
$shadowBin = New-Dir (Join-Path $work 'shadow\opencode-psmux-bridge\bin')
Write-File (Join-Path $shadowBin 'tmux.exe') 'shadow bin stub' | Out-Null

# Hermetic PATH: the fixture bin and System32, nothing else. The doctor spawns no
# external process, so this is sufficient, and it keeps the host's real PATH (which
# contains the real bridge bin) out of the PATH-ownership assertion.
$ownedPath = $fixtureBin + ';' + (Join-Path $env:SystemRoot 'System32')

# --- health fixture ----------------------------------------------------------
#
# An owned HTTP endpoint on an OS-assigned loopback port answering
# GET /global/health. Two listeners in one child: `ok` answers 200, `bad` answers
# 503, because "the server answered, but not ok" is a distinct silent failure that
# OmO's `isServerRunning` reads as "not running".
$healthBodyOk = '{"status":"ok","fixture":"bridge-doctor-harness"}'
$healthBodyBad = '{"status":"degraded","fixture":"bridge-doctor-harness"}'
$healthScript = @'
param([string] $PortFile, [string] $BodyOk, [string] $BodyBad)
$ErrorActionPreference = 'Stop'
$ok  = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, 0)
$bad = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, 0)
$ok.Start()
$bad.Start()
$ports = ([System.Net.IPEndPoint]$ok.LocalEndpoint).Port.ToString() + ' ' + ([System.Net.IPEndPoint]$bad.LocalEndpoint).Port
[System.IO.File]::WriteAllText($PortFile, $ports)

function Get-Response {
    param([int] $Code, [string] $Reason, [string] $Body)
    return ('HTTP/1.1 ' + $Code + ' ' + $Reason + "`r`n" +
            'Content-Type: application/json' + "`r`n" +
            'Content-Length: ' + $Body.Length + "`r`n" +
            'Connection: close' + "`r`n`r`n" + $Body)
}
function Serve-One {
    param($Client, [string] $Response)
    try {
        $s = $Client.GetStream()
        $s.ReadTimeout = 2000
        $buf = New-Object byte[] 4096
        # Read the request head, then ignore it: only the status line and the
        # body are asserted on, and the fixture must not hang on a partial send.
        [void]$s.Read($buf, 0, $buf.Length)
        $b = [System.Text.Encoding]::ASCII.GetBytes($Response)
        $s.Write($b, 0, $b.Length)
        $s.Flush()
    } catch { }
    finally { try { $Client.Close() } catch { } }
}
$respOk  = Get-Response -Code 200 -Reason 'OK' -Body $BodyOk
$respBad = Get-Response -Code 503 -Reason 'Service Unavailable' -Body $BodyBad
# Single-threaded poll loop. TcpListener.Pending() never blocks, so both
# listeners are serviced from one thread with no job, runspace or extra process
# to leak.
while ($true) {
    while ($ok.Pending()) { Serve-One -Client $ok.AcceptTcpClient() -Response $respOk }
    while ($bad.Pending()) { Serve-One -Client $bad.AcceptTcpClient() -Response $respBad }
    Start-Sleep -Milliseconds 5
}
'@
$healthScriptPath = Write-File (Join-Path $work 'health-fixture.ps1') $healthScript
$portFile = Join-Path $work 'health-fixture-port.txt'
Remove-Item -LiteralPath $portFile -ErrorAction SilentlyContinue
$healthProc = Start-Process -FilePath $psExe -ArgumentList (Quote-Argv @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $healthScriptPath, '-PortFile', $portFile,
        '-BodyOk', $healthBodyOk, '-BodyBad', $healthBodyBad)) `
    -NoNewWindow -PassThru

$deadline = [System.Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path -LiteralPath $portFile) -and $deadline.ElapsedMilliseconds -lt 15000) {
    Start-Sleep -Milliseconds 50
}
$healthPort = 0
$unhealthyPort = 0
if (Test-Path -LiteralPath $portFile) {
    $parts = ([System.IO.File]::ReadAllText($portFile)).Trim() -split ' '
    if ($parts.Count -ge 2) {
        $healthPort = [int]$parts[0]
        $unhealthyPort = [int]$parts[1]
    }
}
$healthUp = ($healthPort -gt 0) -and ($unhealthyPort -gt 0)
$deadPort = Get-FreeLoopbackPort

# --- config fixtures ---------------------------------------------------------
$onCfg  = Write-File (Join-Path $work 'omo-tmux-on.jsonc')  '{ "[opencode]": { "tmux": { "enabled": true } } }'
$offCfg = Write-File (Join-Path $work 'omo-tmux-off.jsonc') '{ "[opencode]": { "tmux": { "enabled": false } } }'

# Legal JSONC with trailing commas: the checked-in fixture under
# fixtures\ holds the exact bytes (comments, a block comment, a $schema URL,
# strings containing ,} and ,] plus //, nested arrays, four trailing commas).
# Copied, never generated, so the bytes the doctor parses are the bytes under
# version control.
$trailingSrc = Join-Path $src 'fixtures\omo-tmux-on-trailing-commas.jsonc'
$trailingCfg = Join-Path $work 'omo-trailing-commas.jsonc'
Copy-Item -LiteralPath $trailingSrc -Destination $trailingCfg -Force

# Malformed config carrying a sentinel inside a string value. Truncated before
# any closing brace, so no converter can save it: check 4 must stay FAIL while
# the sentinel stays out of stdout AND stderr. Generated, never checked in.
$sentinel = 'HARNESS-SENTINEL-9F8E7D6C5B4A'
$malformedCfg = Write-File (Join-Path $work 'omo-malformed.jsonc') ('{ "[opencode]": { "tmux": { "enabled": true, "token": "' + $sentinel + '",')

# --- registry fixtures for check 2 ------------------------------------------
#
# check 2 fires only when a `<ns>__<session>.port` exists AND is older than the
# shim. Both fixtures live in their own scratch data dirs, never in the live
# psmux data dir, so no live session is read and none is created.
$liveFixtureDir = New-Dir (Join-Path $work 'registry-fixture-live')
$freshPortFile = Write-File (Join-Path $liveFixtureDir 'fxlive__fresh.port') ([string]$healthPort)
[System.IO.File]::SetLastWriteTimeUtc($freshPortFile, [datetime]::new(2035, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc))

$staleFixtureDir = New-Dir (Join-Path $work 'stale-fixture-data')
$stalePortFile = Write-File (Join-Path $staleFixtureDir 'fxprobe__stale.port') ([string]$healthPort)
[System.IO.File]::SetLastWriteTimeUtc($stalePortFile, [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc))

$emptyFixtureDir = New-Dir (Join-Path $work 'registry-fixture-empty')

# --- package fixtures for check 5 -------------------------------------------
#
# A synthetic bundle proves the drift DETECTOR works. It does not prove anything
# about the real 5.1.43 bundle, and case J below is the one that does that, by
# reading the INSTALLED package tree read-only.
function New-SyntheticBundle {
    param([string] $Root, [int] $DriftLine)
    $rel = 'oh-my-openagent@latest\node_modules\oh-my-openagent'
    $dir = New-Dir (Join-Path $Root $rel)
    $distDir = New-Dir (Join-Path $dir 'dist')
    Write-File (Join-Path $dir 'package.json') ('{ "name": "oh-my-openagent", "version": "' + $contractVersion + '" }') | Out-Null
    $maxLine = 1
    foreach ($a in $anchorTable) { if ($a.Line -gt $maxLine) { $maxLine = $a.Line } }
    # 1-BASED source line N lives at $lines[N-1], and the array is written with
    # WriteAllLines rather than `+=` in a loop: the highest anchor is line 156576,
    # and PowerShell's string `+=` is O(n^2), which hangs on a 5 MB document.
    $lines = New-Object 'string[]' $maxLine
    for ($i = 1; $i -le $maxLine; $i++) { $lines[$i - 1] = 'var filler_line_' + $i + ' = ' + $i + ';' }
    foreach ($a in $anchorTable) {
        if ($a.Line -eq $DriftLine) { $lines[$a.Line - 1] = 'var drifted_at_' + $a.Line + ' = 1;' }
        else { $lines[$a.Line - 1] = $a.Text }
    }
    # New-Dir created the PACKAGE root, not dist/: File.WriteAllLines will not
    # create a missing parent, so writing here without it throws
    # DirectoryNotFoundException and the harness dies before any case runs.
    New-Dir (Join-Path $dir 'dist') | Out-Null
    [System.IO.File]::WriteAllLines((Join-Path $distDir 'index.js'), $lines)
    return $Root
}
$pkgGood = New-SyntheticBundle -Root (Join-Path $work 'pkg-clean') -DriftLine 0
$pkgDrift = New-SyntheticBundle -Root (Join-Path $work 'pkg-drift') -DriftLine $driftAnchorLine

$livePkgRoot = Join-Path $env:USERPROFILE '.cache\opencode\packages'
$livePkgOk = (Test-Path -LiteralPath (Join-Path $livePkgRoot 'oh-my-openagent@latest\node_modules\oh-my-openagent\dist\index.js')) -or
             ((Test-Path -LiteralPath $livePkgRoot) -and (@(Get-ChildItem -LiteralPath $livePkgRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'oh-my-openagent*' }).Count -gt 0))

# --- host observation for the one inherently host-dependent case ------------
$opencodeListener = $false
$fallbackBusy = $false
foreach ($r in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    $a = [string]$r.LocalAddress
    if ($a -ne '127.0.0.1' -and $a -ne '::1') { continue }
    if ([int]$r.LocalPort -eq 4096) { $fallbackBusy = $true }
    $nm = ''
    try { $nm = (Get-Process -Id ([int]$r.OwningProcess) -ErrorAction Stop).ProcessName } catch { }
    if ($nm -like 'opencode*') { $opencodeListener = $true }
}
$noHealthReachable = (-not $fallbackBusy) -and (-not $opencodeListener)

# --------------------------------------------------------------------------- snapshots
# What "the doctor changed nothing" means, made checkable rather than asserted.
function Get-ReadOnlySnapshot {
    param([string[]] $ExtraDirs)
    $sb = New-Object System.Text.StringBuilder
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    [void]$sb.AppendLine('USER_PATH=' + [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))
    $k.Close()
    foreach ($f in @($LiveConfigPath, (Join-Path $LiveDataDir 'last_session'))) {
        if (Test-Path -LiteralPath $f) {
            $i = Get-Item -LiteralPath $f
            [void]$sb.AppendLine('FILE ' + $f + ' sha256=' + (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash + ' bytes=' + $i.Length + ' mtime_utc=' + $i.LastWriteTimeUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"))
        } else {
            [void]$sb.AppendLine('FILE ' + $f + ' MISSING')
        }
    }
    foreach ($d in @($bridgeBin) + @($ExtraDirs)) {
        if (-not (Test-Path -LiteralPath $d)) { [void]$sb.AppendLine('DIR ' + $d + ' MISSING'); continue }
        foreach ($b in @(Get-ChildItem -LiteralPath $d -File -Force -ErrorAction SilentlyContinue | Sort-Object Name)) {
            [void]$sb.AppendLine('DIRFILE ' + $d + ' | ' + $b.Name + ' bytes=' + $b.Length + ' sha256=' + (Get-FileHash -LiteralPath $b.FullName -Algorithm SHA256).Hash)
        }
    }
    return $sb.ToString()
}
function Get-ProcSnapshot {
    $names = @()
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(psmux|tmux)' })) {
        $names += ([string]$p.Id + ':' + $p.ProcessName)
    }
    return (@($names | Sort-Object) -join ' ')
}

Sep '='
Say 'ENVIRONMENT'
Say ('  doctor under test      : ' + $fixtureBin + '\bridge-doctor.ps1')
Say ('  stub shim              : bytes=' + $shimBytes + ' sha256=' + $shimHash)
Say ('  hermetic PATH          : ' + $ownedPath)
Say ('  health fixture         : up=' + $healthUp + '  ok_port=' + $healthPort + '  unhealthy_port=' + $unhealthyPort + '  pid=' + $healthProc.Id)
Say ('  reserved dead port     : ' + $deadPort)
Say ('  live pkg root present  : ' + $livePkgOk + '  (' + $livePkgRoot + ')')
Say ('  host opencode listener : ' + $opencodeListener + '  fallback_4096_busy=' + $fallbackBusy)
Say ('  contract version       : ' + $contractVersion)
Say ('  anchors read from doctor: ' + $anchorTable.Count + ' rows, max line ' + $(if ($anchorTable.Count -gt 0) { [string](($anchorTable | Measure-Object -Property Line -Maximum).Maximum) } else { 'n/a' }))
Assert -Ok ($anchorTable.Count -eq 11) -Name 'the doctor still declares exactly 11 check-5 anchors' -Detail ('found=' + $anchorTable.Count)
Assert -Ok ($driftAnchorLine -gt 0 -and @($anchorTable | Where-Object { $_.Line -eq $driftAnchorLine }).Count -eq 1) -Name ('the anchor this harness corrupts in case C exists at line ' + $driftAnchorLine) -Detail ('found=' + $driftAnchorLine)

$snapBefore = Get-ReadOnlySnapshot -ExtraDirs @($fixtureBin)
$procBefore = Get-ProcSnapshot

$envOwned = @{ PATH = $ownedPath }
$envHappy = @{ PATH = $ownedPath; OPENCODE_PORT = [string]$healthPort }
$envUnhealthy = @{ PATH = $ownedPath; OPENCODE_PORT = [string]$unhealthyPort }
$envDeadPort = @{ PATH = $ownedPath; OPENCODE_PORT = [string]$deadPort }
$envNoPort = @{ PATH = $ownedPath; OPENCODE_PORT = $null }
$envNoBridge = @{ PATH = (Join-Path $env:SystemRoot 'System32'); OPENCODE_PORT = [string]$healthPort }
$envShadow = @{ PATH = ($fixtureBin + ';' + $shadowBin + ';' + (Join-Path $env:SystemRoot 'System32')); OPENCODE_PORT = [string]$healthPort }

$healthyArgs = @('-Namespace', 'fxlive', '-Session', 'fresh', '-DataDir', $liveFixtureDir, '-ConfigPath', $onCfg, '-PackageRoot', $pkgGood)

# --- config-resolution fixtures ------------------------------------------------
# The doctor's default -ConfigPath used to be a hardcoded
# %USERPROFILE%\.omo\omo.jsonc. OmO resolves it as HOME ?? USERPROFILE ?? cwd and
# then omo.jsonc, else omo.json (index.js:87886-87902), so the old default could
# point at a file OmO never opens. These two sandboxes drive the DEFAULT end to
# end, through the real doctor, with no -ConfigPath at all.
$cfgHomeJsonRoot = New-Dir (Join-Path $work 'cfg-home-json')
$cfgHomeJson = New-Dir (Join-Path $cfgHomeJsonRoot '.omo')
[System.IO.File]::WriteAllText((Join-Path $cfgHomeJson 'omo.json'), '{ "[opencode]": { "tmux": { "enabled": false } } }')
$cfgHomeJsoncRoot = New-Dir (Join-Path $work 'cfg-home-jsonc')
$cfgHomeJsonc = New-Dir (Join-Path $cfgHomeJsoncRoot '.omo')
[System.IO.File]::WriteAllText((Join-Path $cfgHomeJsonc 'omo.jsonc'), '{ "[opencode]": { "tmux": { "enabled": true } } }')

$healthyFixtureArgs = @('-Namespace', 'fxlive', '-Session', 'fresh', '-DataDir', $liveFixtureDir, '-PackageRoot', $pkgGood)

$results = @()
$results += Invoke-Case -Name 'A-healthy'       -EnvOverrides $envHappy     -DoctorArgs $healthyArgs -ExpectExit 0
$results += Invoke-Case -Name 'B-wrongversion'  -EnvOverrides $envHappy     -DoctorArgs ($healthyArgs + @('-FrozenOmoVersion', '0.0.1')) -ExpectExit 50
$results += Invoke-Case -Name 'C-wronganchor'   -EnvOverrides $envHappy     -DoctorArgs @('-Namespace', 'fxlive', '-Session', 'fresh', '-DataDir', $liveFixtureDir, '-ConfigPath', $onCfg, '-PackageRoot', $pkgDrift) -ExpectExit 50
$results += Invoke-Case -Name 'D-disabledconfig' -EnvOverrides $envHappy    -DoctorArgs @('-Namespace', 'fxlive', '-Session', 'fresh', '-DataDir', $liveFixtureDir, '-ConfigPath', $offCfg, '-PackageRoot', $pkgGood) -ExpectExit 40
if ($noHealthReachable) {
    $results += Invoke-Case -Name 'E-nohealth'    -EnvOverrides $envNoPort    -DoctorArgs @('-Namespace', 'fxlive', '-Session', 'fresh', '-DataDir', $emptyFixtureDir, '-ConfigPath', $onCfg, '-PackageRoot', $pkgGood) -ExpectExit 30
} else { Skip-Case -Name 'E-nohealth' -Reason 'a loopback listener the doctor would resolve is present on this host' }
$results += Invoke-Case -Name 'F-unhealthy503'  -EnvOverrides $envUnhealthy -DoctorArgs $healthyArgs -ExpectExit 0
$results += Invoke-Case -Name 'G-deadport'      -EnvOverrides $envDeadPort  -DoctorArgs ($healthyArgs + @('-HealthTimeoutMs', '700')) -ExpectExit 0
$results += Invoke-Case -Name 'H-path'          -EnvOverrides $envNoBridge  -DoctorArgs $healthyArgs -ExpectExit 10
$results += Invoke-Case -Name 'I-shadowbin'     -EnvOverrides $envShadow   -DoctorArgs $healthyArgs -ExpectExit 0
if ($livePkgOk) {
    $results += Invoke-Case -Name 'J-real-anchors' -EnvOverrides $envHappy    -DoctorArgs @('-Namespace', 'fxlive', '-Session', 'fresh', '-DataDir', $liveFixtureDir, '-ConfigPath', $onCfg, '-HealthTimeoutMs', '700') -ExpectExit 0
} else { Skip-Case -Name 'J-real-anchors' -Reason 'no installed oh-my-openagent bundle on this host' }

# Default config resolution, no -ConfigPath. HOME is overridden in the CHILD env
# while USERPROFILE stays the real one, so this proves HOME takes precedence.
$results += Invoke-Case -Name 'K-home-precedence' -EnvOverrides @{ PATH = $ownedPath; OPENCODE_PORT = [string]$healthPort; HOME = $cfgHomeJsonRoot } -DoctorArgs $healthyFixtureArgs -ExpectExit 40
$results += Invoke-Case -Name 'L-home-jsonc' -EnvOverrides @{ PATH = $ownedPath; OPENCODE_PORT = [string]$healthPort; HOME = $cfgHomeJsoncRoot } -DoctorArgs $healthyFixtureArgs -ExpectExit 0

# Gate-4 JSONC cases. M is the parent's real host file in miniature: legal
# JSONC with trailing commas that PS5.1 ConvertFrom-Json rejects raw. N is
# unparseable even after conversion and carries a sentinel that must never
# reach the screen.
$results += Invoke-Case -Name 'M-trailingcommas' -EnvOverrides $envHappy -DoctorArgs @('-Namespace', 'fxlive', '-Session', 'fresh', '-DataDir', $liveFixtureDir, '-ConfigPath', $trailingCfg, '-PackageRoot', $pkgGood) -ExpectExit 0
$results += Invoke-Case -Name 'N-malformedsecret' -EnvOverrides $envHappy -DoctorArgs @('-Namespace', 'fxlive', '-Session', 'fresh', '-DataDir', $liveFixtureDir, '-ConfigPath', $malformedCfg, '-PackageRoot', $pkgGood) -ExpectExit 40

$snapAfter = Get-ReadOnlySnapshot -ExtraDirs @($fixtureBin)
$procAfter = Get-ProcSnapshot

# Stop the one process this harness started. Exact PID, nothing enumerated: this
# is the harness cleaning up after itself, not a general process sweep.
if (-not $healthProc.HasExited) { Stop-Process -Id $healthProc.Id -Force -ErrorAction SilentlyContinue }

# =========================================================================== assertions

Sep '='
Say 'ASSERTIONS'
$byName = @{}
foreach ($r in $results) { $byName[$r.Name] = $r }

foreach ($r in $results) {
    Assert -Ok ($r.Actual -eq $r.Expect) -Name ($r.Name + ': exit code is ' + $r.Expect) -Detail ('actual=' + $r.Actual)
    Assert -Ok ($r.OutLines -ge 30) -Name ($r.Name + ': stdout is real content, not an empty capture') -Detail ('lines=' + $r.OutLines)
    Assert -Ok ($r.Err -eq '') -Name ($r.Name + ': stderr empty') -Detail ('bytes=' + $r.Err.Length)
    Assert -Ok ($r.WallMs -lt 15000) -Name ($r.Name + ': wall clock bounded') -Detail ('harness=' + $r.WallMs + 'ms node=' + $r.NodeWallMs + 'ms')
    Assert -Ok ($r.Text -notmatch 'INTERNAL-ERROR') -Name ($r.Name + ': no INTERNAL-ERROR')
    Assert -Ok ($r.Text -match 'elapsed_ms=') -Name ($r.Name + ': the doctor printed its own elapsed_ms')
    Assert -Ok ($r.Text -match 'READ-ONLY: writes nothing, kills nothing, fixes nothing, starts nothing\.') -Name ($r.Name + ': read-only banner present')
}

# ---------------------------------------------------------------- A: healthy
if ($byName.ContainsKey('A-healthy')) {
$ca = $byName['A-healthy']
$passLines = @(Get-VerdictLines -Text $ca.Text -State 'PASS')
$failLines = @(Get-VerdictLines -Text $ca.Text -State 'FAIL')
Assert -Ok ($failLines.Count -eq 0) -Name 'A: zero FAIL lines' -Detail ('fail=' + $failLines.Count)
Assert -Ok ($passLines.Count -eq 5) -Name 'A: exactly five PASS lines' -Detail ('pass=' + $passLines.Count)
$nums = @($passLines | ForEach-Object { $_.N } | Sort-Object)
Assert -Ok (($nums -join ',') -eq '1,2,3,4,5') -Name 'A: the five PASS lines name five DIFFERENT checks' -Detail ('numbers=' + ($nums -join ','))
$titles = @($passLines | ForEach-Object { $_.Title })
Assert -Ok (@($titles | Sort-Object -Unique).Count -eq 5) -Name 'A: the five PASS titles are five DIFFERENT strings'
Say ('  A PASS titles: ' + (($passLines | ForEach-Object { ([string]$_.N) + '=' + $_.Title }) -join ' | '))

# ANTI-VACUOUS GUARD: five PASS lines from five silent no-ops would satisfy the
# three assertions above. These force real observed values out of the report.
Assert -Ok ($ca.Text -match ('tmux\.exe_sha256=' + $shimHash)) -Name 'A: check 1 carries the REAL sha256 of the shim it hashed'
Assert -Ok ($ca.Text -match ('tmux\.exe_present=yes  bytes=' + $shimBytes)) -Name 'A: check 1 carries the REAL byte size'
Assert -Ok ($ca.Text -match 'tmux\.exe_sha256_match=') -Name 'A: check 1 compared that hash to the expected value'
Assert -Ok ($ca.Text -match ('first_path_entry_resolving_tmux=' + [regex]::Escape($fixtureBin + '\tmux.exe'))) -Name 'A: check 1 names the exact file that won PATH resolution'
Assert -Ok ($ca.Text -match ('config=' + [regex]::Escape($onCfg) + '  exists=True')) -Name 'A: check 4 carries the REAL config path it read'
Assert -Ok ($ca.Text -match '\[opencode\]\.tmux\.enabled = true   \(observed literally') -Name 'A: check 4 reports the value it actually parsed out of the document'
Assert -Ok ($ca.Text -match ('registry_entry=fxlive__fresh\.port  port=' + $healthPort)) -Name 'A: check 2 read the REAL port out of the fixture registry entry'
Assert -Ok ($ca.Text -match '\(heuristic\) A=fxlive__fresh\.port  mtime_utc=2035') -Name 'A: check 2 compared two REAL files with real mtimes'
Assert -Ok ($ca.Text -match 'listener_table_read_ms=\d+') -Name 'A: check 3 measured its own listener-table cost'
Assert -Ok ($ca.Text -match ('probed http://127\.0\.0\.1:' + $healthPort + '/global/health')) -Name 'A: check 3 names the endpoint it actually probed'
Assert -Ok ($ca.Text -match 'http_status=200') -Name 'A: check 3 got a real 200 from the owned fixture'
Assert -Ok ($ca.Text -match 'body=\[.*bridge-doctor-harness') -Name 'A: check 3 printed the REAL body the fixture served'
Assert -Ok ($ca.Text -match 'frozen_line_anchors_resolved=11/11') -Name 'A: check 5 verified all 11 line anchors in the synthetic bundle'
Assert -Ok ($ca.Text -match ('contract_frozen_version=' + $contractVersion)) -Name 'A: check 5 reports the frozen version'
Assert -Ok ($ca.Text -match ('installed_version=' + $contractVersion)) -Name 'A: check 5 read the installed version from the fixture package.json'
Assert -Ok ($ca.Text -match 'verdict=PASS') -Name 'A: machine-readable verdict=PASS'
Assert -Ok (-not ($ca.Text -match '\[FAIL \]')) -Name 'A: no FAIL marker anywhere in the output'
Assert -Ok (-not ($ca.Text -match 'another bridge bin directory')) -Name 'A: the doctor does NOT warn about a bridge bin dir when only its own bin dir is on PATH'
Assert -Ok (@(Get-WarnLines -Text $ca.Text).Count -eq 0) -Name 'A: a healthy host produces ZERO WARN lines'
Assert -Ok ($ca.Text -match 'false_negative=\(heuristic\) a server started after the install but before a PATH change will NOT be detected\.') -Name 'A: stale-server false-negative stated in ONE line, verbatim'
Assert -Ok ($ca.Text -match '\[PASS \] 2 STALE-SERVER \(heuristic\)') -Name 'A: check 2 PASS verdict is labelled (heuristic)'
} else { Skip-Case -Name 'A-asserts' -Reason 'case A did not run' }

# ------------------------------------------------- B: wrong frozen version
if ($byName.ContainsKey('B-wrongversion')) {
$cb = $byName['B-wrongversion']
$bFail = @(Get-VerdictLines -Text $cb.Text -State 'FAIL')
Assert -Ok ($bFail.Count -ge 1) -Name 'B: at least one FAIL line' -Detail ('fail=' + $bFail.Count)
Assert -Ok ($bFail[0].N -eq 5) -Name 'B: the FIRST failing check is 5 (VERSION)' -Detail ('first=' + $bFail[0].N)
Assert -Ok ($cb.Text -match 'frozen_line_anchors_resolved=11/11') -Name 'B: the anchors still resolve, so this isolates the VERSION half of check 5'
Assert -Ok ($cb.Text -match 'is neither the frozen 0\.0\.1') -Name 'B: the version FAIL names the frozen version it expected'
# THE REGRESSION THIS CASE EXISTS FOR. With the concatenation unparenthesised,
# PowerShell passed four arguments to Write-Cause, three of them landed in $args,
# and the line printed as "CAUSE the contract is frozen against " -- the frozen
# version gone. A reader was told the contract was frozen against nothing.
Assert -Ok ($cb.Text -match 'the contract is frozen against 0\.0\.1, whose line numbers this check') -Name 'B: the message that must name the frozen version actually names it'
Assert -Ok (-not ($cb.Text -match 'the contract is frozen against\s*$')) -Name 'B: no message line ends with a dropped "frozen against " clause'
Assert -Ok ($cb.Text -match '\[FAIL \] 5 OmO package version drift') -Name 'B: check 5 FAIL verdict present'
} else { Skip-Case -Name 'B-asserts' -Reason 'case B did not run' }

# ----------------------------------------------------- C: wrong line anchor
if ($byName.ContainsKey('C-wronganchor')) {
$cc = $byName['C-wronganchor']
$cFail = @(Get-VerdictLines -Text $cc.Text -State 'FAIL')
Assert -Ok ($cFail.Count -ge 1) -Name 'C: at least one FAIL line' -Detail ('fail=' + $cFail.Count)
Assert -Ok ($cFail[0].N -eq 5) -Name 'C: the FIRST failing check is 5' -Detail ('first=' + $cFail[0].N)
Assert -Ok ($cc.Text -match 'installed_version=' + $contractVersion) -Name 'C: the version is CORRECT, so this isolates the ANCHOR half of check 5'
Assert -Ok ($cc.Text -match 'frozen_line_anchors_resolved=10/11') -Name 'C: exactly one of eleven anchors failed to resolve'
Assert -Ok ($cc.Text -match ('line ' + $driftAnchorLine + ' drifted: expected `' + [regex]::Escape($driftAnchorText) + '`')) -Name 'C: the drift line names the line number and the expected text'
Assert -Ok ($cc.Text -match 'verdict_basis=version-equality') -Name 'C: the version half PASSED and was reported as such'
Assert -Ok (-not ($cc.Text -match '\[FAIL \] [1-4] ')) -Name 'C: no other check failed, so the drift really is isolated to check 5'
} else { Skip-Case -Name 'C-asserts' -Reason 'case C did not run' }

# ------------------------------------------------- D: config says disabled
if ($byName.ContainsKey('D-disabledconfig')) {
$cd = $byName['D-disabledconfig']
$dFail = @(Get-VerdictLines -Text $cd.Text -State 'FAIL')
Assert -Ok ($dFail.Count -ge 1) -Name 'D: at least one FAIL line' -Detail ('fail=' + $dFail.Count)
Assert -Ok ($dFail[0].N -eq 4) -Name 'D: the FIRST failing check is 4 (CONFIG)' -Detail ('first=' + $dFail[0].N)
Assert -Ok ($cd.Text -match '\[opencode\]\.tmux\.enabled = false') -Name 'D: it reports the value it actually parsed (false)'
Assert -Ok ($cd.Text -match ('set \[opencode\]\.tmux\.enabled = true in ' + [regex]::Escape($offCfg))) -Name 'D: the FIX line carries both the key and the path'
Assert -Ok ($cd.Text.Contains($offCfg)) -Name 'D: output names the config FILE PATH'
Assert -Ok (-not ($cd.Text -match '\[opencode\]\.tmux\.enabled = "false"')) -Name 'D: it is a boolean false, not the string "false"'
Assert -Ok ($cd.Text -match 'frozen_line_anchors_resolved=11/11') -Name 'D: check 5 passed, so the exit code isolates CONFIG'
} else { Skip-Case -Name 'D-asserts' -Reason 'case D did not run' }

# ----------------------------------------------------- E: no health reachable
if ($byName.ContainsKey('E-nohealth')) {
$ce = $byName['E-nohealth']
$eFail = @(Get-VerdictLines -Text $ce.Text -State 'FAIL')
Assert -Ok ($eFail.Count -ge 1) -Name 'E: at least one FAIL line' -Detail ('fail=' + $eFail.Count)
Assert -Ok ($eFail[0].N -eq 3) -Name 'E: the FIRST failing check is 3 (PORT)' -Detail ('first=' + $eFail[0].N)
Assert -Ok ($ce.Text -match 'probed NOTHING') -Name 'E: the doctor says plainly that it probed nothing'
Assert -Ok ($ce.Text -match '\[FAIL \] 3 OpenCode port resolution') -Name 'E: check 3 FAIL verdict present, so exit 30 is reachable'
} else { Skip-Case -Name 'E-asserts' -Reason 'case E did not run' }

# --------------------------------------- F: health endpoint answers not-ok
if ($byName.ContainsKey('F-unhealthy503')) {
$cf = $byName['F-unhealthy503']
$fWarn = @(Get-WarnLines -Text $cf.Text)
Assert -Ok ($fWarn.Count -ge 1) -Name 'F: at least one WARN line' -Detail ('warn=' + $fWarn.Count)
Assert -Ok ($cf.Text -match 'http_status=503') -Name 'F: check 3 reports the real 503 status it received'
Assert -Ok ($cf.Text -match 'answered HTTP 503 to /global/health') -Name 'F: it names the endpoint that answered non-ok'
Assert -Ok ($cf.Text -match 'accepts only `response\.ok`') -Name 'F: it explains the OmO-side consequence (isServerRunning reads this as not-running)'
Assert -Ok ($cf.Text -match '\[PASS \] 3 OpenCode port resolution') -Name 'F: check 3 still PASSes -- it grades RESOLUTION, not health'
Assert -Ok ($cf.Text -match 'verdict=PASS') -Name 'F: the run as a whole is PASS, with the health fault reported as a WARN'
} else { Skip-Case -Name 'F-asserts' -Reason 'case F did not run' }

# --------------------------------------------- G: nothing answers the port
if ($byName.ContainsKey('G-deadport')) {
$cg = $byName['G-deadport']
$gWarn = @(Get-WarnLines -Text $cg.Text)
Assert -Ok ($gWarn.Count -ge 1) -Name 'G: at least one WARN line' -Detail ('warn=' + $gWarn.Count)
Assert -Ok ($cg.Text -match ('set, but nothing answered /global/health on port ' + $deadPort)) -Name 'G: it names the port that answered nothing'
Assert -Ok ($cg.Text -match '\[PASS \] 3 OpenCode port resolution') -Name 'G: resolution still PASSes because OPENCODE_PORT is set'
} else { Skip-Case -Name 'G-asserts' -Reason 'case G did not run' }

# ---------------------------------------------------------- H: PATH failure
if ($byName.ContainsKey('H-path')) {
$ch = $byName['H-path']
$hFail = @(Get-VerdictLines -Text $ch.Text -State 'FAIL')
Assert -Ok ($hFail.Count -ge 1) -Name 'H: at least one FAIL line' -Detail ('fail=' + $hFail.Count)
Assert -Ok ($hFail[0].N -eq 1) -Name 'H: the FIRST reported failure is check 1 (PATH)' -Detail ('first=' + $hFail[0].N)
$winnerM = [regex]::Match($ch.Text, 'first_path_entry_resolving_tmux=(\S+)')
Assert -Ok ($winnerM.Success -and ([string]::Compare($winnerM.Groups[1].Value, (Join-Path $fixtureBin 'tmux.exe'), $true) -ne 0)) -Name 'H: the winner is NOT the bridge shim' -Detail ('winner=' + $winnerM.Groups[1].Value)
Assert -Ok ($ch.Text -match 'tmux\.exe_present=yes') -Name 'H: the shim IS present, so this is a PATH problem not a missing-file problem'
Assert -Ok ($ch.Text -match 'bin_dir_index_in_effective_path=-1') -Name 'H: the bridge bin directory is absent from the child PATH (index -1)'
Assert -Ok ($ch.Text -match 'never run this doctor from a shell started before the install') -Name 'H: the remedy names the stale-shell trap'
} else { Skip-Case -Name 'H-asserts' -Reason 'case H did not run' }

# ------------------------------------------------- I: a genuine shadow bin
if ($byName.ContainsKey('I-shadowbin')) {
$ci = $byName['I-shadowbin']
Assert -Ok ($ci.Text -match 'another bridge bin directory is on the PATH') -Name 'I: a SECOND, DIFFERENT bridge bin dir still raises the shadow WARN'
Assert -Ok ($ci.Text -match 'opencode-psmux-bridge') -Name 'I: the legacy-named shadow is recognized as bridge-owned, not as an unrelated directory'
Assert -Ok ($ci.Text -match ([regex]::Escape($shadowBin))) -Name 'I: the WARN names the offending directory'
Assert -Ok (-not ($ci.Text -match ([regex]::Escape('on the PATH: ' + $fixtureBin)))) -Name 'I: the WARN does not name the doctor own bin dir'
Assert -Ok ($ci.Text -match '\[PASS \] 1 PATH ownership') -Name 'I: a shadowed-but-correctly-ordered PATH still PASSes check 1'
Assert -Ok ($ci.Text -match 'verdict=PASS') -Name 'I: the shadow is a WARN, never a fault'
} else { Skip-Case -Name 'I-asserts' -Reason 'case I did not run' }

# ------------------------------------------- J: the REAL installed bundle
if ($byName.ContainsKey('J-real-anchors')) {
$cj = $byName['J-real-anchors']
# Only the installed bundle proves that the contracted version's anchors resolve.
Assert -Ok ($cj.Text -match 'frozen_line_anchors_resolved=11/11') -Name 'J: all 11 anchors resolve in the INSTALLED bundle'
Assert -Ok ($cj.Text -match 'bundle=C:\\Users') -Name 'J: the bundle it read is the live installed one, not a synthetic fixture'
Assert -Ok ($cj.Text -match ('installed_version=' + $contractVersion)) -Name 'J: the installed package.json reports the contracted version'
Assert -Ok ($cj.Text -match ('contract_frozen_version=' + $contractVersion)) -Name 'J: the frozen default equals the installed version'
Assert -Ok ($cj.Text -notmatch 'line \d+ drifted:') -Name 'J: not one anchor drifted'
Assert -Ok (-not ($cj.Text -match 'line \d+ is past the end of the bundle')) -Name 'J: no cited line is past the end of the real bundle'
Assert -Ok ($cj.Text -match 'verdict_basis=version-equality') -Name 'J: verdict basis is version EQUALITY, not a widened known-equivalent set'
Assert -Ok ($cj.Text -match 'known_equivalent_versions=\s*\(same line numbers verified\)') -Name 'J: the known-equivalent set is empty'
Assert -Ok ($cj.Text -match '\[PASS \] 5 OmO package version drift') -Name 'J: check 5 PASSes against the real target'
} else { Skip-Case -Name 'J-asserts' -Reason 'case J did not run' }

# ------------------------------------------------- K/L: default config resolution
if ($byName.ContainsKey('K-home-precedence')) {
# HOME points at a sandbox holding ONLY omo.json (no omo.jsonc) with tmux off.
# USERPROFILE is left alone, so if the doctor still preferred USERPROFILE it would
# read the live config and report something else entirely.
$ck = $byName['K-home-precedence']
$expectJson = Join-Path $cfgHomeJson 'omo.json'
Assert -Ok ($ck.Text -match ('config=' + [regex]::Escape($expectJson) + '  exists=True')) -Name 'K: the doctor read HOME/.omo/omo.json without being told -ConfigPath' -Detail ('got=' + [regex]::Match($ck.Text,'config=(.+?)  exists=').Groups[1].Value)
Assert -Ok ($ck.Text -match 'config_path_rule=omo\.jsonc absent, omo\.json exists') -Name 'K: the report names which rule chose the file'
Assert -Ok ($ck.Text -match '\[opencode\]\.tmux\.enabled = false') -Name 'K: it read the value out of THAT file'
Assert -Ok ($ck.Text -match '\[FAIL \] 4 OmO config') -Name 'K: exit 40 isolates the CONFIG gate'
Assert -Ok (-not ($ck.Text -match [regex]::Escape($LiveConfigPath) + '  exists=')) -Name 'K: it did NOT fall back to the real USERPROFILE config'
} else { Skip-Case -Name 'K-asserts' -Reason 'case K did not run' }

if ($byName.ContainsKey('L-home-jsonc')) {
$cl = $byName['L-home-jsonc']
$expectJsonc = Join-Path $cfgHomeJsonc 'omo.jsonc'
Assert -Ok ($cl.Text -match ('config=' + [regex]::Escape($expectJsonc) + '  exists=True')) -Name 'L: with omo.jsonc present the doctor prefers it' -Detail ('got=' + [regex]::Match($cl.Text,'config=(.+?)  exists=').Groups[1].Value)
Assert -Ok ($cl.Text -match 'config_path_rule=omo\.jsonc exists') -Name 'L: the report names the rule'
Assert -Ok ($cl.Text -match '\[PASS \] 4 OmO config') -Name 'L: tmux true in the HOME config PASSes'
Assert -Ok ($cl.Text -match 'this is the ONE SELECTED user file') -Name 'L: the merged-layer caveat is printed'
} else { Skip-Case -Name 'L-asserts' -Reason 'case L did not run' }

# ------------------------------------------------- M: legal trailing commas
if ($byName.ContainsKey('M-trailingcommas')) {
$cm = $byName['M-trailingcommas']
# The regression this case exists for: the parent's live .omo/omo.jsonc holds
# four trailing commas, which are legal JSONC, and the doctor called it
# unparseable (gate-4 FAIL) because PS5.1 ConvertFrom-Json rejects them raw.
Assert -Ok ($cm.Text -match 'jsonc_parse=OK') -Name 'M: a config with trailing commas parses'
Assert -Ok ($cm.Text -match '\[opencode\]\.tmux\.enabled = true   \(observed literally') -Name 'M: the value is read out of the converted document'
Assert -Ok ($cm.Text -match '\[PASS \] 4 OmO config') -Name 'M: gate 4 PASSes on legal trailing-comma JSONC'
Assert -Ok ($cm.Text -match 'verdict=PASS') -Name 'M: the run as a whole is PASS'
Assert -Ok (-not ($cm.Text -match 'unparseable')) -Name 'M: nothing is reported unparseable'
} else { Skip-Case -Name 'M-asserts' -Reason 'case M did not run' }

# --------------------------------------- N: malformed config keeps its secret
if ($byName.ContainsKey('N-malformedsecret')) {
$cn = $byName['N-malformedsecret']
$nFail = @(Get-VerdictLines -Text $cn.Text -State 'FAIL')
Assert -Ok ($nFail.Count -ge 1) -Name 'N: at least one FAIL line' -Detail ('fail=' + $nFail.Count)
Assert -Ok ($nFail[0].N -eq 4) -Name 'N: the FIRST failing check is 4 (CONFIG)' -Detail ('first=' + $nFail[0].N)
Assert -Ok ($cn.Text -match 'jsonc_parse=FAILED') -Name 'N: the failure is reported as a parse failure'
Assert -Ok ($cn.Text -match 'parse-failed type=') -Name 'N: the reason is a STABLE exception class, not message text'
Assert -Ok ($cn.Text -match 'content withheld') -Name 'N: the report says plainly that content is withheld'
Assert -Ok (-not ($cn.Text.Contains($sentinel))) -Name 'N: the sentinel is ABSENT from stdout'
Assert -Ok (-not ($cn.Err.Contains($sentinel))) -Name 'N: the sentinel is ABSENT from stderr'
} else { Skip-Case -Name 'N-asserts' -Reason 'case N did not run' }

# --------------------------------------------------------------------------- global
Sep '='
Say 'READ-ONLY PROOF (the doctor changed nothing)'
$same = ($snapBefore -ceq $snapAfter)
Say ('  snapshot identical before/after every run: ' + $same)
if (-not $same) {
    $b1 = @($snapBefore -split "`r?`n")
    $b2 = @($snapAfter -split "`r?`n")
    for ($i = 0; $i -lt [Math]::Max($b1.Count, $b2.Count); $i++) {
        $x = ''
        $y = ''
        if ($i -lt $b1.Count) { $x = $b1[$i] }
        if ($i -lt $b2.Count) { $y = $b2[$i] }
        if ($x -cne $y) { Say ('    DIFF line ' + $i + ' before=[' + $x + '] after=[' + $y + ']') }
    }
}
Assert -Ok $same -Name 'user PATH, live omo.jsonc, live last_session, live bridge bin and the fixture bin are byte-identical before and after'
Assert -Ok ($snapBefore -match 'DIRFILE .*fixture-bin \\| bridge-doctor\.ps1') -Name 'the snapshot really did cover the fixture bin directory'

$pidsBefore = @($procBefore -split ' ' | Where-Object { $_ -ne '' })
$pidsAfter = @($procAfter -split ' ' | Where-Object { $_ -ne '' })
$lostPids = @($pidsBefore | Where-Object { $pidsAfter -notcontains $_ })
Assert -Ok ($lostPids.Count -eq 0) -Name 'no psmux/tmux process that existed before the harness is gone (nothing was killed)' -Detail ('before=' + $pidsBefore.Count + ' after=' + $pidsAfter.Count + ' lost=' + ($lostPids -join ','))

Assert -Ok ($script:Skipped -le 2) -Name 'at most two cases skipped; the core cases own their fixtures and cannot skip' -Detail ('skipped=' + $script:Skipped)
Assert -Ok ($results.Count -ge 13) -Name 'at least thirteen cases ran' -Detail ('ran=' + $results.Count)

Sep '='
Say ('ASSERT TOTALS: pass=' + $script:Pass + '  fail=' + $script:Fail + '  skip=' + $script:Skipped)
$totalClock.Stop()
Say ('total_harness_ms=' + $totalClock.ElapsedMilliseconds)
Save-Report
Write-Host ('HARNESS ASSERTIONS: pass=' + $script:Pass + ' fail=' + $script:Fail + ' skip=' + $script:Skipped)
if ($script:Fail -gt 0) { exit 1 }
exit 0
