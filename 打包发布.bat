@echo off
cd /d "%~dp0"
setlocal
chcp 65001 >nul
title DeskGlow pack

set "ELECTRON_RUN_AS_NODE=1"
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Electron runtime missing. Run the dependency installer first.
  pause
  exit /b 1
)

"%ELECTRON%" "%~dp0tools\pack.js"
set CODE=%ERRORLEVEL%
echo.
if "%CODE%"=="0" (
  echo Pack finished. Installer is in the release folder.
) else (
  echo Pack failed. Exit code %CODE%.
)
pause
exit /b %CODE%
