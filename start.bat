@echo off
setlocal
title Javrex Bot System
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js bulunamadi. https://nodejs.org adresinden LTS surumunu kurun (22.5+ gerekli).
  pause
  exit /b 1
)

if not exist ".env" (
  echo [HATA] .env dosyasi bulunamadi.
  echo .env.example dosyasini .env olarak kopyalayip token bilgilerini doldurun.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Bagimliliklar kuruluyor, lutfen bekleyin...
  call npm install
  if errorlevel 1 (
    echo [HATA] npm install basarisiz oldu. Internet baglantinizi kontrol edip tekrar deneyin.
    pause
    exit /b 1
  )
)

echo Javrex Bot System baslatiliyor...
echo Durdurmak icin CTRL+C basin.
echo.
node index.js

echo.
echo Bot durdu. Cikis kodu: %errorlevel%
pause
