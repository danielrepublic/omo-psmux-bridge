@echo off
rem ============================================================================
rem  install.cmd -- the opencode-psmux-bridge one-step installer entry point.
rem
rem  This file exists for ONE reason: to be double-clickable.
rem
rem  WHY IT EXISTS INSTEAD OF POINTING PEOPLE AT install.ps1
rem  -------------------------------------------------------
rem  Every file unpacked from a downloaded zip carries a Zone.Identifier
rem  (Mark-of-the-Web). PowerShell's default execution policy on Windows is
rem  RemoteSigned, which REFUSES to run a script that has one. So the obvious
rem  instruction -- "run install.ps1" -- fails on a fresh download with an error
rem  about remote scripts, which reads like the download was corrupt rather than
rem  like a policy the user never configured.
rem
rem  A .cmd file is not subject to the execution policy, so this wrapper runs
rem  freely and passes `-ExecutionPolicy Bypass` to the PowerShell it starts,
rem  which does run install.ps1. `-NoProfile` keeps a user profile from changing
rem  the meaning of anything the installer does.
rem
rem  WHAT IT DOES, IN ORDER
rem    1. locate a PowerShell host (Sysnative first, so a 32-bit cmd.exe on a
rem       64-bit machine still finds a 64-bit PowerShell)
rem    2. refuse, loudly, if install.ps1 is not beside it -- a zip extracted one
rem       level short looks exactly like a successful unpack otherwise
rem    3. clear Mark-of-the-Web across the extracted tree, so the .ps1 files the
rem       user runs LATER (bridge-doctor, uninstall) are not blocked either
rem    4. run install.ps1, forwarding every argument untouched
rem    5. propagate its exit code EXACTLY
rem
rem  EXIT CODES -- install.ps1's, unmodified. This file invents none:
rem    0  installed, or already correct
rem    1  unexpected error
rem    2  refused; nothing was written
rem   69  the psmux backend could not be resolved (EX_UNAVAILABLE)
rem   70  an error inside the shim itself (EX_SOFTWARE)
rem   78  the bridge resolved to itself (EX_CONFIG)
rem  127 this wrapper could not find a PowerShell host or install.ps1
rem
rem  The extra exit code this file introduces is 127 and it is deliberately
rem  distinct from every code install.ps1 can return, so a caller can always tell
rem  "the installer never started" from "the installer refused".
rem
rem  The working directory is NEVER changed. The first pane's directory is the
rem  invoking client's directory and that invariant has to survive here, exactly
rem  as it survives psmux.cmd.
rem ============================================================================

setlocal EnableExtensions DisableDelayedExpansion

rem ---- where this file lives -------------------------------------------------
set "BRIDGE_BIN=%~dp0"
if "%BRIDGE_BIN:~-1%"=="\" set "BRIDGE_BIN=%BRIDGE_BIN:~0,-1%"

rem ---- 1. locate a PowerShell host -------------------------------------------
set "OMO_PS="
if defined PROCESSOR_ARCHITEW6432 if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "OMO_PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not defined OMO_PS if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "OMO_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined OMO_PS for /f "delims=" %%I in ('where powershell.exe 2^>nul') do if not defined OMO_PS set "OMO_PS=%%I"
if not defined OMO_PS (
    >&2 echo [install] FATAL: no powershell.exe could be found on this machine.
    >&2 echo [install]   The bridge installer is a PowerShell script; without a
    >&2 echo [install]   PowerShell host there is nothing to run it with.
    endlocal & exit /b 127
)

rem ---- 2. the installer must actually be there ------------------------------
set "OMO_INSTALL_PS1=%BRIDGE_BIN%\install.ps1"
if not exist "%OMO_INSTALL_PS1%" (
    >&2 echo [install] FATAL: install.ps1 is not beside this file.
    >&2 echo [install]   expected: "%OMO_INSTALL_PS1%"
    >&2 echo [install]   The zip was most likely extracted one directory too
    >&2 echo [install]   deep, so that bin\ and runtime\ are siblings of where
    >&2 echo [install]   you are now. Unzip it again so the tree looks like:
    >&2 echo [install]     opencode-psmux-bridge\bin\install.cmd
    endlocal & exit /b 127
)

rem ---- 3. clear Mark-of-the-Web across the extracted tree --------------------
rem Best effort, and deliberately so: -ErrorAction SilentlyContinue plus a host
rem that may not even have the cmdlet. This step is a convenience for the files
rem the user runs AFTER the install; step 4's -ExecutionPolicy Bypass is what
rem actually guarantees this install runs at all.
"%OMO_PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%BRIDGE_BIN%' -Recurse -ErrorAction SilentlyContinue"

rem ---- 4. run the installer, forwarding argv untouched -----------------------
"%OMO_PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%OMO_INSTALL_PS1%" %*
set "OMO_RC=%ERRORLEVEL%"

rem ---- 5. say something when it did not succeed ------------------------------
rem Silence on failure is the failure mode this whole project exists to remove,
rem so a non-zero code gets a line naming itself. The detail is on the lines
rem above; this only guarantees the exit did not pass unnoticed.
if not "%OMO_RC%"=="0" (
    >&2 echo [install] install.ps1 returned exit code %OMO_RC%. Stopping here.
    >&2 echo [install] Nothing after this point was attempted. Re-run after
    >&2 echo [install] reading the lines above; nothing was half-written.
)

endlocal & exit /b %OMO_RC%
