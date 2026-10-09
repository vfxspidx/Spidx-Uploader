@echo off
setlocal

REM Re-launch elevated if not already admin (see the installer).
net session >nul 2>&1
if not %errorlevel%==0 (
    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b
)

REM ======================================================================
REM  Spidx Uploader - Photoshop panel uninstaller
REM
REM  Same as in an Administrator Command Prompt:
REM    UnifiedPluginInstallerAgent.exe /remove com.spidx.workupload
REM    UnifiedPluginInstallerAgent.exe /remove "Spidx Uploader"
REM  (Adobe documents /remove by plugin NAME, older builds accept the id -
REM  both are tried; the one that doesn't match just says "not found".)
REM ======================================================================

set "UPIA_DIR=%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent"
if not exist "%UPIA_DIR%\UnifiedPluginInstallerAgent.exe" set "UPIA_DIR=%CommonProgramFiles(x86)%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent"

echo.
echo  Spidx Uploader - Photoshop panel - Uninstall
echo  --------------------------------------------
echo.

if not exist "%UPIA_DIR%\UnifiedPluginInstallerAgent.exe" goto :no_upia

echo  Close Photoshop first if it is open.
echo.

cd /d "%UPIA_DIR%"
echo  Removing by id...
UnifiedPluginInstallerAgent.exe /remove com.spidx.workupload
echo.
echo  Removing by name...
UnifiedPluginInstallerAgent.exe /remove "Spidx Uploader"

echo.
echo  ---- Installed extensions mentioning Spidx (the Photoshop panel should be gone) ----
UnifiedPluginInstallerAgent.exe /list all | findstr /i "Spidx extensions"
call :spidx_hold
exit /b 0

:no_upia
echo  Adobe's plugin installer (UPIA) was not found. It comes with the
echo  Creative Cloud desktop app.
call :spidx_hold
exit /b 1

:spidx_hold
echo.
echo Press Enter to close this window.
set /p "SPIDX_WAIT=" <con
exit /b 0
