@echo off
setlocal
title fivem-local-bridge kurulum
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js bulunamadi. https://nodejs.org adresinden LTS surumunu kurun (20+ gerekli).
  pause
  exit /b 1
)

echo Bagimliliklar kuruluyor...
call npm install
if errorlevel 1 (
  echo [HATA] npm install basarisiz.
  pause
  exit /b 1
)

echo.
echo Kurulum tamam. Baslatmak icin: start.bat
pause
