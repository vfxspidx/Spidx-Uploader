@echo off
setlocal

REM Re-launch elevated if not already admin. Running UPIA as Administrator is
REM what makes the .ccx install work (a normal-user /install is rejected by
REM Adobe's installer with errors like status = -432).
net session >nul 2>&1
if not %errorlevel%==0 (
    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b
)

REM ======================================================================
REM  Spidx Uploader - Photoshop panel installer
REM
REM  Same as doing this by hand in an Administrator Command Prompt:
REM    cd "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent"
REM    UnifiedPluginInstallerAgent.exe /install "<this folder>\com.spidx.workupload_PS.ccx"
REM
REM  Needs the Creative Cloud desktop app (it provides UPIA). Close Photoshop
REM  first, restart it afterwards.
REM ======================================================================

set "CCX=%~dp0com.spidx.workupload_PS.ccx"
set "UPIA_DIR=%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent"
if not exist "%UPIA_DIR%\UnifiedPluginInstallerAgent.exe" set "UPIA_DIR=%CommonProgramFiles(x86)%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent"

echo.
echo  Spidx Uploader - Photoshop panel - Install
echo  ------------------------------------------
echo.

if not exist "%CCX%" goto :no_ccx
if not exist "%UPIA_DIR%\UnifiedPluginInstallerAgent.exe" goto :no_upia

echo  Panel file : %CCX%
echo  Installer  : %UPIA_DIR%\UnifiedPluginInstallerAgent.exe
echo.
echo  Close Photoshop first if it is open.
echo.

cd /d "%UPIA_DIR%"
UnifiedPluginInstallerAgent.exe /install "%CCX%"

echo.
echo  ---- Installed extensions mentioning Spidx (should list the panel under Photoshop) ----
UnifiedPluginInstallerAgent.exe /list all | findstr /i "Spidx extensions"
echo.
echo  If you see "Failed to install, status = -NNN", note the number.
echo  Otherwise start Photoshop - the panel is under Plugins ^> Spidx Uploader.
call :spidx_hold
exit /b 0

:no_ccx
echo  The panel file was not found:
echo    %CCX%
call :spidx_hold
exit /b 1

:no_upia
echo  Adobe's plugin installer (UPIA) was not found. It comes with the
echo  Creative Cloud desktop app - install and sign in to Creative Cloud, then run this again.
call :spidx_hold
exit /b 1

:spidx_hold
echo.
echo Press Enter to close this window.
set /p "SPIDX_WAIT=" <con
exit /b 0
