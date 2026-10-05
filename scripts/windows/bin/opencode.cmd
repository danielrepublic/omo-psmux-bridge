@echo off
rem ---------------------------------------------------------------------------
rem  psmux bridge - `opencode` port wrapper shim.
rem
rem  Lives in the bridge bin directory, which todo 8 puts FIRST on the user
rem  PATH, so it shadows the npm `opencode.cmd`. All logic lives in the
rem  PowerShell helper beside it; this file only locates a PowerShell host and
rem  forwards argv verbatim via %* (the same mechanism npm's own shims use).
rem
rem  CreateProcess cannot execute a .ps1, so the helper is launched as
rem  `powershell.exe -File <helper>`.
rem ---------------------------------------------------------------------------
setlocal

set "OMO_HELPER=%~dp0omo-opencode-port.ps1"
if not exist "%OMO_HELPER%" (
    echo [opencode-wrapper] helper not found: "%OMO_HELPER%" 1>&2
    exit /b 127
)

set "OMO_PS="
if defined PROCESSOR_ARCHITEW6432 if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "OMO_PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not defined OMO_PS if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "OMO_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined OMO_PS for /f "delims=" %%I in ('where powershell.exe 2^>nul') do if not defined OMO_PS set "OMO_PS=%%I"
if not defined OMO_PS (
    echo [opencode-wrapper] no powershell.exe found 1>&2
    exit /b 127
)

"%OMO_PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%OMO_HELPER%" %*
set "OMO_RC=%ERRORLEVEL%"
endlocal & exit /b %OMO_RC%