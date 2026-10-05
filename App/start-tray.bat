@echo off
setlocal EnableDelayedExpansion
title SPIDX WorkUpload Tray

cd /d "%~dp0"

echo.
echo ========================================
echo    SPIDX UPLOADER - TRAY LAUNCHER
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
            echo ^(LTS version^) and run this file again, or drop the official
            echo Node.js Windows Installer next to this file, named:
            echo     node-installer.msi
            echo and run this file again to auto-install it.
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

set "SYSTRAY_OK=0"
if exist "node_modules\node-systray-v2" (
    "%NODE_EXE%" -e "try{const S=require('node-systray-v2');const C=S.default||S;process.exit(typeof C==='function'?0:1);}catch(e){process.exit(1);}" >nul 2>nul
    if not errorlevel 1 set "SYSTRAY_OK=1"
)

if not "%SYSTRAY_OK%"=="1" (
    echo Installing tray icon support...
    if exist "node_modules\node-systray-v2" (
        echo ^(found a broken previous install, reinstalling it^)
        rd /s /q "node_modules\node-systray-v2"
    )
    call "%NPM_CMD%" install node-systray-v2@npm:systray2@^2.1.4
    if errorlevel 1 (
        echo.
        echo Failed to install node-systray-v2 — the tray icon needs this.
        echo Check your internet connection and try again.
        pause
        exit /b 1
    )
)

if not exist "node_modules\playwright-core\.local-browsers" (
    echo Installing Playwright's Firefox engine ^(needed for Firefox automation^)...
    echo ^(one-time download, only relevant if your default browser is Firefox^)
    call "%NPM_CMD%" exec playwright install firefox
)

echo.
echo Setup complete. Starting the tray app now...
echo A Spidx icon will appear in the system tray ^(near the clock^).
echo.
echo From now on, don't run this .bat file directly — closing this window
echo will stop the app. Instead, use "Spidx Uploader.vbs" in the main
echo folder ^(or the Desktop shortcut, if you ran "Install Desktop
echo Shortcut.vbs"^) to start everything silently in the background.
echo.

"%NODE_EXE%" tray.js

echo.
echo ========================================
echo Tray app has stopped.
echo ========================================
pause
goto :eof

rem ------------------------------------------------------------------------
rem  Auto-installs Node.js from a bundled installer sitting next to this
rem  .bat file, if one is present. Drop the official Node.js Windows
rem  Installer (from https://nodejs.org, the .msi download) here and rename
rem  it to "node-installer.msi".
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
