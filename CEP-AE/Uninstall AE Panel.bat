@echo off
setlocal

REM Re-launch elevated if not already admin -- the per-user CEP
REM extensions folder sometimes ends up with ACLs that only an
REM elevated process can write/delete (e.g. if it was ever touched
REM by an elevated installer before). Elevating unconditionally
REM avoids install/uninstall behaving differently depending on
REM how Windows happens to have set that folder up.
net session >nul 2>&1
if not %errorlevel%==0 (
    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b
)

REM ======================================================================
REM  Spidx Uploader - After Effects panel uninstaller
REM
REM  Removes the panel from the per-user CEP extensions directory.
REM  Does NOT revert the PlayerDebugMode registry flag, since other
REM  unsigned panels (Premiere Pro panel, etc.) may still rely on it.
REM  After Effects must be CLOSED while this runs.
REM ======================================================================

set "EXT_ID=com.spidx.uploader.ae"
set "DEST=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%"

echo.
echo  Spidx Uploader - After Effects panel - Uninstall
echo  -------------------------------------------------
echo.

REM Direct pipe check (no temp file) -- avoids stale/locked temp-file
REM false positives that can happen under an elevated process.
tasklist /FI "IMAGENAME eq AfterFX.exe" /NH 2>nul | findstr /I "AfterFX.exe" >nul
if not errorlevel 1 (
    echo  After Effects is running. Close it first, then run this again.
    echo.
    call :spidx_hold
    exit /b 1
)

if not exist "%DEST%" (
    echo  Nothing installed at: %DEST%
    echo.
    call :spidx_hold
    exit /b 0
)

echo  Removing: %DEST%
rmdir /s /q "%DEST%"

if exist "%DEST%" (
    echo.
    echo  Uninstall FAILED - the folder could not be removed.
    echo.
    call :spidx_hold
    exit /b 1
)

echo.
echo  Done. The panel is removed from After Effects.
echo.
call :spidx_hold

exit /b 0

:spidx_hold
echo.
echo Press Enter to close this window.
set /p "SPIDX_WAIT=" <con
exit /b 0
