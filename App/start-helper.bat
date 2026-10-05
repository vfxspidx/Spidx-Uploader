@echo off
setlocal EnableDelayedExpansion
title SPIDX WorkUpload Helper

cd /d "%~dp0"

echo.
echo ========================================
echo       SPIDX UPLOADER HELPER
echo ========================================
echo.

set "NODE_EXE=node"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found in PATH, checking common install locations...

    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    ) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
        set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    ) else (
        call :install_node_from_bundled_installer
        if errorlevel 1 (
            echo.
            echo ERROR: Node.js was not found, and no bundled installer could
            echo set it up automatically.
            echo.
            echo Either install Node.js manually from https://nodejs.org
            echo ^(LTS version^) and run start-helper.bat again, or drop the
            echo official Node.js Windows Installer next to this file, named:
            echo     node-installer.msi
            echo and run start-helper.bat again to auto-install it.
            echo.
            pause
            exit /b 1
        )
    )

    echo Found: !NODE_EXE!
) else (
    rem Found via PATH — NODE_EXE is still the bare word "node" at this
    rem point, which breaks the NODE_DIR lookup below (it would resolve
    rem against the current directory instead of Node's actual install
    rem folder). Resolve it to a real, full path here — using a guard
    rem variable instead of goto, since goto out of a for loop nested
    rem inside this else-block confuses cmd's parenthesis parsing and
    rem crashes the script on launch.
    for /f "delims=" %%P in ('where node') do (
        if not defined NODE_EXE_RESOLVED (
            set "NODE_EXE=%%P"
            set "NODE_EXE_RESOLVED=1"
        )
    )
)

echo Node.js found.
echo.

rem npm usually lives in the same folder as node.exe.
set "NODE_DIR=%~dp0"
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "NPM_CMD=npm"
if exist "%NODE_DIR%npm.cmd" set "NPM_CMD=%NODE_DIR%npm.cmd"

if not exist "node_modules\playwright" (
    echo Installing Playwright...
    call "%NPM_CMD%" install playwright
    if errorlevel 1 (
        echo.
        echo Failed to install Playwright.
        pause
        exit /b 1
    )
)

if not exist "node_modules\sharp" (
    echo Installing sharp ^(image compression^)...
    call "%NPM_CMD%" install sharp
    if errorlevel 1 (
        echo.
        echo Failed to install sharp. Compression will be skipped, uploads still work.
    )
)

if not exist "node_modules\playwright-core\.local-browsers" (
    echo Installing Playwright's Firefox engine ^(needed for Firefox automation^)...
    echo ^(one-time download, only relevant if your default browser is Firefox^)
    call "%NPM_CMD%" exec playwright install firefox
)

echo.
echo Starting helper...
echo.

"%NODE_EXE%" server.js

echo.
echo ========================================
echo Helper has stopped.
echo ========================================
pause
goto :eof

rem ------------------------------------------------------------------------
rem  Auto-installs Node.js from a bundled installer sitting next to this
rem  .bat file, if one is present. Drop the official Node.js Windows
rem  Installer (from https://nodejs.org, the .msi download) here and rename
rem  it to "node-installer.msi" — this lets anyone you hand the project to
rem  skip the manual "go install Node.js yourself" step entirely.
rem  Returns errorlevel 0 and sets NODE_EXE on success, errorlevel 1 if no
rem  installer was found or the install didn't take.
rem ------------------------------------------------------------------------
:install_node_from_bundled_installer
set "NODE_INSTALLER=%~dp0node-installer.msi"

if not exist "%NODE_INSTALLER%" (
    exit /b 1
)

echo.
echo Found bundled installer: %NODE_INSTALLER%
echo Installing Node.js silently — Windows may show a one-time permission prompt...
echo.

start "" /wait msiexec /i "%NODE_INSTALLER%" /quiet /norestart /l*v "%TEMP%\spidx_node_install.log"

if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    echo Node.js installed successfully.
    exit /b 0
)

if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
    echo Node.js installed successfully.
    exit /b 0
)

echo.
echo The installer ran but node.exe still couldn't be found afterwards.
echo Check the install log for details: %TEMP%\spidx_node_install.log
exit /b 1
