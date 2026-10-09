@echo off
setlocal
REM ======================================================================
REM  Spidx Uploader - Premiere Pro panel: refresh the MOGRT list
REM
REM  Drop new .mogrt files into the "mogrts" folder next to this file, run
REM  this, then reinstall the panel (Install PPRO Panel.bat or the Dashboard).
REM  It pulls each template's preview picture out of the .mogrt and updates
REM  mogrts\mogrts.json (see update-mogrts.js).
REM ======================================================================
cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

echo.
echo  Spidx Uploader - refreshing the MOGRT list
echo  ------------------------------------------
echo.
if not defined NODE_EXE goto :no_node

"%NODE_EXE%" "%~dp0update-mogrts.js"
call :spidx_hold
exit /b 0

:no_node
echo  Node.js was not found - install it from https://nodejs.org and run this again.
call :spidx_hold
exit /b 1

:spidx_hold
echo.
echo Press Enter to close this window.
set /p "SPIDX_WAIT=" <con
exit /b 0
