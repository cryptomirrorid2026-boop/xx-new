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

const CHANNELS_FILE   = path.join(__dirname, '..', 'data', 'channels.json');
const CATEGORIES_FILE    = path.join(__dirname, '..', 'data', 'categories.json');
const CAT_DELAYS_FILE    = path.join(__dirname, '..', 'data', 'categoryDelays.json');

class ChannelStore {
  constructor() {
    this.channels         = [];   // Array of channel objects
    this.customCategories = new Set(['General']); // Set of category names
    this.categoryDelays   = new Map();            // Map<categoryName, delayMs>
    this._map             = null; // Reference ke Map utama bot (diisi via attachMap)
    this._tgManager       = null; // Reference ke tgManager (untuk validasi botKey)
    this._watcher         = null;
    this._debounce        = null;
    this.autoHealthTimer       = null;
    this.lastAutoHealthCheckAt = null;
    this.pushEventFn           = null;
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
            category:  ch.category ? String(ch.category).trim() : 'General',
            name:      ch.name     || `channel-${Date.now()}`,
            discordId: String(ch.discordId),
            tgChatId:  String(ch.tgChatId || ''),
            botKey:    String(ch.botKey   || '1'),
            threadId:  ch.threadId ? String(ch.threadId) : null,
            dcWebhookUrl: ch.dcWebhookUrl || null,
            targetChannelId: ch.targetChannelId ? String(ch.targetChannelId) : null,
            targetGuildId: ch.targetGuildId ? String(ch.targetGuildId) : null,
            dcThreadId: ch.dcThreadId ? String(ch.dcThreadId) : null,
            dcCustomUsername: ch.dcCustomUsername || null,
            dcCustomAvatarUrl: ch.dcCustomAvatarUrl || null,
            dcAutoPing: ch.dcAutoPing || null,
            dcOnlyWithMedia: ch.dcOnlyWithMedia === true,
            dcStripInvites: ch.dcStripInvites !== false,
            forwardDelayMs: typeof ch.forwardDelayMs === 'number' ? ch.forwardDelayMs : -1,
            lastActiveAt: ch.lastActiveAt || null,
            lastCheckStatus: ch.lastCheckStatus || 'unknown',
            lastCheckError: ch.lastCheckError || null,
          }));
          return true;
        }
      }
    } catch (err) {
      logger.warn('channelStore: gagal baca channels.json', err.message);
    }

    // Load category delays
    try {
      if (fs.existsSync(CAT_DELAYS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CAT_DELAYS_FILE, 'utf-8'));
        if (raw && typeof raw === 'object') {
          this.categoryDelays = new Map(Object.entries(raw).map(([k,v]) => [k, Number(v) || 0]));
        }
      }
    } catch (_) {}

    try {
      if (fs.existsSync(CATEGORIES_FILE)) {
        const catRaw = JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf-8'));
        if (Array.isArray(catRaw)) {
          catRaw.forEach(c => { if (c) this.customCategories.add(String(c).trim()); });
        }
      }
    } catch (_) {}

    return false;
  }

  _saveCategories() {
    try {
      this._ensureDir();
      fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(Array.from(this.customCategories), null, 2), 'utf-8');
    } catch (err) {
      logger.warn('channelStore: gagal simpan categories.json', err.message);
    }
  }

  _saveCategoryDelays() {
    try {
      this._ensureDir();
      const obj = Object.fromEntries(this.categoryDelays);
      fs.writeFileSync(CAT_DELAYS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('channelStore: gagal simpan categoryDelays.json', err.message);
    }
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
      // Validasi botKey jika tgManager tersedia dan bukan hanya DC->DC
      if (!ch.dcWebhookUrl && this._tgManager && !this._tgManager.get(ch.botKey)) {
        logger.warn(`channelStore: Bot #${ch.botKey} tidak ditemukan, skip "${ch.name}"`);
        continue;
      }
      this._map.set(ch.discordId, {
        category:   ch.category || 'General',
        tgChatId:   ch.tgChatId,
        botKey:     ch.botKey,
        tgThreadId: ch.threadId || null,
        dcWebhookUrl: ch.dcWebhookUrl || null,
        targetChannelId: ch.targetChannelId || null,
        targetGuildId: ch.targetGuildId || null,
        dcThreadId: ch.dcThreadId || null,
        dcCustomUsername: ch.dcCustomUsername || null,
        dcCustomAvatarUrl: ch.dcCustomAvatarUrl || null,
        dcAutoPing: ch.dcAutoPing || null,
        dcOnlyWithMedia: ch.dcOnlyWithMedia === true,
        dcStripInvites: ch.dcStripInvites !== false,
        forwardDelayMs: typeof ch.forwardDelayMs === 'number' ? ch.forwardDelayMs : -1,
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
   * @param {{ name, discordId, tgChatId, botKey, threadId, category, dcWebhookUrl, targetChannelId, targetGuildId }} channel
   */
  add(channel) {
    const ch = {
      category:  channel.category ? String(channel.category).trim() : 'General',
      name:      channel.name      || `channel-${this.channels.length + 1}`,
      discordId: String(channel.discordId),
      tgChatId:  String(channel.tgChatId || ''),
      botKey:    String(channel.botKey  || '1'),
      threadId:  channel.threadId ? String(channel.threadId) : null,
      dcWebhookUrl: channel.dcWebhookUrl || null,
      targetChannelId: channel.targetChannelId ? String(channel.targetChannelId) : null,
      targetGuildId: channel.targetGuildId ? String(channel.targetGuildId) : null,
      dcThreadId: channel.dcThreadId ? String(channel.dcThreadId) : null,
      dcCustomUsername: channel.dcCustomUsername || null,
      dcCustomAvatarUrl: channel.dcCustomAvatarUrl || null,
      dcAutoPing: channel.dcAutoPing || null,
      dcOnlyWithMedia: channel.dcOnlyWithMedia === true,
      dcStripInvites: channel.dcStripInvites !== false,
      forwardDelayMs: typeof channel.forwardDelayMs === 'number' ? channel.forwardDelayMs : -1,
      lastActiveAt: channel.lastActiveAt || null,
      lastCheckStatus: channel.lastCheckStatus || 'unknown',
      lastCheckError: channel.lastCheckError || null,
    };

    const idx = this.channels.findIndex(c => c.discordId === ch.discordId);
    if (idx >= 0) {
      ch.lastActiveAt = this.channels[idx].lastActiveAt || ch.lastActiveAt;
      ch.lastCheckStatus = this.channels[idx].lastCheckStatus || ch.lastCheckStatus;
      ch.lastCheckError = this.channels[idx].lastCheckError || ch.lastCheckError;
    }
    if (idx >= 0) {
      this.channels[idx] = ch; // Update existing
    } else {
      this.channels.push(ch);  // Tambah baru
    }

    this.customCategories.add(ch.category);
    this._saveCategories();

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

  /** Alias untuk find() agar kompatibel */
  get(discordId) {
    return this.find(discordId);
  }

  /** Daftar semua channel (copy array) */
  list() {
    return [...this.channels];
  }

  /**
   * Ambil daftar kategori unik beserta jumlah channelnya
   * @returns {Array<{ name: string, count: number }>}
   */
  listCategories() {
    const counts = {};
    for (const cat of this.customCategories) {
      counts[cat] = 0;
    }
    for (const ch of this.channels) {
      const cat = ch.category || 'General';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
  }

  /**
   * Buat kategori baru (meski belum ada channel di dalamnya)
   * @param {string} categoryName 
   */
  createCategory(categoryName) {
    const name = String(categoryName || '').trim();
    if (!name) throw new Error('Nama kategori tidak boleh kosong');
    this.customCategories.add(name);
    this._saveCategories();
    return name;
  }

  /**
   * Pindahkan sejumlah channel ke kategori tertentu
   * @param {Array<string>} channelIds 
   * @param {string} targetCategory 
   * @returns {number} jumlah channel yang dipindahkan
   */
  moveChannels(channelIds, targetCategory) {
    const toCat = String(targetCategory || '').trim() || 'General';
    const idSet = new Set(channelIds.map(String));
    let moved = 0;
    for (const ch of this.channels) {
      if (idSet.has(ch.discordId)) {
        ch.category = toCat;
        moved++;
      }
    }
    this.customCategories.add(toCat);
    this._saveCategories();
    if (moved > 0) {
      this._save();
      this._rebuildMap();
    }
    return moved;
  }

  /**
   * Ambil semua channel di kategori tertentu
   * @param {string} categoryName 
   */
  getByCategory(categoryName) {
    const target = String(categoryName || '').toLowerCase().trim();
    return this.channels.filter(c => (c.category || 'General').toLowerCase().trim() === target);
  }

  /**
   * Hapus semua channel di bawah sebuah kategori
   * @param {string} categoryName 
   * @returns {number} jumlah channel yang dihapus
   */
  deleteCategory(categoryName) {
    const target = String(categoryName || '').toLowerCase().trim();
    const before = this.channels.length;
    this.channels = this.channels.filter(c => (c.category || 'General').toLowerCase().trim() !== target);
    for (const c of this.customCategories) {
      if (c.toLowerCase().trim() === target) {
        this.customCategories.delete(c);
      }
    }
    this._saveCategories();
    const count = before - this.channels.length;
    if (count > 0) {
      this._save();
      this._rebuildMap();
    }
    return count;
  }

  /**
   * Ganti nama kategori untuk semua channel di dalamnya
   * @param {string} oldName 
   * @param {string} newName 
   */
  renameCategory(oldName, newName) {
    const from = String(oldName || '').toLowerCase().trim();
    const to = String(newName || '').trim() || 'General';
    let changed = 0;
    for (const ch of this.channels) {
      if ((ch.category || 'General').toLowerCase().trim() === from) {
        ch.category = to;
        changed++;
      }
    }
    for (const c of this.customCategories) {
      if (c.toLowerCase().trim() === from) {
        this.customCategories.delete(c);
        this.customCategories.add(to);
      }
    }
    this._saveCategories();
    if (changed > 0) {
      this._save();
      this._rebuildMap();
    }
    return changed;
  }

  /**
   * Mute atau unmute seluruh channel di bawah sebuah kategori
   * @param {string} categoryName 
   * @param {boolean} shouldMute 
   */
  muteCategory(categoryName, shouldMute = true) {
    const mutedChannels = require('./mutedChannels');
    const target = String(categoryName || '').toLowerCase().trim();
    const affected = [];
    for (const ch of this.channels) {
      if ((ch.category || 'General').toLowerCase().trim() === target) {
        if (shouldMute) {
          mutedChannels.add(ch.discordId);
        } else {
          mutedChannels.remove(ch.discordId);
        }
        affected.push(ch.discordId);
      }
    }
    return affected;
  }

  /**
   * Catat aktivitas terbaru saat ada pesan masuk / forward dari channel Discord ini
   */
  recordActivity(discordId) {
    if (!discordId) return;
    const ch = this.channels.find(c => c.discordId === String(discordId));
    if (ch) {
      ch.lastActiveAt = new Date().toISOString();
      ch.lastCheckStatus = 'ok';
      ch.lastCheckError = null;
      this._save();
    }
  }

  /**
   * Update status hasil pengecekan keberadaan channel
   */
  updateHealthStatus(discordId, status, errorMsg = null) {
    const ch = this.channels.find(c => c.discordId === String(discordId));
    if (ch) {
      ch.lastCheckStatus = status;
      ch.lastCheckError = errorMsg;
      this._save();
    }
  }

  /**
   * Mulai sistem pengecekan keaktifan channel otomatis 24 Jam Non-stop
   */
  start24hAutoHealthCheck(discordRegistry, intervalMs = 10 * 60 * 1000, pushEventFn = null) {
    if (this.autoHealthTimer) {
      clearInterval(this.autoHealthTimer);
      this.autoHealthTimer = null;
    }
    if (pushEventFn) {
      this.pushEventFn = pushEventFn;
    }

    logger.info(`🛡️ [Channel Health 24/7] Auto-checker aktif! Memeriksa status berkala setiap ${Math.round(intervalMs / 60000)} menit.`);

    // Jalankan pemeriksaan awal segera (delay 5 detik agar cache Discord terisi)
    setTimeout(() => {
      this.checkAllChannelsHealth(discordRegistry).catch(err => {
        logger.warn('[Channel Health 24/7] Error pada cek awal:', err.message);
      });
    }, 5000);

    // Jalankan berulang 24 jam nonstop
    this.autoHealthTimer = setInterval(() => {
      this.checkAllChannelsHealth(discordRegistry).catch(err => {
        logger.warn('[Channel Health 24/7] Error pada cek berkala:', err.message);
      });
    }, intervalMs);

    if (this.autoHealthTimer.unref) {
      this.autoHealthTimer.unref();
    }
  }

  /**
   * Periksa apakah setiap channel Discord masih ada dan bisa diakses oleh bot token
   */
  async checkAllChannelsHealth(discordRegistry) {
    if (!discordRegistry) return { checked: 0, results: {} };
    const clients = discordRegistry.getClients ? discordRegistry.getClients() : [];
    const results = {};
    let checked = 0;

    // Filter client yang sudah siap/terkoneksi
    const readyClients = clients.filter(c => c && (c.isReady ? c.isReady() : (c.ws?.status === 0 || c.user)));

    if (readyClients.length === 0) {
      logger.warn('[Channel Health 24/7] Discord client belum online, menunda verifikasi status.');
      for (const ch of this.channels) {
        if (!ch.lastCheckStatus || ch.lastCheckStatus === 'unknown') {
          ch.lastCheckStatus = 'unknown';
          ch.lastCheckError = 'Menunggu Discord bot online...';
        }
        results[ch.discordId] = { status: ch.lastCheckStatus, reason: ch.lastCheckError, name: ch.name };
      }
      return { checked: 0, results };
    }

    // Bangun map ID channel dari cache seluruh client (0ms, tidak makan kuota REST)
    const cachedChannelMap = new Map();
    for (const c of readyClients) {
      if (c.channels?.cache) {
        for (const [chId, chObj] of c.channels.cache) {
          if (!cachedChannelMap.has(chId)) {
            cachedChannelMap.set(chId, chObj);
          }
        }
      }
    }

    for (const ch of this.channels) {
      const id = String(ch.discordId);
      checked++;
      let found = false;
      let errorReason = null;
      let checkStatus = 'ok';

      // 1. Cek di cache memori Discord
      if (cachedChannelMap.has(id)) {
        const cachedCh = cachedChannelMap.get(id);
        if (cachedCh && cachedCh.viewable === false) {
          found = false;
          checkStatus = 'no_access';
          errorReason = 'Bot tidak memiliki hak akses melihat channel ini (viewable: false)';
        } else {
          found = true;
          checkStatus = 'ok';
          errorReason = null;
        }
      }

      // 2. Jika tidak ada di cache, coba fetch dengan proteksi rate limit
      if (!found && checkStatus !== 'no_access') {
        for (const c of readyClients) {
          try {
            // Beri jeda kecil agar aman dari rate limit REST API
            await new Promise(r => setTimeout(r, 60));
            const fetched = await c.channels?.fetch(id).catch(err => {
              if (err.code === 10003) {
                errorReason = 'Channel dihapus atau tidak ditemukan di Discord (Code 10003: Unknown Channel)';
                checkStatus = 'not_found';
              } else if (err.code === 50001) {
                errorReason = 'Bot tidak ada di server ini atau tidak memiliki izin akses (Code 50001: Missing Access)';
                checkStatus = 'no_access';
              } else if (err.code === 50004) {
                errorReason = 'Server Discord sedang down/tidak dapat diakses (Code 50004)';
                checkStatus = 'inactive';
              } else if (err.status === 429) {
                errorReason = 'Discord API rate limit hit';
              } else {
                errorReason = err.message;
              }
              return null;
            });

            if (fetched) {
              if (fetched.viewable === false) {
                found = false;
                checkStatus = 'no_access';
                errorReason = 'Bot tidak memiliki hak akses melihat channel ini (viewable: false)';
              } else {
                found = true;
                checkStatus = 'ok';
                errorReason = null;
                cachedChannelMap.set(id, fetched);
                break;
              }
            }
          } catch (e) {
            errorReason = e.message;
          }
        }
      }

      if (found) {
        ch.lastCheckStatus = 'ok';
        ch.lastCheckError = null;
        results[id] = { status: 'ok', name: ch.name };
      } else {
        ch.lastCheckStatus = checkStatus !== 'ok' ? checkStatus : 'inactive';
        ch.lastCheckError = errorReason || 'Channel tidak ditemukan di seluruh akun Discord bot';
        results[id] = { status: ch.lastCheckStatus, reason: ch.lastCheckError, name: ch.name };
      }
    }

    this.lastAutoHealthCheckAt = new Date().toISOString();
    this._save();

    const notFoundCount = Object.values(results).filter(r => r.status === 'not_found' || r.status === 'no_access' || r.status === 'inactive').length;
    logger.info(`🛡️ [Channel Health 24/7] Selesai memeriksa ${checked} channel. Normal: ${checked - notFoundCount}, Bermasalah: ${notFoundCount}`);

    if (this.pushEventFn) {
      if (notFoundCount > 0) {
        this.pushEventFn('warning', `🛡️ [Health Check 24/7] Ditemukan <b>${notFoundCount} channel</b> yang tidak aktif / dihapus!`);
      }
      this.pushEventFn('channel_health_updated', {
        checked,
        notFoundCount,
        lastCheckedAt: this.lastAutoHealthCheckAt,
        results
      });
    }

    return { checked, notFoundCount, results, lastCheckedAt: this.lastAutoHealthCheckAt };
  }

  /**
   * Handle jika ada guild yang bot-nya dikeluarkan
   */
  handleGuildDelete(guildId) {
    if (!guildId) return;
    let count = 0;
    for (const ch of this.channels) {
      if (ch.targetGuildId === String(guildId)) {
        ch.lastCheckStatus = 'no_access';
        ch.lastCheckError = 'Bot telah dikeluarkan dari server Discord ini';
        count++;
      }
    }
    if (count > 0) this._save();
  }

  /**
   * Set forward delay untuk satu channel (dalam ms).
   * Nilai -1 berarti ikut delay kategori. 0 = tanpa delay.
   */
  setChannelDelay(discordId, delayMs) {
    const ch = this.channels.find(c => c.discordId === String(discordId));
    if (!ch) return false;
    ch.forwardDelayMs = typeof delayMs === 'number' ? Math.max(-1, delayMs) : -1;
    this._save();
    this._rebuildMap();
    return true;
  }

  /**
   * Set forward delay untuk seluruh channel di kategori tertentu.
   * @param {string} categoryName
   * @param {number} delayMs  — dalam milidetik (0 = tanpa delay)
   */
  setCategoryDelay(categoryName, delayMs) {
    const name = String(categoryName || '').trim();
    if (!name) return false;
    const ms = typeof delayMs === 'number' ? Math.max(0, delayMs) : 0;
    this.categoryDelays.set(name, ms);
    this._saveCategoryDelays();
    this._rebuildMap();
    return true;
  }

  /**
   * Ambil delay efektif sebuah channel (dalam ms).
   * Priority: channel delay (-1 = pakai kategori) → category delay → 0
   */
  getEffectiveDelay(discordId) {
    const ch = this.channels.find(c => c.discordId === String(discordId));
    if (!ch) return 0;
    if (typeof ch.forwardDelayMs === 'number' && ch.forwardDelayMs >= 0) {
      return ch.forwardDelayMs;
    }
    const catDelay = this.categoryDelays.get(ch.category || 'General');
    return typeof catDelay === 'number' ? catDelay : 0;
  }

  /** Ambil semua category delays sebagai plain object */
  getCategoryDelays() {
    return Object.fromEntries(this.categoryDelays);
  }

  get size() { return this.channels.length; }
}

module.exports = new ChannelStore();
