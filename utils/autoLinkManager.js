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

    // 3. Proses setiap channel (dengan anti-skip dan antrean retry)
    const results = {
      categoryName: finalCategoryName,
      targetCategoryId: targetCatId,
      total: preview.channels.length,
      created: [],
      updated: [],
      errors: [],
    };

    const processChannel = async (srcChan, index, total) => {
      // 1. Cek apakah channel di server tujuan sudah ada dengan nama yang sama di kategori tersebut
      let destChan = targetExistingChannels.find(c => 
        c.type === 0 && 
        c.parent_id === targetCatId && 
        c.name.toLowerCase().trim() === srcChan.name.toLowerCase().trim()
      );

      if (!destChan) {
        logger.info(`AutoLinkManager: [${index+1}/${total}] Membuat channel tujuan #${srcChan.name}...`);
        this._notify('info', `[${index+1}/${total}] Membuat channel tujuan <b>#${srcChan.name}</b>...`);
        destChan = await discordBotPool.createChannel(
          targetGuildId,
          targetCatId,
          srcChan.name,
          srcChan.topic || `Mirror dari #${srcChan.name}`,
          (waitSec) => {
            this._notify('warning', `⏳ Channel #${srcChan.name}: Menunggu cooldown rate-limit channel (${waitSec}s)...`);
          }
        );
        targetExistingChannels.push(destChan);
        await new Promise(r => setTimeout(r, 600));
      }

      // 2. Buat / Ambil Webhook di channel tujuan dengan rotasi bot dan auto-wait rate limit
      logger.info(`AutoLinkManager: [${index+1}/${total}] Menghubungkan webhook untuk #${destChan.name}...`);
      this._notify('info', `[${index+1}/${total}] Menghubungkan webhook untuk <b>#${destChan.name}</b>...`);
      const webhook = await discordBotPool.createWebhook(
        destChan.id,
        `Nexus Mirror - ${srcChan.name}`,
        (waitSec, round, maxRounds) => {
          this._notify('warning', `⏳ Channel #${destChan.name}: Cooldown rate-limit Discord (${waitSec}s). Sistem sedang antre, JANGAN ditutup... [Antrean ${round}/${maxRounds}]`);
        }
      );

      // 3. Simpan ke channelStore dengan category yang rapi
      const existing = channelStore.find(srcChan.id);
      channelStore.add({
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

      await new Promise(r => setTimeout(r, 800));
    };

    // Putaran Pertama (First Pass)
    const failedChannels = [];
    for (let i = 0; i < preview.channels.length; i++) {
      const srcChan = preview.channels[i];
      try {
        await processChannel(srcChan, i, preview.channels.length);
      } catch (err) {
        logger.warn(`AutoLinkManager: Channel #${srcChan.name} masuk antrean coba ulang: ${err.message}`);
        failedChannels.push({ channel: srcChan, originalIndex: i, error: err.message });
      }
    }

    // Putaran Kedua (Second Pass) untuk channel yang sempat rate-limit agar TIDAK ADA YANG TERLEWAT
    if (failedChannels.length > 0) {
      logger.info(`AutoLinkManager: Menjalankan putaran kedua untuk ${failedChannels.length} channel yang sempat tertunda...`);
      this._notify('warning', `🔄 Memproses ulang <b>${failedChannels.length} channel</b> yang sempat terkena jeda rate-limit agar tidak ada yang terlewat...`);
      await new Promise(r => setTimeout(r, 5000));

      for (const item of failedChannels) {
        try {
          await processChannel(item.channel, item.originalIndex, preview.channels.length);
        } catch (retryErr) {
          logger.error(`AutoLinkManager: Channel #${item.channel.name} tetap gagal setelah putaran kedua: ${retryErr.message}`);
          results.errors.push({ name: item.channel.name, discordId: item.channel.id, error: retryErr.message });
        }
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

    const successCount = results.created.length + results.updated.length;
    if (results.errors.length === 0) {
      this._notify('success', `✨ Auto-Link Sempurna: Seluruh <b>${successCount} channel</b> di kategori <b>${finalCategoryName}</b> berhasil dibuatkan webhook 100%!`);
    } else {
      this._notify('warning', `⚠️ Auto-Link Selesai: <b>${successCount} channel</b> sukses terhubung, <b>${results.errors.length} channel</b> kendala.`);
    }

    return results;
  }

  /**
   * Pindai dan lengkapi webhook untuk channel-channel yang belum memiliki webhook
   * @param {{ targetGuildId: string, categoryName?: string }} params
   */
  async repairMissingWebhooks({ targetGuildId, categoryName = null }) {
    if (discordBotPool.size === 0) {
      throw new Error('Belum ada Bot Discord yang terdaftar di Bot Pool.');
    }

    // Filter channel dari channelStore yang belum punya dcWebhookUrl
    const allChannels = channelStore.list();
    const targetChannels = allChannels.filter(c => {
      if (categoryName && (c.category || 'General').toLowerCase().trim() !== String(categoryName).toLowerCase().trim()) {
        return false;
      }
      return !c.dcWebhookUrl || !c.dcWebhookUrl.trim();
    });

    if (targetChannels.length === 0) {
      return { totalChecked: allChannels.length, fixed: [], errors: [], message: 'Semua channel sudah memiliki webhook!' };
    }

    // Ambil channel di target guild
    let destGuildChannels = [];
    try {
      destGuildChannels = await discordBotPool.getGuildChannels(targetGuildId);
    } catch (err) {
      throw new Error(`Gagal membaca server tujuan: ${err.message}`);
    }

    const report = {
      totalChecked: targetChannels.length,
      fixed: [],
      errors: [],
    };

    for (let i = 0; i < targetChannels.length; i++) {
      const ch = targetChannels[i];
      try {
        // Cari channel di target guild berdasarkan nama
        const dest = destGuildChannels.find(d => 
          d.type === 0 && d.name.toLowerCase().trim() === ch.name.toLowerCase().trim()
        );

        if (!dest) {
          report.errors.push({ name: ch.name, error: 'Channel teks tujuan tidak ditemukan di server target' });
          continue;
        }

        this._notify('info', `[${i+1}/${targetChannels.length}] Memperbaiki webhook untuk <b>#${dest.name}</b>...`);
        const webhook = await discordBotPool.createWebhook(dest.id, `Nexus Mirror - ${ch.name}`);

        ch.dcWebhookUrl = webhook.url;
        channelStore.add(ch);
        report.fixed.push({ name: ch.name, webhookUrl: webhook.url });
        await new Promise(r => setTimeout(r, 600));

      } catch (err) {
        report.errors.push({ name: ch.name, error: err.message });
      }
    }

    this._notify('success', `🛠️ Selesai memperbaiki webhook: <b>${report.fixed.length} channel</b> berhasil dilengkapi!`);
    return report;
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
