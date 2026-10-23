# 📡 PANDUAN LENGKAP TAMBAH CHANNEL MIRROR (DC → TG)

## ⚡ Cara Cepat Tambah Channel (via Telegram Bot)

Setelah bot online, kirim pesan DM ke bot admin kamu:

```
/addch namaChannel DISCORD_CHANNEL_ID TELEGRAM_CHAT_ID NOMOR_BOT [THREAD_ID]
```

**Contoh tanpa Topic/Thread:**
```
/addch sinyalbtc 1234567890123456789 -1001234567890 1
```

**Contoh dengan Topic/Thread (grup dengan fitur Forum/Topic):**
```
/addch sinyalbtc 1234567890123456789 -1001234567890 2 94
```

Setelah ditambah → **langsung aktif tanpa restart!**

---

## 📋 Format File `data/channels.json`

Edit langsung file ini jika bot sedang offline:

```json
[
  {
    "name": "nama-channel",           ← Label bebas untuk identifikasi (huruf/angka/strip)
    "discordId": "123456789012345678", ← ID channel Discord (hanya angka, klik kanan → Copy ID)
    "tgChatId": "-1001234567890",      ← ID grup/channel Telegram (negatif untuk supergroup)
    "botKey": "1",                     ← Nomor bot: TELEGRAM_BOT_1, TELEGRAM_BOT_2, dst
    "threadId": "94"                   ← ID Topic/Thread (hapus baris ini jika tidak pakai topic)
  }
]
```

### ✅ Contoh Lengkap (Multiple Channel):
```json
[
  {
    "name": "signal-crypto",
    "discordId": "1494966942568550441",
    "tgChatId": "-1003991448470",
    "botKey": "1"
  },
  {
    "name": "berita-btc",
    "discordId": "1283243124717781043",
    "tgChatId": "-1003533252736",
    "botKey": "2",
    "threadId": "7"
  },
  {
    "name": "pengumuman",
    "discordId": "1156425621661032459",
    "tgChatId": "-1003533252736",
    "botKey": "3",
    "threadId": "22"
  }
]
```

---

## 🔍 Cara Dapat Discord Channel ID

1. Buka Discord → **Settings** → **Advanced** → Aktifkan **Developer Mode**
2. Klik kanan channel Discord yang ingin di-mirror
3. Klik **"Copy Channel ID"**
4. Tempelkan sebagai `discordId`

> ⚠️ Discord channel ID hanya berisi angka (contoh: `1494966942568550441`)

---

## 🔍 Cara Dapat Telegram Chat ID

### Untuk Grup/Supergroup:
1. Tambahkan bot `@userinfobot` ke grup
2. Ketik `/start` → bot akan balas dengan ID grup (dimulai dengan `-100`)
3. Hapus `@userinfobot` dari grup setelah dapat ID

### Untuk Channel Telegram:
- ID channel biasanya dimulai dengan `-100`
- Bisa juga pakai `@userinfobot` atau forward pesan dari channel ke bot

### Untuk Topic/Thread ID:
1. Buka Telegram Web (web.telegram.org)
2. Buka grup → klik topic yang ingin dipakai
3. Lihat URL: `.../#12345` → angka itu adalah Thread ID

---

## ⚖️ Distribusi Bot yang Baik

Jika punya banyak channel, **distribusikan ke beberapa bot** agar tidak kena rate limit Telegram:

| Channel | Bot Key |
|---------|---------|
| Channel 1-5 | `"botKey": "1"` |
| Channel 6-10 | `"botKey": "2"` |
| Channel 11-15 | `"botKey": "3"` |

> 💡 Setiap bot Telegram punya limit 30 pesan/detik. Jika banyak channel aktif sekaligus,
> pakai beberapa bot untuk distribusi beban.

---

## 🛡️ Command Telegram Admin

| Command | Fungsi |
|---------|--------|
| `/testmirror` | **Tes semua channel** — kirim pesan tes untuk verifikasi |
| `/channels` | Lihat daftar semua channel yang terdaftar |
| `/addch` | Tambah channel baru (format lihat di bawah) |
| `/removech` | Hapus channel |
| `/mute` | Hentikan sementara forward dari channel tertentu |
| `/unmute` | Aktifkan kembali |
| `/dlq` | Cek status antrian pesan yang gagal (Dead-Letter Queue) |
| `/status` | Status bot, uptime, statistik |
| `/mapping` | Lihat semua mapping DC → TG aktif |

---

## ❓ Troubleshooting: Channel Tidak Menerima Pesan

Gunakan `/testmirror` untuk cek. Jika ada yang gagal, periksa:

1. **`discordId` salah** → pastikan Developer Mode aktif, copy ID ulang
2. **Bot tidak ada di grup Telegram** → tambahkan bot ke grup & beri hak admin "Post Messages"
3. **`tgChatId` salah** → gunakan `@userinfobot` untuk verifikasi ID
4. **`threadId` salah** → cek URL topic di Telegram Web
5. **`botKey` tidak ada** → pastikan `TELEGRAM_BOT_X` di `.env` sudah diisi
6. **Akun Discord tidak join server** → akun Discord harus sudah join server yang channel-nya mau di-mirror

---

## 🔄 Hot-Reload

Edit `data/channels.json` → simpan → **bot langsung apply tanpa restart!**

Tidak perlu `pm2 restart` setiap kali tambah/hapus channel.

---

## ⚡ FITUR BARU: AUTO-LINK CATEGORY (DC ➔ DC MIRROR)

Kini kamu tidak perlu lagi membuat channel, membuat webhook, dan mengisi ID channel satu per satu secara manual.

### 🚀 Cara Menggunakan:
1. **Daftarkan Bot Pool (3–4 Bot Resmi):**
   - Di dashboard, klik tombol **"Bot Pool"** (atau ikon Discord).
   - Masukkan token Discord Bot resmi Anda (buat di Discord Developer Portal).
   - Pastikan bot-bot tersebut sudah diundang ke server tujuan dengan izin *Administrator / Manage Channels & Webhooks*.
   - Bot Pool akan berotasi otomatis membuat channel & webhook agar terhindar dari *Discord rate limit*.

2. **Jalankan Auto-Link Category:**
   - Klik tombol **"Auto-Link Category"** di dashboard.
   - Masukkan **ID Server Sumber** (akun user token Anda wajib sudah join ke server ini).
   - Masukkan **ID Kategori Sumber**.
   - Masukkan **ID Server Tujuan**.
   - *(Opsional)* ID Kategori Tujuan (kosongkan jika ingin dibuatkan otomatis dengan nama yang sama).
   - *(Opsional)* Label Kategori (misal: "Akademi Crypto", "Kelas Xander").
   - Centang **"Aktifkan Realtime Auto-Sync"**.
   - Klik **"Preview Channel"** untuk melihat daftar channel yang ditemukan.
   - Klik **"Mulai Auto-Link & Provisioning"**.
   - Bot otomatis membuat seluruh channel tujuan, memasang webhook, dan mendaftarkan mappingnya secara rapi!

3. **Realtime Auto-Sync Penuh (Tambah, Rename, & Kurang):**
   - **➕ Channel Baru (Auto-Add):** Jika admin server sumber menambahkan channel baru di kategori tersebut, bot langsung membuat channel tujuan & webhook otomatis.
   - **✏️ Ganti Nama (Auto-Rename):** Jika channel di server sumber diubah namanya, bot langsung mengganti nama channel tujuan agar 100% mirip dan identik ("biar sama persis").
   - **🗑️ Channel Dihapus (Auto-Reduce):** Jika channel di server sumber dihapus, bot otomatis menghapus channel tujuan di Discord dan membersihkan mappingnya di sistem ("mengurangi secara otomatis").

4. **Fitur Rekonsiliasi & Perbandingan Cerdas (Anti-Skip):**
   - Di modal **Auto-Link Category**, klik tombol **"Bandingkan & Periksa Channel"**.
   - Sistem akan membandingkan channel sumber dan tujuan secara visual:
     * 🟢 **Cocok & Terhubung (Identik):** Channel sudah sama persis.
     * 🟡 **Perlu Disamakan Namanya (Auto-Rename):** Menampilkan nama lama vs nama baru.
     * 🔵 **Channel Kurang (Auto-Add):** Channel yang akan dibuat otomatis beserta webhooknya.
     * 🔴 **Channel Terhapus (Auto-Reduce):** Channel yang akan dikurangi/dibersihkan otomatis.
   - Klik **"Mulai Sinkronisasi & Auto-Link"** untuk menjalankan penyelarasan dengan proteksi **Zero-Skip** (jika terkena jeda limit Discord, bot akan antre otomatis dan mengulang putaran kedua hingga 100% tuntas tanpa ada yang terlewati).

5. **Pengelompokan Rapi & Aksi Massal per Kategori:**
   - Channel di dashboard kini tertata rapi dalam kelompok folder/kategori (`Akademi Crypto`, `Kelas Xander`, dll).
   - Dapat di-**Expand / Collapse** per kategori.
   - Tersedia tombol **Search & Filter Dropdown**.
   - Tersedia tombol **Mute All**, **Rename**, dan **Delete Category** untuk menghapus seluruh channel dalam satu kelas sekaligus dengan sekali klik!
   - Tombol **"Lengkapi Webhook Kosong"** untuk memindai dan memperbaiki webhook yang belum terpasang secara instan.

---

## 🚀 FITUR BARU: AUTO-PROMO & MARKETING BOT MULTI-TOKEN (ANTI-BAN)

Fitur marketing profesional untuk mempromosikan mirror kelas/layanan Anda ke banyak server Discord sekaligus secara otomatis, aman, dan tanpa risiko terkena ban.

### 🛡️ Fitur Keamanan Anti-Ban Mutakhir:
1. **Multi-Account Multitasking Pool:**
   - Mendukung banyak akun token Discord (5, 10, 20+ akun).
   - Beban pengiriman dibagi rata secara **Round-Robin** sehingga tidak ada 1 akun yang mengirim terlalu banyak.
   - Bisa import langsung dari token mirror bot atau masukkan akun cadangan baru.
2. **Recursive Spintax Engine `{Pilihan 1|Pilihan 2|Pilihan 3}`:**
   - Setiap pesan diacak variasinya secara otomatis sehingga hash pesan tidak pernah sama.
   - Variabel dinamis: `{server}`, `{channel}`, `{time}`, `{date}`, `{random_code}`, `{random_emoji}`.
3. **Delay Acak & Human Jitter:**
   - Jeda antar pesan diacak (contoh: 90 s.d. 240 detik), bukan jeda statis yang mudah ditandai bot detektor Discord.
4. **Human Typing Emulation:**
   - Bot otomatis memicu status *"Typing..."* selama 3–7 detik sebelum pesan diposting layaknya manusia mengetik.
5. **Safe Quota Guard (Per-Account & Per-Channel):**
   - Batas per jam (contoh: maks 6 pesan/jam per akun).
   - Batas per hari (contoh: maks 30 pesan/hari per akun).
   - Cooldown channel (contoh: tidak posting ke channel yang sama sebelum 120 menit).
6. **Smart Rate-Limit (429) Auto-Pause:**
   - Jika Discord mengembalikan status 429, bot membaca `retry_after`, mengistirahatkan akun tersebut sementara, dan melanjutkan promosi dengan akun sehat lainnya tanpa error.
7. **Auto-Channel Scanner (Discovery):**
   - Pindai otomatis semua channel di server yang dimasuki akun dan hanya pilih channel yang memiliki izin kirim pesan.

