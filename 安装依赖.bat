@echo off
cd /d "%~dp0"
setlocal
title DeskGlow 环境安装

echo ============================================
echo   DeskGlow 桌面美化 - 运行环境安装
echo ============================================
echo.

set "ELECTRON_RUN_AS_NODE="

where npm >nul 2>nul
if errorlevel 1 goto nonpm

if exist "node_modules\electron\dist\electron.exe" goto haveexe

echo [1/3] 安装 npm 依赖...
call npm install --ignore-scripts --no-fund --no-audit
if errorlevel 1 goto npmfail

if exist "node_modules\electron\dist\electron.exe" goto done

echo.
echo [2/3] 下载 Electron 运行时（约 110MB，使用国内镜像）...
if not exist "node_modules\electron" md "node_modules\electron"
if exist "electron.zip" del /q "electron.zip"
curl -L --retry 3 -o "electron.zip" "https://npmmirror.com/mirrors/electron/33.2.0/electron-v33.2.0-win32-x64.zip"
if errorlevel 1 goto dlfail

echo.
echo [3/3] 解压...
if not exist "node_modules\electron\dist" md "node_modules\electron\dist"
tar -xf "electron.zip" -C "node_modules\electron\dist"
if errorlevel 1 goto dlfail
del /q "electron.zip"
powershell -NoProfile -Command "[IO.File]::WriteAllText('node_modules\electron\path.txt','electron.exe')"
goto done

:haveexe
echo [1/3] 运行环境已就绪，无需重复安装。
goto done

:done
echo.
echo ============================================
echo   安装完成！
echo   双击「启动 DeskGlow.vbs」即可运行（不会闪窗）
echo ============================================
echo.
pause
exit /b 0

:nonpm
echo [!] 未检测到 Node.js / npm。
echo     请先安装 Node.js（https://nodejs.org 选 LTS 版本），
echo     安装时保持默认选项（会自动加入 PATH），装完重新打开本文件。
echo.
pause
exit /b 1

:npmfail
echo.
echo [!] npm 依赖安装失败，通常是网络问题。
echo     可先执行：npm config set registry https://registry.npmmirror.com
echo.
pause
exit /b 1

:dlfail
echo.
echo [!] Electron 运行时下载或解压失败。
echo     可手动下载后解压到 node_modules\electron\dist 目录：
echo     https://npmmirror.com/mirrors/electron/33.2.0/electron-v33.2.0-win32-x64.zip
echo.
pause
exit /b 1
