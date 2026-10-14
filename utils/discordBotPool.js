// ============================================================
//   UTILS / DISCORDBOTPOOL.JS
//   Manajemen Bot Discord Resmi (Bot Token Pool)
//   Fungsi:
//     - Rotasi multi-bot (3-4 bot) untuk menghindari Discord rate limit
//     - Pembuatan Kategori & Channel di server tujuan
//     - Pembuatan Webhook otomatis di channel tujuan
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const logger = require('./logger');

const BOTS_FILE = path.join(__dirname, '..', 'data', 'discord-bots.json');
const DISCORD_API_BASE = 'https://discord.com/api/v10';

class DiscordBotPool {
  constructor() {
    this.tokens = [];       // Array of raw bot tokens
    this.cache  = new Map(); // token -> bot info { id, username, avatar, valid }
    this._rrIdx = 0;        // Round-robin index
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    const dir = path.dirname(BOTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _clean(t) {
    if (!t || typeof t !== 'string') return '';
    return t
      .replace(/^["']|["']$/g, '')
      .replace(/^Bot\s+/i, '')
      .trim();
  }

  _mask(t) {
    if (!t || t.length < 15) return '••••••••';
    return t.substring(0, 10) + '••••••••' + t.substring(t.length - 5);
  }

  _load() {
    const loaded = new Set();

    // 1. Baca dari file data/discord-bots.json
    try {
      if (fs.existsSync(BOTS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf-8'));
        if (Array.isArray(raw)) {
          raw.forEach(t => {
            const c = this._clean(t);
            if (c) loaded.add(c);
          });
        }
      }
    } catch (err) {
      logger.warn('DiscordBotPool: gagal baca discord-bots.json', err.message);
    }

    // 2. Baca dari environment variables (.env)
    const envVars = process.env;
    for (const [key, val] of Object.entries(envVars)) {
      if (/^DISCORD_BOT(_\d+)?$/i.test(key) || /^DISCORD_BOT_TOKENS?$/i.test(key)) {
        if (val) {
          val.split(/[\r\n,]+/).forEach(v => {
            const c = this._clean(v);
            if (c && !c.includes('ISI_') && !c.includes('your_discord_bot_token')) {
              loaded.add(c);
            }
          });
        }
      }
    }

    this.tokens = Array.from(loaded);
  }

  _save() {
    try {
      this._ensureDir();
      fs.writeFileSync(BOTS_FILE, JSON.stringify(this.tokens, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('DiscordBotPool: gagal simpan discord-bots.json', err.message);
    }
  }

  /**
   * Helper request ke Discord API dengan token bot tertentu
   */
  async _request(token, method, endpoint, data = null, retryCount = 0) {
    try {
      const headers = {
        'Authorization': `Bot ${token}`,
        'User-Agent': 'DiscordBot (https://github.com/NexusMirror, 1.0.0)',
      };
      const axiosConfig = {
        method,
        url: `${DISCORD_API_BASE}${endpoint}`,
        headers,
        timeout: 20000,
      };
      if (data && method.toUpperCase() !== 'GET') {
        headers['Content-Type'] = 'application/json';
        axiosConfig.data = data;
      }
      const res = await axios(axiosConfig);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && retryCount < 3) {
        const retryAfter = Math.ceil((err.response.data?.retry_after || 1) * 1000);
        logger.warn(`DiscordBotPool: Rate limited (429) pada endpoint ${endpoint}. Tunggu ${retryAfter}ms...`);
        await new Promise(r => setTimeout(r, retryAfter));
        return this._request(token, method, endpoint, data, retryCount + 1);
      }
      if ([500, 502, 503, 504].includes(status) && retryCount < 3) {
        const delay = (retryCount + 1) * 1500;
        logger.warn(`DiscordBotPool: Discord API gateway error (${status}) pada ${endpoint}. Mencoba ulang dalam ${delay}ms... (Percobaan ${retryCount + 1}/3)`);
        await new Promise(r => setTimeout(r, delay));
        return this._request(token, method, endpoint, data, retryCount + 1);
      }
      throw err;
    }
  }

  /**
   * Validasi bot token dan ambil info user bot
   */
  async verifyToken(token) {
    const c = this._clean(token);
    if (!c) throw new Error('Token bot tidak boleh kosong');
    try {
      const data = await this._request(c, 'GET', '/users/@me');
      if (!data || !data.id) {
        throw new Error('Data bot tidak ditemukan dari Discord API');
      }
      const info = {
        id: data.id,
        username: data.username,
        discriminator: data.discriminator || '0',
        avatar: data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : null,
        bot: Boolean(data.bot),
        valid: true,
      };
      this.cache.set(c, info);
      return info;
    } catch (err) {
      if (err.response?.status === 401) {
        throw new Error('Token Discord Bot salah / Unauthorized (401). Pastikan Anda menyalin BOT TOKEN resmi dari Discord Developer Portal (Applications > Bot > Reset Token).');
      }
      if ([500, 502, 503, 504].includes(err.response?.status)) {
        throw new Error(`Discord API gateway error (${err.response.status} Bad Gateway). Discord server sedang sibuk, silakan klik Tambah Bot sekali lagi.`);
      }
      const errMsg = err.response?.data?.message || err.message;
      throw new Error(`Token bot tidak valid: ${errMsg}`);
    }
  }

  /**
   * Tambah bot token ke pool
   */
  async addBot(token) {
    const c = this._clean(token);
    const info = await this.verifyToken(c);
    if (!this.tokens.includes(c)) {
      this.tokens.push(c);
      this._save();
    }
    return { ...info, tokenMasked: this._mask(c) };
  }

  /**
   * Hapus bot token dari pool
   */
  removeBot(tokenOrId) {
    const target = this._clean(tokenOrId);
    const before = this.tokens.length;
    this.tokens = this.tokens.filter(t => {
      const cached = this.cache.get(t);
      if (cached?.id === target || t === target) return false;
      return true;
    });
    if (this.tokens.length < before) {
      this._save();
      return true;
    }
    return false;
  }

  /**
   * Ambil daftar semua bot dalam pool beserta status validasi
   */
  async listBots() {
    const list = [];
    for (const t of this.tokens) {
      try {
        let info = this.cache.get(t);
        if (!info) {
          info = await this.verifyToken(t);
        }
        list.push({
          ...info,
          tokenMasked: this._mask(t),
          token: t,
        });
      } catch (err) {
        list.push({
          id: null,
          username: 'Invalid Bot',
          valid: false,
          error: err.message,
          tokenMasked: this._mask(t),
          token: t,
        });
      }
    }
    return list;
  }

  /**
   * Ambil token bot berikutnya secara round-robin untuk rotasi load-balancing
   */
  getNextBotToken() {
    if (this.tokens.length === 0) {
      throw new Error('Tidak ada Discord Bot Token yang terdaftar di pool. Silakan tambahkan bot token terlebih dahulu.');
    }
    const token = this.tokens[this._rrIdx % this.tokens.length];
    this._rrIdx = (this._rrIdx + 1) % this.tokens.length;
    return token;
  }

  /**
   * Ambil seluruh channel di server tujuan via Bot
   */
  async getGuildChannels(guildId) {
    const token = this.getNextBotToken();
    return await this._request(token, 'GET', `/guilds/${guildId}/channels`);
  }

  /**
   * Buat Kategori di server tujuan
   * @param {string} guildId 
   * @param {string} categoryName 
   */
  async createCategory(guildId, categoryName) {
    const token = this.getNextBotToken();
    return await this._request(token, 'POST', `/guilds/${guildId}/channels`, {
      name: categoryName,
      type: 4, // GUILD_CATEGORY
    });
  }

  /**
   * Buat Channel Teks di server tujuan di bawah kategori dengan auto-wait rate limit
   * @param {string} guildId 
   * @param {string} parentCategoryId 
   * @param {string} channelName 
   * @param {string} topic 
   * @param {Function} onWaitCallback
   */
  async createChannel(guildId, parentCategoryId, channelName, topic = '', onWaitCallback = null) {
    const payload = {
      name: channelName,
      type: 0, // GUILD_TEXT
      parent_id: parentCategoryId || null,
    };
    if (topic) payload.topic = topic.substring(0, 1024);

    const maxRounds = 5;
    for (let round = 0; round < maxRounds; round++) {
      const totalBots = Math.max(1, this.tokens.length);
      let hitRateLimit = false;
      let minRetryAfterMs = 4000;
      let lastErr = null;

      for (let i = 0; i < totalBots; i++) {
        const token = this.getNextBotToken();
        try {
          return await this._request(token, 'POST', `/guilds/${guildId}/channels`, payload);
        } catch (err) {
          lastErr = err;
          if (err.response?.status === 429) {
            hitRateLimit = true;
            const retrySec = Number(err.response.data?.retry_after || err.response.headers?.['retry-after'] || 3);
            const waitMs = Math.ceil(retrySec * 1000) + 600;
            if (waitMs < minRetryAfterMs) minRetryAfterMs = waitMs;
            logger.warn(`DiscordBotPool: Bot #${i+1} terkena rate-limit channel (429). Cooldown: ${retrySec}s.`);
            continue;
          }
          if (err.response?.status === 403) {
            throw new Error(`Bot tidak memiliki izin "Manage Channels" di server tujuan (403 Forbidden). Pastikan Bot diberi hak Administrator.`);
          }
        }
      }

      if (hitRateLimit) {
        const waitSec = Math.ceil(minRetryAfterMs / 1000);
        logger.warn(`DiscordBotPool: Menunggu cooldown pembuatan channel selama ${waitSec} detik (Round ${round + 1}/${maxRounds})...`);
        if (typeof onWaitCallback === 'function') {
          onWaitCallback(waitSec, round + 1, maxRounds);
        }
        await new Promise(r => setTimeout(r, minRetryAfterMs));
        continue;
      }

      if (lastErr) throw lastErr;
    }

    throw new Error(`Gagal membuat channel #${channelName} karena batas rate-limit.`);
  }

  /**
   * Update informasi channel di server tujuan (Rename, ganti topik, atau pindah kategori)
   * Dilengkapi auto-wait rate limit agar tidak ada yang tersekip
   * @param {string} channelId 
   * @param {{ name?: string, topic?: string, parent_id?: string }} updates 
   * @param {Function} onWaitCallback
   */
  async updateChannel(channelId, updates = {}, onWaitCallback = null) {
    const payload = {};
    if (updates.name) payload.name = updates.name.trim().toLowerCase().replace(/\s+/g, '-');
    if (updates.topic !== undefined) payload.topic = updates.topic ? String(updates.topic).substring(0, 1024) : null;
    if (updates.parent_id !== undefined) payload.parent_id = updates.parent_id || null;

    const maxRounds = 5;
    for (let round = 0; round < maxRounds; round++) {
      const totalBots = Math.max(1, this.tokens.length);
      let hitRateLimit = false;
      let minRetryAfterMs = 4000;
      let lastErr = null;

      for (let i = 0; i < totalBots; i++) {
        const token = this.getNextBotToken();
        try {
          return await this._request(token, 'PATCH', `/channels/${channelId}`, payload);
        } catch (err) {
          lastErr = err;
          if (err.response?.status === 404) return null;
          if (err.response?.status === 429) {
            hitRateLimit = true;
            const retrySec = Number(err.response.data?.retry_after || err.response.headers?.['retry-after'] || 3);
            const waitMs = Math.ceil(retrySec * 1000) + 600;
            if (waitMs < minRetryAfterMs) minRetryAfterMs = waitMs;
            logger.warn(`DiscordBotPool: Bot #${i+1} terkena rate-limit update channel (429). Cooldown: ${retrySec}s.`);
            continue;
          }
          if (err.response?.status === 403) {
            throw new Error(`Bot tidak memiliki izin "Manage Channels" di server tujuan (403 Forbidden).`);
          }
        }
      }

      if (hitRateLimit) {
        const waitSec = Math.ceil(minRetryAfterMs / 1000);
        logger.warn(`DiscordBotPool: Menunggu cooldown update channel selama ${waitSec} detik (Round ${round + 1}/${maxRounds})...`);
        if (typeof onWaitCallback === 'function') onWaitCallback(waitSec, round + 1, maxRounds);
        await new Promise(r => setTimeout(r, minRetryAfterMs));
        continue;
      }
      if (lastErr) throw lastErr;
    }
    throw new Error(`Gagal update channel ${channelId} setelah ${maxRounds} putaran karena batas rate-limit.`);
  }

  /**
   * Hapus channel di server tujuan via Bot
   * Dilengkapi auto-wait rate limit
   * @param {string} channelId 
   * @param {Function} onWaitCallback
   */
  async deleteChannel(channelId, onWaitCallback = null) {
    const maxRounds = 5;
    for (let round = 0; round < maxRounds; round++) {
      const totalBots = Math.max(1, this.tokens.length);
      let hitRateLimit = false;
      let minRetryAfterMs = 4000;
      let lastErr = null;

      for (let i = 0; i < totalBots; i++) {
        const token = this.getNextBotToken();
        try {
          return await this._request(token, 'DELETE', `/channels/${channelId}`);
        } catch (err) {
          lastErr = err;
          if (err.response?.status === 404) return true; // Sudah terhapus
          if (err.response?.status === 429) {
            hitRateLimit = true;
            const retrySec = Number(err.response.data?.retry_after || err.response.headers?.['retry-after'] || 3);
            const waitMs = Math.ceil(retrySec * 1000) + 600;
            if (waitMs < minRetryAfterMs) minRetryAfterMs = waitMs;
            logger.warn(`DiscordBotPool: Bot #${i+1} terkena rate-limit delete channel (429). Cooldown: ${retrySec}s.`);
            continue;
          }
          if (err.response?.status === 403) {
            throw new Error(`Bot tidak memiliki izin "Manage Channels" di server tujuan (403 Forbidden).`);
          }
        }
      }

      if (hitRateLimit) {
        const waitSec = Math.ceil(minRetryAfterMs / 1000);
        logger.warn(`DiscordBotPool: Menunggu cooldown delete channel selama ${waitSec} detik (Round ${round + 1}/${maxRounds})...`);
        if (typeof onWaitCallback === 'function') onWaitCallback(waitSec, round + 1, maxRounds);
        await new Promise(r => setTimeout(r, minRetryAfterMs));
        continue;
      }
      if (lastErr) throw lastErr;
    }
    throw new Error(`Gagal hapus channel ${channelId} setelah ${maxRounds} putaran karena batas rate-limit.`);
  }

  /**
   * Dapatkan detail webhook (channel_id, guild_id, name) langsung dari webhook URL tanpa perlu bot token
   * @param {string} webhookUrl 
   */
  async getWebhookDetails(webhookUrl) {
    if (!webhookUrl || typeof webhookUrl !== 'string') return null;
    try {
      const res = await axios.get(webhookUrl.trim(), { timeout: 8000 });
      return res.data;
    } catch (_) {
      return null;
    }
  }

  /**
   * Ambil daftar webhook yang sudah ada di suatu channel
   * @param {string} channelId 
   */
  async getChannelWebhooks(channelId) {
    if (this.tokens.length === 0) return [];
    const token = this.getNextBotToken();
    try {
      const data = await this._request(token, 'GET', `/channels/${channelId}/webhooks`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      logger.warn(`DiscordBotPool: Gagal ambil webhook di channel ${channelId}: ${err.message}`);
      return [];
    }
  }

  /**
   * Buat Webhook di channel tujuan dengan rotasi bot dan auto-wait rate limit
   * @param {string} channelId 
   * @param {string} webhookName 
   * @param {Function} onWaitCallback (callback saat menunggu cooldown rate limit)
   */
  async createWebhook(channelId, webhookName = 'Nexus Mirror', onWaitCallback = null) {
    // 1. Cek apakah di channel ini sudah ada webhook yang bisa dipakai (hindari duplikat & hemat kuota)
    try {
      const existingWebhooks = await this.getChannelWebhooks(channelId);
      if (Array.isArray(existingWebhooks) && existingWebhooks.length > 0) {
        const match = existingWebhooks.find(w => w.token && w.name && w.name.toLowerCase().includes('nexus')) 
                   || existingWebhooks.find(w => w.token);
        if (match && match.token) {
          logger.info(`DiscordBotPool: Menggunakan webhook yang sudah ada di channel ${channelId}: "${match.name}"`);
          return {
            id: match.id,
            token: match.token,
            url: match.url || `https://discord.com/api/webhooks/${match.id}/${match.token}`,
            channelId: match.channel_id,
            guildId: match.guild_id,
            reused: true,
          };
        }
      }
    } catch (_) {}

    // 2. Buat webhook baru dengan sistem rotasi dan retry cerdas (JANGAN DI-SKIP)
    const maxGlobalRounds = 8;
    for (let round = 0; round < maxGlobalRounds; round++) {
      const totalBots = Math.max(1, this.tokens.length);
      let hitRateLimit = false;
      let minRetryAfterMs = 4000;
      let lastErr = null;

      for (let i = 0; i < totalBots; i++) {
        const token = this.getNextBotToken();
        try {
          const data = await this._request(token, 'POST', `/channels/${channelId}/webhooks`, {
            name: webhookName,
          });
          return {
            id: data.id,
            token: data.token,
            url: data.url || `https://discord.com/api/webhooks/${data.id}/${data.token}`,
            channelId: data.channel_id,
            guildId: data.guild_id,
          };
        } catch (err) {
          lastErr = err;
          // Rate limit 429
          if (err.response?.status === 429) {
            hitRateLimit = true;
            const retrySec = Number(err.response.data?.retry_after || err.response.headers?.['retry-after'] || 3);
            const waitMs = Math.ceil(retrySec * 1000) + 600;
            if (waitMs < minRetryAfterMs) minRetryAfterMs = waitMs;
            logger.warn(`DiscordBotPool: Bot #${i+1} terkena rate-limit webhook (429). Cooldown: ${retrySec}s.`);
            continue;
          }

          // Error 30007: Maximum number of webhooks reached (10)
          const errCode = err.response?.data?.code;
          if (err.response?.status === 400 && (errCode === 30007 || String(err.response.data?.message).includes('webhooks'))) {
            logger.warn(`DiscordBotPool: Channel ${channelId} mencapai batas 10 webhook. Mengambil webhook yang tersedia...`);
            const list = await this.getChannelWebhooks(channelId);
            if (list && list.length > 0 && list[0].token) {
              const w = list[0];
              return {
                id: w.id,
                token: w.token,
                url: w.url || `https://discord.com/api/webhooks/${w.id}/${w.token}`,
                channelId: w.channel_id,
                guildId: w.guild_id,
                reused: true,
              };
            }
          }

          // Permission error 403
          if (err.response?.status === 403) {
            throw new Error(`Bot tidak memiliki izin "Manage Webhooks" di server/channel tujuan (403 Forbidden). Pastikan Bot diberi hak Administrator.`);
          }
        }
      }

      // Jika seluruh bot terkena rate limit, TUNGGU sampai rate limit terbuka lalu coba lagi (JANGAN DI-SKIP)
      if (hitRateLimit) {
        const waitSec = Math.ceil(minRetryAfterMs / 1000);
        logger.warn(`DiscordBotPool: Seluruh bot sedang cooldown rate limit. Menunggu ${waitSec} detik sebelum mencoba kembali (Round ${round + 1}/${maxGlobalRounds})...`);
        if (typeof onWaitCallback === 'function') {
          onWaitCallback(waitSec, round + 1, maxGlobalRounds);
        }
        await new Promise(r => setTimeout(r, minRetryAfterMs));
        continue;
      }

      if (lastErr) throw lastErr;
    }

    throw new Error(`Gagal membuat webhook setelah ${maxGlobalRounds} putaran karena batas rate-limit Discord.`);
  }

  get size() {
    return this.tokens.length;
  }
}

module.exports = new DiscordBotPool();
