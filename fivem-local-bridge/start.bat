@echo off
setlocal
title fivem-local-bridge
cd /d "%~dp0"

if not exist "node_modules" (
  echo [HATA] node_modules yok. Once install.bat calistirin.
  pause
  exit /b 1
)

echo fivem-local-bridge baslatiliyor (http://127.0.0.1:37911) ...
echo Durdurmak icin CTRL+C basin.
echo.
node src/index.js

echo.
echo Bridge durdu. Cikis kodu: %errorlevel%
pause
