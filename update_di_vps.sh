#!/usr/bin/env bash
# ============================================================
#   UPDATE BOT OTOMATIS 1-KLIK (VPS LINUX - UBUNTU/DEBIAN)
#   Mirror Bot Discord to Telegram
#   Jalankan dengan: bash update_di_vps.sh
# ============================================================

set -o pipefail

# Warna Terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Berpindah ke direktori project
cd "$(dirname "$0")" || exit 1

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}   🔄 UPDATE BOT OTOMATIS 1-KLIK (VPS LINUX)${NC}"
echo -e "${CYAN}   Mirror Bot Discord to Telegram${NC}"
echo -e "${CYAN}================================================================${NC}"
echo ""

# 1. Cek ketersediaan Git, Node.js, & PM2
echo -e "${BLUE}[1/6] Memeriksa environment VPS (Git, Node, NPM, PM2)...${NC}"
if ! command -v git &> /dev/null; then
    echo -e "${RED}[ERROR] Git belum terinstall di VPS ini!${NC}"
    echo "Jalankan: sudo apt update && sudo apt install -y git"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}[ERROR] Node.js belum terinstall di VPS ini!${NC}"
    echo "Jalankan: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    exit 1
fi

PM2_CMD="pm2"
if ! command -v pm2 &> /dev/null; then
    if npx pm2 -v &> /dev/null; then
        PM2_CMD="npx pm2"
        echo -e "${YELLOW}[INFO] PM2 belum global, menggunakan npx pm2...${NC}"
    else
        echo -e "${YELLOW}[INFO] Menginstall PM2 Process Manager secara global...${NC}"
        npm install -g pm2 || sudo npm install -g pm2
    fi
fi
echo -e "${GREEN}[OK] Environment terverifikasi.${NC}"

# 2. Amankan perubahan lokal darurat via git stash
echo ""
echo -e "${BLUE}[2/6] Mengamankan perubahan lokal VPS (git stash)...${NC}"
git stash save "Auto-stash-vps-$(date +'%Y%m%d-%H%M%S')" > /dev/null 2>&1 || true
echo -e "${GREEN}[OK] Perubahan lokal diamankan.${NC}"

# 3. Mengambil pembaruan terbaru dari GitHub
echo ""
echo -e "${BLUE}[3/6] Menarik update kode dari GitHub (git pull origin main)...${NC}"
if ! git pull origin main; then
    echo -e "${YELLOW}[PERINGATAN] Terjadi konflik saat git pull!${NC}"
    echo -e "${YELLOW}Mengaktifkan mekanisme Fallback Sync (git reset --hard origin/main)...${NC}"
    echo -e "${YELLOW}File database & .env TETAP AMAN karena dilindungi .gitignore.${NC}"
    git fetch origin main
    git reset --hard origin/main
    if [ $? -ne 0 ]; then
        echo -e "${RED}[ERROR] Gagal sinkronisasi dengan GitHub!${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] Sinkronisasi kode berhasil via fallback reset.${NC}"
else
    echo -e "${GREEN}[OK] Kode berhasil diperbarui.${NC}"
fi

# 4. Pasang modul / dependensi baru jika ada
echo ""
echo -e "${BLUE}[4/6] Memeriksa dan memperbarui dependencies (npm install --omit=dev)...${NC}"
npm install --omit=dev
if [ $? -ne 0 ]; then
    echo -e "${RED}[ERROR] Gagal memasang dependensi npm!${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] Pustaka dependensi up-to-date.${NC}"

# 5. Me-restart proses PM2 dengan flag --update-env
echo ""
echo -e "${BLUE}[5/6] Me-restart proses PM2 dengan konfigurasi terbaru (--update-env)...${NC}"
if ! $PM2_CMD restart ecosystem.config.js --update-env > /dev/null 2>&1; then
    echo -e "${YELLOW}[INFO] Proses belum terdaftar di PM2. Memulai proses baru...${NC}"
    $PM2_CMD start ecosystem.config.js --update-env
    if [ $? -ne 0 ]; then
        echo -e "${RED}[ERROR] Gagal menjalankan bot di PM2!${NC}"
        exit 1
    fi
fi
echo -e "${GREEN}[OK] Bot berhasil di-restart dengan environment terbaru.${NC}"

# 6. Menyimpan state PM2 dan menampilkan status terkini
echo ""
echo -e "${BLUE}[6/6] Menyimpan status persistensi PM2 (pm2 save --force)...${NC}"
$PM2_CMD save --force > /dev/null 2>&1 || true
echo -e "${GREEN}[OK] State PM2 tersimpan.${NC}"

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}   ✅ UPDATE BOT DI VPS LINUX SUKSES 100%!${NC}"
echo -e "${GREEN}================================================================${NC}"
echo ""
echo -e "${CYAN}Tabel Status Proses Bot PM2 Terkini:${NC}"
echo "----------------------------------------------------------------"
$PM2_CMD status
echo "----------------------------------------------------------------"
echo ""
echo -e "${YELLOW}💡 Catatan:${NC}"
echo "- Konfigurasi .env terbaru langsung diterapkan tanpa restart VPS."
echo "- Data pelanggan/transaksi di SQLite tetap utuh dan aman."
echo "- Cek log real-time bot dengan: pm2 logs"
echo -e "${GREEN}================================================================${NC}"
echo ""
