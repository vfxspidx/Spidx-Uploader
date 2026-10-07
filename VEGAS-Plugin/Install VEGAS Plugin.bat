@echo off
setlocal

REM Re-launch elevated if not already admin -- VEGAS's "Application
REM Extensions" folders live under Program Files / ProgramData, which a
REM normal process usually can't write to.
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
REM  Spidx Uploader - VEGAS Pro plugin installer
REM
REM  Builds SpidxUploader.dll from SpidxUploaderExtension.cs against YOUR
REM  VEGAS install (csc.exe ships with Windows), copies it into VEGAS's
REM  "Application Extensions" folder and sets the panel's incoming folder.
REM  Re-run it any time you update the plugin. VEGAS must be CLOSED.
REM ======================================================================

cd /d "%~dp0"

echo.
echo  Spidx Uploader - VEGAS Pro plugin
echo  ---------------------------------
echo.

set "NODE_EXE="
for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo  Node.js was not found - it is the same Node.js Spidx Uploader runs on.
    echo  Install it from https://nodejs.org and run this again.
    echo.
    call :spidx_hold
    exit /b 1
)

"%NODE_EXE%" "%~dp0install-vegas.js" install
set "SPIDX_RC=%errorlevel%"

call :spidx_hold
exit /b %SPIDX_RC%

:spidx_hold
echo.
echo Press Enter to close this window.
set /p "SPIDX_WAIT=" <con
exit /b 0
