@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Invoked by Windows for spidx:// links (see the [Registry] section in
rem Installer\SpidxUploader.iss). %1 is the full URI, e.g.
rem "spidx://activate?code=ABCD-EFGH-IJKL". Kept deliberately silent (no
rem "pause", no prompts) since this runs invisibly from a browser click.

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    ) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
        set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    ) else (
        rem No Node anywhere yet — this must be a first run before the app
        rem has ever been started normally. Fall back to the full launcher,
        rem which knows how to install Node itself; it can't pick up the
        rem code from here, so at least get the app running and let the
        rem person paste the code by hand once it's up.
        start "" "%~dp0start-tray.bat"
        exit /b 0
    )
)

"%NODE_EXE%" "%~dp0protocol-handler.js" "%~1"
