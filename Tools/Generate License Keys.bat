@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE="
for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :no_node
"%NODE_EXE%" "%~dp0generate-license-keys.js"
call :hold
exit /b 0
:no_node
echo  Node.js was not found - install it from https://nodejs.org and run this again.
call :hold
exit /b 1
:hold
echo.
echo Press Enter to close this window.
set /p "SPIDX_WAIT=" <con
exit /b 0
