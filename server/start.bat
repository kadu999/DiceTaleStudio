@echo off
setlocal
cd /d "%~dp0"

REM 用法：start.bat [--no-browser]
REM 启动服务端（单端口 1420）：同源托管编辑器网页 + 资源接口 + 运行态 WebSocket。
REM   /client  前端（Unity 客户端）连接
REM   /editor  编辑器连接
REM 未构建前端时会自动先构建一次。
REM 传 --no-browser 时不自动打开浏览器（服务器 / 远程环境用）。

set "PORT=1420"
set "OPEN_BROWSER=1"
if /i "%~1"=="--no-browser" set "OPEN_BROWSER=0"

where node >nul 2>&1
if errorlevel 1 (
    echo [start] 未找到 node，请先安装 Node.js 22 或更高版本。
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [start] 未安装依赖，请先运行 install.bat。
    pause
    exit /b 1
)

if not exist "apps\editor\dist\index.html" (
    echo [start] 未找到编辑器构建产物，正在构建...
    call pnpm build
    if errorlevel 1 (
        echo [start] 构建失败，已中止。
        pause
        exit /b 1
    )
)

echo [start] 编辑器: http://localhost:%PORT%/
echo [start] 接口:   http://localhost:%PORT%/api/health
echo [start] 提示: 想连 Mock 前端，另开窗口执行 pnpm --filter @dts/backend mock
echo [start] 按 Ctrl+C 停止。
echo.

if "%OPEN_BROWSER%"=="1" (
    REM 交给后台 cmd 延迟 2 秒再打开浏览器，避免抢在服务端就绪之前
    start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%/"
)

call pnpm --filter @dts/backend start

echo.
echo [start] 服务端已停止。
pause