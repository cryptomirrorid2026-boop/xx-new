// ============================================================
//   UTILS / AUTOLINKMANAGER.JS
//   Otomatisasi Penghubung Kategori & Channel (DC-to-DC)
//   Fungsi:
//     - Membaca channel di kategori server sumber (via Discord User Token)
//     - Membuat channel & webhook di server tujuan (via Discord Bot Pool)
//     - Mendaftarkan otomatis ke channels.json dengan label kategori rapi
//     - Auto-Sync listener realtime: mendeteksi channel baru yang dibuat
//       di server sumber dan langsung membuatkan channel & webhook tujuan
// ============================================================

'use strict';

const fs             = require('fs');
const path           = require('path');
const logger         = require('./logger');
const channelStore   = require('./channelStore');
const discordBotPool = require('./discordBotPool');

const RULES_FILE = path.join(__dirname, '..', 'data', 'autolink-rules.json');

class AutoLinkManager {
  constructor() {
    this.rules = [];
    this.registry = null;
    this.pushEventFn = null;
    this._hookedClients = new WeakSet();
    this._ensureDir();
    this._loadRules();
  }

  _ensureDir() {
    const dir = path.dirname(RULES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _loadRules() {
    try {
      if (fs.existsSync(RULES_FILE)) {
        const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
        if (Array.isArray(raw)) {
          this.rules = raw;
          return;
        }
      }
    } catch (err) {
      logger.warn('AutoLinkManager: gagal baca autolink-rules.json', err.message);
    }
    this.rules = [];
  }

  _saveRules() {
    try {
      this._ensureDir();
      fs.writeFileSync(RULES_FILE, JSON.stringify(this.rules, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('AutoLinkManager: gagal simpan autolink-rules.json', err.message);
    }
  }

  /**
   * Set fungsi push SSE activity event ke dashboard
   */
  setPushEventFn(fn) {
    this.pushEventFn = fn;
  }

  _notify(type, message) {
    if (typeof this.pushEventFn === 'function') {
      try { this.pushEventFn(type, message); } catch (_) {}
    }
  }

  /**
   * Inisialisasi listener pada seluruh user client di discordRegistry
   */
  init(discordRegistry) {
    this.registry = discordRegistry;
    if (!discordRegistry) return;

    // Pasang listener pada clients yang sudah ada
    const clients = discordRegistry.getClients();
    for (const client of clients) {
      this.hookClient(client);
    }

    // Pantau jika ada client baru didaftarkan
    const originalAdd = discordRegistry.addClient.bind(discordRegistry);
    discordRegistry.addClient = (client) => {
      originalAdd(client);
      this.hookClient(client);
    };

    logger.info(`AutoLinkManager: Siap dengan ${this.rules.length} aturan auto-sync kategori.`);
  }

  /**
   * Daftarkan event listener channelCreate pada sebuah client
   */
  hookClient(client) {
    if (!client || this._hookedClients.has(client)) return;
    this._hookedClients.add(client);

    client.on('channelCreate', async (channel) => {
      try {
        // Hanya proses text channel
        if (channel.type !== 'GUILD_TEXT' && channel.type !== 0) return;
        const guildId = channel.guild?.id;
        const parentId = channel.parentId || channel.parent_id;

        if (!guildId || !parentId) return;

        // Cari aturan yang cocok
        const matchingRule = this.rules.find(r => 
          r.autoSync !== false &&
          String(r.sourceGuildId) === String(guildId) &&
          String(r.sourceCategoryId) === String(parentId)
        );

        if (matchingRule) {
          logger.info(`AutoLinkManager: Channel baru terdeteksi di server sumber: #${channel.name} (${channel.id})`);
          await this.syncNewChannel(channel, matchingRule);
        }
      } catch (err) {
        logger.warn('AutoLinkManager: Error saat memproses channelCreate', err.message);
      }
    });
  }

  /**
   * Cari client user token yang memiliki akses ke server sumber
   */
  _findClientForGuild(guildId) {
    if (!this.registry) return null;
    const clients = this.registry.getClients();
    for (const c of clients) {
      const g = c.guilds?.cache?.get(String(guildId));
      if (g) return { client: c, guild: g };
    }
    return null;
  }

  /**
   * Preview daftar channel dalam kategori server sumber
   * @param {string} sourceGuildId 
   * @param {string} sourceCategoryId 
   */
  async previewSourceCategory(sourceGuildId, sourceCategoryId) {
    const found = this._findClientForGuild(sourceGuildId);
    if (!found) {
      throw new Error(`Tidak ditemukan akun Discord yang berada di server ID: ${sourceGuildId}. Pastikan akun user Anda sudah bergabung ke server tersebut.`);
    }

    const { guild } = found;

    // Fetch channels jika belum lengkap di cache
    try {
      await guild.channels.fetch();
    } catch (_) {}

    const catId = String(sourceCategoryId).trim();
    const categoryChannel = guild.channels.cache.get(catId);
    const categoryName = categoryChannel?.name || 'Unnamed Category';

    // Filter semua text channel di bawah kategori ini
    const textChannels = guild.channels.cache
      .filter(c => (c.parentId === catId || c.parent_id === catId) && (c.type === 'GUILD_TEXT' || c.type === 0))
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(c => {
        const existing = channelStore.find(c.id);
        return {
          id: c.id,
          name: c.name,
          topic: c.topic || '',
          position: c.position,
          alreadyMapped: !!existing,
          currentWebhook: existing?.dcWebhookUrl || null,
          currentCategory: existing?.category || null,
        };
      });

    return {
      sourceGuildId: guild.id,
      sourceGuildName: guild.name,
      sourceCategoryId: catId,
      sourceCategoryName: categoryName,
      channelCount: textChannels.length,
      channels: textChannels,
    };
  }

  /**
   * Eksekusi penyambungan kategori otomatis (Auto Link & Provisioning)
   */
  async executeAutoLink({
    sourceGuildId,
    sourceCategoryId,
    targetGuildId,
    targetCategoryId = null,
    categoryName = '',
    autoSync = true,
  }) {
    if (discordBotPool.size === 0) {
      throw new Error('Belum ada Bot Discord yang terdaftar di Bot Pool. Tambahkan minimal 1 (disarankan 3-4) Bot Discord Token terlebih dahulu.');
    }

    // 1. Ambil data channel dari server sumber
    const preview = await this.previewSourceCategory(sourceGuildId, sourceCategoryId);
    if (preview.channels.length === 0) {
      throw new Error(`Tidak ada text channel yang ditemukan di bawah kategori "${preview.sourceCategoryName}".`);
    }

    const finalCategoryName = (categoryName && categoryName.trim()) 
      ? categoryName.trim() 
      : preview.sourceCategoryName;

    // 2. Tentukan atau buat Kategori di server tujuan
    let targetCatId = targetCategoryId ? String(targetCategoryId).trim() : null;

    // Fetch existing channels di target guild via Bot
    let targetExistingChannels = [];
    try {
      targetExistingChannels = await discordBotPool.getGuildChannels(targetGuildId);
    } catch (err) {
      throw new Error(`Gagal mengakses server tujuan (ID: ${targetGuildId}). Pastikan Bot Discord sudah diundang ke server tujuan dengan hak akses Administrator/Manage Channels. Detail: ${err.message}`);
    }

    // Jika targetCategoryId belum ditentukan, cari kategori dengan nama yang sama atau buat baru
    if (!targetCatId || targetCatId === 'auto') {
      const existingCat = targetExistingChannels.find(c => 
        c.type === 4 && c.name.toLowerCase().trim() === finalCategoryName.toLowerCase().trim()
      );

      if (existingCat) {
        targetCatId = existingCat.id;
        logger.info(`AutoLinkManager: Menggunakan kategori tujuan yang sudah ada: "${existingCat.name}" (${existingCat.id})`);
      } else {
        logger.info(`AutoLinkManager: Membuat kategori baru di server tujuan: "${finalCategoryName}"`);
        const newCat = await discordBotPool.createCategory(targetGuildId, finalCategoryName);
        targetCatId = newCat.id;
        // Refresh daftar channel target
        targetExistingChannels = await discordBotPool.getGuildChannels(targetGuildId);
      }
    }

    // 3. Proses setiap channel
    const results = {
      categoryName: finalCategoryName,
      targetCategoryId: targetCatId,
      total: preview.channels.length,
      created: [],
      updated: [],
      errors: [],
    };

    for (let i = 0; i < preview.channels.length; i++) {
      const srcChan = preview.channels[i];

      try {
        // Cek apakah channel di server tujuan sudah ada dengan nama yang sama di kategori tersebut
        let destChan = targetExistingChannels.find(c => 
          c.type === 0 && 
          c.parent_id === targetCatId && 
          c.name.toLowerCase().trim() === srcChan.name.toLowerCase().trim()
        );

        if (!destChan) {
          // Buat channel baru di server tujuan
          logger.info(`AutoLinkManager: [${i+1}/${preview.channels.length}] Membuat channel tujuan #${srcChan.name}...`);
          destChan = await discordBotPool.createChannel(
            targetGuildId,
            targetCatId,
            srcChan.name,
            srcChan.topic || `Mirror dari #${srcChan.name}`
          );
          // Beri jeda kecil agar Discord menyelesaikan pembuatan channel
          await new Promise(r => setTimeout(r, 400));
        }

        // Buat Webhook di channel tujuan dengan rotasi bot
        logger.info(`AutoLinkManager: Membuat webhook untuk #${destChan.name}...`);
        const webhook = await discordBotPool.createWebhook(
          destChan.id,
          `Nexus Mirror - ${srcChan.name}`
        );

        // Simpan ke channelStore dengan category yang rapi
        const existing = channelStore.find(srcChan.id);
        const savedChannel = channelStore.add({
          category: finalCategoryName,
          name: srcChan.name,
          discordId: srcChan.id,
          dcWebhookUrl: webhook.url,
          tgChatId: existing?.tgChatId || '',
          botKey: existing?.botKey || '1',
          threadId: existing?.threadId || null,
          dcThreadId: existing?.dcThreadId || null,
          dcCustomUsername: existing?.dcCustomUsername || null,
          dcCustomAvatarUrl: existing?.dcCustomAvatarUrl || null,
          dcAutoPing: existing?.dcAutoPing || null,
          dcOnlyWithMedia: existing?.dcOnlyWithMedia || false,
          dcStripInvites: existing?.dcStripInvites !== false,
        });

        if (existing) {
          results.updated.push({ name: srcChan.name, discordId: srcChan.id, webhookUrl: webhook.url });
        } else {
          results.created.push({ name: srcChan.name, discordId: srcChan.id, webhookUrl: webhook.url });
        }

        // Jeda anti-spam aman
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        logger.error(`AutoLinkManager: Gagal memproses channel #${srcChan.name}`, err.message);
        results.errors.push({ name: srcChan.name, discordId: srcChan.id, error: err.message });
      }
    }

    // 4. Simpan / perbarui aturan Auto-Sync
    const ruleIndex = this.rules.findIndex(r => 
      String(r.sourceGuildId) === String(sourceGuildId) && 
      String(r.sourceCategoryId) === String(sourceCategoryId)
    );

    const ruleData = {
      id: ruleIndex >= 0 ? this.rules[ruleIndex].id : `rule_${Date.now()}`,
      sourceGuildId: String(sourceGuildId),
      sourceGuildName: preview.sourceGuildName,
      sourceCategoryId: String(sourceCategoryId),
      sourceCategoryName: preview.sourceCategoryName,
      targetGuildId: String(targetGuildId),
      targetCategoryId: String(targetCatId),
      categoryName: finalCategoryName,
      autoSync: Boolean(autoSync),
      lastSync: new Date().toISOString(),
    };

    if (ruleIndex >= 0) {
      this.rules[ruleIndex] = ruleData;
    } else {
      this.rules.push(ruleData);
    }
    this._saveRules();

    this._notify('success', `✨ Auto-Link Selesai: <b>${results.created.length + results.updated.length} channel</b> di kategori <b>${finalCategoryName}</b> berhasil disambungkan!`);

    return results;
  }

  /**
   * Eksekusi pembuatan channel baru secara otomatis saat terdeteksi event channelCreate
   */
  async syncNewChannel(srcChan, rule) {
    try {
      if (discordBotPool.size === 0) {
        logger.warn('AutoLinkManager: Tidak ada Bot Discord di pool untuk memproses channel baru.');
        return;
      }

      // Buat channel di server tujuan
      const destChan = await discordBotPool.createChannel(
        rule.targetGuildId,
        rule.targetCategoryId,
        srcChan.name,
        srcChan.topic || `Mirror dari #${srcChan.name}`
      );

      await new Promise(r => setTimeout(r, 500));

      // Buat webhook
      const webhook = await discordBotPool.createWebhook(
        destChan.id,
        `Nexus Mirror - ${srcChan.name}`
      );

      // Simpan mapping
      channelStore.add({
        category: rule.categoryName,
        name: srcChan.name,
        discordId: srcChan.id,
        dcWebhookUrl: webhook.url,
        tgChatId: '',
        botKey: '1',
        threadId: null,
      });

      logger.success(`AutoLinkManager: Channel baru #${srcChan.name} otomatis dibuat dan dimapping ke kategori "${rule.categoryName}"`);
      this._notify('success', `🆕 Auto-Sync: Channel <b>#${srcChan.name}</b> otomatis dibuat & disambungkan ke kategori <b>${rule.categoryName}</b>!`);
    } catch (err) {
      logger.error(`AutoLinkManager: Gagal auto-sync channel baru #${srcChan.name}`, err.message);
      this._notify('error', `⚠️ Auto-Sync gagal untuk #${srcChan.name}: ${err.message}`);
    }
  }

  /**
   * Daftar semua aturan auto-sync yang aktif
   */
  listRules() {
    return [...this.rules];
  }

  /**
   * Hapus sebuah aturan
   */
  deleteRule(ruleId) {
    const before = this.rules.length;
    this.rules = this.rules.filter(r => r.id !== String(ruleId));
    if (this.rules.length < before) {
      this._saveRules();
      return true;
    }
    return false;
  }

  /**
   * Toggle status auto-sync aktif/nonaktif
   */
  toggleSync(ruleId, enabled) {
    const rule = this.rules.find(r => r.id === String(ruleId));
    if (rule) {
      rule.autoSync = Boolean(enabled);
      this._saveRules();
      return true;
    }
    return false;
  }
}

module.exports = new AutoLinkManager();
