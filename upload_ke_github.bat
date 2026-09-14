@echo off
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Git.MinGit_Microsoft.Winget.Source_8wekyb3d8bbwe\cmd;%ProgramFiles%\Git\cmd;%ProgramFiles(x86)%\Git\cmd;%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"

setlocal EnableDelayedExpansion
chcp 65001 >nul
title Upload Project ke GitHub (Local 1-Click Deployment)
color 0B

cd /d "%~dp0"

echo ================================================================
echo   🚀 SISTEM UPLOAD 1-KLIK KE GITHUB (LOCAL PC ➡️ GITHUB)
echo   Mirror Bot Discord to Telegram
echo ================================================================
echo.

:: 1. Memeriksa ketersediaan Git di komputer
echo [1/5] Memeriksa instalasi Git...
where git >nul 2>&1
if !errorlevel! neq 0 (
    color 0C
    echo.
    echo [ERROR] Git belum terinstall atau belum masuk ke System PATH.
    echo Silakan unduh dan install Git terlebih dahulu dari:
    echo 👉 https://git-scm.com/downloads
    echo.
    echo Setelah selesai install, buka kembali file ini.
    echo.
    pause
    exit /b 1
)
echo [OK] Git terdeteksi.

:: 2. Memeriksa / inisialisasi Git repository & branch main
echo.
echo [2/5] Memeriksa repository lokal ^& branch main...
if not exist ".git" (
    echo [INFO] Inisialisasi Git repository baru...
    git init
    if !errorlevel! neq 0 (
        echo [ERROR] Gagal inisialisasi repository git.
        pause
        exit /b 1
    )
)

:: Pastikan branch utama bernama main
git branch -M main >nul 2>&1
echo [OK] Branch utama: main.

:: 3. Memeriksa remote origin GitHub
echo.
echo [3/5] Memeriksa koneksi Remote GitHub (origin)...
git remote get-url origin >nul 2>&1
if !errorlevel! equ 0 goto :REMOTE_READY

color 0E
echo.
echo [PERHATIAN] Remote repository GitHub belum diatur.
echo Masukkan URL Repository GitHub Anda [HTTPS / SSH].
echo Contoh: https://github.com/username/nama-repo.git
echo.
set /p "INPUT_ORIGIN=URL Repository GitHub: "
if not defined INPUT_ORIGIN (
    color 0C
    echo [ERROR] URL repository tidak boleh kosong.
    pause
    exit /b 1
)
git remote add origin !INPUT_ORIGIN!
if !errorlevel! neq 0 (
    color 0C
    echo [ERROR] Gagal menambahkan remote origin.
    pause
    exit /b 1
)
color 0B

:REMOTE_READY
for /f "tokens=*" %%i in ('git remote get-url origin 2^>nul') do set "ORIGIN_URL=%%i"
echo [OK] Remote URL: %ORIGIN_URL%

:: 4. Cek perubahan file dan snapshot commit
echo.
echo [4/5] Memeriksa perubahan file project...

set "HAS_CHANGES="
for /f "tokens=*" %%i in ('git status --porcelain 2^>nul') do set "HAS_CHANGES=1"

if not defined HAS_CHANGES (
    echo [INFO] Tidak ada file baru yang diubah. Lanjut ke proses upload...
    goto :CHECK_PUSH
)

echo.
echo ----------------------------------------------------------------
echo Ringkasan file yang diubah / baru:
echo ----------------------------------------------------------------
git status -s
echo ----------------------------------------------------------------
echo.

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set "DT=%%I"
if defined DT (
    set "TIMESTAMP=!DT:~0,4!-!DT:~4,2!-!DT:~6,2! !DT:~8,2!:!DT:~10,2!:!DT:~12,2!"
) else (
    set "TIMESTAMP=%DATE% %TIME%"
)
set "DEFAULT_MSG=Update snapshot: !TIMESTAMP!"

echo Masukkan catatan update (Tekan ENTER untuk pesan default):
echo Default: "!DEFAULT_MSG!"
echo.
set "USER_MSG="
set /p "USER_MSG=Pesan Commit: "
if not defined USER_MSG set "USER_MSG=!DEFAULT_MSG!"

echo.
echo Menambahkan file ke stage tracking (git add -A)...
git add -A

echo Membuat commit: "!USER_MSG!"...
git commit -m "!USER_MSG!"
if !errorlevel! neq 0 (
    color 0C
    echo [ERROR] Gagal membuat git commit.
    pause
    exit /b 1
)

:CHECK_PUSH
:: 5. Melakukan Git Push ke origin main
echo.
echo [5/5] Mengunggah perubahan ke GitHub (git push origin main)...
git push -u origin main
if !errorlevel! neq 0 (
    color 0C
    echo.
    echo ================================================================
    echo   ❌ GAGAL MELAKUKAN PUSH KE GITHUB.
    echo ================================================================
    echo Kemungkinan penyebab:
    echo 1. Akses ditolak [Perlu Personal Access Token / GitHub Login].
    echo 2. Ada commit baru di GitHub yang belum ditarik ke lokal.
    echo    Solusi: jalankan 'git pull origin main --rebase' lalu ulangi.
    echo 3. Koneksi internet terputus atau URL remote salah.
    echo ================================================================
    echo.
    pause
    exit /b 1
)

color 0A
echo.
echo ================================================================
echo   ✅ BERHASIL DI-PUSH KE GITHUB 100%%.
echo ================================================================
echo   Snapshot update terbaru sudah aman di GitHub (branch: main).
echo.
echo   Langkah selanjutnya di VPS:
echo   - VPS Windows RDP : Cukup double-click file "update_di_vps.bat"
echo   - VPS Linux       : Cukup jalankan perintah "bash update_di_vps.sh"
echo ================================================================
echo.
pause
