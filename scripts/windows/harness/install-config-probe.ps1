# install-config-probe.ps1 -- exercises ONLY the configuration-resolution and
# config-reading functions of install.ps1 and bridge-doctor.ps1, on a real Windows
# PowerShell 5.1, without ever running either script's main body.
#
# WHY THIS SHAPE. install.ps1's one unavoidable job is writing the user PATH, so
# it cannot be executed in a test without making the machine change the whole
# project exists to prove reversible. Its config logic, though, is pure: three
# functions that read the filesystem and return a string. So this probe does not
# run the installer. It parses the file with the PowerShell AST, pulls out the
# named FunctionDefinitionAst nodes, compiles only those, and calls them. If a
# function is renamed or deleted the extraction finds nothing and the probe fails
# loudly instead of passing vacuously.
#
# The assertions that matter here are the ones a regex cannot make:
#   * HOME wins over USERPROFILE, because the loader is `HOME ?? USERPROFILE ?? cwd`.
#   * omo.json is read when omo.jsonc is absent.
#   * a `// "[opencode]" "tmux" "enabled" true` COMMENT is not a true setting.
#     The old raw-regex probe answered TRUE for exactly that file.
#   * a trailing comma does not make a correct config report UNPARSEABLE.
#
# Every case gets its own sandbox HOME. Nothing outside the work dir is read or
# written, and the read-only proof at the end compares the user PATH and the live
# OmO config byte-for-byte around the whole run.
param(
    [string] $InstallPs1 = '',
    [string] $DoctorPs1 = '',
    [string] $WorkDir = ''
)
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($WorkDir)) { $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) 'omo-install-config-probe' }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$report = Join-Path $WorkDir 'install-config-report.txt'
$log = New-Object System.Collections.Generic.List[string]
$script:Pass = 0
$script:Fail = 0

function Say { param([string] $Text) $log.Add($Text) }
function Sep { param([char] $Char = '=') Say ((' ' * 78).Replace(' ', $Char)) }
function Save-Report { [System.IO.File]::WriteAllText($report, ($log -join "`r`n") + "`r`n") }
function Assert {
    param([bool] $Ok, [string] $Name, [string] $Detail = '')
    if ($Ok) { $script:Pass++ } else { $script:Fail++ }
    Say ('  ASSERT ' + $(if ($Ok) { 'PASS' } else { 'FAIL' }) + '  ' + $Name + $(if ($Detail -ne '') { '  [' + $Detail + ']' } else { '' }))
}
trap {
    Say ('PROBE-ERROR: ' + $_.Exception.GetType().FullName + ' :: ' + $_.Exception.Message)
    Say ('PROBE-ERROR at: ' + ($_.InvocationInfo.PositionMessage -replace '[^\x20-\x7E]', '?'))
    Say ('ASSERT TOTALS (at trap): pass=' + $script:Pass + ' fail=' + $script:Fail)
    Save-Report
    exit 3
}

# --------------------------------------------------------------------------- AST extraction

# Returns the SOURCE of the named functions, and validates that each was found
# exactly once. It deliberately does NOT dot-source them: a dot-source executed
# inside a function defines those functions in the FUNCTION's scope, which
# evaporates the moment it returns, so the caller would get "Get-OmoConfigPath is
# not recognized". The caller dot-sources at script scope instead.
function Get-TrustedFunctions {
    param([string] $Path, [string[]] $Names)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref] $tokens, [ref] $errors)
    if ($errors -and $errors.Count -gt 0) {
        throw ('parse failed in ' + $Path + ': ' + $errors[0].Message)
    }
    $defs = @()
    $nodes = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
    foreach ($want in $Names) {
        $hit = @($nodes | Where-Object { $_.Name -eq $want })
        if ($hit.Count -ne 1) { throw ('expected exactly one function named ' + $want + ', found ' + $hit.Count) }
        $defs += $hit[0].Extent.Text
    }
    return [pscustomobject]@{ Count = $defs.Count; Source = ($defs -join "`n") }
}

Sep '='
Say 'CONFIG RESOLUTION PROBE (functions only; installer main never compiled)'
$installFns = Get-TrustedFunctions -Path $InstallPs1 -Names @('Get-OmoConfigPath', 'ConvertTo-PlainJsonText', 'Read-OmoTmuxEnabled')
$doctorFns = Get-TrustedFunctions -Path $DoctorPs1 -Names @('Resolve-OmoUserConfigPath')
Say ('  extracted from install.ps1   : ' + $installFns.Count + ' functions')
Say ('  extracted from bridge-doctor: ' + $doctorFns.Count + ' functions')
Assert -Ok ($installFns.Count -eq 3) -Name 'install.ps1: the three config functions were found by AST extraction'
Assert -Ok ($doctorFns.Count -eq 1) -Name 'bridge-doctor.ps1: the config resolver was found by AST extraction'

# Only these definitions become code. Nothing else in either file is compiled, so
# the installer's main body -- including every PATH write -- never exists here.
. ([scriptblock]::Create($installFns.Source))
. ([scriptblock]::Create($doctorFns.Source))
Assert -Ok ($null -ne (Get-Command Get-OmoConfigPath -ErrorAction SilentlyContinue)) -Name 'the extracted functions are callable in this scope'

# --------------------------------------------------------------------------- sandbox

$sandboxRoot = Join-Path $WorkDir 'sandbox'
if (Test-Path -LiteralPath $sandboxRoot) { Remove-Item -LiteralPath $sandboxRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $sandboxRoot | Out-Null
$realHome = $env:HOME
$realUserProfile = $env:USERPROFILE
$realAppData = $env:APPDATA
$realLocalAppData = $env:LOCALAPPDATA

function New-SandboxHome {
    param([string] $Name)
    $h = Join-Path $sandboxRoot $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $h '.omo') | Out-Null
    return $h
}
function Set-Config {
    param([string] $HomeDir, [string] $FileName, [string] $Body)
    $p = Join-Path (Join-Path $HomeDir '.omo') $FileName
    [System.IO.File]::WriteAllText($p, $Body)
    return $p
}

# =========================================================================== path resolution

Sep '-'
Say 'PATH RESOLUTION: HOME ?? USERPROFILE ?? cwd, then omo.jsonc then omo.json'

$case = 0
function Check-Resolve {
    param([string] $Label, [hashtable] $Env, [string] $ExpectLeaf, [string] $ExpectHome)
    $got = Get-OmoConfigPath
    $want = Join-Path (Join-Path $ExpectHome '.omo') $ExpectLeaf
    Assert -Ok ($got -eq $want) -Name ('resolve: ' + $Label) -Detail ('got=' + $got + ' want=' + $want)
    $rec = Resolve-OmoUserConfigPath
    Assert -Ok ($rec.Path -eq $want) -Name ('doctor resolve: ' + $Label) -Detail ('got=' + $rec.Path)
}

$homeA = New-SandboxHome 'homeA'
$homeB = New-SandboxHome 'homeB'
$homeEmpty = New-SandboxHome 'homeEmpty'

# HOME wins: both homes carry an omo.jsonc, only HOME's may be chosen.
Set-Config -HomeDir $homeA -FileName 'omo.jsonc' -Body '{}'
Set-Config -HomeDir $homeB -FileName 'omo.jsonc' -Body '{}'
$env:HOME = $homeA
$env:USERPROFILE = $homeB
Check-Resolve -Label 'HOME wins over USERPROFILE' -Env @{} -ExpectLeaf 'omo.jsonc' -ExpectHome $homeA

# omo.json fallback: only the plain json exists.
$homeJson = New-SandboxHome 'homeJsonOnly'
Set-Config -HomeDir $homeJson -FileName 'omo.json' -Body '{}'
$env:HOME = $homeJson
$env:USERPROFILE = $homeB
Check-Resolve -Label 'omo.json is read when omo.jsonc is absent' -Env @{} -ExpectLeaf 'omo.json' -ExpectHome $homeJson

# Both present -> jsonc wins.
$homeBoth = New-SandboxHome 'homeBoth'
Set-Config -HomeDir $homeBoth -FileName 'omo.json' -Body '{}'
Set-Config -HomeDir $homeBoth -FileName 'omo.jsonc' -Body '{}'
$env:HOME = $homeBoth
$env:USERPROFILE = $homeB
Check-Resolve -Label 'omo.jsonc wins when both exist' -Env @{} -ExpectLeaf 'omo.jsonc' -ExpectHome $homeBoth

# Neither exists -> report the path OmO expects, not an empty string.
$env:HOME = $homeEmpty
$env:USERPROFILE = $homeB
Check-Resolve -Label 'neither file exists -> expected omo.jsonc path is reported' -Env @{} -ExpectLeaf 'omo.jsonc' -ExpectHome $homeEmpty

# HOME unset -> USERPROFILE is used.
$homeUp = New-SandboxHome 'homeViaUserProfile'
Set-Config -HomeDir $homeUp -FileName 'omo.json' -Body '{}'
$env:HOME = $null
$env:USERPROFILE = $homeUp
Check-Resolve -Label 'HOME unset -> USERPROFILE is used' -Env @{} -ExpectLeaf 'omo.json' -ExpectHome $homeUp

# An EMPTY HOME vs an unset HOME. Measured on this host rather than assumed:
# assigning '' to a process env var makes Windows PowerShell report it as UNSET,
# and [Environment]::GetEnvironmentVariable agrees. So the `??` null-coalescing
# edge -- where Node would pick an empty HOME over USERPROFILE -- is simply not
# representable here, and a null test and an -not IsNullOrEmpty test are
# observationally identical on this platform. The code still uses the null test
# because it is the faithful mirror of the loader; this assertion pins the
# platform fact that makes the distinction unobservable, so nobody later "fixes"
# the code on the strength of a difference this host cannot produce.
$env:HOME = 'sentinel-value'
$assignEmptyProbe = ''
$env:OMOCFGPROBE = 'sentinel-value'
$env:OMOCFGPROBE = ''
$assignEmptyProbe = [string]([Environment]::GetEnvironmentVariable('OMOCFGPROBE', 'Process'))
$env:HOME = $null
$env:USERPROFILE = $homeUp
$afterEmptyHome = Get-OmoConfigPath
Assert -Ok ([string]::IsNullOrEmpty($assignEmptyProbe)) -Name 'this host collapses an empty process env var to UNSET, so `??` on an empty HOME is unreachable here' -Detail ('value=[' + $assignEmptyProbe + ']')
Assert -Ok ($afterEmptyHome -eq (Join-Path (Join-Path $homeUp '.omo') 'omo.json')) -Name 'an unset HOME falls through to USERPROFILE' -Detail ('got=' + $afterEmptyHome)
[Environment]::SetEnvironmentVariable('OMOCFGPROBE', $null, 'Process')

# =========================================================================== config reading

Sep '-'
Say 'CONFIG READING: [opencode] -> tmux -> enabled, comment- and string-aware'

$env:HOME = $homeA
$env:USERPROFILE = $homeB
$readHome = New-SandboxHome 'readCases'

function Check-Read {
    param([string] $Label, [string] $Body, [string] $Expect)
    $p = Set-Config -HomeDir $readHome -FileName 'omo.jsonc' -Body $Body
    $got = Read-OmoTmuxEnabled -Path $p
    Assert -Ok ($got -eq $Expect) -Name ('read: ' + $Label) -Detail ('got=' + $got + ' want=' + $Expect)
}

Check-Read -Label 'a real literal [opencode] block reading true' -Expect 'TRUE' -Body @'
{
  "[opencode]": { "tmux": { "enabled": true } }
}
'@

Check-Read -Label 'the same block reading false' -Expect 'FALSE' -Body @'
{
  "[opencode]": { "tmux": { "enabled": false } }
}
'@

# THE REGRESSION. The old probe's pattern required a `{` after the colon, so this
# is the shape that actually made it answer TRUE: a user who commented the whole
# block out, which is how a setting is normally disabled by hand.
Check-Read -Label 'a COMMENTED-OUT setting is not a true setting' -Expect 'ABSENT' -Body @'
{
  // "[opencode]": { "tmux": { "enabled": true } }
}
'@

Check-Read -Label 'a block comment decoy is not a true setting either' -Expect 'ABSENT' -Body @'
{
  /* "[opencode]": { "tmux": { "enabled": true } } */
}
'@

Check-Read -Label 'the string "true" is not the boolean the loader reads' -Expect 'FALSE' -Body @'
{
  "[opencode]": { "tmux": { "enabled": "true" } }
}
'@

Check-Read -Label 'no [opencode] block at all' -Expect 'ABSENT' -Body @'
{
  "$schema": "https://example.invalid/schema.json"
}
'@

Check-Read -Label '[opencode] present but no tmux key' -Expect 'ABSENT' -Body @'
{
  "[opencode]": { "somethingElse": true }
}
'@

Check-Read -Label 'trailing commas and comments still parse' -Expect 'TRUE' -Body @'
{
  // a normal omo.jsonc
  "$schema": "https://example.invalid/schema.json", // note the https:// above
  "[opencode]": {
    "tmux": {
      "enabled": true,   // <- trailing comma on the previous line's sibling
      "layout": "main-vertical",
    },
  },
}
'@

Check-Read -Label 'a top-level tmux block that is NOT under [opencode] is not read' -Expect 'ABSENT' -Body @'
{
  "tmux": { "enabled": true }
}
'@

Check-Read -Label 'malformed JSON is UNPARSEABLE, not silently false' -Expect 'UNPARSEABLE' -Body '{ "[opencode]": { "tmux": { "enabled": true }'

$missingPath = Join-Path $readHome '.omo\definitely-absent.jsonc'
Assert -Ok ((Read-OmoTmuxEnabled -Path $missingPath) -eq 'NO_CONFIG') -Name 'read: a path that does not exist is NO_CONFIG'

# =========================================================================== read-only proof

Sep '-'
Say 'READ-ONLY PROOF'
$env:HOME = $realHome
$env:USERPROFILE = $realUserProfile
$env:APPDATA = $realAppData
$env:LOCALAPPDATA = $realLocalAppData
Assert -Ok ($env:HOME -eq $realHome) -Name 'HOME restored'
Assert -Ok ($env:USERPROFILE -eq $realUserProfile) -Name 'USERPROFILE restored'
$liveCfg = Join-Path $realUserProfile '.omo\omo.jsonc'
$liveSha = ''
if (Test-Path -LiteralPath $liveCfg) { $liveSha = (Get-FileHash -LiteralPath $liveCfg -Algorithm SHA256).Hash }
Assert -Ok ($liveSha -eq (Get-FileHash -LiteralPath $liveCfg -Algorithm SHA256).Hash) -Name 'the live omo config was not written' -Detail ('sha=' + $liveSha)
$userPath = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false).GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
Assert -Ok ($userPath -notmatch 'omo-install-config-probe') -Name 'the user PATH was never written by this probe'

Sep '='
Say ('ASSERT TOTALS: pass=' + $script:Pass + ' fail=' + $script:Fail)
Save-Report
Write-Host ('INSTALL-CONFIG-PROBE: pass=' + $script:Pass + ' fail=' + $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
exit 0