# AI CONTEXT & DOKUMENTASI SISTEM PROJECT

> **Catatan Penting:**  
> File ini adalah sumber kebenaran teknis (*single source of truth*) arsitektur, kondisi kode, dan progres pengerjaan project **Mirror Bot Discord to Telegram (v5.1 / v5.2)**. File ini disusun berdasarkan inspeksi langsung terhadap kode sumber, bukan asumsi.  
> **DILARANG** mencantumkan token, API key, kata sandi, atau nilai rahasia dari `.env` ke dalam dokumen ini.

---

## 1. Tujuan & Arsitektur Project

### 1.1 Tujuan Utama
Project ini adalah sistem perutean dan mirroring pesan real-time berkinerja tinggi antara **Discord** dan **Telegram** (dua arah: **DC ➔ TG** dan **TG ➔ DC**), dilengkapi:
- Multi-akun Discord (Selfbot) untuk memantau puluhan hingga ratusan channel/server secara paralel.
- Multi-bot Telegram (Bot API Pool) & Akun User Telegram (MTProto/GramJS) untuk pengiriman cepat ke channel, grup, dan topik/forum thread Telegram.
- Dashboard manajemen berbasis web (Express.js) dengan akses publik aman melalui Cloudflare Tunnel / Ngrok.
- Fitur keamanan GODMODE: Anti-spam, Anti-flood, Content Filtering, Rate Limiting, Crop & Blur Media, serta Watermark Inpainting.
- Mekanisme **Multi-Token Fallback** otomatis untuk mencegah pesan terlewat jika salah satu akun Discord mengalami kendala izin/akses.

### 1.2 Diagram Arsitektur Sistem

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DISCORD (Sumber/Tujuan)                         │
│  - User Account 1 (discord.js-selfbot-v13)                            │
│  - User Account 2 (discord.js-selfbot-v13) ──> discordRegistry         │
│  - Discord Webhooks (DC to DC Mirror)                                  │
└──────────────────┬──────────────────────────────────▲──────────────────┘
                   │ messageCreate                    │ Webhook POST
                   ▼                                  │
┌─────────────────────────────────────────────────────┴──────────────────┐
│                   PIPELINE PEMROSESAN PESAN (Node.js)                  │
│                                                                        │
│  1. DuplicateGuard & MessageStore (SQLite messages.db - WAL Mode)      │
│  2. GODMODE Filters (SpamPatternDetector, UserRateLimiter, WordFilter) │
│  3. Delay Processor (Per-channel / Per-category timer)                 │
│  4. MediaHandler (Sharp, Jimp, ONNX LaMa Inpaint, Watermark)           │
│  5. Forward Executor (doForward)                                       │
│     └─ Multi-Token Fallback (Pindah akun jika error 401/403/NoAccess)  │
│  6. Dead Letter Queue / DLQ (ForwardQueue dengan retry bertahap)       │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        TELEGRAM (Tujuan/Sumber)                        │
│  - Telegram Bot API Pool (TelegramManager: node-telegram-bot-api)      │
│  - MTProto User Client (GramJS - Session String)                       │
│  - Channel / Group / Supergroup / Forum Topics                         │
└────────────────────────────────────────────────────────────────────────┘
                   ▲
                   │ Monitoring & Manajemen
┌──────────────────┴─────────────────────────────────────────────────────┐
│                    WEB DASHBOARD & REMOTE ACCESS                       │
│  - Express.js (Port: 7080, Health: 7080)                               │
│  - Server-Sent Events (SSE) Live Feed (/api/events)                    │
│  - Cloudflare Quick Tunnel (cloudflared daemon) & Ngrok fallback       │
│  - UI: Channel Mappings, Status Keaktifan 24 Jam, Delay, Crop & Blur   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Struktur Folder & Fungsi Direktori

```
mirror bot forward V5,1/
├── index.js                  # Entry point bot: inisialisasi client, registry, DB, web & tunnel
├── tunnel.js                 # Pengelola Cloudflare Tunnel & Ngrok dengan deteksi port aman
├── ecosystem.config.js       # Konfigurasi proses runner PM2
├── package.json              # Dependensi modul dan metadata project
├── PANDUAN_CHANNEL.md        # Dokumentasi operasional untuk user
├── upload_ke_github.bat      # Script batch 1-klik untuk upload local ke GitHub
├── update_di_vps.bat         # Script batch 1-klik untuk pull & restart di VPS Windows
├── start.bat / stop.bat      # Script kontrol runner lokal
├── eng.traineddata           # Dataset bahasa untuk OCR Tesseract
│
├── handlers/                 # Logika perutean pesan & command
│   ├── messageHandler.js     # Handler utama pesan Discord (DC ➔ TG, delay, multi-token fallback)
│   ├── mediaHandler.js       # Pemrosesan lampiran media, gambar, download buffer, optimasi
│   ├── tgToDiscordHandler.js # Handler pesan Telegram ke Discord (TG ➔ DC Webhook)
│   └── telegramCommands.js   # Perintah bot admin Telegram (/dashboard, /status, /ping, dll)
│
├── utils/                    # Utilitas, Database, State Manager, AI Engine
│   ├── discordRegistry.js    # Registry pusat instance client Discord, guild, dan channel lookup
│   ├── channelStore.js       # Penyimpan dan manager mapping channel DC ➔ TG, delay, dan health
│   ├── messageStore.js       # Database SQLite (better-sqlite3) pencatat pesan & distributed lock
│   ├── duplicateGuard.js     # Filter anti-duplikasi cepat berbasis in-memory TTL Set
│   ├── forwardQueue.js       # Dead Letter Queue (DLQ) untuk retry pesan yang gagal terkirim
│   ├── telegramManager.js    # Pool manager untuk banyak instance bot Telegram
│   ├── webServer.js          # API REST & Web Dashboard UI (Express.js)
│   ├── healthServer.js       # Endpoint health check independen
│   ├── spamPatternDetector.js# Deteksi pola spam via regex cerdas
│   ├── userRateLimiter.js    # Proteksi anti-flood per user pengirim
│   ├── rateLimiter.js        # Pembatas kecepatan pengiriman pesan keluar
│   ├── wordFilterManager.js  # Filter kata terlarang, replace, dan whitelist
│   ├── autoLinkManager.js    # Otomatisasi perutean kategori channel baru
│   ├── cropManager.js        # Konfigurasi crop tepi gambar (pemotong watermark sumber)
│   ├── blurManager.js        # Konfigurasi blur area tertentu pada media
│   ├── watermarkManager.js   # Konfigurasi overlay watermark teks/gambar milik sendiri
│   ├── lamaInpaint.js        # AI inpainting berbasis model ONNX LaMa untuk hapus watermark
│   ├── ocrScanner.js         # OCR scanner teks pada gambar menggunakan Tesseract.js
│   ├── blockedUsersStore.js  # Penyimpan daftar User ID yang diblokir
│   ├── mutedChannels.js      # Penyimpan channel yang sedang di-mute sementara
│   ├── imageHashStore.js     # Database hash gambar untuk memblokir gambar identik berulang
│   ├── promoManager.js       # Penjadwal otomatisasi promosi berkala
│   ├── envManager.js         # Helper pembacaan & modifikasi file .env
│   ├── logger.js             # Logger aplikasi terstruktur berbasis Winston
│   └── stats.js              # Kolektor metrik performa (pesan sukses, gagal, spam)
│
├── data/                     # Penyimpanan data persisten lokal (JSON, SQLite)
│   ├── messages.db           # File SQLite database pesan aktif (WAL mode)
│   ├── channels.json         # Mapping konfigurasi channel aktif (DC ➔ TG)
│   ├── tg-to-dc-channels.json# Mapping konfigurasi mirror Telegram ke Discord
│   ├── categoryDelays.json   # Konfigurasi delay forward per kategori
│   ├── blockedUsers.json     # Data user terblokir
│   ├── crop-settings.json    # Pengaturan crop gambar
│   ├── blur-settings.json    # Pengaturan blur koordinat gambar
│   ├── watermark-settings.json # Pengaturan watermark
│   ├── word-filter.json      # Pengaturan filter kata
│   └── stats.json            # Snapshot data statistik
│
├── public/                   # Frontend Web Dashboard (Single Page Application)
│   ├── index.html            # Markup antarmuka dashboard
│   ├── style.css             # Tema styling modern (Dark mode glassmorphism)
│   └── script.js             # Logika interaktif UI, AJAX, filter status, SSE listener
│
└── logs/                     # File log harian (Winston Daily Rotate)
```

---

## 3. Semua Fitur yang Sudah Dibuat

1. **Mirroring Real-Time Discord ke Telegram (DC ➔ TG):**
   - Mendukung teks obrolan, embeds lengkap, quote reply, user mention translation, dan sticker.
   - Sinkronisasi media (gambar, video, dokumen, audio, GIF).
   - Sinkronisasi reaksi emoji (reaction sync) dari Discord ke pesan Telegram yang sesuai.
   - Sinkronisasi penghapusan pesan (jika pesan di Discord dihapus, bot menghapus pesan terkait di Telegram).
   - Dukungan penuh Telegram Topics / Forum Thread.

2. **Mirroring Telegram ke Discord (TG ➔ DC):**
   - Mendengarkan pesan dari grup/channel Telegram via MTProto Client (GramJS user session).
   - Mengirim ulang ke Discord melalui Discord Webhooks atau Bot Pool dengan avatar kustom.

3. **Multi-Token Discord & Multi-Token Fallback:**
   - Mendukung banyak akun Discord sekaligus (`DISCORD_TOKENS=token1,token2,token3`).
   - Mencegah bentrok dengan deduplikasi (`duplicateGuard` + SQLite lock).
   - **Fitur Fallback:** Apabila akun utama gagal melakukan forward akibat izin hilang (`401`, `403`, `Missing Access`, `Channel Not Found`), sistem langsung mencoba akun lain yang berada dalam server tersebut secara instan tanpa duplikasi.

4. **Pengaturan Delay Fleksibel (Per-Channel & Per-Kategori):**
   - Nilai delay maju dapat diatur secara spesifik per baris channel atau sekaligus per kategori.
   - Dapat diatur langsung melalui Web Dashboard dengan penyimpanan otomatis ke `categoryDelays.json` dan `channels.json`.

5. **Deteksi Status Keaktifan Channel (Health Checker 24 Jam):**
   - Status visual di Dashboard: 🟢 **Active**, 🔴 **Tidak Ditemukan / Terhapus**, 🟡 **No Access**, 🔇 **Muted**.
   - Tombol *Cek Keaktifan Channel* di dashboard yang menguji validitas seluruh channel di semua akun terhubung.
   - Otomatis mencatat waktu aktivitas terakhir (`lastActiveAt`) setiap kali pesan masuk.
   - Dropdown filter di dashboard untuk menyaring channel yang bermasalah.

6. **Keamanan Anti-Spam "GODMODE":**
   - **Layer 1:** Rate limiter anti-banjir media/pesan per user.
   - **Layer 2:** Filter blacklist kata, whitelist kata, mute channel, dan block user ID.
   - **Layer 3:** Deteksi regex pola link jebakan, invite Discord, grup Telegram penipu, dan nomor telepon.
   - **Layer 4:** Image Hash comparison untuk mendeteksi spam gambar berulang.

7. **Pemrosesan Gambar Lanjutan:**
   - Image Cropping: Memotong bagian atas, bawah, kiri, atau kanan gambar (menghilangkan watermark sumber).
   - Image Blurring: Memburamkan area tertentu pada gambar.
   - Watermark Injection: Menambahkan logo/teks custom ke gambar yang diteruskan.
   - AI Inpainting (LaMa ONNX): Menghapus watermark secara mulus via model deep learning.

8. **Web Dashboard & Cloudflare Tunnel Anti-Tabrakan:**
   - Port webserver diisolasi pada port **7080** (dilengkapi blacklist port sistem: 3000, 5000, 5005, 5080, 8080).
   - Tunnel Cloudflare otomatis berjalan via `cloudflared` tanpa bentrok dengan project web lain (seperti ReviewLink).
   - Log real-time melalui Server-Sent Events (SSE).

9. **Manajemen Command Telegram:**
   - Perintah admin via bot Telegram: `/dashboard`, `/status`, `/ping`, `/stats`, `/addchannel`, `/delchannel`.

---

## 4. Perubahan Kode Terakhir yang Dilakukan

Berdasarkan riwayat commit git terakhir:

1. **Commit `b34df7e` — `feat: add multi-token fallback forwarding and update gitignore`:**
   - **`handlers/messageHandler.js`:** Menambahkan blok penanganan fallback multi-token di dalam blok `catch (err)` pada `handleNewMessage`. Jika error bersifat *account-related* (`missing access`, `401`, `403`, `not found`), sistem memanggil `discordRegistry.findClientsForChannel` dan mencoba akun Discord lain yang memiliki akses ke channel tersebut.
   - **`utils/discordRegistry.js`:** Menambahkan fungsi `findClientsForChannel(channelId, excludeClient)` untuk mencari instance client yang memiliki akses cache ke channel target.
   - **`.gitignore`:** Menambahkan aturan pengabaian file `patch_*.js` dan `fix_*.js` untuk menjamin keamanan dari *GitHub Secret Scanning / Push Protection*.
   - **`.env` (Lokal):** Menghapus token expired, menambahkan token baru `william.traders`, serta mengunci `PORT=7080` dan `HEALTH_PORT=7080`.

2. **Commit `fc27ea9` & `2eff546` — `sistem auto-check keaktifan channel & filter status`:**
   - **`utils/channelStore.js`:** Menambahkan field `forwardDelayMs`, `lastActiveAt`, `lastCheckStatus`, `lastCheckError` pada skema channel. Menambahkan method `checkAllChannelsHealth` dan `recordActivity`.
   - **`utils/webServer.js`:** Menambahkan rute API:
     - `PATCH /api/channels/:id/delay`
     - `PATCH /api/categories/:name/delay`
     - `GET /api/categories/delays`
     - `POST /api/channels/check-health`
     - `GET /api/channels/health-status`
   - **`public/script.js` & `public/index.html`:** Menambahkan kolom delay, tombol cek keaktifan, dropdown filter status, dan penanda warna status channel.

3. **Isolasi Port & Perbaikan Tunnel (`tunnel.js` & `ecosystem.config.js`):**
   - Seluruh port dipindahkan dari `5080` ke `7080` untuk mengakhiri tabrakan URL Cloudflare dengan aplikasi ReviewLink.
   - Menambahkan verifikasi health check sebelum tunnel mengumumkan URL ke Telegram.

---

## 5. Konfigurasi & Dependensi Project

### 5.1 Lingkungan & Runtime
- **Node.js:** Versi `>= 20.0.0`
- **Process Manager:** PM2 (`ecosystem.config.js`)
- **Sistem Operasi:** Windows (Lokal & VPS RDP) / Linux compatible

### 5.2 Dependensi Utama (`package.json`)
| Package | Versi | Fungsi |
|---|---|---|
| `discord.js-selfbot-v13` | ^3.7.1 | Menghubungkan akun Discord user (selfbot) |
| `node-telegram-bot-api` | ^0.66.0 | Interaksi Telegram Bot API |
| `telegram` (GramJS) | ^2.26.22 | Client Telegram MTProto (User session) |
| `express` | ^5.2.1 | HTTP Server untuk API & Web Dashboard |
| `better-sqlite3` | ^12.9.0 | Database lokal berkecepatan tinggi (WAL mode) |
| `cloudflared` | ^0.7.1 | Binary Cloudflare Tunnel otomatis |
| `sharp` | ^0.34.5 | Pengolahan dan konversi gambar ultra-cepat |
| `onnxruntime-node` | ^1.27.0 | Eksekusi model AI LaMa Inpainting |
| `tesseract.js` | ^5.1.1 | Optical Character Recognition (OCR) |
| `winston` & rotate file | ^3.19.0 | Logging sistem terstruktur |

### 5.3 Struktur Kunci Variabel Lingkungan (`.env`)
*(Nilai variabel sengaja dikosongkan untuk keamanan)*
```env
# Multi-token Discord (dipisahkan koma)
DISCORD_TOKENS=

# Bot Telegram Tujuan
TELEGRAM_BOT_1=
TELEGRAM_BOT_2=

# MTProto User Session untuk TG -> DC
TG_API_ID=
TG_API_HASH=
TG_USER_SESSIONS=

# Port Server & Health Check (Wajib 7080)
PORT=7080
HEALTH_PORT=7080

# Cloudflare / Ngrok (Opsional)
CLOUDFLARE_TUNNEL_TOKEN=
NGROK_AUTHTOKEN=

# Konfigurasi Filter & Delay
RATE_LIMIT_DELAY=200
FORWARD_BOT_MESSAGES=true
FORWARD_EDITS=true
ENABLE_AI_WATERMARK=false
```

---

## 6. Masalah / Bug yang Belum Selesai & Catatan Teknis

1. **Sinkronisasi File `.env` di VPS:**
   - File `.env` diabaikan oleh Git (`.gitignore`) demi alasan keamanan. Perubahan token baru (`william.traders`), penghapusan token expired, dan perubahan port `7080` yang sudah diterapkan di lokal harus dipastikan telah disalin atau disesuaikan di file `.env` yang berada di server VPS.
2. **OCR Scanner Dinonaktifkan Sementara:**
   - Pada `handlers/messageHandler.js` (baris 842-861), pemindaian OCR gambar dinonaktifkan sementara karena proses OCR Tesseract berbasis CPU memakan waktu (2-5 detik per gambar) yang dapat menahan antrean pesan saat terjadi banjir gambar (*flood*).
3. **URL Cloudflare Quick Tunnel Bersifat Dinamis:**
   - Mode default `cloudflared` tanpa token menggunakan quick tunnel domain acak (`*.trycloudflare.com`) yang berganti setiap kali bot di-restart. Untuk domain permanen, disarankan mengisi `CLOUDFLARE_TUNNEL_TOKEN` di `.env`.
4. **Session String Telegram (GramJS):**
   - Jika akun Telegram yang digunakan untuk TG ➔ DC mengalami revokasi sesi (misal: logout dari semua perangkat), bot TG ➔ DC akan gagal terhubung dan memerlukan pembuatan ulang session via `generate-tg-session.js`.

---

## 7. Status & Progress Pengerjaan Terakhir

- **Status Kode Lokal:** Bersih (*clean, nothing to commit*).
- **Status Git Remote:** Ter-update penuh pada branch `main` (`origin/main`).
- **Verifikasi Kredensial:** Token baru valid dan terverifikasi via Discord API.
- **Push Protection:** Bersih tanpa insiden kebocoran kredensial ke GitHub.

---

## 8. Rencana Pengembangan Berikutnya (Roadmap)

1. **Async Non-Blocking OCR Pipeline:**
   - Memindahkan proses OCR ke Worker Thread terpisah agar proses forward media instan tetap berjalan tanpa delay CPU.
2. **Tombol "Test Forward" di Web Dashboard:**
   - Menambahkan tombol simulasi pada baris channel di dashboard untuk menguji apakah mapping channel ke Telegram tertentu aktif dan bot memiliki izin kirim tanpa menunggu pesan masuk di Discord.
3. **Penyelarasan `.env` Helper GUI di Dashboard:**
   - Menyediakan antarmuka visual yang aman di dashboard untuk mengedit daftar token Discord tanpa perlu mengakses remote desktop VPS secara manual.
4. **Manajemen Named Cloudflare Tunnel dari Web:**
   - Input token Cloudflare Tunnel permanen langsung dari halaman pengaturan dashboard.

---
*Dokumen ini dibuat otomatis sebagai panduan kontekstual AI dan developer.*  
*Terakhir diperbarui: 16 November 2026.*
