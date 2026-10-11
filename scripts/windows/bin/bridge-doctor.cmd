@echo off
rem ---------------------------------------------------------------------------
rem bridge-doctor -- read-only preflight for the opencode-psmux bridge.
rem
rem This launcher exists so the doctor is invocable by bare name from the bridge
rem bin directory (Windows does not put .ps1 in PATHEXT, so the .ps1 alone is not
rem runnable by name). It resolves itself from %~dp0, adds no PATH entry, and
rem propagates the doctor's exit code unchanged -- one code per failing check:
rem
rem     0  all checks pass          10 PATH
rem     1  doctor INTERNAL-ERROR    20 STALE-SERVER (heuristic)
rem                                30 PORT
rem                                40 CONFIG
rem                                50 VERSION
rem
rem Codes are assigned in report order, so when several checks fail the code
rem returned is the FIRST fault and every failure is still printed on screen.
rem
rem All arguments are forwarded verbatim, e.g.
rem     bridge-doctor -Session m -Namespace p14probe
rem     bridge-doctor -ConfigPath <a scratch omo.jsonc copy>
rem     bridge-doctor -Namespace omo_t13
rem
rem Nothing here writes, kills, fixes or starts anything, and no PATH entry is
rem added: the doctor is read-only by construction.
rem ---------------------------------------------------------------------------
setlocal

rem Windows PowerShell 5.1 resolves its OWN module cmdlets -- Get-FileHash among
rem them -- through PSModulePath. PowerShell 7 rebuilds that variable for its
rem runtime and drops 5.1's own module directory, so a 5.1 started from a pwsh 7
rem shell inherits a PSModulePath in which those cmdlets do not exist. Measured
rem on a pwsh 7.6.6 host: check 1 printed HASH-FAILED instead of the shim sha256.
rem Put the directory back first; where it is already present this changes
rem nothing, because PSModulePath is searched in order.
set "OMO_PSMOD=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
if defined PSModulePath (set "PSModulePath=%OMO_PSMOD%;%PSModulePath%") else (set "PSModulePath=%OMO_PSMOD%")

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bridge-doctor.ps1" %*
set "BRIDGE_DOCTOR_EXIT=%ERRORLEVEL%"
endlocal & exit /b %BRIDGE_DOCTOR_EXIT%