@echo off
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe\cmd;%ProgramFiles%\Git\cmd;%ProgramFiles(x86)%\Git\cmd;%LOCALAPPDATA%\Programs\Git\cmd;C:\Git\cmd;C:\Program Files\nodejs;C:\nvm4w\nodejs;%APPDATA%\npm;%PATH%"
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Update Bot Otomatis 1-Klik (VPS Windows RDP)
color 0B

cd /d "%~dp0"

echo ================================================================
echo   UPDATE BOT OTOMATIS 1-KLIK (VPS WINDOWS RDP)
echo   Mirror Bot Discord to Telegram
echo ================================================================
echo.

:: Mencegah Git membeku karena interaksi prompt GUI
set "GIT_TERMINAL_PROMPT=0"
set "GCM_INTERACTIVE=never"
set "GIT_MERGE_AUTOEDIT=no"

:: 1. Cek ketersediaan Git & Node.js
echo [1/6] Memeriksa environment VPS (Git, Node, NPM)...
where git >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Git tidak ditemukan di PATH sistem VPS!
    echo Silakan pastikan Git sudah terinstall di VPS: https://git-scm.com/
    pause
    exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js tidak ditemukan di PATH sistem VPS!
    echo Silakan pastikan Node.js sudah terinstall di VPS: https://nodejs.org/
    pause
    exit /b 1
)

:: Deteksi perintah PM2 (Global atau npx)
set "PM2_CMD=pm2"
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%APPDATA%\npm\pm2.cmd" (
        set "PM2_CMD=%APPDATA%\npm\pm2.cmd"
    ) else (
        echo [INFO] PM2 belum terpasang secara global. Menggunakan npx -y pm2...
        set "PM2_CMD=npx -y pm2"
    )
)
echo [OK] Environment terverifikasi.

:: 2. Amankan perubahan lokal darurat via git stash
echo.
echo [2/6] Mengamankan perubahan lokal VPS (git stash)...
git stash save "Auto-stash-vps" >nul 2>&1
echo [OK] Perubahan lokal diamankan.

:: 3. Mengambil pembaruan terbaru dari GitHub
echo.
echo [3/6] Menarik update kode dari GitHub...
git -c credential.helper= fetch origin main
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Gagal menghubungi GitHub! Pastikan VPS terhubung ke internet.
    pause
    exit /b 1
)

git reset --hard origin/main
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Gagal melakukan sinkronisasi kode dari GitHub!
    pause
    exit /b 1
)
echo [OK] Kode berhasil disinkronkan.

:: 4. Pasang modul / pustaka baru jika ada
echo.
echo [4/6] Memeriksa dan memperbarui dependencies (npm install --omit=dev)...
call npm install --omit=dev
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Gagal memasang modul npm!
    pause
    exit /b 1
)
echo [OK] Pustaka dependensi up-to-date.

:: 5. Me-restart proses PM2 dengan flag --update-env
echo.
echo [5/6] Me-restart proses PM2 dengan konfigurasi terbaru (--update-env)...
call %PM2_CMD% restart ecosystem.config.js --update-env >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Proses belum terdaftar di PM2. Memulai proses baru...
    call %PM2_CMD% start ecosystem.config.js --update-env
    if %errorlevel% neq 0 (
        color 0C
        echo [ERROR] Gagal menjalankan bot di PM2!
        echo Silakan coba jalankan manual menggunakan file start.bat
        pause
        exit /b 1
    )
)
echo [OK] Bot berhasil di-restart dengan environment terbaru.

:: 6. Menyimpan state PM2 dan menampilkan status terkini
echo.
echo [6/6] Menyimpan status persistensi PM2 (pm2 save --force)...
call %PM2_CMD% save --force >nul 2>&1
echo [OK] State PM2 tersimpan.

color 0A
echo.
echo ================================================================
echo   UPDATE BOT DI VPS WINDOWS RDP SUKSES 100%!
echo ================================================================
echo.
echo Tabel Status Proses Bot PM2 Terkini:
echo ----------------------------------------------------------------
call %PM2_CMD% status
echo ----------------------------------------------------------------
echo.
echo Catatan:
echo - Konfigurasi .env terbaru langsung diterapkan tanpa restart VPS.
echo - Data pelanggan/transaksi di SQLite tetap utuh dan aman.
echo - Cek log real-time dengan perintah: pm2 logs
echo ================================================================
echo.
pause
