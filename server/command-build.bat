@echo off
setlocal
cd /d "%~dp0"

REM 用法：command-build.bat
REM 类型检查 + 构建编辑器产物到 apps\editor\dist。
REM 产物由后端同源托管，command-start.bat 启动后访问 http://localhost:1420/ 即为编辑器。

if not exist "node_modules" (
    echo [build] 未安装依赖，请先运行 command-install.bat。
    pause
    exit /b 1
)

echo [build] 类型检查（全部包）...
call pnpm -r typecheck
if errorlevel 1 (
    echo.
    echo [build] 类型检查失败，已中止构建。
    pause
    exit /b 1
)

echo.
echo [build] 构建编辑器...
call pnpm build
if errorlevel 1 (
    echo.
    echo [build] 构建失败。
    pause
    exit /b 1
)

echo.
echo [build] 构建完成。产物目录：apps\editor\dist
echo [build] 下一步：command-start.bat 启动服务端与编辑器；跑测试用 pnpm test。
pause