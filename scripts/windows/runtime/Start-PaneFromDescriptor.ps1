<#
.SYNOPSIS
    Executes one psmux pane described by a bridge descriptor (contract omo-psmux-bridge/1).

.DESCRIPTION
    Invoked by the translated pane command as:

        powershell.exe -NoProfile -NonInteractive -File <helper> -Descriptor <path>

    Reads <bridgeRoot>\state\<uuid>.json, runs it (placeholder prints its lines and
    stays alive; attach execs the real opencode), and deletes the descriptor in a
    finally block. The descriptor is credentials-bearing, so it never leaves the
    state directory and never reaches stdout, stderr or the exit code.

    This script is deliberately dependency-free: contract 6 addresses it by bare
    path with -File, so it may not dot-source a sibling module.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Descriptor
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Continue'

# A pane's stdout is a pipe read by psmux, which speaks UTF-8. Windows PowerShell 5.1
# otherwise encodes redirected output with the OEM code page, which silently destroys any
# non-ASCII character in a pane description (contract 14.1 requires Unicode to survive).
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$script:ContractId = 'omo-psmux-bridge/1'
$script:ConfigName = 'bridge.json'
$script:DefaultOpenCodeCommand = 'opencode'
$script:PlaceholderSleepSeconds = 86400

function Write-BridgeError {
    param(
        [string] $Category,
        [string] $Message
    )
    [Console]::Error.WriteLine("omo-psmux-bridge: ${Category}: ${Message} (contract $script:ContractId)")
}

function Stop-Bridge {
    <#
        Contract 11: descriptor, configuration and containment failures are EX_CONFIG.
        'exit' unwinds the enclosing try/finally, so the descriptor is still removed.
    #>
    param(
        [string] $Category,
        [string] $Message
    )
    Write-BridgeError -Category $Category -Message $Message
    exit 78
}

function Test-BridgeContainedPath {
    param(
        [string] $Root,
        [string] $Candidate
    )
    $rootPrefix = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
    $comparison = [System.StringComparison]::OrdinalIgnoreCase
    return $candidateFull.StartsWith($rootPrefix + [System.IO.Path]::DirectorySeparatorChar, $comparison)
}

function Read-BridgeUtf8Text {
    <#
        Windows PowerShell 5.1 ConvertFrom-Json rejects a leading byte order mark, so a
        BOM is stripped here rather than letting a valid descriptor read as corrupt.
    #>
    param([string] $Path)
    $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($Path))
    if ($text.Length -gt 0 -and $text[0] -eq [char] 0xFEFF) { $text = $text.Substring(1) }
    return $text
}

function Get-BridgeConfig {
    <#
        Static, secret-free configuration. A missing or malformed bridge.json is not
        fatal here: every consumer has a defined fallback, and the helper still has a
        containment root because bridgeRoot is derived from the script location.
    #>
    $configPath = Join-Path (Split-Path -Parent $PSScriptRoot) $script:ConfigName
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }
    try {
        return ((Read-BridgeUtf8Text -Path $configPath) | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Get-BridgeStateDirectory {
    param(
        [string] $BridgeRoot,
        $Config
    )
    if ($null -ne $Config -and $Config.PSObject.Properties.Name -contains 'stateDir' -and -not [string]::IsNullOrEmpty($Config.stateDir)) {
        if ([System.IO.Path]::IsPathRooted($Config.stateDir)) { return $Config.stateDir }
        return Join-Path $BridgeRoot $Config.stateDir
    }
    return Join-Path $BridgeRoot 'state'
}

function Resolve-BridgeOpenCodeCommand {
    param($Config)
    if ($null -ne $Config -and $Config.PSObject.Properties.Name -contains 'opencodeCommand' -and -not [string]::IsNullOrEmpty($Config.opencodeCommand)) {
        return [string] $Config.opencodeCommand
    }
    return $script:DefaultOpenCodeCommand
}

function Get-BridgeRequiredField {
    param(
        $DescriptorObject,
        [string] $Name
    )
    if ($DescriptorObject.PSObject.Properties.Name -notcontains $Name -or $null -eq $DescriptorObject.$Name) {
        Stop-Bridge -Category 'EX_CONFIG' -Message "descriptor field '$Name' is missing"
    }
    return $DescriptorObject.$Name
}

function Set-BridgeProcessEnvironment {
    <#
        Contract 7: the helper applies env itself because psmux respawn-pane -e drops
        values. inherit:true deliberately leaves the value this process already has.

        An empty value is accepted rather than rejected, but Windows cannot represent an
        empty process environment value: both Set-Item env:NAME and the .NET setter treat
        '' as a removal. Clearing the variable is therefore the faithful outcome, because
        a child that sees no NAME expands it to the same empty string as NAME set to ''.
    #>
    param($DescriptorObject)
    if ($DescriptorObject.PSObject.Properties.Name -notcontains 'env' -or $null -eq $DescriptorObject.env) { return }
    foreach ($entry in $DescriptorObject.env) {
        $hasInherit = $entry.PSObject.Properties.Name -contains 'inherit'
        if ($hasInherit -and $entry.inherit -eq $true) { continue }
        if ($entry.PSObject.Properties.Name -notcontains 'value') {
            Stop-Bridge -Category 'EX_CONFIG' -Message 'descriptor env entry declares neither value nor inherit'
        }
        [System.Environment]::SetEnvironmentVariable(
            [string] $entry.name,
            [string] $entry.value,
            [System.EnvironmentVariableTarget]::Process
        )
    }
}

function Invoke-BridgePlaceholder {
    param($DescriptorObject)
    $lines = Get-BridgeRequiredField -DescriptorObject $DescriptorObject -Name 'lines'
    foreach ($line in $lines) { Write-Output $line }
    while ($true) { Start-Sleep -Seconds $script:PlaceholderSleepSeconds }
}

function Invoke-BridgeAttach {
    param(
        $DescriptorObject,
        [string] $OpenCodeCommand
    )
    $url = Get-BridgeRequiredField -DescriptorObject $DescriptorObject -Name 'url'
    $sessionId = Get-BridgeRequiredField -DescriptorObject $DescriptorObject -Name 'sessionId'
    $directory = Get-BridgeRequiredField -DescriptorObject $DescriptorObject -Name 'dir'
    # Keep native stderr non-terminating so a chatty opencode cannot be mistaken for
    # a bridge failure by the enclosing catch.
    $ErrorActionPreference = 'Continue'
    $argumentList = @('attach', [string] $url, '--session', [string] $sessionId, '--dir', [string] $directory)
    & $OpenCodeCommand @argumentList
}

$bridgeRoot = Split-Path -Parent $PSScriptRoot
$config = Get-BridgeConfig
$stateDirectory = Get-BridgeStateDirectory -BridgeRoot $bridgeRoot -Config $config

$descriptorPath = $null
try {
    $descriptorPath = [System.IO.Path]::GetFullPath($Descriptor)
}
catch {
    Stop-Bridge -Category 'EX_CONFIG' -Message 'descriptor path is not a valid filesystem path'
}

# Contract 7: a descriptor is credentials-bearing, so containment is checked before the
# file is read and before anything is deleted. A path outside state is never touched.
if (-not (Test-BridgeContainedPath -Root $stateDirectory -Candidate $descriptorPath)) {
    Stop-Bridge -Category 'EX_CONFIG' -Message 'descriptor path is outside the bridge state directory'
}

try {
    try {
        $descriptorObject = (Read-BridgeUtf8Text -Path $descriptorPath) | ConvertFrom-Json
    }
    catch {
        Stop-Bridge -Category 'EX_CONFIG' -Message 'descriptor is not readable UTF-8 JSON'
    }

    $contract = Get-BridgeRequiredField -DescriptorObject $descriptorObject -Name 'contract'
    if ($contract -ne $script:ContractId) {
        Stop-Bridge -Category 'EX_CONFIG' -Message 'descriptor contract id does not match this bridge'
    }

    Set-BridgeProcessEnvironment -DescriptorObject $descriptorObject

    $kind = Get-BridgeRequiredField -DescriptorObject $descriptorObject -Name 'kind'
    if ($kind -eq 'placeholder') {
        Invoke-BridgePlaceholder -DescriptorObject $descriptorObject
    }
    elseif ($kind -eq 'attach') {
        Invoke-BridgeAttach -DescriptorObject $descriptorObject -OpenCodeCommand (Resolve-BridgeOpenCodeCommand -Config $config)
    }
    else {
        Stop-Bridge -Category 'EX_CONFIG' -Message 'descriptor kind is neither placeholder nor attach'
    }
}
catch {
    Write-BridgeError -Category 'EX_CONFIG' -Message 'pane helper failed before completing'
    exit 78
}
finally {
    Remove-Item -LiteralPath $descriptorPath -Force -ErrorAction SilentlyContinue
}