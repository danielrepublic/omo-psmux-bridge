<#
.SYNOPSIS
    Launches OpenCode with the bridge shim first on the child process PATH only.

.DESCRIPTION
    Contract 12: prepending <bridgeRoot>\bin must be process-local. This script builds a
    ProcessStartInfo whose environment block is a copy of the current process
    environment, prepends the bridge bin folder to that copy, and starts OpenCode from
    it. The caller's $env:PATH is therefore never read-modified-written, and no user or
    machine PATH value, HKCU:\Environment key, setx call or scheduled task is involved.

    OpenCode inherits the caller's stdin, stdout, stderr and console, so it is attached
    to the terminal that launched it rather than detached from it.

.PARAMETER OpenCodeArgs
    Arguments forwarded to opencode as a real argument vector.

.PARAMETER Wait
    Block until OpenCode exits and exit this script with OpenCode's exit code.
#>
[CmdletBinding()]
param(
    [string[]] $OpenCodeArgs = @(),
    [switch] $Wait
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:ContractId = 'omo-psmux-bridge/1'
$script:ConfigName = 'bridge.json'
$script:DefaultOpenCodeCommand = 'opencode'

function Stop-Launch {
    param(
        [string] $Category,
        [string] $Message
    )
    [Console]::Error.WriteLine("omo-psmux-bridge: ${Category}: ${Message} (contract $script:ContractId)")
    exit 78
}

function Get-LaunchConfig {
    $configPath = Join-Path (Split-Path -Parent $PSScriptRoot) $script:ConfigName
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($configPath))
        if ($json.Length -gt 0 -and $json[0] -eq [char] 0xFEFF) { $json = $json.Substring(1) }
        return ($json | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Resolve-OpenCodeCommand {
    param($Config)
    if ($null -ne $Config -and $Config.PSObject.Properties.Name -contains 'opencodeCommand' -and -not [string]::IsNullOrEmpty($Config.opencodeCommand)) {
        return [string] $Config.opencodeCommand
    }
    return $script:DefaultOpenCodeCommand
}

function ConvertTo-NativeArgumentLine {
    <#
        ProcessStartInfo on the .NET Framework has no ArgumentList, so the argument
        vector has to be rendered into one command line. These are the quoting rules the
        C runtime parses back (CommandLineToArgvW): an empty or whitespace-bearing or
        quote-bearing argument is wrapped in double quotes, backslashes preceding a
        quote are doubled, and a run of backslashes closing the argument is doubled.
        Joining the vector with spaces, which is what Start-Process -ArgumentList does on
        Windows PowerShell 5.1, loses exactly the arguments this has to preserve.
    #>
    param([string[]] $Arguments)
    $rendered = foreach ($argument in $Arguments) {
        if ($argument.Length -gt 0 -and $argument -notmatch '[\s"]') {
            $argument
            continue
        }
        $builder = New-Object System.Text.StringBuilder
        [void] $builder.Append('"')
        $pendingBackslashes = 0
        foreach ($character in $argument.ToCharArray()) {
            if ($character -eq '\') {
                $pendingBackslashes++
                continue
            }
            if ($character -eq '"') {
                [void] $builder.Append('\' * (($pendingBackslashes * 2) + 1))
                [void] $builder.Append('"')
                $pendingBackslashes = 0
                continue
            }
            if ($pendingBackslashes -gt 0) {
                [void] $builder.Append('\' * $pendingBackslashes)
                $pendingBackslashes = 0
            }
            [void] $builder.Append($character)
        }
        if ($pendingBackslashes -gt 0) { [void] $builder.Append('\' * ($pendingBackslashes * 2)) }
        [void] $builder.Append('"')
        $builder.ToString()
    }
    return ($rendered -join ' ')
}

$bridgeRoot = Split-Path -Parent $PSScriptRoot
$bridgeBin = Join-Path $bridgeRoot 'bin'
if (-not (Test-Path -LiteralPath $bridgeBin -PathType Container)) {
    Stop-Launch -Category 'EX_CONFIG' -Message 'the bridge bin folder is missing; run scripts\install.ps1 first'
}

$command = Resolve-OpenCodeCommand -Config (Get-LaunchConfig)
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $command
$startInfo.Arguments = ConvertTo-NativeArgumentLine -Arguments $OpenCodeArgs
$startInfo.UseShellExecute = $false
# CreateNoWindow only suppresses creating a *new* console; because UseShellExecute is false
# and the parent already has one, OpenCode inherits this console and stays attached to it
# instead of being orphaned into a window of its own.
$startInfo.CreateNoWindow = $true
$currentLocation = Get-Location
$startInfo.WorkingDirectory = if ($currentLocation.Provider.Name -eq 'FileSystem') { $currentLocation.ProviderPath } else { $env:SystemRoot }
# ProcessStartInfo seeds EnvironmentVariables from the current process, so writing here
# changes the child's block and nothing above it. No Machine or User target is ever used.
$startInfo.EnvironmentVariables['PATH'] = $bridgeBin + ';' + $startInfo.EnvironmentVariables['PATH']

$process = [System.Diagnostics.Process]::Start($startInfo)
if ($null -eq $process) {
    Stop-Launch -Category 'EX_CONFIG' -Message 'the OpenCode process could not be started'
}
Write-Host "[launch] opencode started with $bridgeBin prepended to the child PATH only (pid $($process.Id))"
Write-Output $process.Id

if ($Wait) {
    $process.WaitForExit()
    exit $process.ExitCode
}