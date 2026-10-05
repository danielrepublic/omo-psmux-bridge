@echo off
rem ============================================================================
rem  psmux.cmd -- the opencode-psmux-bridge launcher for the `psmux` command.
rem
rem  Installed at %LOCALAPPDATA%\opencode-psmux-bridge\bin\psmux.cmd
rem  Contract: .omo/plans/omo-psmux-windows-parity.md, todo 8.
rem
rem  1. The real psmux EXE is resolved BY ABSOLUTE PATH from the registry value
rem     HKCU\Software\psmux\InstallDir, falling back to %LOCALAPPDATA%\psmux.
rem     The name is never resolved by bare lookup, because this directory owns
rem     the name once install.ps1 has run.
rem  2. `--no-bridge` as the FIRST argument is stripped, and the real psmux runs
rem     with the INHERITED ENVIRONMENT UNCHANGED -- no PATH extension at all.
rem  3. NO arguments at all are rewritten to `new -A -s default`. Bare psmux on
rem     3.3.8 creates a NEW NUMERIC SESSION every time (measured; it is not
rem     tmux behaviour), and this launcher exists to be tmux-equivalent, which
rem     means attach-to-`default`.
rem  4. Every other invocation forwards argv BYTE-FOR-BYTE.
rem  5. In every bridge-enabled case the bridge bin directory is prepended to
rem     PATH FOR THE CHILD PROCESS ONLY. `setlocal` scopes it; it is never
rem     persisted and never written to the registry.
rem  6. The working directory is NEVER changed -- the first pane's directory is
rem     the invoking client's directory, and that invariant must survive here.
rem  7. `new`/`new-session` with a `-c` path that is not an existing directory
rem     prints a warning naming psmux's silent-fallback behaviour, BEFORE the
rem     arguments are forwarded.
rem
rem  Every string comparison below runs on a COPY of the argument with double
rem  quotes removed, so an unbalanced quote in a malformed argument cannot break
rem  out of the `if` comparison. The forwardable text is never modified.
rem
rem  Exit codes: the child's exit code, or 69 (EX_UNAVAILABLE) when the real
rem  psmux binary cannot be resolved. stdout is never written to on success.
rem ============================================================================

setlocal EnableExtensions DisableDelayedExpansion

rem ---- where this launcher lives ------------------------------------------------
set "PSMUX_BRIDGE_BIN=%~dp0"
if "%PSMUX_BRIDGE_BIN:~-1%"=="\" set "PSMUX_BRIDGE_BIN=%PSMUX_BRIDGE_BIN:~0,-1%"

rem ---- capture argv ONCE, before anything shifts it ----------------------------
set "PSMUX_LAUNCHER_ALL=%*"
set "PSMUX_LAUNCHER_PRE="
set "PSMUX_LAUNCHER_POST=%PSMUX_LAUNCHER_ALL%"
set "PSMUX_LAUNCHER_BRIDGE=1"

rem ---- 1. resolve the install directory from the registry -----------------------
rem reg.exe prints "    <name>    <TYPE>    <value>". Two independent parses are
rem taken and the first one that actually holds a psmux binary wins:
rem   A: whole line, then delete through "    REG_" and through "    ". Space-safe.
rem      (`for /f "tokens=1,2*" %%a ... %%*` is NOT usable: in a batch file the `*`
rem      FOR variable collides with the %* argument modifier and yields "%*".
rem      Measured on this host, so parse A exists.)
rem   B: third whitespace token. Exact unless the path contains a space.
set "PSMUX_LAUNCHER_LINE="
for /f "delims=" %%L in ('reg query "HKCU\Software\psmux" /v InstallDir 2^>nul') do set "PSMUX_LAUNCHER_LINE=%%L"
set "PSMUX_LAUNCHER_IDA=%PSMUX_LAUNCHER_LINE:*    REG_=%"
set "PSMUX_LAUNCHER_IDA=%PSMUX_LAUNCHER_IDA:*    =%"
set "PSMUX_LAUNCHER_IDB="
for /f "tokens=1,2,3*" %%a in ('reg query "HKCU\Software\psmux" /v InstallDir 2^>nul') do if /I "%%a"=="InstallDir" set "PSMUX_LAUNCHER_IDB=%%c"

set "PSMUX_LAUNCHER_ID="
if defined PSMUX_LAUNCHER_IDA if exist "%PSMUX_LAUNCHER_IDA%\psmux.exe" set "PSMUX_LAUNCHER_ID=%PSMUX_LAUNCHER_IDA%"
if not defined PSMUX_LAUNCHER_ID if defined PSMUX_LAUNCHER_IDA if exist "%PSMUX_LAUNCHER_IDA%\tmux.exe" set "PSMUX_LAUNCHER_ID=%PSMUX_LAUNCHER_IDA%"
if not defined PSMUX_LAUNCHER_ID if defined PSMUX_LAUNCHER_IDA if exist "%PSMUX_LAUNCHER_IDA%\pmux.exe" set "PSMUX_LAUNCHER_ID=%PSMUX_LAUNCHER_IDA%"
if not defined PSMUX_LAUNCHER_ID if defined PSMUX_LAUNCHER_IDB if exist "%PSMUX_LAUNCHER_IDB%\psmux.exe" set "PSMUX_LAUNCHER_ID=%PSMUX_LAUNCHER_IDB%"
if not defined PSMUX_LAUNCHER_ID if defined PSMUX_LAUNCHER_IDB if exist "%PSMUX_LAUNCHER_IDB%\tmux.exe" set "PSMUX_LAUNCHER_ID=%PSMUX_LAUNCHER_IDB%"
if not defined PSMUX_LAUNCHER_ID if defined PSMUX_LAUNCHER_IDB if exist "%PSMUX_LAUNCHER_IDB%\pmux.exe" set "PSMUX_LAUNCHER_ID=%PSMUX_LAUNCHER_IDB%"
if not defined PSMUX_LAUNCHER_ID set "PSMUX_LAUNCHER_ID=%PSMUX_LAUNCHER_IDA%"
if not defined PSMUX_LAUNCHER_ID set "PSMUX_LAUNCHER_ID=%LOCALAPPDATA%\psmux"
rem psmux's NSIS installer writes an expanded path, but tolerate a %VAR% reference.
echo %PSMUX_LAUNCHER_ID%| find "%" >nul
if not errorlevel 1 for /f "delims=" %%v in ('call echo %%PSMUX_LAUNCHER_ID%%') do set "PSMUX_LAUNCHER_ID=%%v"
if "%PSMUX_LAUNCHER_ID:~-1%"=="\" set "PSMUX_LAUNCHER_ID=%PSMUX_LAUNCHER_ID:~0,-1%"

rem ---- 2. resolve the backend binary, preferring psmux.exe -----------------------
set "PSMUX_LAUNCHER_EXE="
if not defined PSMUX_LAUNCHER_EXE if exist "%PSMUX_LAUNCHER_ID%\psmux.exe" set "PSMUX_LAUNCHER_EXE=%PSMUX_LAUNCHER_ID%\psmux.exe"
if not defined PSMUX_LAUNCHER_EXE if exist "%PSMUX_LAUNCHER_ID%\tmux.exe" set "PSMUX_LAUNCHER_EXE=%PSMUX_LAUNCHER_ID%\tmux.exe"
if not defined PSMUX_LAUNCHER_EXE if exist "%PSMUX_LAUNCHER_ID%\pmux.exe" set "PSMUX_LAUNCHER_EXE=%PSMUX_LAUNCHER_ID%\pmux.exe"

if not defined PSMUX_LAUNCHER_EXE goto no_backend

rem ---- chain guard: the backend must live outside the bridge bin directory ------
if /I "%PSMUX_LAUNCHER_ID%"=="%PSMUX_BRIDGE_BIN%" goto self_backend

rem ---- 3. classify the invocation -----------------------------------------------
rem `%*` is captured with `set` and then tested with `if defined`, NOT compared as
rem `if "%*"==""`, because `psmux.cmd ""` supplies one EMPTY-STRING argument and
rem must not be mistaken for a bare no-argument invocation.
if not defined PSMUX_LAUNCHER_ALL goto classify_noargs
set "PSMUX_LAUNCHER_A1=%~1"
rem the `if defined` guard is load-bearing: `%V:"=%` on an UNDEFINED variable does not
rem yield an empty string, it yields the literal `"=` (measured), which then breaks
rem the following `if` comparison with an unbalanced-quote parse error.
if defined PSMUX_LAUNCHER_A1 set "PSMUX_LAUNCHER_A1=%PSMUX_LAUNCHER_A1:"=%"
if /I "%PSMUX_LAUNCHER_A1%"=="--no-bridge" goto classify_nobridge
goto classify_passthrough

:classify_noargs
set "PSMUX_LAUNCHER_PRE=new -A -s default"
goto classified

:classify_nobridge
set "PSMUX_LAUNCHER_BRIDGE="
set "PSMUX_LAUNCHER_POST=%PSMUX_LAUNCHER_ALL:~12%"
goto classified

:classify_passthrough

:classified

rem ---- 7. pre-flight the -c path of new / new-session ----------------------------
if not defined PSMUX_LAUNCHER_BRIDGE goto exec
set "PSMUX_LAUNCHER_SAWCREATE="
set "PSMUX_LAUNCHER_CPATH="
:scan
if "%1"=="" goto scan_end
set "PSMUX_LAUNCHER_TOK=%~1"
if defined PSMUX_LAUNCHER_TOK set "PSMUX_LAUNCHER_TOK=%PSMUX_LAUNCHER_TOK:"=%"
if "%PSMUX_LAUNCHER_TOK%"=="-c" goto scan_sawc
if /I "%PSMUX_LAUNCHER_TOK%"=="new" set "PSMUX_LAUNCHER_SAWCREATE=1"
if /I "%PSMUX_LAUNCHER_TOK%"=="new-session" set "PSMUX_LAUNCHER_SAWCREATE=1"
shift
goto scan
:scan_sawc
shift
set "PSMUX_LAUNCHER_CPATH=%~1"
set "PSMUX_LAUNCHER_CPATHQ=%PSMUX_LAUNCHER_CPATH%"
if defined PSMUX_LAUNCHER_CPATHQ set "PSMUX_LAUNCHER_CPATHQ=%PSMUX_LAUNCHER_CPATHQ:"=%"
shift
goto scan
:scan_end
if not defined PSMUX_LAUNCHER_SAWCREATE goto exec
if not defined PSMUX_LAUNCHER_CPATHQ goto exec
if exist "%PSMUX_LAUNCHER_CPATHQ%\" goto exec
>&2 echo [psmux-bridge] WARNING: -c "%PSMUX_LAUNCHER_CPATH%" is not an existing directory.
>&2 echo [psmux-bridge]   psmux 3.3.8 does not validate this path, and fails SILENTLY.
>&2 echo [psmux-bridge]   new-session IGNORES it: the pane starts in the launch directory.
>&2 echo [psmux-bridge]   split-window -c FALLS BACK TO HOME instead.
>&2 echo [psmux-bridge]   forwarding the command unchanged anyway.

rem ---- 5. extend PATH for the child process only -------------------------------
if not exist "%PSMUX_BRIDGE_BIN%\tmux.exe" goto exec
set "PSMUX_LAUNCHER_PATHHEAD="
for /f "delims=; tokens=1" %%h in ("%PATH%") do if not defined PSMUX_LAUNCHER_PATHHEAD set "PSMUX_LAUNCHER_PATHHEAD=%%h"
if /I "%PSMUX_LAUNCHER_PATHHEAD%"=="%PSMUX_BRIDGE_BIN%" goto exec
set "PATH=%PSMUX_BRIDGE_BIN%;%PATH%"

rem ---- 4. exec -------------------------------------------------------------------
:exec
"%PSMUX_LAUNCHER_EXE%" %PSMUX_LAUNCHER_PRE% %PSMUX_LAUNCHER_POST%
set "PSMUX_LAUNCHER_RC=%ERRORLEVEL%"
endlocal & exit /b %PSMUX_LAUNCHER_RC%

:no_backend
>&2 echo [psmux-bridge] FATAL: the real psmux binary could not be resolved.
>&2 echo [psmux-bridge]   missing binary          : %PSMUX_LAUNCHER_ID%\psmux.exe
>&2 echo [psmux-bridge]   also tried               : %PSMUX_LAUNCHER_ID%\tmux.exe
>&2 echo [psmux-bridge]   also tried               : %PSMUX_LAUNCHER_ID%\pmux.exe
>&2 echo [psmux-bridge]   registry HKCU\Software\psmux InstallDir (space-safe parse) : %PSMUX_LAUNCHER_IDA%
>&2 echo [psmux-bridge]   registry HKCU\Software\psmux InstallDir (token parse)      : %PSMUX_LAUNCHER_IDB%
>&2 echo [psmux-bridge]   fallback %LOCALAPPDATA%\psmux          : %LOCALAPPDATA%\psmux
>&2 echo [psmux-bridge] refusing to run. Reinstall psmux, or repair the InstallDir value.
endlocal & exit /b 69

:self_backend
>&2 echo [psmux-bridge] FATAL: the resolved psmux backend IS the bridge bin directory.
>&2 echo [psmux-bridge]   bridge bin : %PSMUX_BRIDGE_BIN%
>&2 echo [psmux-bridge]   resolved   : %PSMUX_LAUNCHER_ID%
>&2 echo [psmux-bridge] refusing to exec, because that would make this launcher recurse.
endlocal & exit /b 69
