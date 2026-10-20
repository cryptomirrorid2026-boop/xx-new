@echo off
title Hentikan Bot 24/7 Windows VPS
color 0C

echo.
echo ============================================================
echo   MENGHENTIKAN SYSTEM AUTOSTART BOT MIRROR 24/7
echo ============================================================
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Harap jalankan file ini sebagai ADMINISTRATOR!
    echo Klik kanan file stop-247-windows.bat -> pilih "Run as administrator"
    pause
    exit /b 1
)

echo [1/3] Menghentikan proses bot di PM2 (jika ada)...
call npx pm2 delete discord-to-telegram-mirror >nul 2>&1
call npx pm2 save --force >nul 2>&1

echo [2/3] Menghentikan proses bot di Task Scheduler & background...
schtasks /end /tn "DiscordTelegramMirror247" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Discord to Telegram Mirror Bot*" >nul 2>&1

echo [3/3] Menghapus pendaftaran otomatis di Task Scheduler...
schtasks /delete /tn "DiscordTelegramMirror247" /f >nul 2>&1

echo.
echo ============================================================
echo   ✅ BOT 24/7 BERHASIL DIHENTIKAN DENGAN SEMPURNA!
echo ============================================================
echo.
pause
