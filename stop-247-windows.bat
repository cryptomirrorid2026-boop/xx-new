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

echo [1/2] Menghentikan proses bot...
schtasks /end /tn "DiscordTelegramMirror247" >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1

echo [2/2] Menghapus pendaftaran otomatis di Task Scheduler...
schtasks /delete /tn "DiscordTelegramMirror247" /f >nul 2>&1

echo.
echo ============================================================
echo   ✅ BOT 24/7 BERHASIL DIHENTIKAN DENGAN SEMPURNA!
echo ============================================================
echo.
pause
