@echo off
setlocal
cd /d "%~dp0"

REM 用法：command-install.bat
REM 安装 workspace 依赖（pnpm workspace：apps/* + packages/* 共 8 个包）。
REM 需要 Node 22+ 与 pnpm；受限网络下可先设置代理再运行，例如：
REM     set HTTP_PROXY=http://127.0.0.1:10808
REM     set HTTPS_PROXY=http://127.0.0.1:10808

where node >nul 2>&1
if errorlevel 1 (
    echo [install] 未找到 node，请先安装 Node.js 22 或更高版本：https://nodejs.org/
    pause
    exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
    echo [install] 未找到 pnpm。可用 corepack enable 启用，或 npm i -g pnpm 安装。
    pause
    exit /b 1
)

echo [install] 环境检查：
node --version
call pnpm --version

echo.
echo [install] 正在安装依赖...
call pnpm install
if errorlevel 1 (
    echo.
    echo [install] 安装失败。若在受限网络下，请先设置代理后重试：
    echo           set HTTP_PROXY=http://127.0.0.1:10808
    echo           set HTTPS_PROXY=http://127.0.0.1:10808
    pause
    exit /b 1
)

echo.
echo [install] 依赖安装完成。下一步：command-build.bat 构建编辑器，或 command-start.bat 直接启动。
pause