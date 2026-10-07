@echo off
setlocal enabledelayedexpansion

rem ============================================================================
rem  Builds SpidxUploaderExtension.cs into SpidxUploader.dll using csc.exe
rem  (ships with every Windows .NET Framework install — no Visual Studio
rem  needed). Run this once after any change to the .cs file, then copy the
rem  resulting .dll into VEGAS's Application Extensions folder (see below).
rem ============================================================================

rem --- Always work from THIS script's own folder, not whatever the current
rem     directory happens to be — "Run as administrator" (and some shortcut
rem     setups) can launch a .bat with the working directory set to
rem     C:\Windows\System32 instead, which makes every relative path below
rem     resolve to the wrong place. %~dp0 is this .bat file's own folder,
rem     always, regardless of how it was launched.
cd /d "%~dp0"

if not exist "SpidxUploaderExtension.cs" (
    echo Could not find SpidxUploaderExtension.cs in this folder:
    echo   %~dp0
    echo.
    echo Make sure SpidxUploaderExtension.cs and build.bat are saved in the
    echo SAME folder, then run build.bat again.
    pause
    exit /b 1
)

rem --- Locate csc.exe (the C# compiler that ships with .NET Framework) ---
set CSC=
for %%V in (v4.0.30319) do (
    if exist "%WINDIR%\Microsoft.NET\Framework64\%%V\csc.exe" set "CSC=%WINDIR%\Microsoft.NET\Framework64\%%V\csc.exe"
    if not defined CSC if exist "%WINDIR%\Microsoft.NET\Framework\%%V\csc.exe" set "CSC=%WINDIR%\Microsoft.NET\Framework\%%V\csc.exe"
)
if not defined CSC (
    echo Could not find csc.exe under %WINDIR%\Microsoft.NET\Framework64 or \Framework.
    echo This ships with .NET Framework 4.x, which Windows normally has by default.
    echo If it's genuinely missing, install the ".NET Framework 4.8 Developer Pack" from Microsoft.
    pause
    exit /b 1
)
echo Using compiler: %CSC%

rem --- Locate ScriptPortal.Vegas.dll (needed to reference the VEGAS API) ---
rem EDIT THIS if your VEGAS install lives somewhere non-default.
set VEGAS_DLL=
for %%D in (
    "C:\Program Files\VEGAS\VEGAS Pro 23.0"
    "C:\Program Files\VEGAS\VEGAS Pro 22.0"
    "C:\Program Files\VEGAS\VEGAS Pro 21.0"
    "C:\Program Files\VEGAS\VEGAS Pro 20.0"
    "C:\Program Files\VEGAS\VEGAS Pro 19.0"
) do (
    if exist "%%~D\ScriptPortal.Vegas.dll" set "VEGAS_DLL=%%~D\ScriptPortal.Vegas.dll"
)
if not defined VEGAS_DLL (
    echo Could not auto-find ScriptPortal.Vegas.dll in the usual VEGAS install paths.
    echo Open this .bat file in a text editor and add your actual VEGAS install
    echo folder to the list above ^(or set VEGAS_DLL directly^), then run it again.
    echo.
    echo Older VEGAS versions ^(13 and below^) use Sony.Vegas.dll instead —
    echo if that's you, also swap the "using ScriptPortal.Vegas;" line in
    echo SpidxUploaderExtension.cs to "using Sony.Vegas;" and point VEGAS_DLL
    echo at Sony.Vegas.dll instead.
    pause
    exit /b 1
)
echo Using VEGAS reference: %VEGAS_DLL%

rem --- Compile ---
"%CSC%" /target:library /out:SpidxUploader.dll ^
    /reference:"%VEGAS_DLL%" ^
    /reference:System.dll ^
    /reference:System.Windows.Forms.dll ^
    /reference:System.Drawing.dll ^
    /reference:System.Web.Extensions.dll ^
    /reference:System.Core.dll ^
    SpidxUploaderExtension.cs

if errorlevel 1 (
    echo.
    echo Build FAILED — see the error above. If it names a missing member
    echo on the Vegas/CustomCommand/DockableControl types, that's a real
    echo API mismatch for your VEGAS version — paste the exact error back.
    pause
    exit /b 1
)

echo.
echo Build succeeded: SpidxUploader.dll
echo.
echo Next: copy SpidxUploader.dll into one of VEGAS's "Application Extensions"
echo folders, e.g.:
echo   %%ProgramData%%\Vegas Pro\^<version^>.0\Application Extensions\
echo then restart VEGAS. The panel appears under View ^> Extensions ^> Spidx Uploader.
pause
