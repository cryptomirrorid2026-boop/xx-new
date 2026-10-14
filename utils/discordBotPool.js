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
   * Buat Channel Teks di server tujuan di bawah kategori
   * @param {string} guildId 
   * @param {string} parentCategoryId 
   * @param {string} channelName 
   * @param {string} topic 
   */
  async createChannel(guildId, parentCategoryId, channelName, topic = '') {
    const token = this.getNextBotToken();
    const payload = {
      name: channelName,
      type: 0, // GUILD_TEXT
      parent_id: parentCategoryId || null,
    };
    if (topic) payload.topic = topic.substring(0, 1024);
    return await this._request(token, 'POST', `/guilds/${guildId}/channels`, payload);
  }

  /**
   * Buat Webhook di channel tujuan dengan rotasi bot
   * @param {string} channelId 
   * @param {string} webhookName 
   */
  async createWebhook(channelId, webhookName = 'Nexus Mirror') {
    // Coba rotasi jika ada beberapa bot
    let lastErr = null;
    const startIdx = this._rrIdx;
    const totalBots = Math.max(1, this.tokens.length);

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
        // Jika 429 rate limit, coba bot berikutnya di pool
        if (err.response?.status === 429) {
          logger.warn(`DiscordBotPool: Bot terkena rate-limit pembuatan webhook. Berpindah ke bot berikutnya di pool...`);
          continue;
        }
        // Jika permission error atau error lain
        break;
      }
    }
    throw lastErr || new Error('Gagal membuat webhook');
  }

  get size() {
    return this.tokens.length;
  }
}

module.exports = new DiscordBotPool();
