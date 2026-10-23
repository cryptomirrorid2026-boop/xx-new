// ============================================================
//   UTILS / PROMOMANAGER.JS — Professional Discord Marketing Engine
//   Multi-Account, Auto DM-to-DM, Server Member Scraper,
//   Anti-Collision Guard, Spintax, Stealth Jitter,
//   Live Shared DM Inbox & Multi-Channel Support
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const { Client, Permissions } = require('discord.js-selfbot-v13');
const logger = require('./logger');

const PROMO_DATA_FILE       = path.join(__dirname, '..', 'data', 'promo-settings.json');
const PROMO_DM_HISTORY_FILE = path.join(__dirname, '..', 'data', 'promo-dm-history.json');
const PROMO_INBOX_FILE      = path.join(__dirname, '..', 'data', 'promo-inbox.json');

class PromoManager {
  constructor() {
    this.discordRegistry = null;
    this.tgManager       = null;
    this.pushEventFn     = null;

    this.clients = new Map(); // tokenId -> { id, client, token, info, isReady, status, error }
    this.runnerTimer = null;
    this.nextExecutionAt = 0;
    this.currentAccountIndex = 0;
    this.currentTargetIndex = 0;

    // Fast O(1) in-memory lookup for sent/closed DMs
    this.dmHistory = new Map(); // userId -> { sentAt, byToken, guildId, status }

    // Live DM Inbox for 2-way dashboard chat
    this.inbox = { conversations: {} };

    this.state = {
      enabled: false,
      status: 'STOPPED', // 'STOPPED' | 'RUNNING' | 'PAUSED' | 'RESTING'
      settings: {
        campaignMode: 'DM', // 'DM' (Member DM to DM) | 'CHANNEL' (Channel Post)
        // DM-to-DM Engine Parameters
        dmDelayMinSec: 25,           // Jitter delay between users in a batch (25s)
        dmDelayMaxSec: 45,           // Jitter delay max (45s)
        dmBatchMinUsers: 3,          // 3 to 5 users per account batch
        dmBatchMaxUsers: 5,
        dmAccountCooldownMin: 3,     // Random 3 to 5 minutes between account rotations
        dmAccountCooldownMax: 5,
        // Channel Mode Parameters
        delayMinSec: 90,
        delayMaxSec: 240,
        channelCooldownMin: 120,
        // Limits & Stealth Safeguards
        hourlyLimitPerToken: 10,
        dailyLimitPerToken: 40,
        simulateTyping: true,
        typingSpeedMsPerChar: 35,
        workingHoursEnabled: false,
        workingHoursStart: 8,
        workingHoursEnd: 23,
        rotationMode: 'round-robin',
        // Telegram Alerts
        telegramAlertsEnabled: true,
        notifyOnServerCompleted: true,
        notifyOnAccountLimit: true,
        notifyOnIncomingDm: true
      },
      tokens: [],
      dmServers: [], // Target servers for member DM promotion
      targets: [],   // Target channels for channel posting
      templates: [
        {
          id: 'tpl_default_1',
          name: 'Promo VIP Mirror (DM Member)',
          content: "{Halo|Hai|Permisi} kak {username|kawan}! 🔥\n\n{Mau dapat sinyal trading real-time tanpa delay?|Lagi cari akses sinyal VIP dengan akurasi tinggi?}\nJoin {Kelas VIP Mirror|VIP Signal Hub|Mirror Trading Community} kami sekarang!\n\n📌 {Benefit VIP:|Keunggulan kami:|Fasilitas yang didapat:}\n- {Sinyal trading 24/7 real-time|Forward sinyal kilat tanpa delay}\n- {Edukasi & bimbingan analisa|Diskusi & tanya jawab bersama mentor}\n- {Mirror Discord & Telegram otomatis|Multi-channel access}\n\n👉 {Info pendaftaran & gabung:|Join sekarang via link:|Hubungi kami:}\nhttps://t.me/yourlink_here\n\n{Salam profit konsisten!|Semoga harimu menyenangkan!|Good luck tradingnya!}",
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
    this._loadDmHistory();
    this._loadInbox();
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
          settings:  { ...this.state.settings, ...(parsed.settings || {}) },
          stats:     { ...this.state.stats, ...(parsed.stats || {}) },
          dmServers: (Array.isArray(parsed.dmServers) ? parsed.dmServers : []).filter(s => s && s.guildId && s.guildId !== 'undefined' && s.guildId !== 'null'),
          tokens:    Array.isArray(parsed.tokens) ? parsed.tokens : [],
          targets:   Array.isArray(parsed.targets) ? parsed.targets : [],
          templates: Array.isArray(parsed.templates) ? parsed.templates : this.state.templates
        };
        if (this.state.status === 'RUNNING') {
          this.state.status = 'PAUSED';
        }
      }
    } catch (err) {
      logger.warn('[PromoBot] Gagal memuat promo-settings.json:', err.message);
    }
  }

  _save() {
    try {
      this._ensureDataDir();
      fs.writeFileSync(PROMO_DATA_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      logger.error('[PromoBot] Gagal menyimpan promo-settings.json:', err.message);
    }
  }

  _loadDmHistory() {
    try {
      if (fs.existsSync(PROMO_DM_HISTORY_FILE)) {
        const raw = fs.readFileSync(PROMO_DM_HISTORY_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.dmHistory = new Map(Object.entries(parsed));
          logger.info(`[PromoBot] Dimuat ${this.dmHistory.size} riwayat DM anti-duplikasi.`);
        }
      }
    } catch (err) {
      logger.warn('[PromoBot] Gagal memuat promo-dm-history.json:', err.message);
    }
  }

  _saveDmHistory() {
    try {
      this._ensureDataDir();
      const obj = Object.fromEntries(this.dmHistory);
      fs.writeFileSync(PROMO_DM_HISTORY_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('[PromoBot] Gagal menyimpan promo-dm-history.json:', err.message);
    }
  }

  _loadInbox() {
    try {
      if (fs.existsSync(PROMO_INBOX_FILE)) {
        const raw = fs.readFileSync(PROMO_INBOX_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.conversations) {
          this.inbox = parsed;
        }
      }
    } catch (err) {
      logger.warn('[PromoBot] Gagal memuat promo-inbox.json:', err.message);
    }
  }

  _saveInbox() {
    try {
      this._ensureDataDir();
      fs.writeFileSync(PROMO_INBOX_FILE, JSON.stringify(this.inbox, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('[PromoBot] Gagal menyimpan promo-inbox.json:', err.message);
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
      status: entry.status, // 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'RATE_LIMITED' | 'BANNED' | 'COMPLETED'
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
      this.state.tokens.forEach(t => {
        t.dailyCount = 0;
        t.lastDailyReset = now;
      });
      this._save();
    }

    this.state.tokens.forEach(t => {
      if (!t.lastHourlyReset || (now - t.lastHourlyReset) >= 3600000) {
        t.hourlyCount = 0;
        t.lastHourlyReset = now;
      }
    });
  }

  // ─── Telegram Bot Alert Dispatcher ──────────────────────────

  async sendTelegramAlert(htmlText) {
    if (!this.state.settings.telegramAlertsEnabled) return;
    try {
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      const adminBotKey = String(process.env.ADMIN_BOT_KEY || '1');
      if (!adminId) return;

      let tg = this.tgManager;
      if (!tg) {
        try { tg = require('./telegramManager'); } catch (_) {}
      }
      if (!tg) return;

      const bot = tg.get(adminBotKey) || tg.get('1') || (tg.bots && tg.bots.values().next().value);
      if (!bot) return;

      await bot.sendMessage(adminId, htmlText, { parse_mode: 'HTML' }).catch(err => {
        logger.warn('[PromoBot] Telegram sendMessage error:', err.message);
      });
    } catch (err) {
      logger.warn('[PromoBot] sendTelegramAlert exception:', err.message);
    }
  }

  // ─── Initialization ────────────────────────────────────────

  init(discordRegistry, tgManager = null) {
    this.discordRegistry = discordRegistry;
    this.tgManager = tgManager;
    this._checkQuotaReset();

    if (Array.isArray(this.state.tokens)) {
      this.state.tokens.forEach(t => {
        if (t.enabled && t.token) {
          this._spawnClient(t);
        }
      });
    }

    logger.info(`🚀 PromoManager initialized | ${this.state.tokens.length} akun, ${this.state.dmServers.length} server DM, ${this.state.targets.length} target channel`);
  }

  _cleanToken(t) {
    if (!t || typeof t !== 'string') return '';
    return t.replace(/^["']|["']$/g, '').trim();
  }

  _maskToken(t) {
    if (!t || t.length < 15) return '••••••••';
    return t.substring(0, 10) + '••••••••' + t.substring(t.length - 5);
  }

  // ─── Client Pool Management & Live DM Listener ─────────────

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

    // ── Shared Live DM Inbox Listener ──
    client.on('messageCreate', async (msg) => {
      try {
        if (msg.channel.type === 'DM' && !msg.author.bot && msg.author.id !== client.user?.id) {
          await this._handleIncomingDM(tokenObj, msg);
        }
      } catch (err) {
        logger.warn('[PromoBot] Error handling incoming DM:', err.message);
      }
    });

    client.on('error', (err) => {
      entry.status = 'ERROR';
      tokenObj.status = 'ERROR';
      tokenObj.errorMsg = err.message;
      this._save();
      logger.warn(`[PromoBot] Akun marketing ${tokenObj.tag || tokenObj.id} error:`, err.message);
    });

    client.on('shardDisconnect', () => {
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

  async _handleIncomingDM(tokenObj, msg) {
    try {
      const convId = `${tokenObj.id}_${msg.author.id}`;
      let conv = this.inbox.conversations[convId];
      const now = Date.now();

      if (!conv) {
        conv = {
          id: convId,
          tokenId: tokenObj.id,
          tokenTag: tokenObj.tag || tokenObj.name,
          userId: msg.author.id,
          userName: msg.author.username,
          userTag: msg.author.tag || msg.author.username,
          userAvatar: msg.author.displayAvatarURL ? msg.author.displayAvatarURL({ dynamic: true, size: 64 }) : null,
          lastMessage: msg.content,
          lastMessageAt: now,
          unread: true,
          messages: []
        };
        this.inbox.conversations[convId] = conv;
      }

      conv.messages.push({
        id: msg.id,
        sender: 'user',
        senderName: msg.author.username,
        content: msg.content,
        timestamp: now
      });

      if (conv.messages.length > 100) conv.messages = conv.messages.slice(-100);

      conv.lastMessage = msg.content;
      conv.lastMessageAt = now;
      conv.unread = true;
      conv.tokenTag = tokenObj.tag || tokenObj.name;
      if (msg.author.displayAvatarURL) {
        conv.userAvatar = msg.author.displayAvatarURL({ dynamic: true, size: 64 });
      }

      this._saveInbox();

      logger.info(`💬 [PromoBot] DM Masuk dari @${msg.author.tag} ke akun ${tokenObj.tag}: "${msg.content.substring(0, 45)}"`);
      this._notify('info', `💬 DM Baru dari <b>@${msg.author.tag}</b>: "${msg.content.substring(0, 35)}..."`);

      if (this.pushEventFn) {
        this.pushEventFn('promo_dm_message', conv);
      }

      if (this.state.settings.notifyOnIncomingDm) {
        const safeContent = (msg.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const tgAlert = [
          `📩 <b>[Promo DM] Balasan Masuk dari Calon Member!</b>`,
          ``,
          `👤 <b>Dari:</b> @${msg.author.tag} (ID: <code>${msg.author.id}</code>)`,
          `🤖 <b>Melalui Akun:</b> ${tokenObj.tag || tokenObj.name}`,
          `💬 <b>Pesan:</b> <i>${safeContent}</i>`,
          ``,
          `👉 <i>Buka Web Dashboard untuk membalas obrolan ini langsung!</i>`
        ].join('\n');
        this.sendTelegramAlert(tgAlert);
      }
    } catch (err) {
      logger.warn('[PromoBot] Error in _handleIncomingDM:', err.message);
    }
  }

  // ─── Token CRUD ────────────────────────────────────────────

  addToken(rawToken, name = '') {
    const cleaned = this._cleanToken(rawToken);
    if (!cleaned) throw new Error('Token tidak boleh kosong!');

    const existing = this.state.tokens.find(t => this._cleanToken(t.token) === cleaned);
    if (existing) throw new Error('Token ini sudah terdaftar dalam pool promo!');

    const id = 'tok_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
    const tokenObj = {
      id,
      name: name || `Akun Promo #${this.state.tokens.length + 1}`,
      token: cleaned,
      maskedToken: this._maskToken(cleaned),
      enabled: true,
      status: 'INITIALIZING',
      tag: null,
      username: null,
      avatar: null,
      guildCount: 0,
      hourlyCount: 0,
      dailyCount: 0,
      totalSent: 0,
      rateLimitedUntil: 0,
      lastSentAt: 0,
      lastHourlyReset: Date.now(),
      lastDailyReset: Date.now(),
      errorMsg: null,
      createdAt: Date.now()
    };

    this.state.tokens.push(tokenObj);
    this._save();
    this._spawnClient(tokenObj);
    return tokenObj;
  }

  async removeToken(id) {
    const idx = this.state.tokens.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Akun token tidak ditemukan!');

    const entry = this.clients.get(id);
    if (entry && entry.client) {
      try { entry.client.destroy(); } catch (_) {}
      this.clients.delete(id);
    }

    const removed = this.state.tokens.splice(idx, 1)[0];
    this._save();
    logger.info(`[PromoBot] Token ${removed.tag || removed.name} dihapus.`);
    return true;
  }

  toggleToken(id, enabled) {
    const tokenObj = this.state.tokens.find(t => t.id === id);
    if (!tokenObj) throw new Error('Akun token tidak ditemukan!');

    tokenObj.enabled = Boolean(enabled);
    this._save();

    if (tokenObj.enabled) {
      this._spawnClient(tokenObj);
    } else {
      const entry = this.clients.get(id);
      if (entry && entry.client) {
        try { entry.client.destroy(); } catch (_) {}
        this.clients.delete(id);
      }
      tokenObj.status = 'DISABLED';
      this._save();
    }
    return tokenObj;
  }

  importTokensFromMirror() {
    if (!this.discordRegistry) {
      throw new Error('discordRegistry mirror bot tidak tersedia!');
    }

    const mirrorTokens = this.discordRegistry.getAllTokens ? this.discordRegistry.getAllTokens() : [];
    let addedCount = 0;

    mirrorTokens.forEach((item, idx) => {
      const raw = typeof item === 'string' ? item : item.token;
      const cleaned = this._cleanToken(raw);
      if (!cleaned || cleaned.includes('ISI_TOKEN')) return;

      const exists = this.state.tokens.some(t => this._cleanToken(t.token) === cleaned);
      if (!exists) {
        const id = 'tok_mirror_' + (idx + 1) + '_' + Date.now().toString(36);
        const tokenObj = {
          id,
          name: `Mirror Akun #${idx + 1}`,
          token: cleaned,
          maskedToken: this._maskToken(cleaned),
          enabled: true,
          status: 'INITIALIZING',
          tag: null,
          username: null,
          avatar: null,
          guildCount: 0,
          hourlyCount: 0,
          dailyCount: 0,
          totalSent: 0,
          rateLimitedUntil: 0,
          lastSentAt: 0,
          lastHourlyReset: Date.now(),
          lastDailyReset: Date.now(),
          errorMsg: null,
          createdAt: Date.now()
        };
        this.state.tokens.push(tokenObj);
        this._spawnClient(tokenObj);
        addedCount++;
      }
    });

    this._save();
    logger.info(`[PromoBot] Diimpor ${addedCount} token dari Mirror Bot.`);
    return { added: addedCount, total: this.state.tokens.length };
  }

  // ─── Multi-Server Target (DM to DM Engine) ──────────────────

  getDmServers() {
    return (this.state.dmServers || []).map(s => {
      const pendingCount = (s.scrapedMembers || []).filter(m => !this.dmHistory.has(m.id)).length;
      return {
        ...s,
        pendingMembersCount: pendingCount,
        progressPercent: s.totalMembers > 0 ? Math.min(Math.round(((s.sentCount || 0) / s.totalMembers) * 100), 100) : 0
      };
    });
  }

  addDmServer(guildIdOrObj, maybeName = '', memberCount = 0) {
    let cleanId = '';
    let name = maybeName;
    let count = memberCount;
    let icon = null;

    if (guildIdOrObj && typeof guildIdOrObj === 'object') {
      cleanId = String(guildIdOrObj.guildId || guildIdOrObj.id || '').trim();
      name = guildIdOrObj.guildName || guildIdOrObj.name || maybeName;
      count = guildIdOrObj.memberCount || guildIdOrObj.approximate_member_count || memberCount || 0;
      icon = guildIdOrObj.icon || guildIdOrObj.iconUrl || null;
    } else {
      cleanId = String(guildIdOrObj || '').trim();
    }

    if (!cleanId || cleanId === 'undefined' || cleanId === 'null') {
      throw new Error('Guild / Server ID harus diisi dan valid!');
    }

    if (!Array.isArray(this.state.dmServers)) this.state.dmServers = [];

    // Bersihkan server tidak valid sebelumnya jika ada
    this.state.dmServers = this.state.dmServers.filter(s => s && s.guildId && s.guildId !== 'undefined' && s.guildId !== 'null');

    const existing = this.state.dmServers.find(s => s.guildId === cleanId);
    if (existing) throw new Error('Server ini sudah terdaftar sebagai target DM!');

    const srv = {
      id: 'srv_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5),
      guildId: cleanId,
      guildName: name || `Server (${cleanId})`,
      icon: icon || null,
      enabled: true,
      scrapedMembers: [],
      totalMembers: count || 0,
      memberCount: count || 0,
      sentCount: 0,
      skippedCount: 0,
      completed: false,
      lastScrapedAt: 0,
      createdAt: Date.now()
    };

    this.state.dmServers.push(srv);
    this._save();

    // Trigger background member scrape
    this.scrapeGuildMembers(cleanId).catch(err => {
      logger.warn(`[PromoBot] Auto-scrape on add failed for ${cleanId}:`, err.message);
    });

    return srv;
  }

  removeDmServer(id) {
    const idx = (this.state.dmServers || []).findIndex(s => s.id === id || s.guildId === id);
    if (idx === -1) throw new Error('Target server DM tidak ditemukan!');
    const removed = this.state.dmServers.splice(idx, 1)[0];
    this._save();
    return removed;
  }

  toggleDmServer(id, enabled) {
    const srv = (this.state.dmServers || []).find(s => s.id === id || s.guildId === id);
    if (!srv) throw new Error('Target server DM tidak ditemukan!');
    srv.enabled = Boolean(enabled);
    this._save();
    return srv;
  }

  async scanJoinedGuilds() {
    const guildsMap = new Map();

    const addGuildToMap = (g, tag) => {
      if (!g || !g.id) return;
      const gId = String(g.id);

      let iconUrl = null;
      try {
        if (typeof g.iconURL === 'function') {
          iconUrl = g.iconURL({ dynamic: true, size: 64 });
        } else if (g.icon) {
          iconUrl = `https://cdn.discordapp.com/icons/${gId}/${g.icon}.png?size=64`;
        }
      } catch (_) {}

      const sName = g.name || 'Discord Server';
      const mCount = g.memberCount || g.approximateMemberCount || g.approximate_member_count || 0;

      if (!guildsMap.has(gId)) {
        guildsMap.set(gId, {
          id: gId,
          guildId: gId,
          name: sName,
          guildName: sName,
          icon: iconUrl,
          iconUrl: iconUrl,
          memberCount: mCount,
          approximate_member_count: mCount,
          alreadyAdded: (this.state.dmServers || []).some(s => s.guildId === gId),
          joinedTokens: []
        });
      }

      const existing = guildsMap.get(gId);
      if (mCount > (existing.memberCount || 0)) {
        existing.memberCount = mCount;
        existing.approximate_member_count = mCount;
      }
      if (tag && !existing.joinedTokens.includes(tag)) {
        existing.joinedTokens.push(tag);
      }
    };

    // 1. Scan dari akun promo (this.clients)
    for (const [tokenId, entry] of this.clients.entries()) {
      if (entry && entry.client) {
        const tokenObj = this.state.tokens.find(t => t.id === tokenId);
        const tag = tokenObj?.tag || tokenObj?.name || entry.info?.tag || `Token-${tokenId.substring(0, 5)}`;

        if (entry.client.guilds && entry.client.guilds.cache) {
          entry.client.guilds.cache.forEach(g => addGuildToMap(g, tag));

          // Jika cache masih kosong, coba fetch
          if (entry.client.guilds.cache.size === 0 && typeof entry.client.guilds.fetch === 'function') {
            try {
              const fetched = await entry.client.guilds.fetch();
              if (fetched && typeof fetched.forEach === 'function') {
                fetched.forEach(g => addGuildToMap(g, tag));
              }
            } catch (_) {}
          }
        }
      }
    }

    // 2. Scan dari akun mirror bot jika ada (this.discordRegistry)
    if (this.discordRegistry && typeof this.discordRegistry.getAllClients === 'function') {
      try {
        const mirrorClients = this.discordRegistry.getAllClients();
        if (Array.isArray(mirrorClients)) {
          for (const client of mirrorClients) {
            if (client && client.guilds && client.guilds.cache) {
              const tag = client.user?.tag || client.user?.username || 'Mirror Bot';
              client.guilds.cache.forEach(g => addGuildToMap(g, tag));
            }
          }
        }
      } catch (_) {}
    }

    return Array.from(guildsMap.values());
  }

  async scrapeGuildMembers(guildId) {
    let matchedClient = null;
    let matchedTokenObj = null;

    for (const [tokenId, entry] of this.clients.entries()) {
      if (entry.isReady && entry.client) {
        if (entry.client.guilds.cache.has(guildId)) {
          matchedClient = entry.client;
          matchedTokenObj = this.state.tokens.find(t => t.id === tokenId);
          break;
        }
      }
    }

    if (!matchedClient) {
      for (const [tokenId, entry] of this.clients.entries()) {
        if (entry.isReady && entry.client) {
          try {
            const g = await entry.client.guilds.fetch(guildId).catch(() => null);
            if (g) {
              matchedClient = entry.client;
              matchedTokenObj = this.state.tokens.find(t => t.id === tokenId);
              break;
            }
          } catch (_) {}
        }
      }
    }

    if (!matchedClient) {
      throw new Error(`Tidak ada akun promo yang bergabung di Server ID ${guildId}. Pastikan salah satu akun sudah bergabung ke server tersebut.`);
    }

    const guild = matchedClient.guilds.cache.get(guildId) || await matchedClient.guilds.fetch(guildId);
    if (!guild) {
      throw new Error(`Server ${guildId} tidak dapat ditemukan.`);
    }

    try {
      await guild.members.fetch().catch(() => {});
    } catch (_) {}

    const members = [];
    const botId = matchedClient.user.id;

    guild.members.cache.forEach(m => {
      if (!m.user.bot && m.id !== botId) {
        members.push({
          id: m.id,
          username: m.user.username,
          tag: m.user.tag || m.user.username,
          avatar: m.user.displayAvatarURL ? m.user.displayAvatarURL({ dynamic: true, size: 32 }) : null
        });
      }
    });

    let srv = (this.state.dmServers || []).find(s => s.guildId === guildId);
    if (!srv) {
      srv = {
        id: 'srv_' + Date.now().toString(36),
        guildId: guild.id,
        guildName: guild.name,
        icon: guild.iconURL ? guild.iconURL({ dynamic: true, size: 64 }) : null,
        enabled: true,
        scrapedMembers: [],
        totalMembers: members.length,
        sentCount: 0,
        skippedCount: 0,
        completed: false,
        lastScrapedAt: Date.now()
      };
      if (!Array.isArray(this.state.dmServers)) this.state.dmServers = [];
      this.state.dmServers.push(srv);
    } else {
      srv.guildName = guild.name;
      srv.icon = guild.iconURL ? guild.iconURL({ dynamic: true, size: 64 }) : null;
      srv.totalMembers = members.length;
      srv.lastScrapedAt = Date.now();
    }

    srv.scrapedMembers = members;
    srv.completed = false;
    this._save();

    logger.success(`[PromoBot] Scrape selesai: ${members.length} member non-bot di server "${guild.name}" via ${matchedTokenObj?.tag}`);
    this._notify('success', `Berhasil scrape <b>${members.length} member</b> di <b>${guild.name}</b>`);

    return {
      success: true,
      guildName: guild.name,
      totalScraped: members.length,
      server: srv
    };
  }

  // ─── Shared Live DM Inbox Hub ──────────────────────────────

  getInbox() {
    const list = Object.values(this.inbox.conversations || {}).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const unreadCount = list.filter(c => c.unread).length;
    return {
      conversations: list,
      unreadCount,
      totalCount: list.length
    };
  }

  getConversation(convId) {
    const conv = this.inbox.conversations[convId];
    if (!conv) throw new Error('Percakapan tidak ditemukan!');
    return conv;
  }

  async sendDmReply(convId, replyText) {
    const text = String(replyText || '').trim();
    if (!text) throw new Error('Pesan balasan tidak boleh kosong!');

    const conv = this.inbox.conversations[convId];
    if (!conv) throw new Error('Percakapan tidak ditemukan!');

    const entry = this.clients.get(conv.tokenId);
    if (!entry || !entry.isReady || !entry.client) {
      throw new Error(`Akun Discord (${conv.tokenTag || conv.tokenId}) sedang tidak online untuk membalas DM ini!`);
    }

    const client = entry.client;
    const user = await client.users.fetch(conv.userId).catch(() => null);
    if (!user) {
      throw new Error(`User Discord (${conv.userId}) tidak dapat ditemukan!`);
    }

    if (this.state.settings.simulateTyping) {
      try {
        const dmCh = await user.createDM().catch(() => null);
        if (dmCh && typeof dmCh.sendTyping === 'function') {
          await dmCh.sendTyping().catch(() => {});
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch (_) {}
    }

    const sentMsg = await user.send(text);
    const now = Date.now();

    conv.messages.push({
      id: sentMsg.id,
      sender: 'admin',
      senderName: 'Admin (Dashboard)',
      content: text,
      timestamp: now
    });

    conv.lastMessage = text;
    conv.lastMessageAt = now;
    conv.unread = false;

    this._saveInbox();

    if (this.pushEventFn) {
      this.pushEventFn('promo_dm_replied', conv);
    }

    this._notify('success', `Balasan terkirim ke <b>@${conv.userTag || conv.userName}</b> melalui <b>${conv.tokenTag}</b>`);
    return { success: true, messageId: sentMsg.id, conversation: conv };
  }

  markConversationRead(convId) {
    const conv = this.inbox.conversations[convId];
    if (conv) {
      conv.unread = false;
      this._saveInbox();
      return true;
    }
    return false;
  }

  deleteConversation(convId) {
    if (this.inbox.conversations[convId]) {
      delete this.inbox.conversations[convId];
      this._saveInbox();
      return true;
    }
    return false;
  }

  importFromMirrorBot() {
    return this.importTokensFromMirror();
  }

  discoverChannels() {
    return this.scanJoinedGuilds();
  }

  // ─── Target Channel (Post Mode) CRUD ───────────────────────

  addTarget(channelIdOrObj, customName = '', guildName = '', notes = '') {
    let cleanId = '';
    let cName = customName;
    let gName = guildName;
    let n = notes;

    if (channelIdOrObj && typeof channelIdOrObj === 'object') {
      cleanId = String(channelIdOrObj.channelId || channelIdOrObj.id || '').trim();
      cName = channelIdOrObj.channelName || channelIdOrObj.customName || channelIdOrObj.name || '';
      gName = channelIdOrObj.guildName || '';
      n = channelIdOrObj.notes || '';
    } else {
      cleanId = String(channelIdOrObj || '').trim();
    }

    if (!cleanId) throw new Error('Channel ID tidak boleh kosong!');

    const existing = this.state.targets.find(t => t.channelId === cleanId);
    if (existing) throw new Error('Channel ID ini sudah terdaftar sebagai target promosi!');

    const id = 'tgt_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
    const target = {
      id,
      channelId: cleanId,
      channelName: cName || `channel-${cleanId}`,
      guildName: gName || 'Unknown Server',
      notes: n || '',
      enabled: true,
      totalSent: 0,
      lastSentAt: 0,
      cooldownUntil: 0,
      createdAt: Date.now()
    };

    this.state.targets.push(target);
    this._save();
    return target;
  }

  removeTarget(id) {
    const idx = this.state.targets.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Target channel tidak ditemukan!');
    const removed = this.state.targets.splice(idx, 1)[0];
    this._save();
    return true;
  }

  toggleTarget(id, enabled) {
    const target = this.state.targets.find(t => t.id === id);
    if (!target) throw new Error('Target channel tidak ditemukan!');
    target.enabled = Boolean(enabled);
    this._save();
    return target;
  }

  // ─── Template & Spintax Engine ─────────────────────────────

  addTemplate(nameOrObj, content = '') {
    let name = '';
    let body = content;

    if (nameOrObj && typeof nameOrObj === 'object') {
      name = nameOrObj.name || '';
      body = nameOrObj.content || '';
    } else {
      name = nameOrObj;
    }

    if (!name || !body) throw new Error('Nama dan isi template promosi wajib diisi!');
    const id = 'tpl_' + Date.now().toString(36);
    const tpl = {
      id,
      name,
      content: body,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
      createdAt: Date.now()
    };
    this.state.templates.push(tpl);
    this._save();
    return tpl;
  }

  updateTemplate(id, data) {
    const tpl = this.state.templates.find(t => t.id === id);
    if (!tpl) throw new Error('Template tidak ditemukan!');
    if (data.name) tpl.name = data.name;
    if (data.content !== undefined) tpl.content = data.content;
    if (data.enabled !== undefined) tpl.enabled = Boolean(data.enabled);
    this._save();
    return tpl;
  }

  removeTemplate(id) {
    const idx = this.state.templates.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Template tidak ditemukan!');
    if (this.state.templates.length <= 1) {
      throw new Error('Minimal harus ada 1 template promosi aktif!');
    }
    this.state.templates.splice(idx, 1);
    this._save();
    return true;
  }

  parseSpintax(text) {
    if (!text || typeof text !== 'string') return '';
    const regex = /\{([^{}]+)\}/g;
    let iteration = 0;
    while (regex.test(text) && iteration < 20) {
      const prev = text;
      text = text.replace(regex, (match, choices) => {
        if (!choices.includes('|')) return match;
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
      });
      if (text === prev) break;
      iteration++;
    }
    return text;
  }

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
      .replace(/\{username\}/gi, meta.username || 'kak')
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

  // ─── Campaign Controls & Execution Dispatcher ───────────────

  start() {
    this._checkQuotaReset();
    this.state.status = 'RUNNING';
    this.state.enabled = true;
    this._save();

    logger.info('🚀 [PromoBot] Kampanye promosi DIMULAI!');
    this._notify('success', 'Kampanye auto-promo diaktifkan');

    this._scheduleNext(2000);
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
        this._scheduleNext(15000);
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
      return currentHour >= workingHoursStart || currentHour < workingHoursEnd;
    }
  }

  async _executeStep() {
    if (this.state.status !== 'RUNNING') return;
    this._checkQuotaReset();

    if (!this._isInsideWorkingHours()) {
      logger.info(`[PromoBot] Di luar jam operasional. Istirahat sejenak...`);
      this._addLog({
        status: 'SKIPPED',
        note: 'Di luar jam kerja aktif marketing (NIGHT_REST)'
      });
      this._scheduleNext(15 * 60 * 1000);
      return;
    }

    const mode = this.state.settings.campaignMode || 'DM';

    if (mode === 'DM') {
      await this._executeDmStep();
    } else {
      await this._executeChannelStep();
    }
  }

  // ─── DM-to-DM Engine Loop (User's Exact Specification) ──────

  async _executeDmStep() {
    // 1. Ambil server target yang aktif & belum selesai
    const activeServers = (this.state.dmServers || []).filter(s => s.enabled && !s.completed);

    if (activeServers.length === 0) {
      logger.info('[PromoBot] Semua target server DM telah selesai atau belum ada server aktif!');
      this._addLog({
        status: 'COMPLETED',
        note: 'Semua target server DM telah selesai dipromosikan!'
      });

      if (this.state.settings.notifyOnServerCompleted) {
        this.sendTelegramAlert([
          `🏁 <b>[Auto-Promo DM] SEMUA TARGET SERVER SELESAI!</b>`,
          ``,
          `🎉 Seluruh calon member pada semua server target telah berhasil di-DM tanpa duplikasi.`,
          `📊 <b>Total DM Berhasil:</b> ${this.state.stats.totalSent}`,
          `🕒 <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}`,
          ``,
          `<i>Kampanye promosi dijeda otomatis. Tambahkan server target baru di Web Dashboard untuk melanjutkan.</i>`
        ].join('\n'));
      }
      this.pause();
      return;
    }

    const currentServer = activeServers[0];

    // Auto-scrape jika member list kosong
    if (!currentServer.scrapedMembers || currentServer.scrapedMembers.length === 0) {
      logger.info(`[PromoBot] Server "${currentServer.guildName}" belum di-scrape. Memulai auto-scrape...`);
      try {
        await this.scrapeGuildMembers(currentServer.guildId);
      } catch (err) {
        logger.warn(`[PromoBot] Gagal auto-scrape server "${currentServer.guildName}":`, err.message);
        currentServer.completed = true;
        this._save();
        this._scheduleNext(5000);
        return;
      }
    }

    // 2. Filter member yang belum pernah di-DM sama sekali (Zero Collision Guard)
    const unmessagedMembers = (currentServer.scrapedMembers || []).filter(m => !this.dmHistory.has(m.id));

    if (unmessagedMembers.length === 0) {
      currentServer.completed = true;
      this._save();

      logger.success(`🎉 [PromoBot] Server "${currentServer.guildName}" SELESAI di-DM semua member!`);
      this._notify('success', `🎉 Server <b>${currentServer.guildName}</b> telah selesai di-DM! Berpindah ke server berikutnya.`);

      if (this.state.settings.notifyOnServerCompleted) {
        this.sendTelegramAlert([
          `🎉 <b>[Auto-Promo DM] Server Target Selesai!</b>`,
          ``,
          `📌 <b>Server:</b> ${currentServer.guildName} (ID: <code>${currentServer.guildId}</code>)`,
          `✅ <b>Total DM Terkirim:</b> ${currentServer.sentCount || 0}`,
          `🚫 <b>Member Di-skip (DM Tutup / Bot):</b> ${currentServer.skippedCount || 0}`,
          `👥 <b>Total Member:</b> ${currentServer.totalMembers || (currentServer.scrapedMembers || []).length}`,
          ``,
          `<i>Melanjutkan otomatis ke server target berikutnya dalam antrean...</i>`
        ].join('\n'));
      }

      this._scheduleNext(2000);
      return;
    }

    // 3. Filter akun yang ready & tidak melebihi kuota
    const now = Date.now();
    const availableTokens = this.state.tokens.filter(t => {
      if (!t.enabled) return false;
      if (t.status !== 'READY') return false;
      if (t.rateLimitedUntil && now < t.rateLimitedUntil) return false;
      if (t.hourlyCount >= (this.state.settings.hourlyLimitPerToken || 10)) return false;
      if (t.dailyCount >= (this.state.settings.dailyLimitPerToken || 40)) return false;
      const entry = this.clients.get(t.id);
      return entry && entry.isReady && entry.client;
    });

    if (availableTokens.length === 0) {
      logger.warn('[PromoBot] Semua akun sedang istirahat / cooldown kuota. Menunggu 3 menit...');
      this._addLog({
        status: 'SKIPPED',
        note: 'Semua akun mencapai kuota per jam/hari atau sedang rate limit'
      });
      this._scheduleNext(3 * 60 * 1000);
      return;
    }

    // Rotasi akun (Round-Robin)
    this.currentAccountIndex = (this.currentAccountIndex || 0) % availableTokens.length;
    const chosenToken = availableTokens[this.currentAccountIndex];
    this.currentAccountIndex++;
    const clientEntry = this.clients.get(chosenToken.id);
    const client = clientEntry.client;

    // 4. Hitung batch size: 3 sampai 5 user per akun (sesuai permintaan user!)
    const minBatch = Math.max(parseInt(this.state.settings.dmBatchMinUsers) || 3, 1);
    const maxBatch = Math.max(parseInt(this.state.settings.dmBatchMaxUsers) || 5, minBatch);
    const batchTarget = Math.min(
      Math.floor(Math.random() * (maxBatch - minBatch + 1)) + minBatch,
      unmessagedMembers.length
    );
    const membersToDm = unmessagedMembers.slice(0, batchTarget);

    // 5. Template Promosi
    const activeTemplates = this.state.templates.filter(tpl => tpl.enabled);
    if (activeTemplates.length === 0) {
      logger.warn('[PromoBot] Tidak ada template promosi aktif!');
      this.pause();
      return;
    }

    logger.info(`🎯 [PromoBot] Akun "${chosenToken.tag}" memulai batch DM (${membersToDm.length} calon member) di server "${currentServer.guildName}"...`);

    let sentInBatch = 0;
    let shouldBreakBatch = false;

    // 6. Eksekusi pengiriman DM ke setiap user dalam batch
    for (let i = 0; i < membersToDm.length; i++) {
      if (this.state.status !== 'RUNNING') break;
      const member = membersToDm[i];

      if (this.dmHistory.has(member.id)) continue;

      const template = activeTemplates[Math.floor(Math.random() * activeTemplates.length)];
      const messageContent = this.renderMessage(template.content, {
        guildName: currentServer.guildName,
        channelName: 'DM',
        username: member.username
      });

      try {
        const user = await client.users.fetch(member.id).catch(() => null);
        if (!user) {
          this.dmHistory.set(member.id, {
            sentAt: Date.now(),
            byToken: chosenToken.tag || chosenToken.name,
            guildId: currentServer.guildId,
            status: 'NOT_FOUND'
          });
          currentServer.skippedCount = (currentServer.skippedCount || 0) + 1;
          continue;
        }

        // Realistic typing simulation
        if (this.state.settings.simulateTyping) {
          try {
            const dmCh = await user.createDM().catch(() => null);
            if (dmCh && typeof dmCh.sendTyping === 'function') {
              await dmCh.sendTyping().catch(() => {});
              const typeDelay = Math.min(Math.max(messageContent.length * 30, 2000), 4500);
              await new Promise(r => setTimeout(r, typeDelay));
            }
          } catch (_) {}
        }

        // Send Direct Message
        const sentMsg = await user.send(messageContent);
        const sentTime = Date.now();

        // Anti-Collision Global Record
        this.dmHistory.set(member.id, {
          sentAt: sentTime,
          byToken: chosenToken.tag || chosenToken.name,
          guildId: currentServer.guildId,
          status: 'SENT'
        });

        chosenToken.hourlyCount = (chosenToken.hourlyCount || 0) + 1;
        chosenToken.dailyCount  = (chosenToken.dailyCount || 0) + 1;
        chosenToken.totalSent   = (chosenToken.totalSent || 0) + 1;
        chosenToken.lastSentAt  = sentTime;

        currentServer.sentCount = (currentServer.sentCount || 0) + 1;
        template.useCount       = (template.useCount || 0) + 1;

        this.state.stats.totalSent = (this.state.stats.totalSent || 0) + 1;
        this.state.stats.todaySent = (this.state.stats.todaySent || 0) + 1;

        this._addLog({
          status: 'SUCCESS',
          tokenTag: chosenToken.tag,
          channelId: `DM-${member.id}`,
          channelName: `@${member.username}`,
          guildName: currentServer.guildName,
          messagePreview: messageContent.substring(0, 80) + '...',
          note: `DM ke @${member.username} via ${chosenToken.tag}`
        });

        sentInBatch++;
        this._save();
        this._saveDmHistory();

        // Hubungkan ke Shared Live DM Inbox agar obrolan tercatat
        const convId = `${chosenToken.id}_${member.id}`;
        if (!this.inbox.conversations[convId]) {
          this.inbox.conversations[convId] = {
            id: convId,
            tokenId: chosenToken.id,
            tokenTag: chosenToken.tag || chosenToken.name,
            userId: member.id,
            userName: member.username,
            userTag: member.tag || member.username,
            userAvatar: member.avatar,
            lastMessage: messageContent,
            lastMessageAt: sentTime,
            unread: false,
            messages: [
              {
                id: sentMsg.id,
                sender: 'bot',
                senderName: chosenToken.tag || chosenToken.name,
                content: messageContent,
                timestamp: sentTime
              }
            ]
          };
          this._saveInbox();
        }

        // Inter-DM jitter delay antar member dalam batch (25-45 detik)
        if (i < membersToDm.length - 1) {
          const jitterMin = (this.state.settings.dmDelayMinSec || 25) * 1000;
          const jitterMax = Math.max((this.state.settings.dmDelayMaxSec || 45) * 1000, jitterMin);
          const jitter = Math.floor(jitterMin + Math.random() * (jitterMax - jitterMin));
          logger.info(`⏳ [PromoBot] Jitter jeda antar user: ${(jitter/1000).toFixed(0)}s`);
          await new Promise(r => setTimeout(r, jitter));
        }

      } catch (err) {
        if (err.code === 50007) {
          // Cannot send messages to this user (DMs closed)
          this.dmHistory.set(member.id, {
            sentAt: Date.now(),
            byToken: chosenToken.tag || chosenToken.name,
            guildId: currentServer.guildId,
            status: 'DM_CLOSED'
          });
          currentServer.skippedCount = (currentServer.skippedCount || 0) + 1;
          this._saveDmHistory();
          this._save();

          this._addLog({
            status: 'SKIPPED',
            tokenTag: chosenToken.tag,
            channelName: `@${member.username}`,
            guildName: currentServer.guildName,
            note: `DM ditutup oleh user (@${member.username})`
          });
          continue;

        } else if (err.httpStatus === 429 || err.code === 429 || (err.message && err.message.includes('429'))) {
          // Rate limit 429
          const retryAfter = (err.retryAfter || 60) * 1000;
          chosenToken.rateLimitedUntil = Date.now() + retryAfter + 10000;
          chosenToken.status = 'RATE_LIMITED';
          this._save();

          logger.warn(`⚠️ [PromoBot] Akun ${chosenToken.tag} terkena Discord Rate Limit 429!`);
          this._addLog({
            status: 'RATE_LIMITED',
            tokenTag: chosenToken.tag,
            note: `Rate limited 429 (cooldown ${(retryAfter/1000).toFixed(0)}s)`
          });

          if (this.state.settings.notifyOnAccountLimit) {
            this.sendTelegramAlert([
              `⚠️ <b>[Auto-Promo Warning] Akun Terkena Rate Limit (429)!</b>`,
              ``,
              `👤 <b>Akun:</b> ${chosenToken.tag} (${chosenToken.name || ''})`,
              `⏳ <b>Cooldown:</b> ${(retryAfter/1000).toFixed(0)} detik`,
              `🔄 <b>Tindakan:</b> Giliran promosi dialihkan ke akun berikutnya secara otomatis.`
            ].join('\n'));
          }
          shouldBreakBatch = true;
          break;

        } else if (err.code === 40001 || err.code === 40002 || err.code === 401 || err.code === 403 || (err.message && (err.message.includes('401') || err.message.includes('banned') || err.message.includes('Unauthorized')))) {
          // Token Invalid / Account Banned
          chosenToken.status = 'INVALID_TOKEN';
          chosenToken.errorMsg = err.message;
          this._save();

          logger.error(`🚨 [PromoBot] Akun ${chosenToken.tag} TERKENA BAN / INVALID: ${err.message}`);
          this._addLog({
            status: 'BANNED',
            tokenTag: chosenToken.tag,
            note: `Akun terkena limit/ban: ${err.message}`
          });

          if (this.state.settings.notifyOnAccountLimit) {
            this.sendTelegramAlert([
              `🚨 <b>[Auto-Promo ALERT] Akun Terkena BAN / Invalid!</b>`,
              ``,
              `👤 <b>Akun:</b> ${chosenToken.tag} (${chosenToken.name || ''})`,
              `❌ <b>Pesan:</b> ${err.message}`,
              `⚠️ <i>Akun ini dinonaktifkan otomatis. Periksa status akun di Discord.</i>`
            ].join('\n'));
          }
          shouldBreakBatch = true;
          break;

        } else {
          logger.warn(`[PromoBot] Gagal DM member ${member.id}:`, err.message);
          this._addLog({
            status: 'FAILED',
            tokenTag: chosenToken.tag,
            channelName: `@${member.username}`,
            note: err.message
          });
        }
      }
    }

    // 7. Delay waktu istirahat antar akun: RANDOM 3-5 MENIT (Sesuai Permintaan User!)
    const cdMinSec = Math.max(parseInt(this.state.settings.dmAccountCooldownMin) || 3, 1) * 60;
    const cdMaxSec = Math.max(parseInt(this.state.settings.dmAccountCooldownMax) || 5, 2) * 60;
    const nextDelayMs = Math.floor(cdMinSec * 1000 + Math.random() * ((cdMaxSec - cdMinSec) * 1000));

    logger.info(`⏳ [PromoBot] Batch selesai (${sentInBatch} DM terkirim). Rotasi akun berikutnya dalam ${(nextDelayMs / 1000 / 60).toFixed(1)} menit`);
    this._scheduleNext(nextDelayMs);
  }

  // ─── Channel Posting Mode (Fallback) ───────────────────────

  async _executeChannelStep() {
    const now = Date.now();
    const channelCooldownMs = (this.state.settings.channelCooldownMin || 60) * 60 * 1000;

    const availableTargets = this.state.targets.filter(t => {
      if (!t.enabled) return false;
      return (now - (t.lastSentAt || 0)) >= channelCooldownMs;
    });

    if (availableTargets.length === 0) {
      logger.info('[PromoBot] Semua target channel sedang cooldown. Menunggu siklus...');
      this._scheduleNext(60000);
      return;
    }

    const availableTokens = this.state.tokens.filter(t => {
      if (!t.enabled || t.status !== 'READY') return false;
      if (t.rateLimitedUntil && now < t.rateLimitedUntil) return false;
      if (t.hourlyCount >= (this.state.settings.hourlyLimitPerToken || 6)) return false;
      if (t.dailyCount >= (this.state.settings.dailyLimitPerToken || 30)) return false;
      return true;
    });

    if (availableTokens.length === 0) {
      logger.warn('[PromoBot] Semua akun mencapai kuota per jam/hari. Cooldown 5 menit...');
      this._scheduleNext(5 * 60 * 1000);
      return;
    }

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

    const candidates = [...availableTokens].sort(() => 0.5 - Math.random());
    for (const tok of candidates) {
      const clientEntry = this.clients.get(tok.id);
      if (clientEntry && clientEntry.isReady && clientEntry.client) {
        if (clientEntry.client.channels.cache.get(target.channelId)) {
          chosenToken = tok;
          chosenClient = clientEntry.client;
          break;
        }
      }
    }

    if (!chosenClient) {
      this.currentAccountIndex = (this.currentAccountIndex || 0) % availableTokens.length;
      chosenToken = availableTokens[this.currentAccountIndex];
      this.currentAccountIndex++;
      chosenClient = this.clients.get(chosenToken.id)?.client;
    }

    if (!chosenClient || !chosenToken) {
      this._scheduleNext(30000);
      return;
    }

    const activeTemplates = this.state.templates.filter(tpl => tpl.enabled);
    if (activeTemplates.length === 0) {
      this.pause();
      return;
    }
    const template = activeTemplates[Math.floor(Math.random() * activeTemplates.length)];

    await this._dispatchPromotion(chosenClient, chosenToken, target, template);

    const minDelay = (this.state.settings.delayMinSec || 90) * 1000;
    const maxDelay = Math.max((this.state.settings.delayMaxSec || 240) * 1000, minDelay);
    const randomizedDelay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
    this._scheduleNext(randomizedDelay);
  }

  async _dispatchPromotion(client, tokenObj, target, template) {
    try {
      const channel = client.channels.cache.get(target.channelId) || await client.channels.fetch(target.channelId).catch(() => null);
      if (!channel) {
        this._addLog({
          status: 'FAILED',
          tokenTag: tokenObj.tag,
          channelId: target.channelId,
          channelName: target.channelName,
          note: 'Channel tidak dapat diakses / belum join server'
        });
        return;
      }

      if (channel.guild?.name) target.guildName = channel.guild.name;
      if (channel.name) target.channelName = channel.name;

      const messageContent = this.renderMessage(template.content, {
        guildName: channel.guild?.name || target.guildName,
        channelName: channel.name || target.channelName
      });

      if (this.state.settings.simulateTyping && typeof channel.sendTyping === 'function') {
        try {
          await channel.sendTyping().catch(() => {});
          const charSpeed = this.state.settings.typingSpeedMsPerChar || 35;
          const typingDuration = Math.min(Math.max(messageContent.length * charSpeed, 2500), 8500);
          await new Promise(res => setTimeout(res, typingDuration));
        } catch (_) {}
      }

      const sentMsg = await channel.send(messageContent);
      const now = Date.now();

      tokenObj.hourlyCount = (tokenObj.hourlyCount || 0) + 1;
      tokenObj.dailyCount  = (tokenObj.dailyCount || 0) + 1;
      tokenObj.totalSent   = (tokenObj.totalSent || 0) + 1;
      tokenObj.lastSentAt  = now;

      target.lastSentAt = now;
      target.totalSent  = (target.totalSent || 0) + 1;

      template.useCount   = (template.useCount || 0) + 1;
      template.lastUsedAt = now;

      this.state.stats.totalSent = (this.state.stats.totalSent || 0) + 1;
      this.state.stats.todaySent = (this.state.stats.todaySent || 0) + 1;

      this._addLog({
        status: 'SUCCESS',
        tokenTag: tokenObj.tag,
        channelId: target.channelId,
        channelName: channel.name,
        guildName: channel.guild?.name || target.guildName,
        messagePreview: messageContent.substring(0, 100) + '...',
        note: `Terkirim via ${tokenObj.tag} (Pesan #${sentMsg.id})`
      });

      this._notify('success', `[Promo] Terkirim ke <b>#${channel.name}</b> (${channel.guild?.name}) oleh <b>${tokenObj.tag}</b>`);
      this._save();

    } catch (err) {
      this.state.stats.totalFailed = (this.state.stats.totalFailed || 0) + 1;
      if (err.httpStatus === 429 || err.code === 429) {
        const retryAfter = (err.retryAfter || 30) * 1000;
        tokenObj.rateLimitedUntil = Date.now() + retryAfter + 5000;
        tokenObj.status = 'RATE_LIMITED';
        this._addLog({
          status: 'RATE_LIMITED',
          tokenTag: tokenObj.tag,
          channelId: target.channelId,
          note: `Rate limit 429 (cooldown ${(retryAfter/1000).toFixed(0)}s)`
        });
      } else {
        this._addLog({
          status: 'FAILED',
          tokenTag: tokenObj.tag,
          channelId: target.channelId,
          note: err.message
        });
      }
      this._save();
    }
  }

  // ─── Test Send ─────────────────────────────────────────────

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
    const activeServers = (this.state.dmServers || []).filter(s => s.enabled && !s.completed).length;

    let currentAccountTag = '-';
    let currentTargetName = '-';

    if (this.state.tokens.length > 0) {
      const idx = (this.currentAccountIndex || 0) % this.state.tokens.length;
      currentAccountTag = this.state.tokens[idx]?.tag || this.state.tokens[idx]?.name || '-';
    }

    if (this.state.settings.campaignMode === 'DM') {
      if (this.state.dmServers && this.state.dmServers.length > 0) {
        const srv = this.state.dmServers.find(s => s.enabled && !s.completed) || this.state.dmServers[0];
        currentTargetName = srv ? `[DM] ${srv.guildName}` : '-';
      }
    } else {
      if (this.state.targets.length > 0) {
        const idx = (this.currentTargetIndex || 0) % this.state.targets.length;
        currentTargetName = this.state.targets[idx]?.channelName || this.state.targets[idx]?.channelId || '-';
      }
    }

    return {
      status: this.state.status,
      enabled: this.state.enabled,
      campaignMode: this.state.settings.campaignMode || 'DM',
      nextExecutionAt: this.nextExecutionAt,
      countdownSec,
      activeTokens,
      totalTokens: this.state.tokens.length,
      activeTargets,
      totalTargets: this.state.targets.length,
      activeServers,
      totalServers: (this.state.dmServers || []).length,
      currentAccountTag,
      currentTargetName,
      unreadInboxCount: Object.values(this.inbox.conversations || {}).filter(c => c.unread).length,
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
