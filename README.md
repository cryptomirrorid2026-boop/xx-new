# Discord to Telegram Mirror Bot

Bot yang meneruskan pesan dari Discord ke Telegram secara **real-time**.

---

## ✨ Fitur

| Fitur | Deskripsi |
|-------|-----------|
| 🔄 Real-time forwarding | Pesan langsung dikirim saat muncul di Discord |
| 🖼️ Forward media | Gambar, video, audio, dan file dokumen |
| 📌 Multi-channel | Bisa mapping banyak channel Discord ke Telegram |
| ✏️ Forward edit | Pesan yang diedit juga diteruskan |
| 🛡️ Filter kata | Blacklist kata tertentu agar tidak diteruskan |
| 📊 Statistik | Monitoring jumlah pesan yang diteruskan |
| 🔁 Auto-restart | `start.bat` otomatis restart jika bot crash |

---

## 🚀 Cara Setup

### 1. Buat Discord Bot

1. Buka [Discord Developer Portal](https://discord.com/developers/applications)
2. Klik **"New Application"** → beri nama → **"Bot"** di sidebar
3. Klik **"Reset Token"** → copy tokennya
4. Di bagian **Privileged Gateway Intents**, aktifkan:
   - ✅ **MESSAGE CONTENT INTENT**
   - ✅ **SERVER MEMBERS INTENT**
5. **Invite bot** ke server dengan permission:
   - `Read Messages/View Channels`
   - `Read Message History`

### 2. Buat Telegram Bot

1. Buka Telegram, cari **@BotFather**
2. Kirim `/newbot` dan ikuti instruksi
3. Copy token yang diberikan

### 3. Dapatkan Telegram Chat ID

- **Untuk grup/channel:** Tambahkan bot ke grup, lalu kirim pesan. Kunjungi:
  ```
  https://api.telegram.org/bot<TOKEN>/getUpdates
  ```
  Lihat nilai `"chat": {"id": ...}` di response. ID grup biasanya dimulai dengan `-100`

- **Untuk private chat:** Mulai chat dengan bot Anda, lalu cek URL di atas.

### 4. Dapatkan Discord Channel ID

1. Di Discord, aktifkan **Developer Mode** (Settings → Advanced → Developer Mode)
2. Klik kanan pada channel yang ingin dimonitor → **"Copy Channel ID"**

### 5. Konfigurasi .env

Edit file `.env`:

```env
DISCORD_TOKEN=token_discord_bot_anda
TELEGRAM_BOT_TOKEN=token_telegram_bot_anda

# Satu pasangan:
CHANNEL_MAPPING=123456789012345678:-1001234567890

# Multi pasangan (pisahkan dengan koma):
CHANNEL_MAPPING=123456789012345678:-1001234567890,987654321098765432:-1009876543210
```

### 6. Jalankan Bot

**Windows** — double-click `start.bat`

**Manual:**
```bash
npm install
node index.js
```

---

## 📂 Struktur File

```
bot miror dc to tele/
├── index.js              ← Entry point utama
├── .env                  ← Konfigurasi (EDIT INI)
├── .env.example          ← Template konfigurasi
├── start.bat             ← Script jalankan di Windows
├── package.json
│
├── handlers/
│   ├── messageHandler.js  ← Logic forward pesan teks
│   └── mediaHandler.js    ← Handle gambar/video/file
│
└── utils/
    ├── logger.js          ← Logger berwarna
    ├── formatter.js       ← Format pesan Discord → Telegram
    ├── rateLimiter.js     ← Anti-flood Telegram API
    └── stats.js           ← Statistik pesan
```

---

## ⚙️ Opsi Konfigurasi .env

| Variable | Default | Keterangan |
|----------|---------|------------|
| `DISCORD_TOKEN` | — | Token bot Discord (wajib) |
| `TELEGRAM_BOT_TOKEN` | — | Token bot Telegram (wajib) |
| `CHANNEL_MAPPING` | — | Mapping channel (wajib) |
| `WATERMARK` | `🔄 Discord Mirror` | Teks header di setiap pesan |
| `FORWARD_BOT_MESSAGES` | `false` | Forward pesan dari bot lain? |
| `FORWARD_EDITS` | `true` | Forward pesan yang diedit? |
| `SHOW_CHANNEL_NAME` | `true` | Tampilkan nama channel? |
| `SHOW_SERVER_NAME` | `true` | Tampilkan nama server? |
| `SHOW_AUTHOR_NAME` | `true` | Tampilkan nama pengirim? |
| `BLACKLIST_WORDS` | — | Kata yang diblacklist (koma) |
| `MAX_MESSAGE_LENGTH` | `4000` | Batas panjang pesan (karakter) |
| `RATE_LIMIT_DELAY` | `500` | Delay antar pesan ke TG (ms) |

---

## 🔧 Troubleshooting

**Bot tidak membaca pesan:**
- Pastikan `MESSAGE CONTENT INTENT` diaktifkan di Discord Developer Portal
- Pastikan bot sudah diinvite ke server dengan permission yang benar

**Pesan tidak sampai ke Telegram:**
- Cek Chat ID sudah benar (grup harus `-100xxxxx`)
- Pastikan bot Telegram sudah dijadikan admin di grup/channel

**Error "Missing Access":**
- Bot Discord tidak punya permission untuk membaca channel tersebut

---

## 📝 Format Pesan di Telegram

```
🔄 Discord Mirror
🏠 **Nama Server**  📌 #nama-channel  👤 NamaPengguna
──────────────────────────────
Isi pesan dari Discord...
```
