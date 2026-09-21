@echo off
setlocal

cd /d "%~dp0"
if errorlevel 1 (
    echo Could not open the Puko OPAC folder.
    echo.
    pause
    exit /b 90
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\RunPukoReadingCollection.ps1" -Execute

set "PUKO_EXIT=%ERRORLEVEL%"

echo.
if "%PUKO_EXIT%"=="0" (
    echo Puko reading collection completed successfully.
) else (
    echo Puko reading collection stopped or failed. Exit code: %PUKO_EXIT%
)
echo.
pause

endlocal & exit /b %PUKO_EXIT%
