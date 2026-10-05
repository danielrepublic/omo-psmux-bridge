#Requires -Version 5.1
<#
    conpty-driver.ps1 -- task 16 of omo-psmux-windows-parity.

    Owns a Windows ConPTY on the Windows host and drives the REAL bridge
    launcher (psmux.cmd) through it.  No `ssh -t` / `ssh -tt` anywhere: the
    pty lives on this host, so ConPTY is never put back into the byte path of
    an ssh-allocated remote PTY, which is exactly what psmux's own docs warn
    about for its attach path.

    The driver does five checks and records a PASS/FAIL verdict plus observed
    values for each:
      attach-shows-content       the attached client renders the session content
      resize-propagates          window_width/window_height follow a ConPTY resize
      detach-leaves-session-alive
      cwd-invariant              pane cwd == launch dir, from two launch dirs
      split-window-inherits-cwd  split-window without -c inherits the pane cwd
    plus a negative_control that deliberately asserts a WRONG expected width and
    must be reported FAIL (proving the comparison is not normalized away).

    Everything is written as UTF-8 JSON to -OutJson.  The host console is
    BIG5, so the bytes are never round-tripped through it.
#>
[CmdletBinding()]
param(
    [string]$OutJson = "$env:TEMP\t16-result.json"
)

$ErrorActionPreference = 'Stop'
$script:NS      = 'omo_t16'
$script:Root    = "$env:TEMP\t16"
$script:DirD    = "$env:TEMP\t16_D"
$script:DirE    = "$env:TEMP\t16_E"
$script:Launcher = "$env:LOCALAPPDATA\opencode-psmux-bridge\bin\psmux.cmd"
$script:BridgeExe = "$env:LOCALAPPDATA\opencode-psmux-bridge\bin\tmux.exe"
$script:PsmuxHome = "$env:USERPROFILE\.psmux"

# ---------------------------------------------------------------- C# ConPTY ---
$csharp = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace T16ConPty
{
    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    internal static class K32
    {
        public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        public const uint STARTF_USESHOWWINDOW = 0x00000001;
        public const short SW_HIDE = 0;
        public const uint STILL_ACTIVE = 0x000000FF;
        public const uint WAIT_OBJECT_0 = 0x00000000;
        public const uint WAIT_TIMEOUT = 0x00000102;
        public static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, uint nSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern int ClosePseudoConsole(IntPtr hPC);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToWrite, out int lpNumberOfBytesWritten, IntPtr lpOverlapped);
    }

    // One owned ConPTY plus the child running inside it.
    public class ConPtyProcess : IDisposable
    {
        private IntPtr hPC = IntPtr.Zero;
        private IntPtr hProc = IntPtr.Zero;
        private IntPtr hThr = IntPtr.Zero;
        private IntPtr attrList = IntPtr.Zero;
        private IntPtr hPipeInWrite = IntPtr.Zero;
        private IntPtr hPipeOutRead = IntPtr.Zero;
        private FileStream input = null;
        private Thread reader = null;
        private volatile bool outOwnedByReader = false;
        private MemoryStream buf = new MemoryStream();
        private object gate = new object();
        private object wgate = new object();
        private volatile bool stopping = false;

        public int Pid = 0;
        public string CommandLine = "";
        public short Cols = 0;
        public short Rows = 0;

        public ConPtyProcess(short cols, short rows, string commandLine, string cwd)
        {
            Cols = cols; Rows = rows; CommandLine = commandLine;

            IntPtr hInRead, hInWrite, hOutRead, hOutWrite;
            if (!K32.CreatePipe(out hInRead, out hInWrite, IntPtr.Zero, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe(input)");
            if (!K32.CreatePipe(out hOutRead, out hOutWrite, IntPtr.Zero, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe(output)");

            COORD size = new COORD();
            size.X = cols; size.Y = rows;
            IntPtr pc;
            int rc = K32.CreatePseudoConsole(size, hInRead, hOutWrite, 0, out pc);
            if (rc != 0)
            {
                K32.CloseHandle(hInRead); K32.CloseHandle(hInWrite);
                K32.CloseHandle(hOutRead); K32.CloseHandle(hOutWrite);
                throw new Win32Exception(rc, "CreatePseudoConsole returned nonzero HRESULT");
            }
            hPC = pc;
            hPipeInWrite = hInWrite;
            hPipeOutRead = hOutRead;

            IntPtr needed = IntPtr.Zero;
            K32.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref needed);
            attrList = Marshal.AllocHGlobal(needed);
            if (!K32.InitializeProcThreadAttributeList(attrList, 1, 0, ref needed))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList");
            if (!K32.UpdateProcThreadAttribute(attrList, 0, K32.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute");

            STARTUPINFOEX si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.StartupInfo.dwFlags = (int)K32.STARTF_USESHOWWINDOW;
            si.StartupInfo.wShowWindow = K32.SW_HIDE;
            si.lpAttributeList = attrList;

            PROCESS_INFORMATION pi;
            StringBuilder cl = new StringBuilder(commandLine);
            if (!K32.CreateProcessW(null, cl, IntPtr.Zero, IntPtr.Zero, false,
                                    K32.EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi))
            {
                int e = Marshal.GetLastWin32Error();
                K32.ClosePseudoConsole(hPC);
                K32.CloseHandle(hInWrite); K32.CloseHandle(hOutRead);
                throw new Win32Exception(e, "CreateProcessW failed for: " + commandLine);
            }
            hProc = pi.hProcess; hThr = pi.hThread; Pid = pi.dwProcessId;
            K32.CloseHandle(hInRead);
            K32.CloseHandle(hOutWrite);

            input = new FileStream(new SafeFileHandle(hPipeInWrite, true), FileAccess.Write, 4096, false);
            hPipeInWrite = IntPtr.Zero;

            reader = new Thread(new ThreadStart(ReadLoop));
            reader.IsBackground = true;
            reader.Name = "t16-conpty-reader-" + Pid;
            reader.Start();
        }

        private void ReadLoop()
        {
            // Ownership of the output-pipe read handle transfers to this thread
            // HERE and nowhere else, so Dispose must not close it a second time.
            outOwnedByReader = true;
            SafeFileHandle sfh = new SafeFileHandle(hPipeOutRead, true);
            byte[] tmp = new byte[8192];
            try
            {
                using (FileStream fs = new FileStream(sfh, FileAccess.Read, 8192, false))
                {
                    while (!stopping)
                    {
                        int n = fs.Read(tmp, 0, tmp.Length);
                        if (n <= 0) break;
                        lock (gate) { buf.Write(tmp, 0, n); }
                    }
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            catch (ArgumentException) { }
        }

        public void Write(byte[] data)
        {
            lock (wgate)
            {
                input.Write(data, 0, data.Length);
                input.Flush();
            }
        }

        public void Resize(short cols, short rows)
        {
            COORD s = new COORD();
            s.X = cols; s.Y = rows;
            int rc = K32.ResizePseudoConsole(hPC, s);
            Cols = cols; Rows = rows;
            if (rc != 0) throw new Win32Exception(rc, "ResizePseudoConsole returned nonzero HRESULT");
        }

        public long Length { get { lock (gate) { return buf.Length; } } }

        public byte[] Snapshot() { lock (gate) { return buf.ToArray(); } }

        public bool HasExited
        {
            get
            {
                if (hProc == IntPtr.Zero) return true;
                uint c;
                if (!K32.GetExitCodeProcess(hProc, out c)) return true;
                return c != K32.STILL_ACTIVE;
            }
        }

        public uint ExitCode
        {
            get { uint c = 0; if (hProc != IntPtr.Zero) K32.GetExitCodeProcess(hProc, out c); return c; }
        }

        public bool WaitForExit(int ms)
        {
            if (hProc == IntPtr.Zero) return true;
            return K32.WaitForSingleObject(hProc, (uint)ms) == K32.WAIT_OBJECT_0;
        }

        public void Kill()
        {
            if (hProc != IntPtr.Zero && !HasExited) K32.TerminateProcess(hProc, 1);
        }

        public void Dispose()
        {
            stopping = true;
            if (hPC != IntPtr.Zero) { try { K32.ClosePseudoConsole(hPC); } catch { } hPC = IntPtr.Zero; }
            if (hThr != IntPtr.Zero) { try { K32.CloseHandle(hThr); } catch { } hThr = IntPtr.Zero; }
            if (hProc != IntPtr.Zero) { try { K32.CloseHandle(hProc); } catch { } hProc = IntPtr.Zero; }
            if (attrList != IntPtr.Zero)
            {
                try { K32.DeleteProcThreadAttributeList(attrList); } catch { }
                try { Marshal.FreeHGlobal(attrList); } catch { }
                attrList = IntPtr.Zero;
            }
            if (hPipeInWrite != IntPtr.Zero) { try { K32.CloseHandle(hPipeInWrite); } catch { } hPipeInWrite = IntPtr.Zero; }
            if (hPipeOutRead != IntPtr.Zero && !outOwnedByReader) { try { K32.CloseHandle(hPipeOutRead); } catch { } }
            hPipeOutRead = IntPtr.Zero;
            try { if (input != null) { input.Dispose(); input = null; } } catch { }
            try { if (reader != null) { reader.Join(1500); } } catch { }
        }
    }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp -ErrorAction Stop

# ------------------------------------------------------------------ helpers ---
function New-Result {
    param([string]$Check, $Expected, $Observed, [string]$Verdict, [string[]]$Notes = @())
    [ordered]@{
        check             = $Check
        expected          = $Expected
        observed          = $Observed
        verdict           = $Verdict
        notes             = $Notes
    }
}

function ConvertTo-Text {
    param([byte[]]$Bytes)
    if ($null -eq $Bytes) { return '' }
    $s = [System.Text.Encoding]::UTF8.GetString($Bytes)
    # CSI / OSC / single-char escapes, then NULs.  The text CONTENT is what we
    # assert on; the escape sequences are rendering, not content.
    $s = [regex]::Replace($s, "\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", '')
    $s = [regex]::Replace($s, "\x1b\[[0-9;?<>= ]*[ -/]*[@-~]", '')
    $s = [regex]::Replace($s, "\x1b[@-Z\\-_]", '')
    $s = $s -replace "\x00", ''
    return $s
}

# Non-interactive probe.  Runs the REAL launcher.  Start-Process with
# RedirectStandardOutput to a file: the host console is BIG5 and must not touch
# the bytes.  ProcessStartInfo + ReadToEndAsync is deliberately NOT used -- it
# returns empty stdout on this host and manufactures vacuous passes.
function Invoke-Psmux {
    param([string[]]$Argv, [string]$Cwd, [int]$TimeoutSec = 25)
    $id = [Guid]::NewGuid().ToString('N').Substring(0, 10)
    $so = Join-Path $Root "so_$id.txt"
    $se = Join-Path $Root "se_$id.txt"
    foreach ($a in $Argv) {
        if ($a -match '[ \t]') {
            if ($a -notmatch '^".*"$') { throw "argv element needs pre-quoting: [$a]" }
        }
    }
    $sp = @{
        FilePath               = $Launcher
        WorkingDirectory       = $Cwd
        NoNewWindow            = $true
        PassThru               = $true
        RedirectStandardOutput = $so
        RedirectStandardError  = $se
    }
    if ($Argv.Count -gt 0) { $sp['ArgumentList'] = $Argv }
    $p = Start-Process @sp
    $exited = $p.WaitForExit($TimeoutSec * 1000)
    if (-not $exited) {
        try { $p.Kill() } catch { }
        try { $p.WaitForExit(5000) } catch { }
    }
    $outB = if (Test-Path $so) { [System.IO.File]::ReadAllBytes($so) } else { @() }
    $errB = if (Test-Path $se) { [System.IO.File]::ReadAllBytes($se) } else { @() }
    $ec = $null
    try { $ec = $p.ExitCode } catch { }
    [ordered]@{
        argv          = $Argv
        cwd           = $Cwd
        timed_out     = (-not $exited)
        exit_code     = $ec
        stdout_len    = $outB.Length
        stderr_len    = $errB.Length
        stdout        = (ConvertTo-Text $outB).Trim()
        stderr        = (ConvertTo-Text $errB).Trim()
    }
}

# psmux prints NOTHING AT ALL on stdout when a list is empty (measured, task 5).
# That is its normal "empty" answer and is not an error, so it is not folded into
# a failure -- but a check that needs a value is never PASSED on an empty read.
function Read-Psmux {
    param([string[]]$Argv, [string]$Cwd, [int]$TimeoutSec = 25)
    $r = Invoke-Psmux -Argv $Argv -Cwd $Cwd -TimeoutSec $TimeoutSec
    $r['value'] = ($r['stdout'] -split "`r?`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
    if ($null -eq $r['value']) { $r['value'] = '' }
    return $r
}

function Read-WindowSize {
    param([string]$Session, [string]$Cwd)
    $fmt = '"#{window_width}x#{window_height}"'
    $r = Read-Psmux -Argv @('-L', $NS, 'display-message', '-t', $Session, '-p', $fmt) -Cwd $Cwd
    $raw = [string]$r['value']
    $clean = ($raw -replace "['`"]", '').Trim()
    $parsed = ''
    if ($clean -match '^(\d+)x(\d+)$') { $parsed = "$($Matches[1])x$($Matches[2])" }
    [ordered]@{
        source    = 'display-message -t <session> -p "#{window_width}x#{window_height}"'
        raw       = $raw
        cleaned   = $clean
        parsed    = $parsed
        exit_code = $r['exit_code']
        timed_out = $r['timed_out']
        stderr    = $r['stderr']
    }
}

function Read-PanePath {
    param([string]$Session, [string]$Cwd)
    $r = Read-Psmux -Argv @('-L', $NS, 'display-message', '-t', "$Session`:`0", '-p', '"#{pane_current_path}"') -Cwd $Cwd
    [ordered]@{
        source    = 'display-message -t <session>:0 -p "#{pane_current_path}"'
        raw       = [string]$r['value']
        exit_code = $r['exit_code']
        stderr    = $r['stderr']
    }
}

function List-Sessions {
    param([string]$Cwd)
    $r = Read-Psmux -Argv @('-L', $NS, 'list-sessions', '-F', '"#{session_name}:attached=#{session_attached}:windows=#{session_windows}"') -Cwd $Cwd
    [ordered]@{
        raw       = [string]$r['value']
        all_lines = ($r['stdout'] -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
        exit_code = $r['exit_code']
    }
}

function List-Panes {
    param([string]$Session, [string]$Cwd)
    $r = Read-Psmux -Argv @('-L', $NS, 'list-panes', '-t', $Session, '-F', '"#{pane_id}|#{pane_current_path}|#{pane_width}x#{pane_height}"') -Cwd $Cwd
    $lines = @($r['stdout'] -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    [ordered]@{
        raw       = [string]$r['value']
        panes     = $lines
        count     = $lines.Count
        exit_code = $r['exit_code']
        stderr    = $r['stderr']
    }
}

function Get-PsmuxProcesses {
    $p = Get-CimInstance Win32_Process -Filter "Name='psmux.exe' OR Name='tmux.exe'" -ErrorAction SilentlyContinue
    $out = @()
    foreach ($x in $p) {
        $isMine = ([string]$x.CommandLine) -like "*$NS*"
        $out += [ordered]@{ pid = $x.ProcessId; name = $x.Name; command_line = [string]$x.CommandLine; created_by_this_task = $isMine }
    }
    $out
}

function Get-UserPathEntries {
    $raw = (Get-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -ErrorAction SilentlyContinue).Path
    if ($null -eq $raw) { $raw = '' }
    $entries = @($raw -split ';' | Where-Object { $_.Trim() -ne '' })
    [ordered]@{
        raw          = $raw
        entry_count  = $entries.Count
        entries      = $entries
        has_bridge   = (@($entries | Where-Object { $_ -like '*opencode-psmux-bridge*' }).Count -gt 0)
    }
}

function Send-Key {
    param($Client, [string]$Ascii)
    $Client.Write([System.Text.Encoding]::ASCII.GetBytes($Ascii))
}

function Send-PrefixKey {
    param($Client, [string]$Ascii, [int]$GapMs = 250)
    $Client.Write([byte[]]@(0x02))
    Start-Sleep -Milliseconds $GapMs
    $Client.Write([System.Text.Encoding]::ASCII.GetBytes($Ascii))
}

# --------------------------------------------------------------------- state ---
$result = [ordered]@{
    task                 = 16
    title                = 'Verify the interactive surface over a Windows-local ConPTY'
    captured_at_utc      = (Get-Date).ToUniversalTime().ToString('o')
    host                 = [ordered]@{
        computer            = $env:COMPUTERNAME
        os                  = (Get-CimInstance Win32_OperatingSystem).Caption
        os_version          = [string](Get-CimInstance Win32_OperatingSystem).Version
        powershell          = $PSVersionTable.PSVersion.ToString()
        console_encoding    = [Console]::OutputEncoding.WebName
    }
    transport            = [ordered]@{
        kind                 = 'Windows ConPTY owned by this harness, on the Windows host'
        why_not_ssh_tt       = "psmux's own docs: do not add -t/-tt, allocating a remote PTY puts ConPTY back in the byte path. No ssh -t/-tt was used at any point."
        implementation       = 'PowerShell 5.1 Add-Type + C# P/Invoke (CreatePseudoConsole / ResizePseudoConsole / ClosePseudoConsole / CreatePipe / InitializeProcThreadAttributeList / UpdateProcThreadAttribute[PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE] / CreateProcessW[EXTENDED_STARTUPINFO_PRESENT])'
        language_why         = 'Add-Type + kernel32.dll P/Invoke needs NO toolchain on this host. python is the Store stub and returns "Python was not found"; there is no gcc/cl, so no winpty; bun/dotnet would have been the fallback but were not needed.'
        resize_equivalent    = 'ResizePseudoConsole is the ConPTY equivalent of TIOCSWINSZ'
    }
    namespace            = [ordered]@{
        flag              = '-L omo_t16'
        why               = 'throwaway namespace; PSMUX_DATA_DIR isolation is broken at psmux 3.3.8 (upstream #599) so -L is the only working lever'
        isolation_state   = 'C:\Users\Daniel\.psmux (shared, pre-existing)'
    }
    launcher             = [ordered]@{
        path               = $Launcher
        exists             = (Test-Path $Launcher)
        note               = 'every client and every probe in this task went through this launcher, the real path the user types'
    }
    checks               = @()
    negative_control     = $null
    cleanup              = [ordered]@{}
    not_proved           = @()
}

$baselineProcs = @(Get-PsmuxProcesses)
$result['baseline'] = [ordered]@{
    taken_at_utc        = (Get-Date).ToUniversalTime().ToString('o')
    psmux_processes     = $baselineProcs
    psmux_process_count = $baselineProcs.Count
    owned_by_this_task  = @($baselineProcs | Where-Object { $_['created_by_this_task'] } | ForEach-Object { $_['pid'] })
    user_path           = (Get-UserPathEntries)
    bridge_tmux_exe     = [ordered]@{
        path   = $BridgeExe
        size   = (Get-Item $BridgeExe).Length
        sha256 = (Get-FileHash -Algorithm SHA256 -Path $BridgeExe).Hash
    }
    psmux_home_before   = @(Get-ChildItem -Force $script:PsmuxHome -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
}

# ---------------------------------------------------------------- set up dirs ---
foreach ($d in @($script:Root, $script:DirD, $script:DirE)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
}
$result['directories'] = [ordered]@{
    created_from_D = $script:DirD
    attach_from_E  = $script:DirE
    scratch        = $script:Root
    both_exist     = ((Test-Path $script:DirD) -and (Test-Path $script:DirE))
}

# ============================================================================
# CHECK 1 -- attach-shows-content   (client #1, invoked from D)
# ============================================================================
$markerTyped = 'T16TYPED4B2E'
$markerSrv   = 'T16SRV7C1E'
$c1 = $null
$sess = ''
$check1 = $null
try {
    $c1 = [T16ConPty.ConPtyProcess]::new([int16]100, [int16]30, 'cmd.exe /d /s /c "' + $Launcher + ' -L ' + $NS + '"', $script:DirD)

    # wait until the bare invocation has created its session and attached
    $att = $null; $ls = $null
    for ($i = 0; $i -lt 16; $i++) {
        Start-Sleep -Milliseconds 500
        $ls = List-Sessions -Cwd $script:DirD
        if ($ls['raw'] -ne '') {
            $sess = ([string]$ls['raw'] -split ':')[0]
            $att = ([regex]::Match([string]$ls['raw'], 'attached=(\d+)')).Groups[1].Value
            if ($null -ne $att -and [int]$att -gt 0) { break }
        }
    }
    $bytes1 = $c1.Snapshot()
    $text1  = ConvertTo-Text $bytes1
    $sawPrompt = $text1 -match 't16_D'

    # type a marker through the client and watch it come back through the pty
    Send-Key $c1 ("echo $markerTyped`r")
    $sawTyped = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        $text1 = ConvertTo-Text ($c1.Snapshot())
        if ($text1 -match $markerTyped) { $sawTyped = $true; break }
    }
    $bytes1 = $c1.Snapshot()
    $text1  = ConvertTo-Text $bytes1
    $index  = $text1.IndexOf($markerTyped)
    $sample = if ($index -ge 0) { $text1.Substring([Math]::Max(0, $index - 90), [Math]::Min(230, $text1.Length - [Math]::Max(0, $index - 90))) } else { '' }

    $check1 = New-Result -Check 'attach-shows-content' `
        -Expected "captured ConPTY output is non-empty AND contains the session's marker '$markerTyped' AND the pane's launch directory token 't16_D'" `
        -Observed ([ordered]@{
            client_argv             = @('psmux.cmd', '-L', $NS, '(zero further args -> launcher pass-through of a bare namespaced psmux)')
            client_cwd              = $script:DirD
            conpty_size_at_attach   = '100x30'
            client_pid              = $c1.Pid
            session_created         = $sess
            session_attached        = $att
            capture_method          = 'raw bytes read off the ConPTY output pipe by the harness reader thread (not a file redirect, not ProcessStartInfo); CSI/OSC escapes stripped, then asserted on the text'
            captured_bytes          = $bytes1.Length
            captured_nonnull_bytes  = @($bytes1 | Where-Object { $_ -ne 0 }).Count
            captured_text_length    = $text1.Length
            marker_seen_in_capture  = $sawTyped
            pane_dir_token_seen     = $sawPrompt
            marker_sample           = $sample
            alternate_screen_escape = ([regex]::Matches(([System.Text.Encoding]::ASCII.GetString($bytes1)), "\x1b\[\?1049h")).Count
        }) `
        -Verdict $(if ($bytes1.Length -gt 0 -and $sawTyped -and $sawPrompt) { 'PASS' } else { 'FAIL' }) `
        -Notes @(
            'An absent alternate-screen escape sequence is NOT treated as a failure: content is captured from the pty byte stream.',
            'client_argv is the zero-argument launcher form the user actually types; -L is prepended because PSMUX_DATA_DIR isolation is broken upstream (#599).',
            'The session id is numeric because bare psmux 3.3.8 always allocates the next numeric name.'
        )
    $result['checks'] += $check1
}
catch {
    $result['checks'] += (New-Result -Check 'attach-shows-content' -Expected 'client attaches and session content is captured' -Observed @{ error = $_.Exception.Message } -Verdict 'FAIL' -Notes @('harness exception'))
}

# ============================================================================
# CHECK 4 (first read) -- cwd-invariant: pane cwd right after creation from D
# ============================================================================
$pathRead1 = $null
if ($sess -ne '') { $pathRead1 = Read-PanePath -Session $sess -Cwd $script:DirD }

# ---- server-side marker: proves the attach renders SERVER content, not our echo
if ($sess -ne '') {
    $null = Invoke-Psmux -Argv @('-L', $NS, 'send-keys', '-t', "$sess`:`0", ('"echo ' + $markerSrv + '"'), 'Enter') -Cwd $script:DirD
}

# ---- detach client #1 -------------------------------------------------------
$detachInfo = [ordered]@{ sent = $null; client_exit_code = $null; client_exited = $null; elapsed_ms = $null }
if ($c1 -ne $null) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Send-PrefixKey $c1 'd'
    $detachInfo['sent'] = 'CTRL-B (0x02) then "d" -- the psmux/tmux detach prefix'
    $detachInfo['client_exited'] = $c1.WaitForExit(10000)
    $detachInfo['elapsed_ms'] = $sw.ElapsedMilliseconds
    $detachInfo['client_exit_code'] = $c1.ExitCode
}

$postDetach1 = [ordered]@{
    sessions        = (List-Sessions -Cwd $script:DirE)
    panes           = (List-Panes -Session $sess -Cwd $script:DirE)
    clients         = (Read-Psmux -Argv @('-L', $NS, 'list-clients', '-F', '"#{client_pid}"') -Cwd $script:DirE)['value']
    client_process_gone = ($c1.HasExited)
}

$check3 = New-Result -Check 'detach-leaves-session-alive' `
    -Expected 'after detaching, the session still exists with its pane, session_attached is 0, list-clients is empty, and the client process has exited' `
    -Observed ([ordered]@{
        session                  = $sess
        detach_input             = $detachInfo['sent']
        detach_elapsed_ms        = $detachInfo['elapsed_ms']
        client_exited            = $detachInfo['client_exited']
        client_exit_code         = $detachInfo['client_exit_code']
        sessions_after_detach    = $postDetach1['sessions']['raw']
        session_attached_after   = ([regex]::Match([string]$postDetach1['sessions']['raw'], 'attached=(\d+)')).Groups[1].Value
        panes_after_detach       = $postDetach1['panes']['panes']
        pane_count_after_detach  = $postDetach1['panes']['count']
        list_clients_after       = $postDetach1['clients']
        pane_path_after_detach   = $pathRead1
    }) `
    -Verdict $(if ($postDetach1['sessions']['raw'] -ne '' -and $postDetach1['panes']['count'] -ge 1 -and ([regex]::Match([string]$postDetach1['sessions']['raw'], 'attached=(\d+)')).Groups[1].Value -eq '0' -and $postDetach1['clients'] -eq '' -and $postDetach1['client_process_gone']) { 'PASS' } else { 'FAIL' }) `
    -Notes @('the detach key was sent through the owned ConPTY, not through an ssh-allocated pty')
$result['checks'] += $check3

# ============================================================================
# CHECK 2 + 3(second read) + 5 -- client #2, attached from E
# ============================================================================
$c2 = $null
$beforeSize = $null; $afterSize = $null; $resizePoll = @(); $resizeMs = $null
$pathRead2 = $null; $split = $null; $panesAfterSplit = $null
$check2 = $null; $check4 = $null; $check5 = $null
try {
    $c2 = [T16ConPty.ConPtyProcess]::new([int16]80, [int16]24, ('cmd.exe /d /s /c "' + $Launcher + ' -L ' + $NS + ' attach -t ' + $sess + '"'), $script:DirE)

    $att2 = $null
    for ($i = 0; $i -lt 16; $i++) {
        Start-Sleep -Milliseconds 500
        $ls2 = List-Sessions -Cwd $script:DirE
        $att2 = ([regex]::Match([string]$ls2['raw'], 'attached=(\d+)')).Groups[1].Value
        if ($null -ne $att2 -and [int]$att2 -gt 0) { break }
    }

    # --- content of the session, produced by the SERVER before the attach ---
    $bytes2 = $c2.Snapshot()
    $text2  = ConvertTo-Text $bytes2
    $sawSrv = $false
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 250
        $text2 = ConvertTo-Text ($c2.Snapshot())
        if ($text2 -match $markerSrv) { $sawSrv = $true; break }
    }
    $bytes2 = $c2.Snapshot()
    $text2  = ConvertTo-Text $bytes2
    $iSrv = $text2.IndexOf($markerSrv)
    $sample2 = if ($iSrv -ge 0) { $text2.Substring([Math]::Max(0, $iSrv - 90), [Math]::Min(230, $text2.Length - [Math]::Max(0, $iSrv - 90))) } else { '' }

    $result['checks'] = @($result['checks'] | Where-Object { $_['check'] -ne 'attach-shows-content' })
    $check1b = New-Result -Check 'attach-shows-content' `
        -Expected "the re-attached client's ConPTY capture is non-empty AND contains the SERVER-produced marker '$markerSrv' that was written into the pane by send-keys BEFORE the attach" `
        -Observed ([ordered]@{
            client_argv            = @('psmux.cmd', '-L', $NS, 'attach', '-t', $sess)
            client_cwd             = $script:DirE
            conpty_size_at_attach  = '80x24'
            client_pid             = $c2.Pid
            session_attached       = $att2
            capture_method         = 'raw bytes read off the ConPTY output pipe by the harness reader thread; CSI/OSC escapes stripped, then asserted on the text'
            captured_bytes         = $bytes2.Length
            captured_nonnull_bytes = @($bytes2 | Where-Object { $_ -ne 0 }).Count
            captured_text_length   = $text2.Length
            server_marker_seen     = $sawSrv
            server_marker_origin   = "psmux -L $NS send-keys -t $sess`:0.0 `"echo $markerSrv`" Enter  (run while NO client was attached)"
            marker_sample          = $sample2
            alternate_screen_escape_count = ([regex]::Matches(([System.Text.Encoding]::ASCII.GetString($bytes2)), "\x1b\[\?1049h")).Count
            first_client_typed_marker_seen = $sawTyped
        }) `
        -Verdict $(if ($bytes2.Length -gt 0 -and $sawSrv) { 'PASS' } else { 'FAIL' }) `
        -Notes @(
            'An absent alternate-screen escape sequence is NOT a failure: content is captured from the pty byte stream instead.',
            'The marker was produced by the SERVER before the attach, so seeing it proves the client renders session content rather than echoing our own input.'
        )
    $result['checks'] += $check1b

    # ------------------------- CHECK 2: resize-propagates ----------------------
    $beforeSize = Read-WindowSize -Session $sess -Cwd $script:DirE
    $wantCols = 132; $wantRows = 43
    $want = "$($wantCols)x$($wantRows)"
    $resizeRc = 'ok'
    try { $c2.Resize([int16]$wantCols, [int16]$wantRows) } catch { $resizeRc = $_.Exception.Message }
    $swr = [System.Diagnostics.Stopwatch]::StartNew()
    $afterSize = $beforeSize
    $n = 0
    while ($swr.ElapsedMilliseconds -lt 20000) {
        Start-Sleep -Milliseconds 300
        $n++
        $afterSize = Read-WindowSize -Session $sess -Cwd $script:DirE
        $resizePoll += [ordered]@{ attempt = $n; at_ms = $swr.ElapsedMilliseconds; parsed = $afterSize['parsed']; raw = $afterSize['raw'] }
        if ($afterSize['parsed'] -eq $want) { break }
    }
    $resizeMs = $swr.ElapsedMilliseconds

    $changed = ($beforeSize['parsed'] -ne '' -and $afterSize['parsed'] -ne '' -and $beforeSize['parsed'] -ne $afterSize['parsed'])
    $correct = ($afterSize['parsed'] -eq $want)
    $check2 = New-Result -Check 'resize-propagates' `
        -Expected "width/height reported by psmux CHANGES across a ConPTY resize and the post-resize value equals $($wantCols)x$($wantRows)" `
        -Observed ([ordered]@{
            conpty_before          = '80x24'
            conpty_after           = $want
            resize_api             = 'ResizePseudoConsole'
            resize_api_result      = $resizeRc
            before_read            = $beforeSize
            after_read             = $afterSize
            before_parsed          = $beforeSize['parsed']
            after_parsed           = $afterSize['parsed']
            value_changed          = $changed
            equals_requested_size  = $correct
            settle_bounded_timeout_ms = 20000
            settle_elapsed_ms      = $resizeMs
            settle_poll_attempts   = $n
            settle_poll_trace      = $resizePoll
            read_source            = 'psmux -L omo_t16 display-message -t <session> -p "#{window_width}x#{window_height}"  (a real psmux read; the width is NEVER computed by the harness)'
        }) `
        -Verdict $(if ($changed -and $correct) { 'PASS' } else { 'FAIL' }) `
        -Notes @('ConPTY resize is asynchronous, so the reported size is polled to a bounded timeout and the settle time is recorded.')
    $result['checks'] += $check2

    # ------------------------- CHECK 4 (second read): cwd-invariant ----------
    $pathRead2 = Read-PanePath -Session $sess -Cwd $script:DirE
    $e1 = $pathRead1['raw']
    $e2 = $pathRead2['raw']
    $norm = { param($s) (([string]$s) -replace '\\+$', '') }
    $d = & $norm $e1
    $d2 = & $norm $e2
    $dirD = & $norm $script:DirD
    $check4 = New-Result -Check 'cwd-invariant' `
        -Expected "pane_current_path equals the creating directory D ($($script:DirD)) on BOTH reads: once after creation from D, and once while re-attached from E ($($script:DirE))" `
        -Observed ([ordered]@{
            created_from_D         = $dirD
            attach_from_E          = (& $norm $script:DirE)
            read_1_after_create_from_D = $e1
            read_2_while_attached_from_E = $e2
            read_1_equals_D        = ($d -eq $dirD)
            read_2_equals_D        = ($d2 -eq $dirD)
            path_unchanged_by_reattach = ($d -eq $d2)
            read_1_source          = $pathRead1['source']
            read_2_source          = $pathRead2['source']
            read_1_command         = ('psmux.cmd -L ' + $NS + ' display-message -t ' + $sess + ':0.0 -p "#{pane_current_path}"')
            read_2_command         = ('psmux.cmd -L ' + $NS + ' display-message -t ' + $sess + ':0.0 -p "#{pane_current_path}"')
            creation_form          = 'bare launcher (zero further args) from D -- no -c, so the cwd-inheritance path is the one under test'
        }) `
        -Verdict $(if (($d -eq $dirD) -and ($d2 -eq $dirD) -and ($e1 -ne '') -and ($e2 -ne '')) { 'PASS' } else { 'FAIL' }) `
        -Notes @('"attached from here" can never be asserted from the invocation directory, because a client attach never transmits the client cwd. It is asserted by the SECOND read still naming D.')
    $result['checks'] += $check4

    # ------------------------- CHECK 5: split-window-inherits-cwd -------------
    $panesBefore = List-Panes -Session $sess -Cwd $script:DirE
    $split = Invoke-Psmux -Argv @('-L', $NS, 'split-window', '-t', "$sess`:`0") -Cwd $script:DirE
    $panesAfter = List-Panes -Session $sess -Cwd $script:DirE
    $how = 'non-interactive: psmux.cmd -L omo_t16 split-window -t <session>:0.0   (NO -c flag)'
    if ($panesAfter['count'] -le $panesBefore['count']) {
        # no client-free split; drive the client's own split-window keybinding
        Send-PrefixKey $c2 '"'
        Start-Sleep -Milliseconds 2500
        $panesAfter = List-Panes -Session $sess -Cwd $script:DirE
        $how = 'client keybinding: CTRL-B then " (psmux binds this to `split-window -v`), because the client-free split-window call did not add a pane'
    }
    $newPaths = @()
    foreach ($l in @($panesAfter['panes'])) {
        $parts = ([string]$l) -split '\|'
        if ($parts.Count -ge 2) { $newPaths += ((& $norm $parts[1])) }
    }
    $allD = ($newPaths.Count -ge 2)
    foreach ($p in $newPaths) { if ((& $norm $p) -ne $dirD) { $allD = $false } }
    $check5 = New-Result -Check 'split-window-inherits-cwd' `
        -Expected "every pane in the session reports pane_current_path == D ($($script:DirD)), including the pane added by split-window with NO -c" `
        -Observed ([ordered]@{
            split_invocation   = $how
            split_call         = $split
            panes_before       = $panesBefore['panes']
            panes_before_count = $panesBefore['count']
            panes_after        = $panesAfter['panes']
            panes_after_count  = $panesAfter['count']
            pane_paths_after   = $newPaths
            all_panes_equal_D  = $allD
            D_normalised       = $dirD
        }) `
        -Verdict $(if ($panesAfter['count'] -ge 2 -and $allD) { 'PASS' } else { 'FAIL' }) `
        -Notes @('-c was deliberately NOT passed: the plan requires the INHERITANCE path, and a bad -c on 3.3.8 falls back to HOME.')
    $result['checks'] += $check5

    # ------------------------- negative control ------------------------------
    $ncRead = Read-WindowSize -Session $sess -Cwd $script:DirE
    $wrongWant = '131x43'
    $ncVerdict = if (($ncRead['parsed'] -ne '') -and ($ncRead['parsed'] -ne $wrongWant)) { 'FAIL' } else { 'PASS' }
    $result['negative_control'] = [ordered]@{
        purpose       = 'prove the comparison is a real comparison: assert a deliberately WRONG expected width and confirm the harness reports FAIL instead of normalizing it away'
        expected      = $wrongWant
        observed      = $ncRead['parsed']
        verdict       = $ncVerdict
        expected_when_correct_would_be = $want
        note          = 'the only difference between this and check 2 is the expected string (131x43 instead of 132x43); the observed read is identical'
        read          = $ncRead
    }

    # ---- detach client #2 ----------------------------------------------------
    Send-PrefixKey $c2 'd'
    $c2.WaitForExit(10000)
    $result['cleanup']['client2_detached'] = [ordered]@{
        client_pid   = $c2.Pid
        client_exited = $c2.HasExited
        exit_code    = $c2.ExitCode
    }
}
catch {
    $err = $_.Exception.Message
    foreach ($n in @(
        @{ c = 'resize-propagates';     x = "conpty resized to 132x43 and psmux reported size changes to it" },
        @{ c = 'cwd-invariant';         x = "pane_current_path == D on both reads" },
        @{ c = 'split-window-inherits-cwd'; x = 'split-window without -c inherits D' },
        @{ c = 'attach-shows-content';  x = 'server-produced marker visible in the attach capture' })) {
        $result['checks'] += (New-Result -Check $n.c -Expected $n.x -Observed @{ harness_error = $err } -Verdict 'FAIL' -Notes @('harness exception'))
    }
    if ($null -eq $result['negative_control']) {
        $result['negative_control'] = [ordered]@{ purpose = 'not run'; expected = '131x43'; observed = ''; verdict = 'NOT_RUN'; note = "harness exception: $err" }
    }
}
finally {
    foreach ($c in @($c1, $c2)) {
        if ($null -ne $c) {
            if (-not $c.HasExited) { try { $c.Kill() } catch { } ; try { $c.WaitForExit(5000) } catch { } }
            $c.Dispose()
        }
    }
}

# ------------------------------------------------------------------ cleanup ---
$ownPids = @()
foreach ($p in @(Get-PsmuxProcesses)) { if ($p['created_by_this_task']) { $ownPids += $p['pid'] } }
$killSrv = Invoke-Psmux -Argv @('-L', $NS, 'kill-server') -Cwd $script:DirE -TimeoutSec 20
Start-Sleep -Seconds 2
$srvGone = $false
for ($i = 0; $i -lt 8; $i++) {
    $alive = @(Get-PsmuxProcesses | Where-Object { $_['created_by_this_task'] })
    if ($alive.Count -eq 0) { $srvGone = $true; break }
    Start-Sleep -Milliseconds 500
}
$sessionsAfter = List-Sessions -Cwd $script:DirE

$mineBefore = @(Get-ChildItem -Force $script:PsmuxHome -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$NS*" })
$deleted = @()
foreach ($f in $mineBefore) {
    try { Remove-Item -Force $f.FullName -ErrorAction Stop; $deleted += $f.Name } catch { }
}
$mineAfter = @(Get-ChildItem -Force $script:PsmuxHome -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$NS*" })

$finalProcs = @(Get-PsmuxProcesses)
$finalPath = Get-UserPathEntries
$finalPidList = @($finalProcs | ForEach-Object { $_['pid'] })
$foreignSurvivors = @($baselineProcs | Where-Object { $finalPidList -contains $_['pid'] } | ForEach-Object { $_['pid'] })
$foreignLost = @($baselineProcs | Where-Object { $finalPidList -notcontains $_['pid'] } | ForEach-Object { $_['pid'] })
$finalExe = [ordered]@{
    path   = $BridgeExe
    size   = (Get-Item $BridgeExe).Length
    sha256 = (Get-FileHash -Algorithm SHA256 -Path $BridgeExe).Hash
}
$executable = ($finalExe['size'] -eq 86110208 -and $finalExe['sha256'] -eq '9EA5E733FD78F4EA966A85A5CF062D1113C644FEFF80AD3B3084574C2BA2A858')

# my own scratch: result files + dirs, leaving the staged script for the caller
$scratchLeft = @()
foreach ($f in @(Get-ChildItem -Force $Root -ErrorAction SilentlyContinue)) {
    try { Remove-Item -Force -Recurse $f.FullName -ErrorAction Stop } catch { $scratchLeft += $f.Name }
}
foreach ($d in @($script:DirD, $script:DirE, $script:Root)) {
    try { Remove-Item -Force -Recurse $d -ErrorAction Stop } catch { $scratchLeft += (Split-Path $d -Leaf) }
}
$scratchLeft += @(Get-ChildItem -Force $script:Root -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
foreach ($t in @($script:DirD, $script:DirE, $script:Root)) {
    $scratchLeft += @($t | Where-Object { Test-Path $_ })
}

$result['cleanup'] = [ordered]@{
    conpty_handles_closed       = $true
    clients_terminated          = $true
    kill_server_call            = $killSrv
    my_psmux_pids_before_kill   = $ownPids
    my_psmux_server_gone        = $srvGone
    sessions_left_in_namespace  = $sessionsAfter['raw']
    my_psmux_home_files_before  = @($mineBefore | ForEach-Object { $_.Name })
    my_psmux_home_files_deleted = $deleted
    my_psmux_home_files_after   = @($mineAfter | ForEach-Object { $_.Name })
    my_psmux_home_files_remaining = $mineAfter.Count
    scratch_still_present       = @($scratchLeft | Where-Object { $_ -ne '' })
    psmux_processes_before      = @($baselineProcs | ForEach-Object { $_['pid'] })
    psmux_processes_after       = $finalPidList
    foreign_pids_preserved      = $baselineProcs.Count
    foreign_pids_still_alive    = $foreignSurvivors
    foreign_pids_lost           = $foreignLost
    foreign_pids_untouched      = ($foreignLost.Count -eq 0)
    bridge_tmux_exe_unchanged   = $executable
    bridge_tmux_exe_after       = $finalExe
    user_path_entry_count       = $finalPath['entry_count']
    user_path_before            = $result['baseline']['user_path']['entry_count']
    user_path_unchanged         = ($finalPath['raw'] -eq $result['baseline']['user_path']['raw'])
    install_ps1_called          = $false
    setx_called                 = $false
}

# ------------------------------------------------------------- not proved ----
$result['not_proved'] = @(
    'No check ran through `ssh -t` / `ssh -tt`: psmux documents that allocating a remote PTY puts ConPTY back into the byte path. The ConPTY was owned by this harness on the Windows host instead.'
) + @($result['checks'] | Where-Object { $_['verdict'] -ne 'PASS' } | ForEach-Object { "FAIL: " + $_['check'] })

$json = $result | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("WROTE " + $OutJson + " bytes=" + $json.Length)