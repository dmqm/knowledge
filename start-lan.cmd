@echo off
cd /d "%~dp0"
echo 以局域网模式启动（其他设备可通过 http://本机IP:4321 访问）
if "%LC_PASSWORD%"=="" (
  echo 提示^：建议设置密码，例如： set LC_PASSWORD=your-secret ^&^& start-lan.cmd
)
node server.mjs --host 0.0.0.0
