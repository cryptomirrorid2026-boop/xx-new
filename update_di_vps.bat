@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Update Bot Otomatis 1-Klik (VPS Windows RDP)
color 0B

cd /d "%~dp0"

echo ================================================================
echo   🔄 UPDATE BOT OTOMATIS 1-KLIK (VPS WINDOWS RDP)
echo   Mirror Bot Discord to Telegram
echo ================================================================
echo.

:: 1. Cek ketersediaan Git & Node.js
echo [1/6] Memeriksa environment VPS (Git, Node, NPM)...
where git >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Git tidak ditemukan di PATH sistem VPS!
    pause
    exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js tidak ditemukan di PATH sistem VPS!
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
        echo [INFO] PM2 belum terpasang secara global. Menggunakan npx pm2...
        set "PM2_CMD=npx pm2"
    )
)
echo [OK] Environment terverifikasi.

:: 2. Amankan perubahan lokal darurat via git stash
echo.
echo [2/6] Mengamankan perubahan lokal VPS (git stash)...
git stash save "Auto-stash-vps-%date%-%time%" >nul 2>&1
echo [OK] Perubahan lokal diamankan.

:: 3. Mengambil pembaruan terbaru dari GitHub (git pull origin main)
echo.
echo [3/6] Menarik update kode dari GitHub (git pull origin main)...
git pull origin main
if %errorlevel% neq 0 (
    color 0E
    echo.
    echo [PERINGATAN] Terjadi konflik saat git pull!
    echo Mengaktifkan mekanisme Fallback Sync (git reset --hard origin/main)...
    echo File database & .env TETAP AMAN karena dilindungi .gitignore.
    echo.
    git fetch origin main
    git reset --hard origin/main
    if %errorlevel% neq 0 (
        color 0C
        echo [ERROR] Gagal melakukan sinkronisasi dengan GitHub!
        pause
        exit /b 1
    )
    color 0B
    echo [OK] Sinkronisasi kode berhasil via fallback reset.
) else (
    echo [OK] Kode berhasil diperbarui.
)

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
echo   ✅ UPDATE BOT DI VPS WINDOWS RDP SUKSES 100%!
echo ================================================================
echo.
echo Tabel Status Proses Bot PM2 Terkini:
echo ----------------------------------------------------------------
call %PM2_CMD% status
echo ----------------------------------------------------------------
echo.
echo 💡 Catatan:
echo - Konfigurasi .env terbaru langsung diterapkan tanpa restart VPS.
echo - Data pelanggan/transaksi di SQLite tetap utuh dan aman.
echo - Cek log real-time dengan perintah: pm2 logs
echo ================================================================
echo.
pause
