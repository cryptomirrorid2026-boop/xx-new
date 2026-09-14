@echo off
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe\cmd;%ProgramFiles%\Git\cmd;%ProgramFiles(x86)%\Git\cmd;%LOCALAPPDATA%\Programs\Git\cmd;C:\Git\cmd;C:\Program Files\nodejs;C:\nvm4w\nodejs;%APPDATA%\npm;%PATH%"
:: ============================================================
::   SETUP BOT DISCORD-TELEGRAM MIRROR 24/7 DI WINDOWS VPS / RDP
::   Jalankan file ini dengan: Right-click -> Run as Administrator
:: ============================================================
title Setup Bot 24/7 Windows VPS
color 0A

echo.
echo ============================================================
echo   MENGAKTIFKAN SYSTEM AUTOSTART BOT MIRROR 24/7 (WINDOWS VPS)
echo ============================================================
echo.

:: Check Admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Harap jalankan file ini sebagai ADMINISTRATOR!
    echo Klik kanan file setup-247-windows.bat -> pilih "Run as administrator"
    pause
    exit /b 1
)

set "BOT_DIR=%~dp0"
if "%BOT_DIR:~-1%"=="\" set "BOT_DIR=%BOT_DIR:~0,-1%"

echo [1/3] Menendaftarkan Bot ke Task Scheduler Windows (User %USERNAME%)...
schtasks /create /tn "DiscordTelegramMirror247" /tr "cmd.exe /c cd /d \"%BOT_DIR%\" && start.bat" /sc ONSTART /ru "%USERNAME%" /rl HIGHEST /f

if %errorLevel% equ 0 (
    echo [SUCCESS] Task Scheduler berhasil dibuat!
) else (
    echo [ERROR] Gagal membuat Task Scheduler.
    pause
    exit /b 1
)

echo.
echo [2/3] Mematikan Power Sleep VPS (agar Windows tidak pernah Sleep)...
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change monitor-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1

echo.
echo [3/3] Memulai Bot di Background Server sekarang...
schtasks /run /tn "DiscordTelegramMirror247" >nul 2>&1

echo.
echo ============================================================
echo   ✅ BOT SUDAH AKTIF 24/7 DI BACKGROUND WINDOWS VPS!
echo ============================================================
echo  Bot sekarang berjalan di tingkat SISTEM (System Level).
echo  - Meskipun RDP ditutup / disilang (X), bot TETAP JALAN.
echo  - Meskipun RDP di-Logoff, bot TETAP JALAN.
echo  - Jika VPS di-restart / reboot, bot OTOMATIS NYALA SENDIRI.
echo ============================================================
echo.
echo  PENTING:
echo  - Untuk mengecek bot jalan: Buka Task Manager -> Tab Details -> cari node.exe
echo  - Untuk mematikan bot 24/7: Jalankan stop-247-windows.bat
echo.
pause
