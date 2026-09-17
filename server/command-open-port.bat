@echo off
setlocal
cd /d "%~dp0"

REM 用法：command-open-port.bat [端口] [--print]
REM 放行 Windows 防火墙入站 TCP 端口，使同一 WiFi 下的手机/平板能访问本机服务。
REM 需要管理员权限，会自动提权（UAC）。
REM 端口默认 1420，应与 resources\config\app.json 里的 server.port 一致。
REM --print 只显示将要执行的命令，不做修改、不提权。

set "PORT=1420"
set "DRY=0"

if "%~1"=="" goto :args_done
if /i "%~1"=="--print" goto :arg_print
set "PORT=%~1"
if /i "%~2"=="--print" set "DRY=1"
goto :args_done

:arg_print
set "DRY=1"

:args_done
set "RULE_NAME=DiceTaleStudio %PORT%"

echo [open-port] 端口: %PORT%
echo [open-port] 规则名: %RULE_NAME%

if "%DRY%"=="1" (
    echo [open-port] --print 模式：仅显示将要执行的命令，未做任何修改。
    echo   netsh advfirewall firewall delete rule name="%RULE_NAME%"
    echo   netsh advfirewall firewall add rule name="%RULE_NAME%" dir=in action=allow protocol=TCP localport=%PORT% profile=any
    exit /b 0
)

REM ---- 非管理员则自动提权（UAC）----
net session >nul 2>&1
if errorlevel 1 (
    echo [open-port] 需要管理员权限，正在请求提权（请在弹出的 UAC 窗口点"是"）...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%PORT%' -Verb RunAs"
    exit /b 0
)

REM ---- 添加规则（幂等：先删再建，避免重复规则）----
netsh advfirewall firewall delete rule name="%RULE_NAME%" >nul 2>&1
netsh advfirewall firewall add rule name="%RULE_NAME%" dir=in action=allow protocol=TCP localport=%PORT% profile=any
if errorlevel 1 (
    echo [open-port] 添加防火墙规则失败。
    pause
    exit /b 1
)

echo.
echo [open-port] 已放行 TCP %PORT%。同一 WiFi 下的手机/平板现在可以访问。
echo [open-port] 地址形如 http://^<本机局域网IP^>:%PORT%/ ，具体 IP 见 command-start.bat 的启动日志。
pause