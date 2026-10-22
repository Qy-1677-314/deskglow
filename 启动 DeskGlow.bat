@echo off
cd /d "%~dp0"
setlocal
title DeskGlow 桌面美化

rem 清掉可能被外部继承的 Node 模式标记，避免 Electron 被当成普通 Node 执行后秒退
set "ELECTRON_RUN_AS_NODE="
set "EXE=node_modules\electron\dist\electron.exe"

if exist "%EXE%" goto run

echo [DeskGlow] 还没有安装运行环境。
echo 请先双击运行「安装依赖.bat」，看到「安装完成」后再启动本程序。
echo.
pause
exit /b 1

:run
rem 交给启动器：它负责选正常模式/兼容模式，并把 Electron 独立出去后立即返回
set "ELECTRON_RUN_AS_NODE=1"
"%EXE%" launch.js
if errorlevel 1 goto fail
exit /b 0

:fail
echo.
echo [DeskGlow] 启动失败，详细信息见 logs\launch.log
echo.
pause
exit /b 1
