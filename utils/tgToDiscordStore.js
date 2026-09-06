// ============================================================
//   UTILS / TGTODISCORDSTORE.JS
//   Manajemen mapping: Telegram Chat → Discord Webhook
//   Persistent ke: data/tg-to-dc-channels.json
//   Hot-reload: edit file → berlaku tanpa restart
//
//   Format JSON:
//   [
//     {
//       "name":        "nama bebas",
//       "tgChatId":   "-1001234567890",
//       "tgThreadId": null,          ← Topic/Thread TG (opsional)
//       "botKey":     "1",           ← TELEGRAM_BOT_X yang akan listen
//       "dcWebhookUrl": "https://discord.com/api/webhooks/xxx/yyy"
//     }
//   ]
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const CHANNELS_FILE = path.join(__dirname, '..', 'data', 'tg-to-dc-channels.json');

class TgToDiscordStore {
  constructor() {
    this.channels  = [];
    this._map      = null; // Map: `${tgChatId}:${tgThreadId||''}` → channel config
    this._watcher  = null;
    this._debounce = null;
    this._ensureDir();
    this._load();
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

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
            name:         ch.name         || `tg-channel-${Date.now()}`,
            tgChatId:     String(ch.tgChatId),
            tgThreadId:   ch.tgThreadId   ? String(ch.tgThreadId) : null,
            botKey:       String(ch.botKey || '1'),
            dcWebhookUrl: ch.dcWebhookUrl || '',
            autoPingText: ch.autoPingText || null,
            autoPingPosition: ch.autoPingPosition || 'bottom',
            channelTag:   ch.channelTag !== undefined ? !!ch.channelTag : false,
            ghostPing:    ch.ghostPing !== undefined ? !!ch.ghostPing : false,
          }));
          this._rebuildMap();
          return true;
        }
      }
    } catch (err) {
      logger.warn('tgToDiscordStore: gagal baca tg-to-dc-channels.json', err.message);
    }
    return false;
  }

  _save() {
    try {
      this._ensureDir();
      fs.writeFileSync(CHANNELS_FILE, JSON.stringify(this.channels, null, 2), 'utf-8');
      return true;
    } catch (err) {
      logger.warn('tgToDiscordStore: gagal simpan tg-to-dc-channels.json', err.message);
      return false;
    }
  }

  /** Rebuild lookup Map dari array channels */
  _rebuildMap() {
    this._map = new Map();
    for (const ch of this.channels) {
      if (!ch.dcWebhookUrl) continue;
      // Key: chatId saja (jika tidak ada threadId) ATAU chatId:threadId
      const key = ch.tgThreadId
        ? `${ch.tgChatId}:${ch.tgThreadId}`
        : String(ch.tgChatId);
      this._map.set(key, ch);
      // Selalu juga daftarkan key tanpa thread agar catch-all berhasil
      if (ch.tgThreadId && !this._map.has(String(ch.tgChatId))) {
        this._map.set(String(ch.tgChatId), ch);
      }
    }
  }

  // ─── Publik: Lookup ──────────────────────────────────────────────────────────

  /**
   * Cari config berdasarkan TG Chat ID dan Thread ID (opsional).
   * Prioritas: exact match (chatId+threadId) → catch-all (chatId saja)
   */
  findByTgChat(tgChatId, tgThreadId = null) {
    const chatStr = String(tgChatId);
    if (tgThreadId) {
      const exact = this._map?.get(`${chatStr}:${String(tgThreadId)}`);
      if (exact) return exact;
    }
    return this._map?.get(chatStr) || null;
  }

  /** Cek apakah tgChatId ada dalam mapping */
  hasChat(tgChatId) {
    return !!this.findByTgChat(tgChatId);
  }

  // ─── Publik: CRUD ─────────────────────────────────────────────────────────────

  /**
   * Tambah atau update mapping.
   * @param {{ name, tgChatId, tgThreadId, botKey, dcWebhookUrl }} channel
   */
  add(channel) {
    if (!channel.tgChatId || !channel.dcWebhookUrl) {
      logger.warn('tgToDiscordStore: tgChatId dan dcWebhookUrl wajib diisi');
      return null;
    }
    const ch = {
      name:         channel.name         || `tg-ch-${this.channels.length + 1}`,
      tgChatId:     String(channel.tgChatId),
      tgThreadId:   channel.tgThreadId   ? String(channel.tgThreadId) : null,
      botKey:       String(channel.botKey || '1'),
      dcWebhookUrl: channel.dcWebhookUrl,
      autoPingText: channel.autoPingText || null,
      autoPingPosition: channel.autoPingPosition || 'bottom',
      channelTag:   channel.channelTag !== undefined ? !!channel.channelTag : false,
      ghostPing:    channel.ghostPing !== undefined ? !!channel.ghostPing : false,
    };
    // Cari existing (match by tgChatId + tgThreadId)
    const idx = this.channels.findIndex(c =>
      c.tgChatId === ch.tgChatId && (c.tgThreadId || null) === (ch.tgThreadId || null)
    );
    if (idx >= 0) {
      this.channels[idx] = ch;
    } else {
      this.channels.push(ch);
    }
    this._save();
    this._rebuildMap();
    logger.info(`tgToDiscordStore: mapping [${ch.name}] TG:${ch.tgChatId} → DC Webhook ditambahkan`);
    return ch;
  }

  /**
   * Hapus mapping berdasarkan tgChatId (dan opsional tgThreadId)
   * @param {string} tgChatId
   * @param {string|null} tgThreadId
   */
  remove(tgChatId, tgThreadId = null) {
    const before = this.channels.length;
    this.channels = this.channels.filter(c => {
      if (c.tgChatId !== String(tgChatId)) return true;
      if (tgThreadId && c.tgThreadId !== String(tgThreadId)) return true;
      return false;
    });
    if (this.channels.length < before) {
      this._save();
      this._rebuildMap();
      return true;
    }
    return false;
  }

  /** Hapus berdasarkan index (untuk dashboard) */
  removeByIndex(idx) {
    if (idx < 0 || idx >= this.channels.length) return false;
    this.channels.splice(idx, 1);
    this._save();
    this._rebuildMap();
    return true;
  }

  /** Cari channel by tgChatId (array, bisa banyak thread) */
  findAllByChat(tgChatId) {
    return this.channels.filter(c => c.tgChatId === String(tgChatId));
  }

  /** Daftar semua channel */
  list() {
    return [...this.channels];
  }

  get size() { return this.channels.length; }

  // ─── Hot-reload ───────────────────────────────────────────────────────────────

  startWatcher() {
    if (this._watcher) return;
    if (!fs.existsSync(CHANNELS_FILE)) return;

    try {
      this._watcher = fs.watch(CHANNELS_FILE, (event) => {
        if (event !== 'change') return;
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
          const ok = this._load();
          if (ok) {
            logger.success(`🔄 tg-to-dc-channels.json hot-reload! ${this.size} mapping aktif`);
          }
        }, 600);
      });
      logger.info('tgToDiscordStore: hot-reload aktif');
    } catch (err) {
      logger.warn('tgToDiscordStore: hot-reload tidak aktif', err.message);
    }
  }
}

module.exports = new TgToDiscordStore();
