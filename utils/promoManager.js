// ============================================================
//   UTILS / PROMOMANAGER.JS — Professional Discord Marketing Engine
//   Multi-Account, Spintax, Anti-Ban Stealth, Realistic Typing,
//   Per-Token Hourly/Daily Quotas, Cooldown & Channel Discovery
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const { Client, Permissions } = require('discord.js-selfbot-v13');
const logger = require('./logger');

const PROMO_DATA_FILE = path.join(__dirname, '..', 'data', 'promo-settings.json');

class PromoManager {
  constructor() {
    this.discordRegistry = null; // reference to main bot discordRegistry
    this.pushEventFn     = null; // SSE push event callback

    this.clients = new Map(); // tokenId -> { client, token, info, isReady, status, error }
    this.runnerTimer = null;
    this.nextExecutionAt = 0;
    this.currentAccountIndex = 0;
    this.currentTargetIndex = 0;

    this.state = {
      enabled: false,
      status: 'STOPPED', // 'STOPPED' | 'RUNNING' | 'PAUSED' | 'RESTING'
      settings: {
        delayMinSec: 90,
        delayMaxSec: 240,
        hourlyLimitPerToken: 6,
        dailyLimitPerToken: 30,
        channelCooldownMin: 120,
        simulateTyping: true,
        typingSpeedMsPerChar: 35,
        workingHoursEnabled: false,
        workingHoursStart: 8,
        workingHoursEnd: 23,
        autoSkipRestrictedChannels: true,
        rotationMode: 'round-robin' // 'round-robin' | 'random'
      },
      tokens: [],
      targets: [],
      templates: [
        {
          id: 'tpl_default_1',
          name: 'Promo Kelas VIP Mirror (Standar)',
          content: "{Halo|Hai|Permisi} {semuanya|rekan trader|kawan}! 🔥\n\n{Mau dapat sinyal trading real-time tanpa delay?|Lagi cari akses sinyal VIP dengan akurasi tinggi?}\nJoin {Kelas VIP Mirror|VIP Signal Hub|Mirror Trading Community} kami sekarang!\n\n📌 {Fasilitas yang didapat:|Keunggulan kami:|Benefit VIP:}\n- {Sinyal trading 24/7 real-time|Forward sinyal kilat tanpa delay}\n- {Edukasi & bimbingan analisa|Diskusi & tanya jawab bersama mentor}\n- {Mirror Discord & Telegram otomatis|Multi-channel access}\n\n👉 {Info pendaftaran & gabung:|Join sekarang via link:|Hubungi kami:}\nhttps://t.me/yourlink_here\n\n{Salam profit konsisten!|Semoga harimu menyenangkan!|Good luck tradingnya!}",
          enabled: true
        }
      ],
      stats: {
        totalSent: 0,
        totalFailed: 0,
        todaySent: 0,
        lastResetDay: new Date().toISOString().slice(0, 10)
      },
      logs: []
    };

    this._ensureDataDir();
    this._load();
  }

  // ─── Setup & Persistence ───────────────────────────────────

  _ensureDataDir() {
    const dir = path.dirname(PROMO_DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(PROMO_DATA_FILE)) {
        const raw = fs.readFileSync(PROMO_DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.state = {
          ...this.state,
          ...parsed,
          settings: { ...this.state.settings, ...(parsed.settings || {}) },
          stats:    { ...this.state.stats, ...(parsed.stats || {}) },
        };
        // Reset status jika sebelumnya running tapi process restart
        if (this.state.status === 'RUNNING') {
          this.state.status = 'PAUSED';
        }
      }
    } catch (err) {
      logger.warn('PromoManager: Gagal memuat promo-settings.json', err.message);
    }
  }

  _save() {
    try {
      this._ensureDataDir();
      fs.writeFileSync(PROMO_DATA_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      logger.error('PromoManager: Gagal menyimpan promo-settings.json', err.message);
    }
  }

  setPushEventFn(fn) {
    this.pushEventFn = fn;
  }

  _notify(type, message) {
    if (this.pushEventFn) {
      try { this.pushEventFn(type, message); } catch (_) {}
    }
  }

  _addLog(entry) {
    const logItem = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString('id-ID', { hour12: false }),
      dateStr: new Date().toLocaleDateString('id-ID'),
      status: entry.status, // 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'RATE_LIMITED'
      tokenTag: entry.tokenTag || 'Unknown',
      channelId: entry.channelId || '-',
      channelName: entry.channelName || '-',
      guildName: entry.guildName || '-',
      messagePreview: entry.messagePreview || '',
      note: entry.note || ''
    };

    this.state.logs.unshift(logItem);
    if (this.state.logs.length > 200) {
      this.state.logs = this.state.logs.slice(0, 200);
    }
    this._save();
    return logItem;
  }

  _checkQuotaReset() {
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    if (this.state.stats.lastResetDay !== today) {
      this.state.stats.todaySent = 0;
      this.state.stats.lastResetDay = today;
      // Reset daily count token
      this.state.tokens.forEach(t => {
        t.dailyCount = 0;
        t.lastDailyReset = now;
      });
      this._save();
    }

    // Reset hourly count token jika lewat 1 jam
    this.state.tokens.forEach(t => {
      if (!t.lastHourlyReset || (now - t.lastHourlyReset) >= 3600000) {
        t.hourlyCount = 0;
        t.lastHourlyReset = now;
      }
    });
  }

  // ─── Initialization ────────────────────────────────────────

  init(discordRegistry) {
    this.discordRegistry = discordRegistry;
    this._checkQuotaReset();

    // Auto connect configured promo tokens
    if (Array.isArray(this.state.tokens)) {
      this.state.tokens.forEach(t => {
        if (t.enabled && t.token) {
          this._spawnClient(t);
        }
      });
    }

    logger.info(`🚀 PromoManager initialized | ${this.state.tokens.length} akun terdaftar, ${this.state.targets.length} target channel`);
  }

  _cleanToken(t) {
    if (!t || typeof t !== 'string') return '';
    return t.replace(/^["']|["']$/g, '').trim();
  }

  _maskToken(t) {
    if (!t || t.length < 15) return '••••••••';
    return t.substring(0, 10) + '••••••••' + t.substring(t.length - 5);
  }

  // ─── Client Pool Management ────────────────────────────────

  _spawnClient(tokenObj) {
    const rawToken = this._cleanToken(tokenObj.token);
    if (!rawToken) return null;

    if (this.clients.has(tokenObj.id)) {
      const existing = this.clients.get(tokenObj.id);
      if (existing.isReady) return existing.client;
      try { existing.client.destroy(); } catch (_) {}
    }

    tokenObj.status = 'CONNECTING';
    tokenObj.errorMsg = null;

    const client = new Client({ checkUpdate: false });
    const entry = {
      id: tokenObj.id,
      client,
      token: rawToken,
      isReady: false,
      status: 'CONNECTING',
      error: null
    };
    this.clients.set(tokenObj.id, entry);

    client.once('ready', (c) => {
      entry.isReady = true;
      entry.status = 'READY';
      tokenObj.status = 'READY';
      tokenObj.tag = c.user.tag;
      tokenObj.username = c.user.username;
      tokenObj.avatar = c.user.displayAvatarURL({ dynamic: true, size: 64 });
      tokenObj.guildCount = c.guilds.cache.size;
      tokenObj.errorMsg = null;
      this._save();
      logger.success(`[PromoBot] Akun marketing online: ${c.user.tag} (${c.guilds.cache.size} server)`);
      this._notify('success', `Akun promosi <b>${c.user.tag}</b> siap digunakan`);
    });

    client.on('error', (err) => {
      entry.status = 'ERROR';
      tokenObj.status = 'ERROR';
      tokenObj.errorMsg = err.message;
      this._save();
      logger.warn(`[PromoBot] Akun marketing ${tokenObj.tag || tokenObj.id} error:`, err.message);
    });

    client.on('shardDisconnect', (event) => {
      entry.isReady = false;
      entry.status = 'DISCONNECTED';
      tokenObj.status = 'DISCONNECTED';
      this._save();
    });

    client.login(rawToken).catch((err) => {
      entry.status = 'INVALID_TOKEN';
      tokenObj.status = 'INVALID_TOKEN';
      tokenObj.errorMsg = err.message;
      this._save();
      logger.error(`[PromoBot] Gagal login akun ${tokenObj.id}:`, err.message);
    });

    return client;
  }

  async addToken(rawToken, name = '') {
    const cleaned = this._cleanToken(rawToken);
    if (!cleaned) throw new Error('Token Discord tidak boleh kosong!');

    // Cek duplikasi
    const exists = this.state.tokens.find(t => t.token === cleaned);
    if (exists) throw new Error('Token Discord ini sudah terdaftar dalam promo pool!');

    const id = 'tok_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const tokenObj = {
      id,
      name: name || `Akun Promo #${this.state.tokens.length + 1}`,
      token: cleaned,
      maskedToken: this._maskToken(cleaned),
      enabled: true,
      tag: 'Connecting...',
      username: '',
      avatar: '',
      guildCount: 0,
      status: 'CONNECTING',
      errorMsg: null,
      hourlyCount: 0,
      dailyCount: 0,
      totalSent: 0,
      lastHourlyReset: Date.now(),
      lastDailyReset: Date.now(),
      lastSentAt: 0,
      rateLimitedUntil: 0
    };

    this.state.tokens.push(tokenObj);
    this._save();

    this._spawnClient(tokenObj);
    return tokenObj;
  }

  async removeToken(tokenId) {
    const idx = this.state.tokens.findIndex(t => t.id === tokenId);
    if (idx === -1) return false;

    const removed = this.state.tokens.splice(idx, 1)[0];
    if (this.clients.has(tokenId)) {
      try {
        const c = this.clients.get(tokenId).client;
        c.destroy();
      } catch (_) {}
      this.clients.delete(tokenId);
    }
    this._save();
    return true;
  }

  toggleToken(tokenId, enabled) {
    const tok = this.state.tokens.find(t => t.id === tokenId);
    if (!tok) return false;
    tok.enabled = enabled;
    if (!enabled && this.clients.has(tokenId)) {
      try {
        this.clients.get(tokenId).client.destroy();
      } catch (_) {}
      this.clients.delete(tokenId);
      tok.status = 'DISABLED';
    } else if (enabled) {
      this._spawnClient(tok);
    }
    this._save();
    return true;
  }

  importFromMirrorBot() {
    if (!this.discordRegistry) return { added: 0, total: this.state.tokens.length };
    let added = 0;

    const activeClients = this.discordRegistry.getClients() || [];
    for (const c of activeClients) {
      if (c && c.token) {
        const cleaned = this._cleanToken(c.token);
        const exists = this.state.tokens.some(t => t.token === cleaned);
        if (!exists) {
          const id = 'tok_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
          const tokenObj = {
            id,
            name: c.user?.username ? `Mirror: ${c.user.username}` : `Akun Mirror #${added + 1}`,
            token: cleaned,
            maskedToken: this._maskToken(cleaned),
            enabled: true,
            tag: c.user?.tag || 'Connecting...',
            username: c.user?.username || '',
            avatar: c.user?.displayAvatarURL ? c.user.displayAvatarURL({ dynamic: true, size: 64 }) : '',
            guildCount: c.guilds?.cache?.size || 0,
            status: 'READY',
            errorMsg: null,
            hourlyCount: 0,
            dailyCount: 0,
            totalSent: 0,
            lastHourlyReset: Date.now(),
            lastDailyReset: Date.now(),
            lastSentAt: 0,
            rateLimitedUntil: 0
          };
          this.state.tokens.push(tokenObj);
          this._spawnClient(tokenObj);
          added++;
        }
      }
    }
    this._save();
    return { added, total: this.state.tokens.length };
  }

  // ─── Target Channels Management ────────────────────────────

  addTarget(channelData) {
    const { channelId, channelName, guildId, guildName, notes } = channelData;
    if (!channelId) throw new Error('Channel ID wajib diisi!');

    const exists = this.state.targets.find(t => t.channelId === String(channelId).trim());
    if (exists) throw new Error('Target channel ID ini sudah ada di daftar!');

    const targetObj = {
      id: 'tgt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      channelId: String(channelId).trim(),
      channelName: channelName || `Channel ${channelId}`,
      guildId: guildId || '',
      guildName: guildName || 'Discord Server',
      notes: notes || '',
      enabled: true,
      lastSentAt: 0,
      totalSent: 0,
      status: 'ACTIVE'
    };

    this.state.targets.push(targetObj);
    this._save();
    return targetObj;
  }

  removeTarget(targetId) {
    const idx = this.state.targets.findIndex(t => t.id === targetId || t.channelId === targetId);
    if (idx === -1) return false;
    this.state.targets.splice(idx, 1);
    this._save();
    return true;
  }

  toggleTarget(targetId, enabled) {
    const target = this.state.targets.find(t => t.id === targetId || t.channelId === targetId);
    if (!target) return false;
    target.enabled = enabled;
    this._save();
    return true;
  }

  // Auto-Discover Channels yang bisa dikirim pesan dari akun yang aktif
  async discoverChannels() {
    const discovered = [];
    const seenChannelIds = new Set();
    const existingTargetIds = new Set(this.state.targets.map(t => t.channelId));

    for (const [_, clientEntry] of this.clients) {
      if (!clientEntry.isReady || !clientEntry.client) continue;
      const c = clientEntry.client;

      for (const [guildId, guild] of c.guilds.cache) {
        try {
          const channels = guild.channels?.cache || [];
          for (const [chId, ch] of channels) {
            // Filter hanya GUILD_TEXT (tipe 0) atau text-based
            if (ch.type !== 'GUILD_TEXT' && ch.type !== 0) continue;
            if (seenChannelIds.has(chId)) continue;

            // Cek permission kirim pesan
            const me = guild.members?.cache?.get(c.user.id) || guild.me;
            let canSend = true;
            if (me && typeof ch.permissionsFor === 'function') {
              const perms = ch.permissionsFor(me);
              if (perms && (!perms.has(Permissions.FLAGS.VIEW_CHANNEL) || !perms.has(Permissions.FLAGS.SEND_MESSAGES))) {
                canSend = false;
              }
            }

            if (!canSend) continue;

            // Skip channel jika namanya mencurigakan (rules, announcements, mod-log)
            const chName = ch.name.toLowerCase();
            const isRestrictedName = /rules|aturan|announcement|pengumuman|mod-log|audit|verif|welcome|selamat-datang/i.test(chName);

            seenChannelIds.add(chId);
            discovered.push({
              channelId: chId,
              channelName: ch.name,
              guildId: guildId,
              guildName: guild.name,
              isRestrictedName,
              alreadyAdded: existingTargetIds.has(chId),
              foundViaAccount: c.user.tag
            });
          }
        } catch (_) {}
      }
    }

    return discovered;
  }

  // ─── Templates & Spintax Engine ────────────────────────────

  addTemplate(templateData) {
    const { name, content } = templateData;
    if (!content) throw new Error('Konten pesan promosi tidak boleh kosong!');

    const id = 'tpl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const tpl = {
      id,
      name: name || `Template Promosi #${this.state.templates.length + 1}`,
      content: content.trim(),
      enabled: true,
      lastUsedAt: 0,
      useCount: 0
    };

    this.state.templates.push(tpl);
    this._save();
    return tpl;
  }

  updateTemplate(id, templateData) {
    const tpl = this.state.templates.find(t => t.id === id);
    if (!tpl) throw new Error('Template tidak ditemukan!');

    if (templateData.name !== undefined) tpl.name = templateData.name;
    if (templateData.content !== undefined) tpl.content = templateData.content.trim();
    if (templateData.enabled !== undefined) tpl.enabled = templateData.enabled;

    this._save();
    return tpl;
  }

  removeTemplate(id) {
    const idx = this.state.templates.findIndex(t => t.id === id);
    if (idx === -1) return false;
    this.state.templates.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * Recursive Spintax Parser
   * Mendukung nested spintax seperti: {Halo {kawan|teman}|Permisi kak}
   */
  parseSpintax(text) {
    if (!text || typeof text !== 'string') return '';
    const regex = /\{([^{}]+)\}/g;
    let iteration = 0;
    while (regex.test(text) && iteration < 20) {
      const prev = text;
      text = text.replace(regex, (match, choices) => {
        if (!choices.includes('|')) return match; // Keep tags like {server}, {channel}, etc.
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
      });
      if (text === prev) break;
      iteration++;
    }
    return text;
  }

  /**
   * Render dynamic variables
   */
  renderMessage(templateContent, meta = {}) {
    let result = this.parseSpintax(templateContent);

    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';
    const dateStr = now.toLocaleDateString('id-ID');
    const randomCode = '#MK-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    
    const emojis = ['🚀', '🔥', '💎', '📈', '⚡', '🎯', '📊', '💰', '👑', '✨', '🏆', '💡', '⭐'];
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

    result = result
      .replace(/\{server\}/gi, meta.guildName || 'Server')
      .replace(/\{channel\}/gi, meta.channelName || 'channel')
      .replace(/\{time\}/gi, timeStr)
      .replace(/\{date\}/gi, dateStr)
      .replace(/\{random_code\}/gi, randomCode)
      .replace(/\{random_emoji\}/gi, randomEmoji);

    return result;
  }

  previewTemplate(content, meta = {}) {
    return this.renderMessage(content, meta);
  }

  // ─── Settings ──────────────────────────────────────────────

  updateSettings(newSettings) {
    this.state.settings = { ...this.state.settings, ...newSettings };
    this._save();
    return this.state.settings;
  }

  getSettings() {
    return this.state.settings;
  }

  // ─── Campaign Controls & Anti-Ban Dispatcher ───────────────

  start() {
    this._checkQuotaReset();
    this.state.status = 'RUNNING';
    this.state.enabled = true;
    this._save();

    logger.info('🚀 [PromoBot] Kampanye promosi DIMULAI!');
    this._notify('success', 'Kampanye auto-promo diaktifkan');

    this._scheduleNext(2000); // Mulai eksekusi pertama dalam 2 detik
    return this.getStatus();
  }

  pause() {
    if (this.runnerTimer) {
      clearTimeout(this.runnerTimer);
      this.runnerTimer = null;
    }
    this.state.status = 'PAUSED';
    this.nextExecutionAt = 0;
    this._save();

    logger.info('⏸️ [PromoBot] Kampanye promosi DIJEDA');
    this._notify('warning', 'Kampanye auto-promo dijeda');
    return this.getStatus();
  }

  stop() {
    if (this.runnerTimer) {
      clearTimeout(this.runnerTimer);
      this.runnerTimer = null;
    }
    this.state.status = 'STOPPED';
    this.state.enabled = false;
    this.nextExecutionAt = 0;
    this._save();

    logger.info('⏹️ [PromoBot] Kampanye promosi DIHENTIKAN');
    this._notify('info', 'Kampanye auto-promo dihentikan');
    return this.getStatus();
  }

  _scheduleNext(delayMs) {
    if (this.runnerTimer) clearTimeout(this.runnerTimer);
    if (this.state.status !== 'RUNNING') return;

    this.nextExecutionAt = Date.now() + delayMs;
    this.runnerTimer = setTimeout(() => {
      this._executeStep().catch(err => {
        logger.error('[PromoBot] Error in step:', err.message);
        this._scheduleNext(15000); // Retry fallback 15s
      });
    }, delayMs);
  }

  _isInsideWorkingHours() {
    if (!this.state.settings.workingHoursEnabled) return true;
    const currentHour = new Date().getHours();
    const { workingHoursStart, workingHoursEnd } = this.state.settings;
    if (workingHoursStart <= workingHoursEnd) {
      return currentHour >= workingHoursStart && currentHour < workingHoursEnd;
    } else {
      // Midnight wrap (contoh: 20:00 - 04:00)
      return currentHour >= workingHoursStart || currentHour < workingHoursEnd;
    }
  }

  /**
   * Eksekusi satu langkah promosi aman (Human-like dispatch)
   */
  async _executeStep() {
    if (this.state.status !== 'RUNNING') return;

    this._checkQuotaReset();

    // 1. Cek Jam Operasional
    if (!this._isInsideWorkingHours()) {
      logger.info(`[PromoBot] Di luar jam kerja aktif (${this.state.settings.workingHoursStart}:00 - ${this.state.settings.workingHoursEnd}:00). Istirahat sejenak...`);
      this._addLog({
        status: 'SKIPPED',
        note: 'Di luar jam kerja aktif marketing (NIGHT_REST)'
      });
      // Jadwalkan cek lagi dalam 15 menit
      this._scheduleNext(15 * 60 * 1000);
      return;
    }

    // 2. Filter target aktif dan periksa cooldown channel
    const now = Date.now();
    const channelCooldownMs = (this.state.settings.channelCooldownMin || 60) * 60 * 1000;

    const availableTargets = this.state.targets.filter(t => {
      if (!t.enabled) return false;
      const timeSinceLast = now - (t.lastSentAt || 0);
      return timeSinceLast >= channelCooldownMs;
    });

    if (availableTargets.length === 0) {
      logger.info('[PromoBot] Semua target channel sedang cooldown. Menunggu siklus cooldown berikutnya...');
      this._scheduleNext(60000); // Cek lagi 1 menit
      return;
    }

    // 3. Filter akun yang ready & tidak melebihi kuota
    const availableTokens = this.state.tokens.filter(t => {
      if (!t.enabled) return false;
      if (t.status !== 'READY') return false;
      if (t.rateLimitedUntil && now < t.rateLimitedUntil) return false;
      if (t.hourlyCount >= this.state.settings.hourlyLimitPerToken) return false;
      if (t.dailyCount >= this.state.settings.dailyLimitPerToken) return false;
      return true;
    });

    if (availableTokens.length === 0) {
      logger.warn('[PromoBot] Tidak ada akun yang siap (semua akun mencapai kuota per jam/hari atau sedang rate limit).');
      this._addLog({
        status: 'SKIPPED',
        note: 'Semua akun mencapai kuota / rate limited'
      });
      this._scheduleNext(5 * 60 * 1000); // Cek lagi dalam 5 menit
      return;
    }

    // 4. Pilih Target Channel & Akun secara Round-Robin atau Random
    let target = null;
    let chosenToken = null;
    let chosenClient = null;

    if (this.state.settings.rotationMode === 'random') {
      target = availableTargets[Math.floor(Math.random() * availableTargets.length)];
    } else {
      this.currentTargetIndex = (this.currentTargetIndex || 0) % availableTargets.length;
      target = availableTargets[this.currentTargetIndex];
      this.currentTargetIndex++;
    }

    // Cari akun yang memiliki akses ke target channel tersebut
    const candidates = [...availableTokens].sort(() => 0.5 - Math.random());
    for (const tok of candidates) {
      const clientEntry = this.clients.get(tok.id);
      if (clientEntry && clientEntry.isReady && clientEntry.client) {
        // Coba cek apakah client memiliki channel atau guild ini di cache
        const ch = clientEntry.client.channels.cache.get(target.channelId);
        if (ch) {
          chosenToken = tok;
          chosenClient = clientEntry.client;
          break;
        }
      }
    }

    // Jika belum ketemu di cache, gunakan round-robin token pertama dan coba fetch
    if (!chosenClient) {
      this.currentAccountIndex = (this.currentAccountIndex || 0) % availableTokens.length;
      chosenToken = availableTokens[this.currentAccountIndex];
      this.currentAccountIndex++;
      const entry = this.clients.get(chosenToken.id);
      chosenClient = entry?.client;
    }

    if (!chosenClient || !chosenToken) {
      logger.warn('[PromoBot] Gagal menemukan client yang cocok. Menunggu giliran...');
      this._scheduleNext(30000);
      return;
    }

    // 5. Pilih Template Promosi
    const activeTemplates = this.state.templates.filter(tpl => tpl.enabled);
    if (activeTemplates.length === 0) {
      logger.warn('[PromoBot] Tidak ada template promosi aktif!');
      this.pause();
      return;
    }
    const template = activeTemplates[Math.floor(Math.random() * activeTemplates.length)];

    // 6. Eksekusi pengiriman dengan Anti-Ban Safeguard
    await this._dispatchPromotion(chosenClient, chosenToken, target, template);

    // 7. Hitung delay acak berikutnya (Human Jitter)
    const minDelay = (this.state.settings.delayMinSec || 90) * 1000;
    const maxDelay = Math.max((this.state.settings.delayMaxSec || 240) * 1000, minDelay);
    const randomizedDelay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));

    logger.info(`⏳ [PromoBot] Pesan terkirim. Pengiriman berikutnya dalam ${(randomizedDelay / 1000).toFixed(0)} detik`);
    this._scheduleNext(randomizedDelay);
  }

  async _dispatchPromotion(client, tokenObj, target, template) {
    let channel = null;

    try {
      // 1. Fetch channel
      channel = client.channels.cache.get(target.channelId) || await client.channels.fetch(target.channelId).catch(() => null);

      if (!channel) {
        logger.warn(`[PromoBot] Channel #${target.channelId} tidak dapat diakses oleh akun ${tokenObj.tag}`);
        this._addLog({
          status: 'FAILED',
          tokenTag: tokenObj.tag,
          channelId: target.channelId,
          channelName: target.channelName,
          guildName: target.guildName,
          note: 'Channel tidak dapat diakses / bot belum join server'
        });
        return;
      }

      // Update target guild name jika belum ada
      if (channel.guild?.name) target.guildName = channel.guild.name;
      if (channel.name) target.channelName = channel.name;

      // 2. Render teks Spintax unik
      const messageContent = this.renderMessage(template.content, {
        guildName: channel.guild?.name || target.guildName,
        channelName: channel.name || target.channelName
      });

      // 3. Human Typing Simulation
      if (this.state.settings.simulateTyping && typeof channel.sendTyping === 'function') {
        try {
          await channel.sendTyping().catch(() => {});
          const charSpeed = this.state.settings.typingSpeedMsPerChar || 35;
          const typingDuration = Math.min(Math.max(messageContent.length * charSpeed, 2500), 8500);
          await new Promise(res => setTimeout(res, typingDuration));
        } catch (_) {}
      }

      // 4. Kirim Pesan
      const sentMsg = await channel.send(messageContent);

      // 5. Update kuota & catatan keberhasilan
      const now = Date.now();
      tokenObj.hourlyCount = (tokenObj.hourlyCount || 0) + 1;
      tokenObj.dailyCount = (tokenObj.dailyCount || 0) + 1;
      tokenObj.totalSent = (tokenObj.totalSent || 0) + 1;
      tokenObj.lastSentAt = now;

      target.lastSentAt = now;
      target.totalSent = (target.totalSent || 0) + 1;

      template.useCount = (template.useCount || 0) + 1;
      template.lastUsedAt = now;

      this.state.stats.totalSent = (this.state.stats.totalSent || 0) + 1;
      this.state.stats.todaySent = (this.state.stats.todaySent || 0) + 1;

      this._addLog({
        status: 'SUCCESS',
        tokenTag: tokenObj.tag,
        channelId: target.channelId,
        channelName: channel.name,
        guildName: channel.guild?.name || target.guildName,
        messagePreview: messageContent.substring(0, 100) + (messageContent.length > 100 ? '...' : ''),
        note: `Terkirim via ${tokenObj.tag} (Pesan #${sentMsg.id})`
      });

      this._notify('success', `[Promo] Pesan terkirim ke <b>#${channel.name}</b> (${channel.guild?.name}) oleh <b>${tokenObj.tag}</b>`);
      this._save();

    } catch (err) {
      this.state.stats.totalFailed = (this.state.stats.totalFailed || 0) + 1;

      // Handle Discord Rate-Limit (429)
      if (err.httpStatus === 429 || err.code === 429 || (err.message && err.message.includes('429'))) {
        const retryAfter = (err.retryAfter || err.timeout || 30) * 1000;
        tokenObj.rateLimitedUntil = Date.now() + retryAfter + 5000;
        tokenObj.status = 'RATE_LIMITED';

        logger.warn(`⚠️ [PromoBot] Akun ${tokenObj.tag} terkena Discord Rate Limit! Cooldown selama ${(retryAfter/1000).toFixed(0)}s`);
        this._addLog({
          status: 'RATE_LIMITED',
          tokenTag: tokenObj.tag,
          channelId: target.channelId,
          channelName: target.channelName,
          note: `Rate limit 429 (cooldown ${(retryAfter/1000).toFixed(0)}s)`
        });
      } else if (err.code === 50001 || err.code === 50013) {
        // Missing Access / Missing Permissions
        logger.warn(`⚠️ [PromoBot] Akun ${tokenObj.tag} tidak punya izin kirim di #${target.channelName}: ${err.message}`);
        this._addLog({
          status: 'FAILED',
          tokenTag: tokenObj.tag,
          channelId: target.channelId,
          channelName: target.channelName,
          note: `Izin ditolak: ${err.message}`
        });
      } else {
        logger.error(`[PromoBot] Gagal kirim promosi via ${tokenObj.tag}:`, err.message);
        this._addLog({
          status: 'FAILED',
          tokenTag: tokenObj.tag,
          channelId: target.channelId,
          channelName: target.channelName,
          note: err.message
        });
      }
      this._save();
    }
  }

  /**
   * One-off Test Send
   */
  async sendTestMessage(tokenId, channelId, templateId) {
    const tokenObj = tokenId ? this.state.tokens.find(t => t.id === tokenId) : this.state.tokens.find(t => t.enabled && t.status === 'READY');
    if (!tokenObj) throw new Error('Tidak ada akun token Discord yang siap untuk tes kirim!');

    const clientEntry = this.clients.get(tokenObj.id);
    if (!clientEntry || !clientEntry.isReady || !clientEntry.client) {
      throw new Error(`Akun ${tokenObj.tag || tokenObj.name} belum online atau tidak siap!`);
    }

    const targetChId = channelId || (this.state.targets[0] ? this.state.targets[0].channelId : null);
    if (!targetChId) throw new Error('Target channel ID harus ditentukan!');

    const tpl = templateId ? this.state.templates.find(t => t.id === templateId) : this.state.templates[0];
    if (!tpl) throw new Error('Template promosi tidak ditemukan!');

    const client = clientEntry.client;
    const channel = client.channels.cache.get(targetChId) || await client.channels.fetch(targetChId).catch(() => null);
    if (!channel) throw new Error(`Channel #${targetChId} tidak dapat diakses oleh akun ${tokenObj.tag}!`);

    const messageContent = this.renderMessage(tpl.content, {
      guildName: channel.guild?.name || 'Server',
      channelName: channel.name || 'channel'
    });

    if (this.state.settings.simulateTyping && typeof channel.sendTyping === 'function') {
      await channel.sendTyping().catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    }

    const sent = await channel.send(messageContent);
    this._addLog({
      status: 'SUCCESS',
      tokenTag: tokenObj.tag,
      channelId: channel.id,
      channelName: channel.name,
      guildName: channel.guild?.name || 'Server',
      messagePreview: messageContent.substring(0, 100),
      note: `🧪 Test Send Berhasil (Pesan #${sent.id})`
    });

    this._notify('success', `🧪 Tes kirim promosi berhasil ke <b>#${channel.name}</b> via <b>${tokenObj.tag}</b>`);
    return {
      success: true,
      messageId: sent.id,
      channelName: channel.name,
      guildName: channel.guild?.name,
      account: tokenObj.tag
    };
  }

  // ─── Status & Reporting ────────────────────────────────────

  getStatus() {
    this._checkQuotaReset();
    const now = Date.now();
    const countdownSec = this.nextExecutionAt > now ? Math.ceil((this.nextExecutionAt - now) / 1000) : 0;

    const activeTokens = this.state.tokens.filter(t => t.enabled && t.status === 'READY').length;
    const activeTargets = this.state.targets.filter(t => t.enabled).length;

    let currentAccountTag = '-';
    let currentTargetName = '-';

    if (this.state.tokens.length > 0) {
      const idx = (this.currentAccountIndex || 0) % this.state.tokens.length;
      currentAccountTag = this.state.tokens[idx]?.tag || this.state.tokens[idx]?.name || '-';
    }
    if (this.state.targets.length > 0) {
      const idx = (this.currentTargetIndex || 0) % this.state.targets.length;
      currentTargetName = this.state.targets[idx]?.channelName || this.state.targets[idx]?.channelId || '-';
    }

    return {
      status: this.state.status,
      enabled: this.state.enabled,
      nextExecutionAt: this.nextExecutionAt,
      countdownSec,
      activeTokens,
      totalTokens: this.state.tokens.length,
      activeTargets,
      totalTargets: this.state.targets.length,
      currentAccountTag,
      currentTargetName,
      stats: this.state.stats
    };
  }

  getTokens() {
    this._checkQuotaReset();
    return this.state.tokens;
  }

  getTargets() {
    return this.state.targets;
  }

  getTemplates() {
    return this.state.templates;
  }

  getLogs() {
    return this.state.logs;
  }

  clearLogs() {
    this.state.logs = [];
    this._save();
    return true;
  }
}

module.exports = new PromoManager();
