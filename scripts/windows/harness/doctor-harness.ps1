$ErrorActionPreference = 'Stop'
$src = 'C:\opencode-t13'
$bridgeBin = 'C:\Users\Daniel\AppData\Local\opencode-psmux-bridge\bin'
$work = 'C:\opencode-t13\cases'
$node = 'C:\Program Files\nodejs\node.exe'
$driver = Join-Path $src 'doctor-invoke.cjs'
$report = Join-Path $src 'harness-report.txt'

# Always flush the log, even on an unhandled harness error, so a capture is never
# lost. A harness that dies with the evidence only in its variables has produced
# nothing.
trap {
    Say ('HARNESS-ERROR: ' + $_.Exception.GetType().FullName + ' :: ' + $_.Exception.Message)
    Say ('HARNESS-ERROR at: ' + ($_.InvocationInfo.PositionMessage -replace '[^\x20-\x7E]', '?'))
    Say ('ASSERT TOTALS (at trap): pass=' + $script:Pass + '  fail=' + $script:Fail)
    [System.IO.File]::WriteAllText($report, ($log -join "`r`n") + "`r`n")
    Write-Host ('HARNESS-ERROR, report still written: ' + $_.Exception.Message)
    exit 3
}

New-Item -ItemType Directory -Force -Path $work | Out-Null

$totalClock = [System.Diagnostics.Stopwatch]::StartNew()
$log = New-Object System.Collections.Generic.List[string]

# NOTE the names: `R` and `Rule` are NOT safe helper names in PowerShell. `r` is
# the built-in alias for Invoke-History and PowerShell refuses to let a function
# shadow it, so `R ('x')` invoked Invoke-History instead and threw
# "cannot find history for command line id 'x'". Use Say/Sep.
function Say { param([string] $Text) $log.Add($Text) }
function Sep { param([char] $Char = '=') Say ((' ' * 78).Replace(' ', $Char)) }

$script:Pass = 0
$script:Fail = 0
function Assert {
    param([bool] $Ok, [string] $Name, [string] $Detail = '')
    if ($Ok) { $script:Pass++ } else { $script:Fail++ }
    $tail = ''
    if ($Detail -ne '') { $tail = '  [' + $Detail + ']' }
    Say ('  ASSERT ' + $(if ($Ok) { 'PASS' } else { 'FAIL' }) + '  ' + $Name + $tail)
}

# --------------------------------------------------------------------------- snapshots
# What "the doctor changed nothing" means, made checkable rather than asserted.
function Get-ReadOnlySnapshot {
    $sb = New-Object System.Text.StringBuilder
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    [void]$sb.AppendLine('USER_PATH=' + [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))
    $k.Close()
    foreach ($f in @('C:\Users\Daniel\.omo\omo.jsonc', 'C:\Users\Daniel\.psmux\last_session')) {
        if (Test-Path -LiteralPath $f) {
            $i = Get-Item -LiteralPath $f
            [void]$sb.AppendLine('FILE ' + $f + ' sha256=' + (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash + ' bytes=' + $i.Length + ' mtime_utc=' + $i.LastWriteTimeUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"))
        } else {
            [void]$sb.AppendLine('FILE ' + $f + ' MISSING')
        }
    }
    foreach ($b in @(Get-ChildItem -LiteralPath $bridgeBin -Force | Sort-Object Name)) {
        [void]$sb.AppendLine('BIN ' + $b.Name + ' bytes=' + $b.Length)
    }
    # Only the p14probe registry is snapshot-compareable: other lanes are creating
    # omo_t14d_*/omo_t14s_* entries concurrently, so a whole-directory diff would be
    # noisy without saying anything about this doctor.
    foreach ($b in @(Get-ChildItem -LiteralPath 'C:\Users\Daniel\.psmux' -File -Force | Where-Object { $_.Name -like 'p14probe__*' } | Sort-Object Name)) {
        [void]$sb.AppendLine('OTHER_SESSION ' + $b.Name + ' sha256=' + (Get-FileHash -LiteralPath $b.FullName -Algorithm SHA256).Hash + ' mtime_utc=' + $b.LastWriteTimeUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"))
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

function Get-VerdictLines {
    param([string] $Text, [string] $State)
    $res = @()
    foreach ($ln in @($Text -split "`r?`n")) {
        if ($ln -match ('^\[' + $State + ' \] (\d) (.*)$')) {
            $res += [pscustomobject]@{ N = [int]$Matches[1]; Title = $Matches[2].Trim() }
        }
    }
    return $res
}

# Every capture goes through Start-Process -RedirectStandardOutput /
# -RedirectStandardError (recorded failures V-18 / V-22: ProcessStartInfo +
# ReadToEndAsync returns EMPTY stdout on this host, which silently turns every
# comparison into a vacuous pass). The doctor's own stdout is written to a FILE by
# the node driver, so no pipe layer sits between its WriteLine calls and the bytes
# this harness asserts on.
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
    $argv = @($driver, (Join-Path $bridgeBin 'bridge-doctor.ps1'), $out, $err, $envJson) + $DoctorArgs

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
    $outLines = 0
    if ($null -ne $j) {
        if ($null -ne $j.status) { $actual = [int]$j.status }
        $nodeWall = [int]$j.wallMs
    }
    $outLines = @($doctorText -split "`r?`n" | Where-Object { $_.Trim() -ne '' }).Count

    Sep '-'
    Say ('CASE ' + $Name)
    Say ('  cmd            : powershell -NoProfile -ExecutionPolicy Bypass -File BRIDGEDIR\bridge-doctor.ps1 ' + ($DoctorArgs -join ' '))
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

# =========================================================================== environment

$livePort = '0'
foreach ($r in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
    if ([string]$r.LocalAddress -eq '127.0.0.1') {
        $nm = ''
        try { $nm = (Get-Process -Id ([int]$r.OwningProcess) -ErrorAction Stop).ProcessName } catch { }
        if ($nm -like 'opencode*') { $livePort = [string][int]$r.LocalPort }
    }
}
Say ('live opencode loopback port = ' + $livePort)

$basePath = [Environment]::GetEnvironmentVariable('Path', 'Process')
$pathWithBridge = $bridgeBin + ';' + $basePath
$liveCfg = 'C:\Users\Daniel\.omo\omo.jsonc'
$scratchCfg = Join-Path $work 'omo-tmux-off.jsonc'
$cfgText = [System.IO.File]::ReadAllText($liveCfg)
$cfgOff = $cfgText -replace '("enabled"\s*:\s*)true', '$1false'
[System.IO.File]::WriteAllText($scratchCfg, $cfgOff)

Sep '='
Say 'ENVIRONMENT'
Say ('  base process PATH entries  : ' + @($basePath -split ';' | Where-Object { $_.Trim() -ne '' }).Count)
Say ('  bridge bin already in PATH : ' + ($basePath -imatch [regex]::Escape($bridgeBin)))
Say ('  with-bridge PATH entries   : ' + @($pathWithBridge -split ';' | Where-Object { $_.Trim() -ne '' }).Count)
Say ('  scratch config             : ' + $scratchCfg + '  bytes=' + (Get-Item -LiteralPath $scratchCfg).Length)
Say ('  live  omo.jsonc sha256     : ' + (Get-FileHash -LiteralPath $liveCfg -Algorithm SHA256).Hash)
Say ('  scratch       sha256       : ' + (Get-FileHash -LiteralPath $scratchCfg -Algorithm SHA256).Hash)
Say ('  scratch differs from live  : ' + ((Get-FileHash -LiteralPath $liveCfg -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $scratchCfg -Algorithm SHA256).Hash))
Say ('  scratch has enabled:false  : ' + ($cfgOff -match '"enabled"\s*:\s*false'))

$snapBefore = Get-ReadOnlySnapshot
$procBefore = Get-ProcSnapshot

$envHappy = @{ PATH = $pathWithBridge; OPENCODE_PORT = $livePort }
$envNoPort = @{ PATH = $pathWithBridge; OPENCODE_PORT = $null }
$envNoBridge = @{ PATH = $basePath; OPENCODE_PORT = $livePort }

$results = @()
$results += Invoke-Case -Name 'A-happy'         -EnvOverrides $envHappy    -DoctorArgs @('-Namespace', 'p14probe', '-Session', 'm') -ExpectExit 0
$results += Invoke-Case -Name 'B-config-off'    -EnvOverrides $envHappy    -DoctorArgs @('-Namespace', 'p14probe', '-Session', 'm', '-ConfigPath', $scratchCfg) -ExpectExit 40
$results += Invoke-Case -Name 'C-stale-server'  -EnvOverrides $envHappy    -DoctorArgs @('-Namespace', 'omo_t13', '-Session', 't13s') -ExpectExit 20
$results += Invoke-Case -Name 'D-path-missing'  -EnvOverrides $envNoBridge -DoctorArgs @('-Namespace', 'p14probe', '-Session', 'm') -ExpectExit 10
$results += Invoke-Case -Name 'E-port-reach'    -EnvOverrides $envNoPort   -DoctorArgs @('-Namespace', 'p14probe', '-Session', 'm') -ExpectExit 30
$results += Invoke-Case -Name 'F-version-reach' -EnvOverrides $envHappy    -DoctorArgs @('-Namespace', 'p14probe', '-Session', 'm', '-FrozenOmoVersion', '0.0.1') -ExpectExit 50

$snapAfter = Get-ReadOnlySnapshot
$procAfter = Get-ProcSnapshot

# =========================================================================== assertions

Sep '='
Say 'ASSERTIONS'
$byName = @{}
foreach ($r in $results) { $byName[$r.Name] = $r }

foreach ($r in $results) {
    Assert -Ok ($r.Actual -eq $r.Expect) -Name ($r.Name + ': exit code is ' + $r.Expect) -Detail ('actual=' + $r.Actual)
    Assert -Ok ($r.OutLines -ge 30) -Name ($r.Name + ': stdout is real content, not an empty capture') -Detail ('lines=' + $r.OutLines)
    Assert -Ok ($r.Err -eq '') -Name ($r.Name + ': stderr empty') -Detail ('bytes=' + $r.Err.Length)
    Assert -Ok ($r.WallMs -lt 10000) -Name ($r.Name + ': wall clock under 10 s') -Detail ('harness=' + $r.WallMs + 'ms node=' + $r.NodeWallMs + 'ms')
    Assert -Ok ($r.Text -notmatch 'INTERNAL-ERROR') -Name ($r.Name + ': no INTERNAL-ERROR')
    Assert -Ok ($r.Text -match 'elapsed_ms=') -Name ($r.Name + ': the doctor printed its own elapsed_ms')
}

$ca = $byName['A-happy']
$passLines = Get-VerdictLines -Text $ca.Text -State 'PASS'
$failLines = Get-VerdictLines -Text $ca.Text -State 'FAIL'
Assert -Ok ($failLines.Count -eq 0) -Name 'A: zero FAIL lines' -Detail ('fail=' + $failLines.Count)
Assert -Ok ($passLines.Count -eq 5) -Name 'A: exactly five PASS lines' -Detail ('pass=' + $passLines.Count)
$nums = @($passLines | ForEach-Object { $_.N } | Sort-Object)
Assert -Ok (($nums -join ',') -eq '1,2,3,4,5') -Name 'A: the five PASS lines name five DIFFERENT checks' -Detail ('numbers=' + ($nums -join ','))
$titles = @($passLines | ForEach-Object { $_.Title })
$uniq = @($titles | Sort-Object -Unique)
Assert -Ok ($uniq.Count -eq 5) -Name 'A: the five PASS titles are five DIFFERENT strings' -Detail ('unique=' + $uniq.Count)
Say ('  A PASS titles: ' + (($passLines | ForEach-Object { ([string]$_.N) + '=' + $_.Title }) -join ' | '))

# ANTI-VACUOUS GUARD. Five PASS lines from five silent no-ops would satisfy every
# assertion above. These force real observed values out of the report instead.
Assert -Ok ($ca.Text -match 'tmux\.exe_sha256=9EA5E733FD78F4EA966A85A5CF062D1113C644FEFF80AD3B3084574C2BA2A858') -Name 'A: check 1 carries the REAL sha256 of tmux.exe'
Assert -Ok ($ca.Text -match 'tmux\.exe_present=yes  bytes=86110208') -Name 'A: check 1 carries the REAL byte size of tmux.exe'
Assert -Ok ($ca.Text -match 'tmux\.exe_sha256_match=YES') -Name 'A: check 1 compared that hash to the contract value'
Assert -Ok ($ca.Text -match 'config=C:\\Users\\Daniel\\\.omo\\omo\.jsonc  exists=True') -Name 'A: check 4 carries the REAL config path'
Assert -Ok ($ca.Text -match '\[opencode\]\.tmux\.enabled = true   \(observed literally') -Name 'A: check 4 reports the value it actually parsed out of the document'
Assert -Ok ($ca.Text -match 'installed_version=5\.1\.1[78]') -Name 'A: check 5 carries the REAL installed version string'
Assert -Ok ($ca.Text -match 'frozen_line_anchors_resolved=11/11') -Name 'A: check 5 verified all 11 line anchors in the installed bundle'
Assert -Ok ($ca.Text -match '\(heuristic\) A=p14probe__m\.port  mtime_utc=20') -Name 'A: check 2 compared two REAL files with real mtimes'
Assert -Ok ($ca.Text -match 'registry_entry=p14probe__m\.port  port=\d{4,5}') -Name 'A: check 2 read a REAL port out of a real registry entry'
Assert -Ok ($ca.Text -match 'listener_table_read_ms=\d+') -Name 'A: check 3 measured its own listener-table cost'
Assert -Ok ($ca.Text -match 'probed http://127\.0\.0\.1:\d+/global/health') -Name 'A: check 3 names the endpoint it actually probed'
Assert -Ok ($ca.Text -match 'verdict=PASS') -Name 'A: machine-readable verdict=PASS'
Assert -Ok ($ca.Text -match 'false_negative=\(heuristic\) a server started after the install but before a PATH change will NOT be detected\.') -Name 'A: stale-server false-negative stated in ONE line, verbatim'
Assert -Ok ($ca.Text -match '\[PASS \] 2 STALE-SERVER \(heuristic\)$') -Name 'A: check 2 PASS verdict is labelled (heuristic)'
Assert -Ok ($ca.Text -match 'READ-ONLY: writes nothing, kills nothing, fixes nothing, starts nothing\.') -Name 'A: the read-only banner is present'
Assert -Ok ($ca.Text -match 'No credential is printed') -Name 'A: the no-credential banner is present'
Assert -Ok ($ca.Text -match '\[FAIL \]') -Eq $false -Name 'A: no FAIL marker anywhere in the output'

$cb = $byName['B-config-off']
$bFail = Get-VerdictLines -Text $cb.Text -State 'FAIL'
Assert -Ok ($bFail.Count -ge 1) -Name 'B: at least one FAIL line' -Detail ('fail=' + $bFail.Count)
Assert -Ok ($bFail[0].N -eq 4) -Name 'B: the FIRST failing check is 4 (CONFIG)' -Detail ('first=' + $bFail[0].N)
Assert -Ok ($cb.Text -match '\[opencode\]\.tmux\.enabled') -Name 'B: output names the config KEY'
Assert -Ok ($cb.Text.Contains('C:\opencode-t13\cases\omo-tmux-off.jsonc')) -Name 'B: output names the config FILE PATH'
Assert -Ok ($cb.Text -match 'set \[opencode\]\.tmux\.enabled = true in C:\\opencode-t13\\cases\\omo-tmux-off\.jsonc') -Name 'B: the FIX line carries both the key and the path'
Assert -Ok ($cb.Text -match '\[opencode\]\.tmux\.enabled = false') -Name 'B: it reports the value it actually parsed (false)'

$cc = $byName['C-stale-server']
$cFail = Get-VerdictLines -Text $cc.Text -State 'FAIL'
Assert -Ok ($cFail.Count -ge 1) -Name 'C: at least one FAIL line' -Detail ('fail=' + $cFail.Count)
Assert -Ok ($cFail[0].N -eq 2) -Name 'C: the FIRST failing check is 2 (STALE-SERVER)' -Detail ('first=' + $cFail[0].N)
Assert -Ok ($cc.Text -match 'kill-server -t') -Name 'C: output contains the literal substring "kill-server -t"'
Assert -Ok ($cc.Text -match 'psmux kill-server -t t13s') -Name 'C: the remedy names the actual session'
Assert -Ok ($cc.Text -match 'psmux -L omo_t13') -Name 'C: the alternative -L namespace route is named'
Assert -Ok ($cc.Text -match '\[FAIL \] 2 STALE-SERVER \(heuristic\)') -Name 'C: the FAIL verdict line itself carries (heuristic)'
Assert -Ok ($cc.Text -match 'is OLDER than bin\\tmux\.exe by \d+ s') -Name 'C: the FAIL quotes the measured mtime delta'
Assert -Ok ($cc.Text -match 'registry_entry=omo_t13__t13s\.port  port=\d{4,5}') -Name 'C: it read the real stale registry entry'

$cd = $byName['D-path-missing']
$dFail = Get-VerdictLines -Text $cd.Text -State 'FAIL'
Assert -Ok ($dFail.Count -ge 1) -Name 'D: at least one FAIL line' -Detail ('fail=' + $dFail.Count)
Assert -Ok ($dFail[0].N -eq 1) -Name 'D: the FIRST reported failure is check 1 (PATH), not a port failure' -Detail ('first=' + $dFail[0].N)
Assert -Ok ($cd.Text -match 'first_path_entry_resolving_tmux=C:\\Users\\Daniel\\AppData\\Local\\psmux\\tmux\.exe') -Name 'D: it names the real psmux tmux that won PATH resolution'
Assert -Ok ($cd.Text -match 'tmux\.exe_present=yes') -Name 'D: the shim IS present, so this is a PATH problem not a missing-file problem'
Assert -Ok ($cd.Text -match 'bin_dir_index_in_effective_path=-1') -Name 'D: the bridge bin directory is absent from the child PATH (index -1)'

$ce = $byName['E-port-reach']
Assert -Ok ($ce.Text -match '\[FAIL \] 3 OpenCode port resolution') -Name 'E: check 3 can fail, so exit code 30 is reachable'

$cf = $byName['F-version-reach']
Assert -Ok ($cf.Text -match '\[FAIL \] 5 OmO package version drift') -Name 'F: check 5 can fail, so exit code 50 is reachable'
Assert -Ok ($cf.Text -match 'is neither the frozen 5\.1\.18') -Name 'F: the version FAIL explains itself'

Sep '='
Say 'READ-ONLY PROOF (the doctor changed nothing)'
$same = ($snapBefore -ceq $snapAfter)
Say ('  snapshot identical before/after all six runs: ' + $same)
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
Assert -Ok $same -Name 'user PATH, omo.jsonc, last_session, bridge bin and the p14probe registry are byte-identical before and after'
Assert -Ok ($snapBefore -match 'USER_PATH=(?![^\r\n]*opencode-psmux-bridge)') -Name 'the persisted user PATH still contains NO bridge entry'

$pidsBefore = @($procBefore -split ' ' | Where-Object { $_ -ne '' })
$pidsAfter = @($procAfter -split ' ' | Where-Object { $_ -ne '' })
$lostPids = @($pidsBefore | Where-Object { $pidsAfter -notcontains $_ })
Assert -Ok ($lostPids.Count -eq 0) -Name 'no psmux/tmux process that existed before the harness is gone (nothing was killed)' -Detail ('before=' + $pidsBefore.Count + ' after=' + $pidsAfter.Count + ' lost=' + ($lostPids -join ','))

Sep '='
Say ('ASSERT TOTALS: pass=' + $script:Pass + '  fail=' + $script:Fail)
$totalClock.Stop()
Say ('total_harness_ms=' + $totalClock.ElapsedMilliseconds)
[System.IO.File]::WriteAllText($report, ($log -join "`r`n") + "`r`n")
Write-Host ('HARNESS ASSERTIONS: pass=' + $script:Pass + ' fail=' + $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
exit 0