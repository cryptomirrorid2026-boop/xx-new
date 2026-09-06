#!/bin/bash
# ============================================================
#   MIRROR BOT VPS AUTO-START & SELF-HEALING LAUNCHER v2
#   Perintah Tunggal: bash start.sh
#   Membuat bot 100% Mandiri, Otomatis Nyala Saat VPS Reboot,
#   Auto-Restart Saat RAM Penuh & Bebas Perawatan Manual.
# ============================================================

echo "🚀 [1/5] Memeriksa environment VPS & Node.js..."

# Cek Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js belum terinstall! Menginstall Node.js v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs || sudo apt-get install -y nodejs
fi

# Cek PM2
if ! command -v pm2 &> /dev/null; then
    echo "⚙️ [2/5] Menginstall PM2 (Process Manager)..."
    npm install -g pm2
fi

# Install pm2-logrotate agar file log tidak memenuhi harddisk VPS
echo "📦 [3/5] Mengatur log-rotation otomatis (mencegah disk VPS penuh)..."
pm2 install pm2-logrotate > /dev/null 2>&1 || true
pm2 set pm2-logrotate:max_size 10M > /dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 5 > /dev/null 2>&1 || true

# Install dependencies project
if [ ! -d "node_modules" ]; then
    echo "📦 [4/5] Menginstall dependencies npm..."
    npm install
fi

echo "🔄 [5/5] Mengaktifkan Bot & Auto-Start Systemd VPS..."

# Hentikan proses lama jika ada
pm2 delete all > /dev/null 2>&1 || true

# Jalankan bot via ecosystem.config.js
pm2 start ecosystem.config.js --env production

# Daftarkan auto-start di OS Linux (Systemd) agar otomatis nyala saat VPS Reboot
SYSTEMD_CMD=$(pm2 startup systemd | grep "sudo env PATH" || true)
if [ -n "$SYSTEMD_CMD" ]; then
    eval "$SYSTEMD_CMD" > /dev/null 2>&1 || true
fi

# Simpan state PM2
pm2 save

echo "=========================================================="
echo "✅ BOT SEKARANG 100% MANDIRI & AUTO-START BERHASIL!"
echo "=========================================================="
echo "✨ Apa yang sudah dikonfigurasi secara otomatis:"
echo " 1. Bot otomatis nyala sendiri saat VPS mati/reboot."
echo " 2. Memory Guard aktif: RAM dibersihkan & restart otomatis jika penuh."
echo " 3. Antrian pengiriman anti-macet: Timeout 25 detik aktif."
echo " 4. File log otomatis di-rotasi agar harddisk VPS tidak penuh."
echo "=========================================================="
echo "📌 Cek status bot kapan saja dengan: pm2 status"
echo "📌 Cek log real-time bot dengan:     pm2 logs"
echo "=========================================================="
