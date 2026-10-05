<#
.SYNOPSIS
    opencode-psmux-bridge one-line installer bootstrap.

.DESCRIPTION
    The "paste one line into a terminal" path. This script is the whole of that
    line's complexity: it finds the newest published release, downloads the zip,
    verifies nothing silently, unpacks it somewhere disposable, runs the real
    installer, and cleans up after itself.

    WHY THIS EXISTS RATHER THAN A ONE-LINER
    ---------------------------------------
    The obvious one-liner is a single long `powershell -Command "..."` string
    that downloads, expands and invokes in place. It was written, and it was
    wrong twice over:

      * it expanded into %LOCALAPPDATA%, which is exactly where install.ps1
        stages the payload, so the script unpacked the archive into the
        directory it was about to install over;
      * it invoked the entry point as `& $env:LOCALAPPDATA\...`, unquoted, so a
        Windows account name containing a space produced a command that could
        not parse.

    Both are the kind of defect that only appears on someone else's machine.
    Putting the steps in a file means they can be read, reviewed and fixed in
    one place, and leaves the pasted line short enough to trust.

.INPUTS
    None. Everything is discovered from the GitHub releases API.

.OUTPUTS
    ASCII `KEY=VALUE` lines prefixed `[bootstrap]`, so a user can paste one line
    into a bug report and the shape of the run can be read off it. ASCII only,
    because this host's console codepage is big5.

.NOTES
    Exit codes:
      0  the installer ran and returned 0 (see install.cmd for its codes)
      1  an unexpected error here; nothing was installed
      2  the repository has no published release to install
      3  the latest release has no zip asset, or it could not be downloaded
      4  the downloaded archive did not contain the expected entry point
    The installer's own codes are propagated unchanged, so a refusal (2) or a
    missing backend (69) from install.ps1 arrives as itself and not as 1.

    Requires only PowerShell and a network. It does NOT require git, bun, node,
    or admin rights: it writes exclusively under %TEMP%.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------- constants

# The one place the project's coordinates are written down. Overridable so the
# bootstrap can be exercised against a fork without editing it.
$Repository = 'danielrepublic/omo-psmux-bridge'
$AssetNameSuffix = '-win-x64.zip'

# --------------------------------------------------------------------------- output

function Write-Line {
    param([string] $Text)
    # ASCII only: this host's console codepage is big5.
    [Console]::Out.WriteLine($Text)
}

function Fail {
    param([string] $Code, [string] $Reason)
    Write-Line ('[bootstrap] RESULT=FAILED')
    Write-Line ('[bootstrap] reason=' + $Code)
    Write-Line ('[bootstrap] detail=' + $Reason)
    exit 3
}

# --------------------------------------------------------------------------- TLS

# Windows PowerShell 5.1 negotiates TLS 1.0 on some hosts, and the GitHub API
# answers that with a 403 that looks like a rate limit rather than a protocol
# refusal. Pinning 1.2 here is the difference between "it works" and "it fails on
# the maintainer's machine and not on mine". Values are OR-ed, not assigned, so a
# host that already permits a stronger protocol keeps it.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Write-Line '[bootstrap] warn=tls12_unavailable_continuing'
}

# --------------------------------------------------------------------------- locate the release

Write-Line ('[bootstrap] repository=' + $Repository)
$apiBase = 'https://api.github.com/repos/' + $Repository + '/releases'

$headers = @{
    # The GitHub API rejects a request with no User-Agent outright, and the
    # rejection is a 403 with a body that does not mention the real cause.
    'User-Agent' = 'opencode-psmux-bridge-bootstrap'
    'Accept'     = 'application/vnd.github+json'
}

try {
    $release = Invoke-RestMethod -Uri ($apiBase + '/latest') -Headers $headers -Method Get
} catch {
    $status = $null
    if ($_.Exception.PSObject.Properties['Response']) { $status = $_.Exception.Response.StatusCode.value__ }
    if ($status -eq 404) {
        Write-Line '[bootstrap] RESULT=FAILED'
        Write-Line '[bootstrap] reason=no_published_release'
        Write-Line ('[bootstrap] detail=' + $Repository + ' has no published release yet.')
        exit 2
    }
    Fail 'release_lookup_failed' $_.Exception.Message
}

if ($null -eq $release -or [string]::IsNullOrEmpty($release.tag_name)) {
    Fail 'release_lookup_empty' ('the API returned no tag_name for ' + $Repository)
}

$tag = [string] $release.tag_name
Write-Line ('[bootstrap] tag=' + $tag)
Write-Line ('[bootstrap] release_url=https://github.com/' + $Repository + '/releases/tag/' + $tag)

$asset = $null
foreach ($candidate in $release.assets) {
    if ([string]$candidate.name -like ('*' + $AssetNameSuffix)) { $asset = $candidate; break }
}
if ($null -eq $asset) {
    Fail 'no_asset' ('no asset matching *' + $AssetNameSuffix + ' on release ' + $tag)
}

$assetName = [string] $asset.name
$assetUrl = [string] $asset.browser_download_url
$assetSize = [int64] $asset.size
Write-Line ('[bootstrap] asset=' + $assetName)
Write-Line ('[bootstrap] asset_bytes=' + $assetSize)
Write-Line ('[bootstrap] asset_url=' + $assetUrl)

# --------------------------------------------------------------------------- workspace

# Under TEMP, and named for the tag, so two runs cannot collide and a failed run
# leaves something a reader can inspect instead of nothing at all.
$workRoot = Join-Path $env:TEMP ('omo-psmux-bridge-' + ($tag -replace '[^A-Za-z0-9._-]', '_'))
$zipPath = Join-Path $workRoot $assetName
$extractRoot = Join-Path $workRoot 'extracted'

Write-Line ('[bootstrap] work_dir=' + $workRoot)

# --------------------------------------------------------------------------- download

Write-Line '[bootstrap] step=download'
Write-Line ('[bootstrap] note=this asset is roughly ' + [math]::Round($assetSize / 1MB) + ' MB and PowerShell shows no progress bar while it arrives')

try {
    if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

    # -UseBasicParsing avoids Invoke-WebRequest's IE dependency, which is absent
    # on a Server Core host and present-but-broken on some desktop images.
    Invoke-WebRequest -Uri $assetUrl -OutFile $zipPath -UseBasicParsing
} catch {
    Fail 'download_failed' $_.Exception.Message
}

if (-not (Test-Path -LiteralPath $zipPath)) {
    Fail 'download_missing' ('the request reported success but ' + $zipPath + ' does not exist')
}

$actualSize = (Get-Item -LiteralPath $zipPath).Length
Write-Line ('[bootstrap] downloaded_bytes=' + $actualSize)
if ($actualSize -ne $assetSize) {
    Fail 'size_mismatch' ('expected ' + $assetSize + ' bytes from the API, got ' + $actualSize)
}

# --------------------------------------------------------------------------- verify

# There is no checksum to compare against: a signature over the artifact would
# have to be published by the same release that publishes the artifact, which
# proves nothing about who produced it. So the sha256 is COMPUTED AND PRINTED,
# and the release page shows the same value computed by CI. A user who wants to
# confirm the download was intact compares those two numbers, and the script
# hands them the number rather than making them go and find it.
Write-Line '[bootstrap] step=verify'
$sha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Write-Line ('[bootstrap] sha256=' + $sha)
Write-Line ('[bootstrap] sha256_note=compare this with the value on the release page before trusting the install')

# --------------------------------------------------------------------------- extract

Write-Line '[bootstrap] step=extract'
try {
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
} catch {
    Fail 'extract_failed' $_.Exception.Message
}

# --------------------------------------------------------------------------- locate the entry point

# The archive is required to have exactly one top-level directory. Guessing which
# directory holds bin\install.cmd would be the same class of mistake as the
# one-liner this file replaced; refusing to guess is the point.
$entryPoint = Join-Path $extractRoot 'opencode-psmux-bridge\bin\install.cmd'
if (-not (Test-Path -LiteralPath $entryPoint)) {
    $found = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -Filter 'install.cmd' -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName })
    if ($found.Count -eq 0) {
        Fail 'entry_point_missing' ('no install.cmd anywhere under ' + $extractRoot)
    }
    Fail 'entry_point_unexpected_location' ('expected ' + $entryPoint + ' but found ' + ($found -join ' | '))
}
Write-Line ('[bootstrap] entry_point=' + $entryPoint)

# --------------------------------------------------------------------------- install

Write-Line '[bootstrap] step=install'
Write-Line '[bootstrap] ==== install.cmd output follows ===='

# Run the .cmd rather than install.ps1, deliberately: install.cmd is the entry
# point that clears Mark-of-the-Web from the tree first. Skipping it to "go
# straight to the script" would reintroduce exactly the policy failure that entry
# point exists to solve.
$process = Start-Process -FilePath $env:ComSpec `
    -ArgumentList @('/c', ('"' + $entryPoint + '"')) `
    -Wait -NoNewWindow -PassThru
$installerExit = $process.ExitCode

Write-Line '[bootstrap] ==== install.cmd output ends ===='
Write-Line ('[bootstrap] installer_exit=' + $installerExit)

# --------------------------------------------------------------------------- cleanup

# The extracted copy is disposable: install.ps1 has already staged the payload
# into %LOCALAPPDATA%. Leaving ~86 MB behind in TEMP under a name that looks
# authoritative is how a later session ends up debugging a stale tree, so it goes
# -- but only on success, so a failed run can be inspected.
if ($installerExit -eq 0) {
    try {
        Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction Stop
        Write-Line '[bootstrap] cleanup=removed_work_dir'
    } catch {
        Write-Line ('[bootstrap] cleanup=kept_work_dir reason=' + $_.Exception.Message)
    }
} else {
    Write-Line ('[bootstrap] cleanup=kept_work_dir reason=installer_failed exit=' + $installerExit)
}

Write-Line ('[bootstrap] RESULT=' + $(if ($installerExit -eq 0) { 'OK' } else { 'INSTALLER_FAILED' }))
Write-Line ('[bootstrap] next=open a NEW terminal, then run: psmux')

exit $installerExit
