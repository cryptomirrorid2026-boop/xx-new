@echo off
title Discord to Telegram Mirror Bot
color 0B
echo.
echo  ==========================================
echo    DISCORD TO TELEGRAM MIRROR BOT
echo    Real-time Message Forwarding
echo  ==========================================
echo.

:: Cek apakah Node.js terinstall
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    if exist "C:\nvm4w\nodejs\node.exe" set "PATH=%PATH%;C:\nvm4w\nodejs"
    if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
    where node >nul 2>nul
)
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Node.js tidak ditemukan!
    echo  Download di: https://nodejs.org
    pause
    exit /b 1
)

:: Cek apakah .env sudah dikonfigurasi
if not exist ".env" (
    echo  [ERROR] File .env tidak ditemukan!
    echo  Salin .env.example menjadi .env dan isi token Anda
    pause
    exit /b 1
)

:: Install dependencies jika node_modules belum ada
if not exist "node_modules" (
    echo  [INFO] Menginstall dependencies...
    npm install
    if %ERRORLEVEL% neq 0 (
        echo  [ERROR] Gagal menginstall dependencies!
        pause
        exit /b 1
    )
    echo.
)

echo  [INFO] Memulai bot...
echo  [INFO] Tekan Ctrl+C untuk menghentikan
echo.

:restart
node --max-old-space-size=1024 --expose-gc index.js

echo.
echo  [WARN] Bot terhenti. Mengulang kembali dalam 3 detik...
timeout /t 3 /nobreak >nul
goto restart

echo.
echo  Bot dihentikan.
pause
