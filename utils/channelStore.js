// ============================================================
//   UTILS / CHANNELSTORE.JS
//   Manajemen channel mapping yang persisten & hot-reloadable
//
//   File penyimpanan: data/channels.json
//   Format:
//   [
//     {
//       "name":      "akademicrypto",     ← label bebas (untuk identifikasi)
//       "discordId": "1494966942568550441",
//       "tgChatId":  "-1003991448470",
//       "botKey":    "2",                 ← nomor TELEGRAM_BOT_X
//       "threadId":  "94"                 ← null jika tidak pakai Topic/Forum
//     }
//   ]
//
//   Hot-reload:
//     Saat channels.json diedit & disimpan → bot otomatis reload
//     tanpa perlu restart.
//
//   API publik:
//     channelStore.attachMap(map, tgManager) — hubungkan ke Map utama bot
//     channelStore.startWatcher()            — aktifkan hot-reload
//     channelStore.add(channel)             — tambah/update channel
//     channelStore.remove(discordId)        — hapus channel
//     channelStore.list()                   — daftar semua channel
//     channelStore.importFromEnv(str)       — migrasi dari CHANNEL_MAPPING env
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const CHANNELS_FILE = path.join(__dirname, '..', 'data', 'channels.json');

class ChannelStore {
  constructor() {
    this.channels   = [];   // Array of channel objects
    this._map       = null; // Reference ke Map utama bot (diisi via attachMap)
    this._tgManager = null; // Reference ke tgManager (untuk validasi botKey)
    this._watcher   = null;
    this._debounce  = null;
    this._ensureDir();
    this._load();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _ensureDir() {
    const dir = path.dirname(CHANNELS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(CHANNELS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
        if (Array.isArray(raw)) {
          this.channels = raw.map(ch => ({
            name:      ch.name     || `channel-${Date.now()}`,
            discordId: String(ch.discordId),
            tgChatId:  String(ch.tgChatId),
            botKey:    String(ch.botKey   || '1'),
            threadId:  ch.threadId ? String(ch.threadId) : null,
            dcWebhookUrl: ch.dcWebhookUrl || null,
            dcThreadId: ch.dcThreadId ? String(ch.dcThreadId) : null,
            dcCustomUsername: ch.dcCustomUsername || null,
            dcCustomAvatarUrl: ch.dcCustomAvatarUrl || null,
            dcAutoPing: ch.dcAutoPing || null,
            dcOnlyWithMedia: ch.dcOnlyWithMedia === true,
            dcStripInvites: ch.dcStripInvites !== false,
          }));
          return true;
        }
      }
    } catch (err) {
      logger.warn('channelStore: gagal baca channels.json', err.message);
    }
    return false;
  }

  _save() {
    try {
      this._ensureDir();
      const tmpFile = CHANNELS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.channels, null, 2), 'utf-8');
      fs.renameSync(tmpFile, CHANNELS_FILE);
    } catch (err) {
      logger.warn('channelStore: gagal simpan channels.json', err.message);
    }
  }

  /** Rebuild Map utama dari array channels */
  _rebuildMap() {
    if (!this._map) return;
    this._map.clear();

    for (const ch of this.channels) {
      // Validasi botKey jika tgManager tersedia
      if (this._tgManager && !this._tgManager.get(ch.botKey)) {
        logger.warn(`channelStore: Bot #${ch.botKey} tidak ditemukan, skip "${ch.name}"`);
        continue;
      }
      this._map.set(ch.discordId, {
        tgChatId:   ch.tgChatId,
        botKey:     ch.botKey,
        tgThreadId: ch.threadId || null,
        dcWebhookUrl: ch.dcWebhookUrl || null,
        dcThreadId: ch.dcThreadId || null,
        dcCustomUsername: ch.dcCustomUsername || null,
        dcCustomAvatarUrl: ch.dcCustomAvatarUrl || null,
        dcAutoPing: ch.dcAutoPing || null,
        dcOnlyWithMedia: ch.dcOnlyWithMedia === true,
        dcStripInvites: ch.dcStripInvites !== false,
        name:       ch.name,
      });
    }
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  /**
   * Hubungkan channelStore ke Map utama yang dipakai seluruh bot.
   * Map yang sama (by reference) → saat di-rebuild, semua bagian bot
   * langsung melihat data terbaru tanpa restart.
   */
  attachMap(channelMap, tgManager = null) {
    this._map       = channelMap;
    this._tgManager = tgManager;
    this._rebuildMap();
  }

  /**
   * Aktifkan hot-reload: perubahan pada channels.json langsung diterapkan
   * tanpa restart bot.
   */
  startWatcher() {
    if (this._watcher || !fs.existsSync(CHANNELS_FILE)) return;

    try {
      this._watcher = fs.watch(CHANNELS_FILE, (event) => {
        if (event !== 'change') return;
        // Debounce 600ms agar tidak double-fire (perilaku Windows)
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
          const ok = this._load();
          if (ok) {
            this._rebuildMap();
            logger.success(`🔄 channels.json hot-reload! ${this._map?.size || 0} channel aktif`);
          }
        }, 600);
      });
      logger.info('channelStore: hot-reload aktif — edit channels.json → langsung berlaku');
    } catch (err) {
      logger.warn('channelStore: hot-reload tidak aktif', err.message);
    }
  }

  // ─── Migrasi ──────────────────────────────────────────────────────────────

  /**
   * Import channel dari format lama CHANNEL_MAPPING di .env
   * Hanya dijalankan saat channels.json belum ada.
   * @param {string} envString — nilai CHANNEL_MAPPING
   * @returns {number} jumlah channel yang berhasil diimpor
   */
  importFromEnv(envString) {
    if (!envString || envString.includes('DISCORD_CHANNEL')) return 0;
    let count = 0;

    envString.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
      const parts    = pair.split(':').map(s => s.trim());
      if (parts.length < 2) return;

      const discordId = parts[0];
      const tgChatId  = parts[1];
      const botKey    = parts[2] || '1';
      const threadId  = parts[3] || null;
      if (!discordId || !tgChatId) return;

      // Hindari duplikat
      if (this.channels.find(c => c.discordId === discordId)) return;

      count++;
      this.channels.push({
        name:      `channel-${count}`,
        discordId,
        tgChatId,
        botKey,
        threadId,
      });
    });

    if (count > 0) {
      this._save();
      logger.info(`channelStore: ${count} channel diimpor dari CHANNEL_MAPPING → channels.json`);
    }
    return count;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * Tambah atau update channel.
   * @param {{ name, discordId, tgChatId, botKey, threadId }} channel
   */
  add(channel) {
    const ch = {
      name:      channel.name      || `channel-${this.channels.length + 1}`,
      discordId: String(channel.discordId),
      tgChatId:  String(channel.tgChatId),
      botKey:    String(channel.botKey  || '1'),
      threadId:  channel.threadId ? String(channel.threadId) : null,
      dcWebhookUrl: channel.dcWebhookUrl || null,
      dcThreadId: channel.dcThreadId ? String(channel.dcThreadId) : null,
      dcCustomUsername: channel.dcCustomUsername || null,
      dcCustomAvatarUrl: channel.dcCustomAvatarUrl || null,
      dcAutoPing: channel.dcAutoPing || null,
      dcOnlyWithMedia: channel.dcOnlyWithMedia === true,
      dcStripInvites: channel.dcStripInvites !== false,
    };

    const idx = this.channels.findIndex(c => c.discordId === ch.discordId);
    if (idx >= 0) {
      this.channels[idx] = ch; // Update existing
    } else {
      this.channels.push(ch);  // Tambah baru
    }

    this._save();
    this._rebuildMap();
    return ch;
  }

  /**
   * Hapus channel berdasarkan Discord Channel ID.
   * @returns {boolean} true jika berhasil dihapus
   */
  remove(discordId) {
    const before = this.channels.length;
    this.channels = this.channels.filter(c => c.discordId !== String(discordId));
    if (this.channels.length < before) {
      this._save();
      this._rebuildMap();
      return true;
    }
    return false;
  }

  /** Cari channel berdasarkan Discord ID */
  find(discordId) {
    return this.channels.find(c => c.discordId === String(discordId)) || null;
  }

  /** Daftar semua channel (copy array) */
  list() {
    return [...this.channels];
  }

  get size() { return this.channels.length; }
}

module.exports = new ChannelStore();
