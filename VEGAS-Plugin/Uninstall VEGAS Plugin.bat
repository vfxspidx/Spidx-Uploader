@echo off
setlocal

REM Re-launch elevated if not already admin (see the installer).
net session >nul 2>&1
if not %errorlevel%==0 (
    if "%~1"=="" (
        powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    ) else (
        powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs -WorkingDirectory '%~dp0'"
    )
    exit /b
)

REM ======================================================================
REM  Spidx Uploader - VEGAS Pro plugin uninstaller
REM  Removes SpidxUploader.dll from VEGAS's Application Extensions
REM  folder(s). VEGAS must be CLOSED. Pass /silent to skip the final
REM  "press Enter" wait (used by the Windows uninstaller).
REM ======================================================================

cd /d "%~dp0"

echo.
echo  Spidx Uploader - VEGAS Pro plugin - Uninstall
echo  ---------------------------------------------
echo.

set "NODE_EXE="
for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo  Node.js was not found - cannot run the uninstaller.
    echo  Delete SpidxUploader.dll from VEGAS's "Application Extensions" folder by hand.
    echo.
    if /i not "%~1"=="/silent" call :spidx_hold
    exit /b 1
)

"%NODE_EXE%" "%~dp0install-vegas.js" uninstall
set "SPIDX_RC=%errorlevel%"

if /i not "%~1"=="/silent" call :spidx_hold
exit /b %SPIDX_RC%

:spidx_hold
echo.
echo Press Enter to close this window.
set /p "SPIDX_WAIT=" <con
exit /b 0
