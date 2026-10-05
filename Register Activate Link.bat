@echo off
rem Registers the spidx:// link (Discord "Activate" button) for this copy of
rem Spidx Uploader. Current user only, no admin rights needed. Run once.
reg add "HKCU\Software\Classes\spidx" /ve /t REG_SZ /d "URL:Spidx Uploader Protocol" /f >nul
reg add "HKCU\Software\Classes\spidx" /v "URL Protocol" /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Classes\spidx\DefaultIcon" /ve /t REG_SZ /d "%~dp0App\tray-icon.ico" /f >nul
reg add "HKCU\Software\Classes\spidx\shell\open\command" /ve /t REG_SZ /d "\"%~dp0App\protocol-handler.bat\" \"%%1\"" /f >nul
if errorlevel 1 (
    echo Registration failed.
) else (
    echo Done. The Discord "Activate" button will now open Spidx Uploader.
)
pause
