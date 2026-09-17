@echo off
setlocal
cd /d "%~dp0"

REM 用法：command-start.bat [--open]
REM 启动服务端（单端口 1420）：同源托管编辑器网页 + 资源接口 + 运行态 WebSocket。
REM   /client  前端（Unity 客户端）连接
REM   /editor  编辑器连接
REM 默认不打开浏览器（需要时传 --open）。
REM 默认监听 0.0.0.0：同一 WiFi 下的手机/平板可用本机局域网 IP 访问，
REM 可用地址会打印在下方启动日志里；连不上时先运行 command-open-port.bat 放行防火墙。
REM 端口与监听地址可用环境变量覆盖（需与本文件前面的 set 二选一），例如：
REM     set PORT=1421
REM     set HOST=127.0.0.1

if not defined PORT set "PORT=1420"
if not defined HOST set "HOST=0.0.0.0"
set "OPEN_BROWSER=0"
if /i "%~1"=="--open" set "OPEN_BROWSER=1"

where node >nul 2>&1
if errorlevel 1 (
    echo [start] 未找到 node，请先安装 Node.js 22 或更高版本。
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [start] 未安装依赖，请先运行 command-install.bat。
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

REM ---- 端口占用预检：避免直接抛 EADDRINUSE 让人摸不着头脑 ----
set "PORT_OWNER="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /c:"LISTENING"') do set "PORT_OWNER=%%p"
if defined PORT_OWNER (
    echo [start] 端口 %PORT% 已被占用（PID %PORT_OWNER%），可能已有一个服务端在运行。
    echo [start] 关掉原来那个窗口即可；或先结束占用进程：
    echo          taskkill /PID %PORT_OWNER% /F
    echo [start] 也可换端口启动：
    echo          set PORT=1421
    echo          command-start.bat
    pause
    exit /b 1
)

echo [start] 本机:   http://localhost:%PORT%/
echo [start] 局域网: 同一 WiFi 下的手机/平板用本机 IP 访问（见下方启动日志列出的地址）
echo [start] 接口:   http://localhost:%PORT%/api/health
echo [start] 提示:   手机/平板连不上时，先运行 command-open-port.bat 放行防火墙 %PORT% 端口
echo [start] 提示:   想连 Mock 前端，另开窗口执行 pnpm --filter @dts/backend mock
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