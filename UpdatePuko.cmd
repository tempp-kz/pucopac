@echo off
setlocal

cd /d "%~dp0"
if errorlevel 1 (
    echo Could not open the Puko OPAC folder.
    echo.
    pause
    exit /b 90
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\UpdatePuko.ps1" -DailyUpdate

set "PUKO_EXIT=%ERRORLEVEL%"

echo.
if "%PUKO_EXIT%"=="0" (
    echo Puko OPAC update completed successfully.
) else (
    echo Puko OPAC update stopped or failed. Exit code: %PUKO_EXIT%
)
echo.
pause

endlocal & exit /b %PUKO_EXIT%