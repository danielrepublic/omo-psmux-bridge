<#
.SYNOPSIS
    Executes one psmux pane described by the bridge's helper invocation.

.DESCRIPTION
    Invoked by the translated pane command as a SINGLE argv element holding one
    self-quoted command line (src/translate.ts HELPER_CONTRACT):

        powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<helper>"
            --payload <b64url> --command <b64url-json> [--cwd <b64url>]
            --env-slots <n> [--correlation <b64url>]

    --payload      Provenance only: the byte-exact text between the outer double
                   quotes of OmO's /bin/sh -c "..." element. NEVER handed to a
                   shell; no POSIX shell is guaranteed to exist, and doing so is
                   how the original defect is reproduced.
    --command      Base64url of a JSON array of tokens: the Windows-native command
                   to exec. token[0] is the program. Tokens are execed directly
                   with no shell wrapper.
    --cwd          Base64url of a UTF-8 working directory. Omitted unless the
                   caller supplied one; when absent the pane cwd is left alone.
    --env-slots    Decimal count N, always present, 0 in the normal case. Says:
                   read OMO_PANE_ENV_0 .. OMO_PANE_ENV_<N-1> from THIS process's
                   own environment, each split on its FIRST '=' only. Values never
                   appear in argv in any encoding: a command line is visible in a
                   process listing, and base64 is not encryption.
    --correlation  Base64url correlation id. Required: the trace file, the
                   consume-once marker and the fallback file are all named by it,
                   and a made-up id would silently collide with another pane's.

    Delivery order (src/descriptor.ts loadAssignments): the helper's own process
    environment first (all N or none: a partial set is refused, because a pane
    with the password but not the username is a different failure from a pane
    with neither, and only the second is one the bridge can fix), then the
    restricted-ACL fallback file under %USERPROFILE%\.omo-pane-env\state\, read
    once, deleted immediately, deletion VERIFIED. An unverified deletion is a
    failure and nothing is applied: nothing may run while a credential cannot be
    proven destroyed.

    Attach readiness (src/descriptor.ts attachRetryPolicy, upstream OpenCode
    issue #3505): `opencode attach` waits up to 5 s polling <origin>/global/health
    before the FIRST run, and is retried ONCE on a non-zero exit. A pane that
    starts before its session is ready must not silently vanish. Bounded, capped
    at one, and never applied to any other command.

    Consume-once: the exclusive creation of the per-pane trace file IS the claim
    (FileMode.CreateNew, not Test-Path-then-write, so two helpers racing on one
    descriptor cannot both win). A second run for the same id exits 67 without
    executing anything.

    Exit codes (src/descriptor.ts DESCRIPTOR_CONTRACT.exitCodes, sysexits.h
    numbering, disjoint from the chain guard's 78): 64 usage, 65 malformed,
    66 absent, 67 consumed, 71 delete-unverified. Otherwise the command's own
    exit code is propagated.

    This script is deliberately dependency-free: the translator addresses it by
    bare path with -File, so it may not dot-source a sibling module. ASCII only:
    the maintainer's console codepage is big5, and test/windows-scripts.test.ts
    asserts no byte above 127.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# A pane's stdout is a pipe read by psmux, which speaks UTF-8. Windows PowerShell 5.1
# otherwise encodes redirected output with the OEM code page, which silently destroys any
# non-ASCII character in a pane description.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$script:ExitUsage = 64
$script:ExitMalformed = 65
$script:ExitAbsent = 66
$script:ExitConsumed = 67
$script:ExitDeleteUnverified = 71
$script:ExitSpawnFailed = 127

$script:EnvSlotPrefix = 'OMO_PANE_ENV_'
$script:CorrelationPattern = '^[a-z0-9-]+$'
$script:CorrelationMaxLength = 64

$script:ProfileSubdir = '.omo-pane-env'
$script:ProfileStateSubdir = 'state'
$script:DescriptorFilePrefix = 'desc-'
$script:DescriptorFileSuffix = '.env'

$script:TraceDirName = 'state'
$script:TraceFilePrefix = 'pane-'
$script:TraceFileSuffix = '.jsonl'

$script:AttachProgram = 'opencode'
$script:AttachVerb = 'attach'
$script:HealthPath = '/global/health'
$script:AttachReadyWaitMs = 5000
$script:AttachPollIntervalMs = 250
$script:AttachRetryWaitMs = 2000

function Write-BridgeError {
    param([string] $Message)
    [Console]::Error.WriteLine("omo-psmux-bridge: $Message")
}

function Exit-Bridge {
    param(
        [int] $Code,
        [string] $Message
    )
    Write-BridgeError -Message $Message
    exit $Code
}

function ConvertFrom-Base64Url {
    <#
        Unambiguous total base64url: [A-Za-z0-9_-], unpadded. The exact inverse of
        src/translate.ts encodeField. Invalid input yields '' and never throws,
        so the caller can report usage rather than a stack trace.
    #>
    param([string] $Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $standard = $Text.Replace('-', '+').Replace('_', '/')
    $remainder = $standard.Length % 4
    if ($remainder -eq 1) { return '' }
    if ($remainder -gt 0) { $standard += ('=' * (4 - $remainder)) }
    try {
        $bytes = [System.Convert]::FromBase64String($standard)
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    catch {
        return ''
    }
}

function ConvertTo-JsonEscapedString {
    <#
        One JSON string literal, escaped EXACTLY as Node's JSON.stringify escapes
        it: " and \ backslash-escaped, the five short escapes, other C0 controls
        as lowercase \u00xx, lone surrogates as lowercase \uxxxx, everything else
        (including DEL, non-ASCII and paired surrogates) raw. This is what makes
        the fallback-file digest computable here: the digest is a sha256 over the
        JSON array text, so the text must be byte-identical to what the shim wrote.
    #>
    param([string] $Value)
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $index = 0
    while ($index -lt $Value.Length) {
        $code = [int][char]$Value[$index]
        if ($Value[$index] -eq '"') { [void]$builder.Append('\"') }
        elseif ($Value[$index] -eq '\') { [void]$builder.Append('\\') }
        elseif ($code -eq 8) { [void]$builder.Append('\b') }
        elseif ($code -eq 9) { [void]$builder.Append('\t') }
        elseif ($code -eq 10) { [void]$builder.Append('\n') }
        elseif ($code -eq 12) { [void]$builder.Append('\f') }
        elseif ($code -eq 13) { [void]$builder.Append('\r') }
        elseif ($code -lt 0x20) { [void]$builder.Append(('\u{0:x4}' -f $code)) }
        elseif ($code -ge 0xD800 -and $code -le 0xDBFF -and ($index + 1) -lt $Value.Length) {
            $next = [int][char]$Value[$index + 1]
            if ($next -ge 0xDC00 -and $next -le 0xDFFF) {
                [void]$builder.Append($Value[$index])
                [void]$builder.Append($Value[$index + 1])
                $index += 1
            }
            else {
                [void]$builder.Append(('\u{0:x4}' -f $code))
            }
        }
        elseif (($code -ge 0xD800 -and $code -le 0xDFFF)) {
            [void]$builder.Append(('\u{0:x4}' -f $code))
        }
        else {
            [void]$builder.Append($Value[$index])
        }
        $index += 1
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-JsonStringArray {
    <#
        JSON.stringify(assignments): '[' + literals joined by ',' + ']'. No spaces.
        Any space would change the digest, so none is emitted.
    #>
    param([string[]] $Items)
    $parts = @()
    foreach ($item in $Items) { $parts += (ConvertTo-JsonEscapedString -Value $item) }
    return '[' + ($parts -join ',') + ']'
}

function Get-StringSha256Hex {
    param([string] $Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes)
        return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally {
        $sha.Dispose()
    }
}

function Get-CurrentIsoTime {
    return ([System.DateTime]::UtcNow.ToString('o'))
}

function Write-TraceLine {
    <#
        One JSON object appended to the pane trace file. Best-effort: a trace that
        cannot be written must not kill the pane, because the exit code is what OmO
        branches on and the trace is only evidence. Returns $true when written.
    #>
    param(
        [string] $TracePath,
        [hashtable] $Record
    )
    if ([string]::IsNullOrEmpty($TracePath)) { return $false }
    try {
        $line = ($Record | ConvertTo-Json -Compress -Depth 4)
        $dir = Split-Path -Parent $TracePath
        if (-not [string]::IsNullOrEmpty($dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($line + "`n")
        $stream = [System.IO.File]::Open($TracePath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
        }
        finally {
            $stream.Close()
        }
        return $true
    }
    catch {
        return $false
    }
}

function Get-JsonField {
    <#
        Read one field of a ConvertFrom-Json object without tripping
        Set-StrictMode 2.0, which treats a missing property as an error. A
        missing field is $null, which the caller validates like any other
        malformed shape rather than dying with a stack trace inside a pane.
    #>
    param(
        $Object,
        [string] $Name
    )
    if ($Object -eq $null) { return $null }
    if ($Object.PSObject.Properties.Name -notcontains $Name) { return $null }
    return $Object.$Name
}

function Test-SafeCorrelationId {
    param([string] $Value)
    if ([string]::IsNullOrEmpty($Value)) { return $false }
    if ($Value.Length -gt $script:CorrelationMaxLength) { return $false }
    return [bool]([System.Text.RegularExpressions.Regex]::IsMatch($Value, $script:CorrelationPattern))
}

function Get-DescriptorFilePath {
    param(
        [string] $ProfileDir,
        [string] $CorrelationId
    )
    return (Join-Path (Join-Path (Join-Path $ProfileDir $script:ProfileSubdir) $script:ProfileStateSubdir) ($script:DescriptorFilePrefix + $CorrelationId + $script:DescriptorFileSuffix))
}

function Get-TraceFilePath {
    param(
        [string] $BridgeRoot,
        [string] $CorrelationId
    )
    return (Join-Path (Join-Path $BridgeRoot $script:TraceDirName) ($script:TraceFilePrefix + $CorrelationId + $script:TraceFileSuffix))
}

function Split-EnvAssignment {
    <#
        Split one NAME=VALUE assignment on its FIRST '=' only, so a password
        containing '=' survives whole. Returns $null for an assignment with no '='
        or with an empty name, so a malformed slot is refused instead of applying
        an empty variable.
    #>
    param([string] $Assignment)
    if ([string]::IsNullOrEmpty($Assignment)) { return $null }
    $separator = $Assignment.IndexOf('=')
    if ($separator -le 0) { return $null }
    return @{
        name = $Assignment.Substring(0, $separator)
        value = $Assignment.Substring($separator + 1)
    }
}

function Set-PaneProcessEnvironment {
    <#
        Apply assignments to this process. An empty value cannot be represented in
        a Windows process environment block, so clearing the variable is the
        faithful outcome: a child that sees no NAME expands it to the same empty
        string as NAME set to ''.
    #>
    param([hashtable[]] $Assignments)
    foreach ($pair in $Assignments) {
        [System.Environment]::SetEnvironmentVariable([string]$pair['name'], [string]$pair['value'], [System.EnvironmentVariableTarget]::Process)
    }
}

function Protect-FallbackFile {
    <#
        Best-effort hardening of the credential fallback file before it is read:
        disable inheritance and leave access for the current user only. A failure
        here never stops the pane: the file already lives under the user's own
        profile, and a pane that refuses to start over an ACL call is the exact
        failure this bridge exists to remove.
    #>
    param([string] $Path)
    try {
        $acl = Get-Acl -LiteralPath $Path
        $acl.SetAccessRuleProtection($true, $false)
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'Allow')
        $acl.SetAccessRule($rule)
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    catch {
    }
}

function Test-ServerHealthy {
    <#
        One readiness probe: GET <origin>/global/health with a short timeout. Any
        2xx response means the server answers. Anything else (connection refused,
        timeout, non-2xx) means not yet.
    #>
    param([string] $HealthUrl)
    try {
        $request = [System.Net.WebRequest]::CreateHttp($HealthUrl)
        $request.Method = 'GET'
        $request.Timeout = 2000
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        try {
            $status = [int]$response.StatusCode
            return ($status -ge 200 -and $status -lt 300)
        }
        finally {
            $response.Close()
        }
    }
    catch {
        return $false
    }
}

function Wait-AttachReady {
    <#
        Bounded wait for the session to become attachable, before the FIRST run.
        Always terminates: the deadline caps the total, so a dead session does not
        hold the pane hostage. Returns the milliseconds actually waited.
    #>
    param([string] $ServerUrl)
    $origin = $null
    if ($ServerUrl -match '^(https?://[^/]+)') { $origin = $Matches[1] }
    if ([string]::IsNullOrEmpty($origin)) { return 0 }
    $healthUrl = $origin + $script:HealthPath
    $started = [System.Environment]::TickCount
    $elapsed = 0
    while ($elapsed -lt $script:AttachReadyWaitMs) {
        if (Test-ServerHealthy -HealthUrl $healthUrl) { break }
        $elapsed = [System.Environment]::TickCount - $started
        if ($elapsed -lt 0) { $elapsed += 2147483647 }
        if ($elapsed -ge $script:AttachReadyWaitMs) { break }
        $remaining = $script:AttachReadyWaitMs - $elapsed
        $nap = $script:AttachPollIntervalMs
        if ($nap -gt $remaining) { $nap = $remaining }
        Start-Sleep -Milliseconds $nap
        $elapsed = [System.Environment]::TickCount - $started
        if ($elapsed -lt 0) { $elapsed += 2147483647 }
    }
    if ($elapsed -gt $script:AttachReadyWaitMs) { $elapsed = $script:AttachReadyWaitMs }
    if ($elapsed -lt 0) { $elapsed = 0 }
    return $elapsed
}

function Invoke-PaneCommand {
    <#
        Exec the token vector directly with no shell wrapper. THE RESULT is the
        exit code, carried by the script variable it sets: this function must
        never use Write-Output/return for the code, because everything the pane
        command prints also flows out of this function onto its pipeline. In
        PowerShell a function's caller captures its WHOLE output stream, so a
        'return' would bundle the pane command's own stdout into the exit code.
        A program that cannot be started gets 127 (the shell convention for
        command-not-found), not a helper exit code: the delivery succeeded, the
        command is what failed.
    #>
    param(
        [string[]] $Command,
        [string] $Cwd
    )
    if (-not [string]::IsNullOrEmpty($Cwd)) {
        try {
            Set-Location -LiteralPath $Cwd
        }
        catch {
            Exit-Bridge -Code $script:ExitUsage -Message "EX_USAGE: cannot change directory to the --cwd value"
        }
    }
    $program = $Command[0]
    $commandArgs = @()
    if ($Command.Length -gt 1) { $commandArgs = $Command[1..($Command.Length - 1)] }
    try {
        & $program @commandArgs
        $code = $LASTEXITCODE
        if ($code -eq $null) {
            if ($?) { $code = 0 } else { $code = 1 }
        }
        $script:LastPaneExitCode = [int]$code
    }
    catch {
        Write-BridgeError -Message "cannot start pane command: $($_.Exception.Message)"
        $script:LastPaneExitCode = $script:ExitSpawnFailed
    }
}

# ---------------------------------------------------------------------------
# Parse the helper invocation. Parsed by hand in $args order rather than by a
# param block, so an unknown flag is a usage error with a message rather than a
# PowerShell parameter-binding stack trace inside a pane.
# ---------------------------------------------------------------------------

$payloadB64 = $null
$commandB64 = $null
$cwdB64 = $null
$envSlotsText = $null
$correlationB64 = $null

$index = 0
while ($index -lt $args.Count) {
    $flag = [string]$args[$index]
    $value = $null
    if (($index + 1) -lt $args.Count) { $value = [string]$args[$index + 1] }
    if ($value -eq $null) {
        Exit-Bridge -Code $script:ExitUsage -Message "EX_USAGE: dangling flag $flag"
    }
    switch ($flag) {
        '--payload' { $payloadB64 = $value }
        '--command' { $commandB64 = $value }
        '--cwd' { $cwdB64 = $value }
        '--env-slots' { $envSlotsText = $value }
        '--correlation' { $correlationB64 = $value }
        default {
            Exit-Bridge -Code $script:ExitUsage -Message "EX_USAGE: unknown flag $flag"
        }
    }
    $index += 2
}

if ([string]::IsNullOrEmpty($payloadB64)) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: missing --payload'
}
if ([string]::IsNullOrEmpty($commandB64)) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: missing --command'
}
if ($envSlotsText -eq $null) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: missing --env-slots'
}
$envSlotCount = 0
if (-not [int]::TryParse($envSlotsText, [ref]$envSlotCount) -or $envSlotCount -lt 0) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: --env-slots is not a non-negative integer'
}
if ([string]::IsNullOrEmpty($correlationB64)) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: missing --correlation'
}

# The payload body is provenance only. Decoded so a malformed value is refused
# up front, then never used again: the helper MUST NOT hand this to a shell.
$payloadBody = ConvertFrom-Base64Url -Text $payloadB64
# A non-empty valid base64url value always decodes to non-empty bytes, so an
# empty decode means the value was not valid base64url at all.
if ([string]::IsNullOrEmpty($payloadBody)) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: --payload is not valid base64url'
}

$commandJson = ConvertFrom-Base64Url -Text $commandB64
if ([string]::IsNullOrEmpty($commandJson)) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: --command is not valid base64url'
}
$commandTokens = $null
try {
    # ConvertFrom-Json unwraps a single-element array into a scalar, and a
    # one-token command is still a command. So parse without @(...), then
    # normalise the result to an array OURSELVES. (Wrapping in @() here
    # double-wraps the common multi-token case: ConvertFrom-Json already
    # returns the whole string array as one object's value, and @() would
    # nest it inside a second array, turning every token into "non-string".)
    $parsedTokens = ConvertFrom-Json -InputObject $commandJson
    if ($parsedTokens -is [System.Array]) { $commandTokens = $parsedTokens }
    else { $commandTokens = @($parsedTokens) }
}
catch {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: --command is not a JSON array'
}
if ($commandTokens -eq $null -or ($commandTokens -isnot [System.Array]) -or $commandTokens.Count -eq 0) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: --command holds no tokens'
}
$command = @()
foreach ($token in $commandTokens) {
    if ($token -isnot [string]) {
        Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: --command holds a non-string token'
    }
    $command += [string]$token
}

$cwd = $null
if (-not [string]::IsNullOrEmpty($cwdB64)) {
    $cwd = ConvertFrom-Base64Url -Text $cwdB64
    if ([string]::IsNullOrEmpty($cwd)) {
        Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: --cwd is not valid base64url'
    }
}

$correlationId = ConvertFrom-Base64Url -Text $correlationB64
if (-not (Test-SafeCorrelationId -Value $correlationId)) {
    Exit-Bridge -Code $script:ExitUsage -Message 'EX_USAGE: --correlation is not a safe correlation id'
}

# ---------------------------------------------------------------------------
# Classify the command. Byte-exact, not a basename match: `opencode.exe attach`
# is NOT matched, because the translator never emits it and a wrong match would
# apply a retry to something nobody asked to be retried. Nor is a PowerShell
# script whose TEXT mentions `opencode attach`.
# ---------------------------------------------------------------------------

$isAttach = ($command[0] -ceq $script:AttachProgram -and $command.Count -ge 2 -and $command[1] -ceq $script:AttachVerb)
$isPlaceholder = ((-not $isAttach) -and ($command[0] -ceq 'powershell' -or $command[0] -ceq 'pwsh') -and ($command -contains '-Command'))
$kind = 'other'
if ($isAttach) { $kind = 'attach' }
elseif ($isPlaceholder) { $kind = 'placeholder' }
$program = $command[0]
$verb = ''
if ($isAttach) { $verb = $script:AttachVerb }
elseif ($isPlaceholder) { $verb = '-Command' }

# ---------------------------------------------------------------------------
# Claim the descriptor: the exclusive creation of the trace file IS the marker.
# ---------------------------------------------------------------------------

$bridgeRoot = Split-Path -Parent $PSScriptRoot
$tracePath = Get-TraceFilePath -BridgeRoot $bridgeRoot -CorrelationId $correlationId
$traceAvailable = $true

$opening = [ordered]@{
    v = 1
    correlationId = $correlationId
    at = (Get-CurrentIsoTime)
    kind = $kind
    program = $program
    verb = $verb
    envMechanism = 'pending'
    slotCount = $envSlotCount
    slotNames = @()
    descriptorFileUsed = $false
    deleteVerified = $false
    attachRetryApplies = [bool]$isAttach
    attachWaitMs = 0
    attachRetries = 0
    exitCode = 0
    outcome = 'opened'
}

try {
    $traceDir = Split-Path -Parent $tracePath
    if (-not [string]::IsNullOrEmpty($traceDir)) {
        New-Item -ItemType Directory -Force -Path $traceDir | Out-Null
    }
    $openingLine = ($opening | ConvertTo-Json -Compress -Depth 4) + "`n"
    $openingBytes = [System.Text.Encoding]::UTF8.GetBytes($openingLine)
    $claim = [System.IO.File]::Open($tracePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $claim.Write($openingBytes, 0, $openingBytes.Length)
        $claim.Flush()
    }
    finally {
        $claim.Close()
    }
    $claimError = $null
}
catch {
    $claimError = $_
}
if ($claimError -ne $null) {
    if (Test-Path -LiteralPath $tracePath -PathType Leaf) {
        Exit-Bridge -Code $script:ExitConsumed -Message "EX_NOUSER: descriptor $correlationId was already consumed; refusing to launch a second pane for it"
    }
    # The trace is evidence, not the claim's only half that matters when the
    # filesystem itself is at fault: an unwritable state directory must not kill
    # the pane, so continue untraced rather than strand a subagent.
    $traceAvailable = $false
    $tracePath = $null
    Write-BridgeError -Message "trace unavailable, continuing untraced: $($claimError.Exception.Message)"
}

function Exit-WithTrace {
    param(
        [string] $Outcome,
        [string] $Mechanism,
        [int] $Code,
        [string] $Message,
        [string[]] $SlotNames,
        [bool] $DescriptorFileUsed,
        [bool] $DeleteVerified,
        [int] $AttachWaitMs,
        [int] $AttachRetries
    )
    if ($traceAvailable -and -not [string]::IsNullOrEmpty($tracePath)) {
        $record = [ordered]@{
            v = 1
            correlationId = $correlationId
            at = (Get-CurrentIsoTime)
            kind = $kind
            program = $program
            verb = $verb
            envMechanism = $Mechanism
            slotCount = $envSlotCount
            slotNames = $SlotNames
            descriptorFileUsed = $DescriptorFileUsed
            deleteVerified = $DeleteVerified
            attachRetryApplies = [bool]$isAttach
            attachWaitMs = $AttachWaitMs
            attachRetries = $AttachRetries
            exitCode = $Code
            outcome = $Outcome
        }
        Write-TraceLine -TracePath $tracePath -Record $record | Out-Null
    }
    if (-not [string]::IsNullOrEmpty($Message)) {
        Write-BridgeError -Message $Message
    }
    exit $Code
}

# ---------------------------------------------------------------------------
# Deliver the -e assignments, in the documented order.
# ---------------------------------------------------------------------------

# Zero slots is the NORMAL case (the translator strips nothing because there
# was nothing to strip). There is nothing to deliver, so continue straight to
# the run: this must NOT exit here, or every credential-free pane would vanish.
$assignments = @()
$slotNames = @()
$mechanism = 'environment'
$descriptorFileUsed = $false
$deleteVerified = $true

if ($envSlotCount -gt 0) {
$missing = @()
$fromEnvironment = @()
$envMalformed = $null
for ($slot = 0; $slot -lt $envSlotCount; $slot += 1) {
    $variable = $script:EnvSlotPrefix + $slot
    if (-not (Test-Path -LiteralPath ('env:' + $variable))) {
        # Absent, not empty: an empty value is a real value (see
        # Set-PaneProcessEnvironment), so only a missing variable is a gap.
        $missing += $variable
        continue
    }
    $raw = [System.Environment]::GetEnvironmentVariable($variable, [System.EnvironmentVariableTarget]::Process)
    if ($raw -eq $null) { $raw = '' }
    $pair = Split-EnvAssignment -Assignment $raw
    if ($pair -eq $null) {
        $envMalformed = $variable
        break
    }
    $fromEnvironment += $pair
}

if ($envMalformed -ne $null) {
    Exit-WithTrace -Outcome 'malformed' -Mechanism 'environment' -Code $script:ExitMalformed -Message "EX_DATAERR: $envMalformed does not hold a NAME=VALUE assignment" -SlotNames @() -DescriptorFileUsed $false -DeleteVerified $true -AttachWaitMs 0 -AttachRetries 0
}

if ($missing.Count -eq 0) {
    $assignments = $fromEnvironment
    foreach ($pair in $assignments) { $slotNames += [string]$pair['name'] }
    Set-PaneProcessEnvironment -Assignments $assignments
}
else {
    $mechanism = 'file'
    $descriptorFileUsed = $true
    $profileDir = $env:USERPROFILE
    if ([string]::IsNullOrEmpty($profileDir)) { $profileDir = $env:HOME }
    if ([string]::IsNullOrEmpty($profileDir)) {
        Exit-WithTrace -Outcome 'absent' -Mechanism 'file' -Code $script:ExitAbsent -Message "EX_NOINPUT: neither the helper environment (missing $($missing -join ', ')) nor a fallback file carries the pane environment; refusing to launch a pane without it" -SlotNames @() -DescriptorFileUsed $true -DeleteVerified $true -AttachWaitMs 0 -AttachRetries 0
    }
    $fallbackPath = Get-DescriptorFilePath -ProfileDir $profileDir -CorrelationId $correlationId
    if (-not (Test-Path -LiteralPath $fallbackPath -PathType Leaf)) {
        Exit-WithTrace -Outcome 'absent' -Mechanism 'file' -Code $script:ExitAbsent -Message "EX_NOINPUT: neither the helper environment (missing $($missing -join ', ')) nor $fallbackPath carries the pane environment; refusing to launch a pane without it" -SlotNames @() -DescriptorFileUsed $true -DeleteVerified $true -AttachWaitMs 0 -AttachRetries 0
    }
    Protect-FallbackFile -Path $fallbackPath
    $body = ''
    try {
        $body = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($fallbackPath))
    }
    catch {
        Exit-WithTrace -Outcome 'malformed' -Mechanism 'file' -Code $script:ExitMalformed -Message "EX_DATAERR: ${fallbackPath}: fallback payload is not readable" -SlotNames @() -DescriptorFileUsed $true -DeleteVerified $true -AttachWaitMs 0 -AttachRetries 0
    }
    $parsed = $null
    try {
        $parsed = ($body | ConvertFrom-Json)
    }
    catch {
        $parsed = $null
    }
    $payloadOk = $false
    $fileAssignments = @()
    if ($parsed -ne $null) {
        # ConvertFrom-Json unwraps a single-element array into a scalar, and a
        # one-slot fallback file is the COMMON credential case. Read, then
        # normalise ourselves; never wrap with @() directly.
        $rawAssignmentsValue = Get-JsonField -Object $parsed -Name 'assignments'
        if ($rawAssignmentsValue -is [System.Array]) { $rawAssignments = $rawAssignmentsValue }
        else { $rawAssignments = @($rawAssignmentsValue) }
        $rawDigest = Get-JsonField -Object $parsed -Name 'digest'
        $rawCount = Get-JsonField -Object $parsed -Name 'count'
        $rawVersion = Get-JsonField -Object $parsed -Name 'v'
        $allStrings = $true
        if ($rawAssignments -isnot [System.Array]) { $allStrings = $false }
        else {
            foreach ($entry in $rawAssignments) {
                if ($entry -isnot [string]) { $allStrings = $false; break }
            }
        }
        if ($rawVersion -eq 1 -and $allStrings) {
            $list = @()
            foreach ($entry in $rawAssignments) { $list += [string]$entry }
            if ($rawCount -eq $list.Count -and $list.Count -eq $envSlotCount) {
                $computed = Get-StringSha256Hex -Text (ConvertTo-JsonStringArray -Items $list)
                if ($rawDigest -ceq $computed) {
                    $payloadOk = $true
                    foreach ($text in $list) {
                        $pair = Split-EnvAssignment -Assignment $text
                        if ($pair -eq $null) { $payloadOk = $false; break }
                        $fileAssignments += $pair
                    }
                }
            }
        }
    }
    if (-not $payloadOk) {
        Exit-WithTrace -Outcome 'malformed' -Mechanism 'file' -Code $script:ExitMalformed -Message "EX_DATAERR: ${fallbackPath}: fallback payload failed its digest or slot-count check" -SlotNames @() -DescriptorFileUsed $true -DeleteVerified $true -AttachWaitMs 0 -AttachRetries 0
    }
    # Read once. Deleted immediately. And the deletion is checked, not assumed.
    try {
        Remove-Item -LiteralPath $fallbackPath -Force -ErrorAction Stop
    }
    catch {
    }
    if (Test-Path -LiteralPath $fallbackPath) {
        Exit-WithTrace -Outcome 'delete-unverified' -Mechanism 'file' -Code $script:ExitDeleteUnverified -Message "EX_OSERR: $fallbackPath could not be removed; refusing to run with a credential that may outlive the read" -SlotNames @() -DescriptorFileUsed $true -DeleteVerified $false -AttachWaitMs 0 -AttachRetries 0
    }
    $assignments = $fileAssignments
    foreach ($pair in $assignments) { $slotNames += [string]$pair['name'] }
    Set-PaneProcessEnvironment -Assignments $assignments
    $deleteVerified = $true
}
}

# ---------------------------------------------------------------------------
# Run the command, with the attach readiness wait and the single retry.
# ---------------------------------------------------------------------------

$attachWaitMs = 0
$attachRetries = 0

if ($isAttach -and $command.Count -ge 3) {
    $attachWaitMs = Wait-AttachReady -ServerUrl $command[2]
}

$script:LastPaneExitCode = 1
Invoke-PaneCommand -Command $command -Cwd $cwd
$exitCode = $script:LastPaneExitCode

if ($isAttach -and $exitCode -ne 0) {
    Start-Sleep -Milliseconds $script:AttachRetryWaitMs
    Invoke-PaneCommand -Command $command -Cwd $cwd
    $exitCode = $script:LastPaneExitCode
    $attachRetries = 1
}

$outcome = 'succeeded'
if ($exitCode -ne 0) {
    if ($isAttach) { $outcome = 'exhausted' }
    else { $outcome = 'delivered' }
}

Exit-WithTrace -Outcome $outcome -Mechanism $mechanism -Code $exitCode -Message '' -SlotNames $slotNames -DescriptorFileUsed $descriptorFileUsed -DeleteVerified $deleteVerified -AttachWaitMs $attachWaitMs -AttachRetries $attachRetries
