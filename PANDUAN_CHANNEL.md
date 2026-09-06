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
