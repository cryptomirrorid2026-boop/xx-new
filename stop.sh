#!/usr/bin/env bash
# ============================================================
#   STOP BOT MIRROR (VPS LINUX - AMAN & ANTI-BENTROK)
#   Menghentikan HANYA proses Bot Mirror Discord-Telegram
#   (TIDAK akan menyentuh atau mematikan project Store / bot lain)
#   Jalankan dengan: bash stop.sh
# ============================================================

set -o pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

cd "$(dirname "$0")" || exit 1

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}   🛑 MENGHENTIKAN BOT MIRROR DISCORD TO TELEGRAM${NC}"
echo -e "${CYAN}================================================================${NC}"

# Tentukan nama proses dari .env
APP_NAME="discord-to-telegram-mirror"
if [ -f ".env" ]; then
    ENV_APP_NAME=$(grep -E "^PM2_APP_NAME=" .env | cut -d '=' -f2 | tr -d ' "\r\n')
    if [ -n "$ENV_APP_NAME" ]; then
        APP_NAME="$ENV_APP_NAME"
    fi
fi

PM2_CMD="pm2"
if ! command -v pm2 &> /dev/null; then
    if npx pm2 -v &> /dev/null; then
        PM2_CMD="npx pm2"
    fi
fi

echo -e "${BLUE}[1/3] Menghentikan proses PM2 '${APP_NAME}'...${NC}"
$PM2_CMD stop "$APP_NAME" > /dev/null 2>&1 || true
$PM2_CMD delete "$APP_NAME" > /dev/null 2>&1 || true
$PM2_CMD delete discord-to-telegram-mirror > /dev/null 2>&1 || true
$PM2_CMD delete nexus-dashboard-tunnel > /dev/null 2>&1 || true
$PM2_CMD delete discord-to-telegram-mirror-tunnel > /dev/null 2>&1 || true

echo -e "${BLUE}[2/3] Membersihkan file PID tunnel lokal...${NC}"
rm -f data/tunnel.pid > /dev/null 2>&1 || true

echo -e "${BLUE}[3/3] Menyimpan status PM2...${NC}"
$PM2_CMD save --force > /dev/null 2>&1 || true

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}   ✅ BOT MIRROR BERHASIL DIHENTIKAN DENGAN BERSIH!${NC}"
echo -e "${GREEN}   Project Store dan proses lain tetap aman & berjalan.${NC}"
echo -e "${GREEN}================================================================${NC}"
echo ""
echo -e "${CYAN}Status PM2 Terkini:${NC}"
$PM2_CMD status
echo ""
