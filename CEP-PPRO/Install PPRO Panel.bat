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
REM  Spidx Uploader - Premiere Pro panel installer
REM
REM  1) Enables PlayerDebugMode, which Adobe requires for CEP panels that
REM     aren't signed with a paid Adobe certificate. This is a per-user
REM     registry flag, nothing system-wide.
REM  2) Copies this folder into the per-user CEP extensions directory.
REM
REM  Re-run it any time you update the plugin. Premiere Pro must be
REM  CLOSED while this runs.
REM ======================================================================

set "EXT_ID=com.spidx.uploader.ppro"
set "DEST=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%"
set "SRC=%~dp0"

echo.
echo  Spidx Uploader - Premiere Pro panel
echo  ------------------------------------
echo.

REM Direct pipe check (no temp file) -- avoids stale/locked temp-file
REM false positives that can happen under an elevated process. Also
REM matches both "Adobe Premiere Pro.exe" and newer "Premiere Pro.exe"
REM naming used by some recent Premiere builds.
tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" /NH 2>nul | findstr /I "Premiere Pro.exe" >nul
if not errorlevel 1 (
    echo  Premiere Pro is running. Close it first, then run this again.
    echo.
    call :spidx_hold
    exit /b 1
)

echo  Enabling PlayerDebugMode (required for unsigned panels)...
for %%V in (8 9 10 11 12 13) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

echo  Installing to: %DEST%
if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%" >nul 2>&1

xcopy "%SRC%CSXS" "%DEST%\CSXS\" /e /i /y >nul
xcopy "%SRC%client" "%DEST%\client\" /e /i /y >nul
xcopy "%SRC%host" "%DEST%\host\" /e /i /y >nul
xcopy "%SRC%icons" "%DEST%\icons\" /e /i /y >nul
xcopy "%SRC%presets" "%DEST%\presets\" /e /i /y >nul
if exist "%SRC%mogrts" xcopy "%SRC%mogrts" "%DEST%\mogrts\" /e /i /y >nul

if not exist "%DEST%\CSXS\manifest.xml" (
    echo.
    echo  Install FAILED - manifest.xml did not get copied.
    echo.
    call :spidx_hold
    exit /b 1
)

echo.
echo  Done. Start Premiere Pro and open:
echo      Window ^> Extensions ^> Spidx Uploader
echo.
echo  Before the first upload, read PRESET-SETUP.txt in this folder --
echo  the panel needs a one-time PNG export preset (pngframe.epr) that
echo  only Premiere's own Export Media dialog can create.
echo.
echo  Then click "Change incoming folder" in the panel and pick the
echo  App\incoming folder of your Spidx Uploader install.
echo.
call :spidx_hold

exit /b 0

:spidx_hold
echo.
echo Press Enter to close this window.
set /p "SPIDX_WAIT=" <con
exit /b 0
