// ============================================================
//   UTILS / AUTOLINKMANAGER.JS
//   Otomatisasi Penghubung Kategori & Channel (DC-to-DC)
//   Fungsi:
//     - Membaca channel di kategori server sumber (via Discord User Token)
//     - Membuat channel & webhook di server tujuan (via Discord Bot Pool)
//     - Mendaftarkan otomatis ke channels.json dengan label kategori rapi
//     - Auto-Sync listener realtime:
//       * channelCreate: buat channel & webhook tujuan otomatis
//       * channelUpdate: rename otomatis jika nama berbeda ("biar sama mirip")
//       * channelDelete: kurangi/hapus channel tujuan & bersihkan mapping
//     - Category Reconcile / Smart Sync:
//       * Membaca dan membandingkan seluruh channel antara sumber & tujuan
//       * Menambahkan yang kurang, menyamakan nama yang beda, menghapus yang terhapus
//       * Anti-skip dengan antrean retry rate-limit 100% tuntas
// ============================================================

'use strict';

const fs             = require('fs');
const path           = require('path');
const logger         = require('./logger');
const channelStore   = require('./channelStore');
const discordBotPool = require('./discordBotPool');

const RULES_FILE = path.join(__dirname, '..', 'data', 'autolink-rules.json');

/**
 * Normalisasi dan bersihkan nama channel dari emoji, prefix nomor (01-, 1.), dan karakter pemisah dekoratif
 * @param {string} str 
 * @returns {string}
 */
function cleanChannelName(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA00}-\u{1FAFF}]/gu, '')
    .replace(/^[0-9]+[.\-_\s|]+/g, '')
    .replace(/[|\-_~•★✦►▶▸▹#]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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
   * Daftarkan event listener channelCreate, channelUpdate, channelDelete pada sebuah client
   */
  hookClient(client) {
    if (!client || this._hookedClients.has(client)) return;
    this._hookedClients.add(client);

    // 1. Channel Baru Dibuat di Server Sumber ("menambahkan secara otomatis")
    client.on('channelCreate', async (channel) => {
      try {
        if (channel.type !== 'GUILD_TEXT' && channel.type !== 0) return;
        const guildId = channel.guild?.id;
        const parentId = channel.parentId || channel.parent_id;
        if (!guildId || !parentId) return;

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

    // 2. Channel Diupdate / Direname / Dipindahkan ("jika ada channel yang tidak sama namanya")
    client.on('channelUpdate', async (oldChannel, newChannel) => {
      try {
        if (newChannel.type !== 'GUILD_TEXT' && newChannel.type !== 0) return;
        const guildId = newChannel.guild?.id;
        const oldParentId = oldChannel.parentId || oldChannel.parent_id;
        const newParentId = newChannel.parentId || newChannel.parent_id;
        if (!guildId) return;

        // Cari aturan yang relevan (apakah channel baru/lama berada di kategori yang dipantau)
        const matchingRule = this.rules.find(r => 
          r.autoSync !== false &&
          String(r.sourceGuildId) === String(guildId) &&
          (String(r.sourceCategoryId) === String(newParentId) || String(r.sourceCategoryId) === String(oldParentId))
        );

        if (!matchingRule) return;

        // A. Channel dipindahkan KE DALAM kategori yang dipantau
        if (oldParentId !== newParentId && String(newParentId) === String(matchingRule.sourceCategoryId)) {
          logger.info(`AutoLinkManager: Channel #${newChannel.name} dipindahkan ke dalam kategori "${matchingRule.categoryName}". Menambahkan ke server tujuan...`);
          await this.syncNewChannel(newChannel, matchingRule);
          return;
        }

        // B. Channel dipindahkan KELUAR DARI kategori yang dipantau ("mengurangi secara otomatis")
        if (oldParentId !== newParentId && String(oldParentId) === String(matchingRule.sourceCategoryId)) {
          logger.info(`AutoLinkManager: Channel #${oldChannel.name} dipindahkan keluar dari kategori "${matchingRule.categoryName}". Mengurangi...`);
          await this.syncRemovedChannel(oldChannel, matchingRule);
          return;
        }

        // C. Nama atau topik channel berubah ("jika ada channel yang tidak sama namanya biar sama mirip")
        if (oldChannel.name !== newChannel.name || oldChannel.topic !== newChannel.topic) {
          logger.info(`AutoLinkManager: Channel diubah: #${oldChannel.name} ➔ #${newChannel.name}. Menyesuaikan nama di server tujuan...`);
          await this.syncRenamedChannel(oldChannel, newChannel, matchingRule);
        }

        // D. Urutan posisi channel di server sumber berubah (Channel Dragged / Reordered)
        if (oldChannel.position !== newChannel.position) {
          logger.info(`AutoLinkManager: Posisi channel di server sumber berubah: #${newChannel.name} (${oldChannel.position} ➔ ${newChannel.position}). Menyelaraskan urutan di server tujuan...`);
          await this.syncCategoryPositions(matchingRule);
        }
      } catch (err) {
        logger.warn('AutoLinkManager: Error saat memproses channelUpdate', err.message);
      }
    });

    // 3. Channel Dihapus di Server Sumber ("mengurangi secara otomatis")
    client.on('channelDelete', async (channel) => {
      try {
        const guildId = channel.guild?.id;
        const parentId = channel.parentId || channel.parent_id;
        if (!guildId) return;

        const matchingRule = this.rules.find(r => 
          r.autoSync !== false &&
          String(r.sourceGuildId) === String(guildId) &&
          (!parentId || String(r.sourceCategoryId) === String(parentId))
        );

        const existing = channelStore.find(channel.id);
        if (matchingRule || existing) {
          logger.info(`AutoLinkManager: Channel #${channel.name} (${channel.id}) dihapus di server sumber. Mengurangi & membersihkan di server tujuan...`);
          await this.syncRemovedChannel(channel, matchingRule);
        }
      } catch (err) {
        logger.warn('AutoLinkManager: Error saat memproses channelDelete', err.message);
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
   * Cari atau buat kategori "[📁 ARSIP LAMA]" di server tujuan agar chat history tidak hilang
   * @param {string} targetGuildId 
   */
  async _getOrCreateArchiveCategory(targetGuildId) {
    const archiveCatName = '[📁 ARSIP LAMA]';
    try {
      const channels = await discordBotPool.getGuildChannels(targetGuildId);
      let cat = channels.find(c => 
        (c.type === 4 || c.type === 'GUILD_CATEGORY') && 
        (c.name.toLowerCase().includes('arsip') || c.name.toLowerCase().includes('archive'))
      );
      if (!cat) {
        logger.info(`AutoLinkManager: Membuat kategori arsip "${archiveCatName}" di server tujuan...`);
        cat = await discordBotPool.createCategory(targetGuildId, archiveCatName);
      }
      return cat.id;
    } catch (err) {
      logger.warn(`AutoLinkManager: Gagal _getOrCreateArchiveCategory: ${err.message}`);
      return null;
    }
  }

  /**
   * Selaraskan seluruh urutan channel di kategori tujuan sesuai urutan di server sumber (1:1)
   */
  async syncCategoryPositions(rule) {
    try {
      if (!rule?.sourceGuildId || !rule?.sourceCategoryId || !rule?.targetGuildId || !rule?.targetCategoryId) return;
      const preview = await this.previewSourceCategory(rule.sourceGuildId, rule.sourceCategoryId);
      const positionPayload = [];
      for (let i = 0; i < preview.channels.length; i++) {
        const src = preview.channels[i];
        const stored = channelStore.find(src.id);
        if (stored?.targetChannelId) {
          positionPayload.push({
            id: stored.targetChannelId,
            position: i,
            parent_id: rule.targetCategoryId,
          });
        }
      }
      if (positionPayload.length > 0) {
        await discordBotPool.updateChannelPositions(rule.targetGuildId, positionPayload);
        logger.success(`AutoLinkManager: Urutan posisi channel di kategori "${rule.categoryName}" berhasil diselaraskan otomatis (1:1).`);
        this._notify('info', `🔄 Auto-Sync: Urutan posisi channel di kategori <b>${rule.categoryName}</b> otomatis diselaraskan (1:1)!`);
      }
    } catch (err) {
      logger.warn('AutoLinkManager: Gagal syncCategoryPositions', err.message);
    }
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
          targetChannelId: existing?.targetChannelId || null,
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

    // 3. Smart Pairing untuk channel yang sudah ada di kategori target (Chat History Aman!)
    const destCatChannels = targetExistingChannels
      .filter(c => (c.type === 0 || c.type === 'GUILD_TEXT') && String(c.parent_id || c.parentId) === String(targetCatId))
      .sort((a, b) => (a.position || 0) - (b.position || 0));

    const matchedDestMap = new Map(); // srcId -> destChan
    const usedDestIds = new Set();

    // Pass 1: Stored targetChannelId
    for (const src of preview.channels) {
      const existing = channelStore.find(src.id);
      if (existing?.targetChannelId) {
        const dest = destCatChannels.find(d => d.id === existing.targetChannelId && !usedDestIds.has(d.id))
                  || targetExistingChannels.find(d => d.id === existing.targetChannelId && !usedDestIds.has(d.id));
        if (dest) {
          usedDestIds.add(dest.id);
          matchedDestMap.set(src.id, dest);
        }
      }
    }

    // Pass 2: Exact normalized name match
    for (const src of preview.channels) {
      if (matchedDestMap.has(src.id)) continue;
      const srcNorm = src.name.trim().toLowerCase().replace(/\s+/g, '-');
      const dest = destCatChannels.find(d => 
        !usedDestIds.has(d.id) && d.name.trim().toLowerCase().replace(/\s+/g, '-') === srcNorm
      );
      if (dest) {
        usedDestIds.add(dest.id);
        matchedDestMap.set(src.id, dest);
      }
    }

    // Pass 3: Cleaned / fuzzy name match (abaikan emoji, nomor urut 01-, spasi)
    for (const src of preview.channels) {
      if (matchedDestMap.has(src.id)) continue;
      const srcClean = cleanChannelName(src.name);
      if (!srcClean) continue;
      const dest = destCatChannels.find(d => {
        if (usedDestIds.has(d.id)) return false;
        const dClean = cleanChannelName(d.name);
        if (dClean && srcClean === dClean) return true;
        if (srcClean.length >= 4 && dClean.length >= 4 && (srcClean.includes(dClean) || dClean.includes(srcClean))) return true;
        return false;
      });
      if (dest) {
        usedDestIds.add(dest.id);
        matchedDestMap.set(src.id, dest);
      }
    }

    // Pass 4: Sequential position-based pairing
    // Memasangkan channel yang sudah ada di kategori tujuan agar TIDAK dibuat duplikat dan chat history aman
    for (const src of preview.channels) {
      if (matchedDestMap.has(src.id)) continue;
      const nextUnused = destCatChannels.find(d => !usedDestIds.has(d.id));
      if (nextUnused) {
        usedDestIds.add(nextUnused.id);
        matchedDestMap.set(src.id, nextUnused);
      }
    }

    // 4. Proses setiap channel (dengan anti-skip dan antrean retry)
    const results = {
      categoryName: finalCategoryName,
      targetCategoryId: targetCatId,
      total: preview.channels.length,
      created: [],
      updated: [],
      renamed: [],
      errors: [],
    };

    const processChannel = async (srcChan, index, total) => {
      const existing = channelStore.find(srcChan.id);
      let destChan = matchedDestMap.get(srcChan.id) || null;

      // Jika channel belum ada di server tujuan (channel kurang), buatkan
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
      } else {
        // Jika channel tujuan ada tapi namanya tidak sama persis, rename agar sama persis ("biar sama mirip")
        const srcNorm = srcChan.name.toLowerCase().trim().replace(/\s+/g, '-');
        const destNorm = destChan.name.toLowerCase().trim().replace(/\s+/g, '-');
        if (destNorm !== srcNorm) {
          logger.info(`AutoLinkManager: Menyesuaikan nama channel tujuan: #${destChan.name} ➔ #${srcChan.name}...`);
          this._notify('info', `Menyesuaikan nama channel tujuan: #${destChan.name} ➔ <b>#${srcChan.name}</b> (Chat Aman ✅)...`);
          await discordBotPool.updateChannel(destChan.id, { name: srcChan.name });
          destChan.name = srcChan.name;
          results.renamed.push({ oldName: destChan.name, newName: srcChan.name, targetChannelId: destChan.id });
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // Buat / Ambil Webhook di channel tujuan dengan rotasi bot dan auto-wait rate limit
      logger.info(`AutoLinkManager: [${index+1}/${total}] Menghubungkan webhook untuk #${destChan.name}...`);
      this._notify('info', `[${index+1}/${total}] Menghubungkan webhook untuk <b>#${destChan.name}</b>...`);
      const webhook = await discordBotPool.createWebhook(
        destChan.id,
        `Nexus Mirror - ${srcChan.name}`,
        (waitSec, round, maxRounds) => {
          this._notify('warning', `⏳ Channel #${destChan.name}: Cooldown rate-limit Discord (${waitSec}s). Sistem sedang antre, JANGAN ditutup... [Antrean ${round}/${maxRounds}]`);
        }
      );

      // Simpan ke channelStore dengan targetChannelId & targetGuildId
      channelStore.add({
        category: finalCategoryName,
        name: srcChan.name,
        discordId: srcChan.id,
        dcWebhookUrl: webhook.url,
        targetChannelId: destChan.id,
        targetGuildId: targetGuildId,
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
        results.updated.push({ name: srcChan.name, discordId: srcChan.id, webhookUrl: webhook.url, targetChannelId: destChan.id });
      } else {
        results.created.push({ name: srcChan.name, discordId: srcChan.id, webhookUrl: webhook.url, targetChannelId: destChan.id });
      }

      await new Promise(r => setTimeout(r, 700));
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
      await new Promise(r => setTimeout(r, 4000));

      for (const item of failedChannels) {
        try {
          await processChannel(item.channel, item.originalIndex, preview.channels.length);
        } catch (retryErr) {
          logger.error(`AutoLinkManager: Channel #${item.channel.name} tetap gagal setelah putaran kedua: ${retryErr.message}`);
          results.errors.push({ name: item.channel.name, discordId: item.channel.id, error: retryErr.message });
        }
      }
    }

    // Selaraskan urutan posisi channel di server tujuan (1:1)
    try {
      const positionPayload = [];
      for (let i = 0; i < preview.channels.length; i++) {
        const src = preview.channels[i];
        const stored = channelStore.find(src.id);
        if (stored?.targetChannelId) {
          positionPayload.push({
            id: stored.targetChannelId,
            position: i,
            parent_id: targetCatId,
          });
        }
      }
      if (positionPayload.length > 0) {
        await discordBotPool.updateChannelPositions(targetGuildId, positionPayload);
      }
    } catch (_) {}

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
   * Bandingkan channel antara kategori sumber dan server tujuan secara mendalam:
   * Mendeteksi:
   * - identical: nama sama, terhubung webhook
   * - toRename: nama channel di sumber & tujuan berbeda ("ada channel yang tidak sama namanya")
   * - toAdd: ada di sumber tapi belum ada di server tujuan ("ada channel yang kurang")
   * - toRemove: ada di target/store tapi sudah terhapus di sumber ("mengurangi secara otomatis")
   * - toRepairWebhook: target channel ada tapi webhook belum terpasang
   */
  async compareCategory({
    sourceGuildId,
    sourceCategoryId,
    targetGuildId,
    targetCategoryId = null,
    categoryName = '',
  }) {
    if (discordBotPool.size === 0) {
      throw new Error('Belum ada Bot Discord yang terdaftar di Bot Pool.');
    }

    // 1. Ambil channel sumber
    const preview = await this.previewSourceCategory(sourceGuildId, sourceCategoryId);
    const srcChannels = preview.channels;

    // 2. Ambil channel target
    let destGuildChannels = [];
    try {
      destGuildChannels = await discordBotPool.getGuildChannels(targetGuildId);
    } catch (err) {
      throw new Error(`Gagal membaca server tujuan: ${err.message}`);
    }

    const finalCategoryName = (categoryName && categoryName.trim()) 
      ? categoryName.trim() 
      : preview.sourceCategoryName;

    // Tentukan target category id
    let targetCatId = targetCategoryId ? String(targetCategoryId).trim() : null;
    if (!targetCatId || targetCatId === 'auto') {
      const existingCat = destGuildChannels.find(c => 
        c.type === 4 && c.name.toLowerCase().trim() === finalCategoryName.toLowerCase().trim()
      );
      if (existingCat) targetCatId = existingCat.id;
    }

    const destCatChannels = targetCatId 
      ? destGuildChannels.filter(c => (c.type === 0 || c.type === 'GUILD_TEXT') && String(c.parent_id || c.parentId) === String(targetCatId)).sort((a, b) => (a.position || 0) - (b.position || 0))
      : [];

    const storedCategoryChannels = channelStore.getByCategory(finalCategoryName);

    // Multi-pass Smart Pairing (Prioritaskan melestarikan channel yang sudah ada agar chat history tidak hilang)
    const matchedDestMap = new Map(); // srcId -> destChan
    const usedDestIds = new Set();

    // Pass 1: Stored mapping di channelStore
    for (const src of srcChannels) {
      const stored = channelStore.find(src.id);
      if (stored?.targetChannelId) {
        const destChan = destCatChannels.find(d => d.id === stored.targetChannelId && !usedDestIds.has(d.id))
                      || destGuildChannels.find(d => d.id === stored.targetChannelId && !usedDestIds.has(d.id));
        if (destChan) {
          usedDestIds.add(destChan.id);
          matchedDestMap.set(src.id, destChan);
        }
      }
    }

    // Pass 2: Exact normalized name match
    for (const src of srcChannels) {
      if (matchedDestMap.has(src.id)) continue;
      const srcNorm = src.name.trim().toLowerCase().replace(/\s+/g, '-');
      const destChan = destCatChannels.find(d => 
        !usedDestIds.has(d.id) && d.name.trim().toLowerCase().replace(/\s+/g, '-') === srcNorm
      );
      if (destChan) {
        usedDestIds.add(destChan.id);
        matchedDestMap.set(src.id, destChan);
      }
    }

    // Pass 3: Cleaned / Fuzzy name match (abaikan emoji, nomor urut 01-, spasi)
    for (const src of srcChannels) {
      if (matchedDestMap.has(src.id)) continue;
      const srcClean = cleanChannelName(src.name);
      if (!srcClean) continue;
      const destChan = destCatChannels.find(d => {
        if (usedDestIds.has(d.id)) return false;
        const dClean = cleanChannelName(d.name);
        if (dClean && srcClean === dClean) return true;
        if (srcClean.length >= 4 && dClean.length >= 4 && (srcClean.includes(dClean) || dClean.includes(srcClean))) return true;
        return false;
      });
      if (destChan) {
        usedDestIds.add(destChan.id);
        matchedDestMap.set(src.id, destChan);
      }
    }

    // Pass 4: Webhook lookup jika ada di stored
    for (const src of srcChannels) {
      if (matchedDestMap.has(src.id)) continue;
      const stored = channelStore.find(src.id);
      if (stored?.dcWebhookUrl) {
        try {
          const wh = await discordBotPool.getWebhookDetails(stored.dcWebhookUrl);
          if (wh?.channel_id && !usedDestIds.has(wh.channel_id)) {
            const destChan = destCatChannels.find(d => d.id === wh.channel_id)
                          || destGuildChannels.find(d => d.id === wh.channel_id);
            if (destChan) {
              usedDestIds.add(destChan.id);
              matchedDestMap.set(src.id, destChan);
            }
          }
        } catch (_) {}
      }
    }

    // Pass 5: Smart Sequential Pairing (Pasangkan channel yang sudah ada berdasarkan urutan posisi)
    // JANGAN HAPUS channel yang sudah ada dan ada isinya di kategori tujuan!
    // Pasangkan ke channel sumber yang belum memiliki padanan, lalu rename dan pasang webhook!
    for (const src of srcChannels) {
      if (matchedDestMap.has(src.id)) continue;
      const nextUnusedDest = destCatChannels.find(d => !usedDestIds.has(d.id));
      if (nextUnusedDest) {
        usedDestIds.add(nextUnusedDest.id);
        matchedDestMap.set(src.id, nextUnusedDest);
      }
    }

    // Kategorikan hasil perbandingan
    const identical = [];
    const toRename = [];
    const toAdd = [];
    const toRepairWebhook = [];

    for (const src of srcChannels) {
      const stored = channelStore.find(src.id);
      const destChan = matchedDestMap.get(src.id);

      if (destChan) {
        const srcNorm = src.name.trim().toLowerCase().replace(/\s+/g, '-');
        const destNorm = destChan.name.trim().toLowerCase().replace(/\s+/g, '-');

        if (srcNorm !== destNorm) {
          // Kasus: Channel sudah ada di tujuan tapi nama berbeda ("biar sama mirip")
          // RENAME nama channel tersebut & sambungkan webhook (Chat history tetap aman dan tidak hilang!)
          toRename.push({
            sourceId: src.id,
            sourceName: src.name,
            targetChannelId: destChan.id,
            targetOldName: destChan.name,
            targetNewName: src.name,
            currentWebhook: stored?.dcWebhookUrl || null,
          });
        } else if (!stored?.dcWebhookUrl) {
          // Kasus: Nama cocok tapi webhook belum ada
          toRepairWebhook.push({
            sourceId: src.id,
            name: src.name,
            targetChannelId: destChan.id,
          });
        } else {
          // Kasus: Cocok identik
          identical.push({
            sourceId: src.id,
            name: src.name,
            targetChannelId: destChan.id,
            webhookUrl: stored.dcWebhookUrl,
          });
        }
      } else {
        // Kasus: Belum ada di server tujuan (Channel Kurang) -> Tambahkan baru
        toAdd.push({
          sourceId: src.id,
          name: src.name,
          topic: src.topic || '',
        });
      }
    }

    // Periksa channel berlebih / terhapus
    const toRemove = [];

    // 1. Channel yang sebelumnya tersimpan di database mapping tapi sudah dihapus di server sumber
    for (const st of storedCategoryChannels) {
      if (!srcChannels.some(s => String(s.id) === String(st.discordId))) {
        toRemove.push({
          discordId: st.discordId,
          name: st.name,
          targetChannelId: st.targetChannelId || null,
          reason: 'Channel telah dihapus dari server sumber',
        });
      }
    }

    // 2. Channel di kategori tujuan yang benar-benar berlebih / tidak aktif (tidak ada pasangannya di sumber)
    for (const d of destCatChannels) {
      if (!usedDestIds.has(d.id)) {
        if (!toRemove.some(r => r.targetChannelId === d.id)) {
          toRemove.push({
            discordId: null,
            name: d.name,
            targetChannelId: d.id,
            reason: 'Channel berlebih di kategori server tujuan (tidak ada padanan di sumber)',
          });
        }
      }
    }

    return {
      sourceGuildId,
      sourceGuildName: preview.sourceGuildName,
      sourceCategoryId,
      sourceCategoryName: preview.sourceCategoryName,
      targetGuildId,
      targetCategoryId: targetCatId,
      categoryName: finalCategoryName,
      counts: {
        totalSource: srcChannels.length,
        totalTarget: destCatChannels.length,
        identicalCount: identical.length,
        toRenameCount: toRename.length,
        toAddCount: toAdd.length,
        toRemoveCount: toRemove.length,
        toRepairCount: toRepairWebhook.length,
      },
      identical,
      toRename,
      toAdd,
      toRemove,
      toRepairWebhook,
      srcChannels,
    };
  }

  /**
   * Eksekusi Rekonsiliasi & Sinkronisasi Cerdas:
   * - Otomatis ubah nama channel yang berbeda ("biar sama sama mirip")
   * - Otomatis buat channel yang kurang + webhook ("menambahkan secara otomatis")
   * - Otomatis hapus channel yang terhapus di sumber ("mengurangi secara otomatis")
   * - Dilengkapi anti-skip dan antrean retry berulang
   */
  async executeReconcile({
    sourceGuildId,
    sourceCategoryId,
    targetGuildId,
    targetCategoryId = null,
    categoryName = '',
    options = { rename: true, add: true, remove: true, repairWebhook: true },
    autoSync = true,
  }) {
    // 1. Jalankan perbandingan terlebih dahulu
    const diff = await this.compareCategory({
      sourceGuildId,
      sourceCategoryId,
      targetGuildId,
      targetCategoryId,
      categoryName,
    });

    const finalCategoryName = diff.categoryName;
    let targetCatId = diff.targetCategoryId;

    // Pastikan target category ada jika perlu menambah channel
    if (!targetCatId && (diff.toAdd.length > 0 || options.add)) {
      const newCat = await discordBotPool.createCategory(targetGuildId, finalCategoryName);
      targetCatId = newCat.id;
    }

    const report = {
      categoryName: finalCategoryName,
      targetCategoryId: targetCatId,
      renamed: [],
      added: [],
      removed: [],
      repaired: [],
      errors: [],
    };

    const totalActions = 
      (options.rename ? diff.toRename.length : 0) +
      (options.add ? diff.toAdd.length : 0) +
      (options.remove ? diff.toRemove.length : 0) +
      (options.repairWebhook ? diff.toRepairWebhook.length : 0);

    let currentAction = 0;

    // ── Phase 1: Hubungkan & Rename Channel yang Sudah Ada (Chat History Aman!) ──
    if (diff.toRename.length > 0) {
      this._notify('info', `✏️ [1/4] Menghubungkan & menyesuaikan <b>${diff.toRename.length} channel</b> yang sudah ada di tujuan...`);
      for (const item of diff.toRename) {
        currentAction++;
        try {
          if (options.rename !== false) {
            this._notify('info', `[${currentAction}/${totalActions}] Mengubah nama #${item.targetOldName} ➔ <b>#${item.targetNewName}</b>...`);
            await discordBotPool.updateChannel(item.targetChannelId, {
              name: item.targetNewName,
            }, (waitSec) => {
              this._notify('warning', `⏳ Channel #${item.targetNewName}: Menunggu cooldown (${waitSec}s)...`);
            });
          }

          // Hubungkan / Dapatkan Webhook di channel tujuan yang sudah ada ini (Chat History Aman!)
          this._notify('info', `Menghubungkan webhook untuk channel tujuan <b>#${item.targetNewName}</b>...`);
          const webhook = await discordBotPool.createWebhook(
            item.targetChannelId,
            `Nexus Mirror - ${item.targetNewName}`,
            (waitSec, round, maxRounds) => {
              this._notify('warning', `⏳ Webhook #${item.targetNewName}: Cooldown rate-limit (${waitSec}s)...`);
            }
          );

          // Update di channelStore
          const ch = channelStore.find(item.sourceId);
          channelStore.add({
            category: finalCategoryName,
            name: item.targetNewName,
            discordId: item.sourceId,
            dcWebhookUrl: webhook.url,
            targetChannelId: item.targetChannelId,
            targetGuildId: targetGuildId,
            tgChatId: ch?.tgChatId || '',
            botKey: ch?.botKey || '1',
            threadId: ch?.threadId || null,
            dcThreadId: ch?.dcThreadId || null,
            dcCustomUsername: ch?.dcCustomUsername || null,
            dcCustomAvatarUrl: ch?.dcCustomAvatarUrl || null,
            dcAutoPing: ch?.dcAutoPing || null,
            dcOnlyWithMedia: ch?.dcOnlyWithMedia || false,
            dcStripInvites: ch?.dcStripInvites !== false,
          });

          report.renamed.push({
            oldName: item.targetOldName,
            newName: item.targetNewName,
            targetChannelId: item.targetChannelId,
            webhookUrl: webhook.url,
          });
          await new Promise(r => setTimeout(r, 600));
        } catch (err) {
          logger.warn(`AutoLinkManager: Gagal rename/link channel #${item.targetNewName}: ${err.message}`);
          report.errors.push({ name: item.targetNewName, action: 'rename', error: err.message });
        }
      }
    }

    // ── Phase 2: Buat Channel yang Kurang ("ada chanel yang kurang bot ini bisa menambahkan") ──
    if (options.add !== false && diff.toAdd.length > 0) {
      this._notify('info', `➕ [2/4] Membuat <b>${diff.toAdd.length} channel baru</b> yang belum ada di server tujuan...`);
      const failedAdd = [];

      const processAdd = async (item, idx, total) => {
        currentAction++;
        this._notify('info', `[${currentAction}/${totalActions}] Membuat channel tujuan <b>#${item.name}</b>...`);
        const destChan = await discordBotPool.createChannel(
          targetGuildId,
          targetCatId,
          item.name,
          item.topic || `Mirror dari #${item.name}`,
          (waitSec) => {
            this._notify('warning', `⏳ Channel #${item.name}: Menunggu cooldown (${waitSec}s)...`);
          }
        );

        await new Promise(r => setTimeout(r, 600));

        this._notify('info', `Menghubungkan webhook untuk <b>#${item.name}</b>...`);
        const webhook = await discordBotPool.createWebhook(
          destChan.id,
          `Nexus Mirror - ${item.name}`,
          (waitSec, round, maxRounds) => {
            this._notify('warning', `⏳ Channel #${item.name}: Cooldown rate-limit (${waitSec}s) [Antrean ${round}/${maxRounds}]`);
          }
        );

        channelStore.add({
          category: finalCategoryName,
          name: item.name,
          discordId: item.sourceId,
          dcWebhookUrl: webhook.url,
          targetChannelId: destChan.id,
          targetGuildId: targetGuildId,
          tgChatId: '',
          botKey: '1',
          threadId: null,
        });

        report.added.push({ name: item.name, targetChannelId: destChan.id, webhookUrl: webhook.url });
        await new Promise(r => setTimeout(r, 700));
      };

      // Putaran 1
      for (let i = 0; i < diff.toAdd.length; i++) {
        const item = diff.toAdd[i];
        try {
          await processAdd(item, i, diff.toAdd.length);
        } catch (err) {
          logger.warn(`AutoLinkManager: Channel #${item.name} gagal di putaran 1, masuk antrean retry: ${err.message}`);
          failedAdd.push({ item, error: err.message });
        }
      }

      // Putaran 2 (Retry Anti-Skip)
      if (failedAdd.length > 0) {
        this._notify('warning', `🔄 Memproses ulang <b>${failedAdd.length} channel</b> yang tertunda rate-limit agar tidak terlewat...`);
        await new Promise(r => setTimeout(r, 4000));
        for (const f of failedAdd) {
          try {
            await processAdd(f.item, 0, failedAdd.length);
          } catch (retryErr) {
            report.errors.push({ name: f.item.name, action: 'add', error: retryErr.message });
          }
        }
      }
    }

    // ── Phase 3: Penanganan Channel Berlebih / Terhapus di Sumber (Mode Arsip / Hapus) ──
    const removeAction = options.removeAction || (options.remove === false ? 'ignore' : 'archive');
    if (removeAction !== 'ignore' && diff.toRemove.length > 0) {
      if (removeAction === 'archive') {
        this._notify('info', `📦 [3/5] Mengarsipkan <b>${diff.toRemove.length} channel</b> ke kategori [📁 ARSIP LAMA] (Chat Tetap Utuh ✅)...`);
        const archiveCatId = await this._getOrCreateArchiveCategory(targetGuildId);
        for (const item of diff.toRemove) {
          currentAction++;
          try {
            this._notify('info', `[${currentAction}/${totalActions}] Memindahkan channel ke arsip: <b>#${item.name}</b>...`);
            if (item.targetChannelId) {
              const archiveName = item.name.toLowerCase().startsWith('arsip-') ? item.name : `arsip-${item.name}`;
              await discordBotPool.updateChannel(item.targetChannelId, {
                parent_id: archiveCatId || null,
                name: archiveName,
              });
            }

            if (item.discordId) {
              channelStore.remove(item.discordId);
            }

            report.removed.push({ name: item.name, targetChannelId: item.targetChannelId, action: 'archive' });
            await new Promise(r => setTimeout(r, 500));
          } catch (err) {
            logger.warn(`AutoLinkManager: Gagal arsipkan channel #${item.name}: ${err.message}`);
            report.errors.push({ name: item.name, action: 'archive', error: err.message });
          }
        }
      } else if (removeAction === 'delete') {
        this._notify('info', `🗑️ [3/5] Menghapus permanen <b>${diff.toRemove.length} channel</b> yang berlebih di Discord...`);
        for (const item of diff.toRemove) {
          currentAction++;
          try {
            this._notify('info', `[${currentAction}/${totalActions}] Menghapus channel <b>#${item.name}</b>...`);
            if (item.targetChannelId) {
              await discordBotPool.deleteChannel(item.targetChannelId, (waitSec) => {
                this._notify('warning', `⏳ Menunggu cooldown delete (${waitSec}s)...`);
              });
            }

            if (item.discordId) {
              channelStore.remove(item.discordId);
            }

            report.removed.push({ name: item.name, targetChannelId: item.targetChannelId, action: 'delete' });
            await new Promise(r => setTimeout(r, 500));
          } catch (err) {
            logger.warn(`AutoLinkManager: Gagal hapus channel #${item.name}: ${err.message}`);
            report.errors.push({ name: item.name, action: 'remove', error: err.message });
          }
        }
      }
    }

    // ── Phase 4: Lengkapi Webhook Kosong ──
    if (options.repairWebhook !== false && diff.toRepairWebhook.length > 0) {
      this._notify('info', `🛠️ [4/5] Melengkapi <b>${diff.toRepairWebhook.length} webhook</b> yang kosong...`);
      for (const item of diff.toRepairWebhook) {
        currentAction++;
        try {
          this._notify('info', `Membuat webhook untuk <b>#${item.name}</b>...`);
          const webhook = await discordBotPool.createWebhook(item.targetChannelId, `Nexus Mirror - ${item.name}`);
          const ch = channelStore.find(item.sourceId);
          if (ch) {
            ch.dcWebhookUrl = webhook.url;
            ch.targetChannelId = item.targetChannelId;
            ch.targetGuildId = targetGuildId;
            channelStore.add(ch);
          }
          report.repaired.push({ name: item.name, webhookUrl: webhook.url });
          await new Promise(r => setTimeout(r, 600));
        } catch (err) {
          report.errors.push({ name: item.name, action: 'repairWebhook', error: err.message });
        }
      }
    }

    // ── Update Metadata Mapping untuk Channel Identik ──
    if (diff.identical && diff.identical.length > 0) {
      for (const item of diff.identical) {
        const ch = channelStore.find(item.sourceId);
        if (ch) {
          ch.category = finalCategoryName;
          ch.targetChannelId = item.targetChannelId;
          ch.targetGuildId = targetGuildId;
          channelStore.add(ch);
        }
      }
    }

    // ── Phase 5: Sinkronisasi Urutan Posisi Channel (Channel Order Sync 1:1) ──
    if (options.position !== false && diff.srcChannels && diff.srcChannels.length > 0) {
      this._notify('info', `🔄 [5/5] Menyelaraskan urutan posisi channel di server tujuan (1:1)...`);
      try {
        const positionPayload = [];
        for (let i = 0; i < diff.srcChannels.length; i++) {
          const src = diff.srcChannels[i];
          const stored = channelStore.find(src.id);
          const targetId = stored?.targetChannelId;
          if (targetId) {
            positionPayload.push({
              id: targetId,
              position: i,
              parent_id: targetCatId,
            });
          }
        }
        if (positionPayload.length > 0) {
          await discordBotPool.updateChannelPositions(targetGuildId, positionPayload);
          this._notify('success', `✨ Urutan posisi channel berhasil diselaraskan 100% persis seperti server sumber!`);
        }
      } catch (posErr) {
        logger.warn(`AutoLinkManager: Gagal sinkronisasi urutan posisi: ${posErr.message}`);
      }
    }

    // Simpan / update aturan Auto-Sync
    const ruleIndex = this.rules.findIndex(r => 
      String(r.sourceGuildId) === String(sourceGuildId) && 
      String(r.sourceCategoryId) === String(sourceCategoryId)
    );

    const ruleData = {
      id: ruleIndex >= 0 ? this.rules[ruleIndex].id : `rule_${Date.now()}`,
      sourceGuildId: String(sourceGuildId),
      sourceGuildName: diff.sourceGuildName,
      sourceCategoryId: String(sourceCategoryId),
      sourceCategoryName: diff.sourceCategoryName,
      targetGuildId: String(targetGuildId),
      targetCategoryId: String(targetCatId),
      categoryName: finalCategoryName,
      autoSync: Boolean(autoSync),
      lastSync: new Date().toISOString(),
    };

    if (ruleIndex >= 0) this.rules[ruleIndex] = ruleData;
    else this.rules.push(ruleData);
    this._saveRules();

    const totalSuccess = report.renamed.length + report.added.length + report.removed.length + report.repaired.length;
    if (report.errors.length === 0) {
      this._notify('success', `✨ Sinkronisasi Selesai 100%! (${report.renamed.length} rename, ${report.added.length} dibuat, ${report.removed.length} dikurangi). Semua channel identik mirip!`);
    } else {
      this._notify('warning', `⚠️ Sinkronisasi Selesai: <b>${totalSuccess} berhasil</b>, ${report.errors.length} kendala.`);
    }

    return report;
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
        // Cari channel di target guild berdasarkan targetChannelId atau nama
        let dest = null;
        if (ch.targetChannelId) {
          dest = destGuildChannels.find(d => d.id === ch.targetChannelId);
        }
        if (!dest) {
          dest = destGuildChannels.find(d => 
            d.type === 0 && d.name.toLowerCase().trim().replace(/\s+/g, '-') === ch.name.toLowerCase().trim().replace(/\s+/g, '-')
          );
        }

        if (!dest) {
          report.errors.push({ name: ch.name, error: 'Channel teks tujuan tidak ditemukan di server target' });
          continue;
        }

        this._notify('info', `[${i+1}/${targetChannels.length}] Memperbaiki webhook untuk <b>#${dest.name}</b>...`);
        const webhook = await discordBotPool.createWebhook(dest.id, `Nexus Mirror - ${ch.name}`);

        ch.dcWebhookUrl = webhook.url;
        ch.targetChannelId = dest.id;
        ch.targetGuildId = targetGuildId;
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
        targetChannelId: destChan.id,
        targetGuildId: rule.targetGuildId,
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
   * Sinkronisasi pergantian nama channel dari server sumber ke server tujuan
   */
  async syncRenamedChannel(oldChan, newChan, rule) {
    try {
      if (discordBotPool.size === 0) return;

      const existing = channelStore.find(newChan.id);
      let targetChanId = existing?.targetChannelId;

      // Jika targetChannelId belum ada, coba cari lewat webhook
      if (!targetChanId && existing?.dcWebhookUrl) {
        const wh = await discordBotPool.getWebhookDetails(existing.dcWebhookUrl);
        if (wh?.channel_id) targetChanId = wh.channel_id;
      }

      // Jika belum ada juga, coba cari di target guild berdasarkan nama lama
      if (!targetChanId && rule?.targetGuildId) {
        const destChannels = await discordBotPool.getGuildChannels(rule.targetGuildId);
        const oldNorm = oldChan.name.toLowerCase().replace(/\s+/g, '-');
        const match = destChannels.find(d => 
          d.type === 0 && 
          String(d.parent_id) === String(rule.targetCategoryId) && 
          d.name.toLowerCase().replace(/\s+/g, '-') === oldNorm
        );
        if (match) targetChanId = match.id;
      }

      if (targetChanId) {
        logger.info(`AutoLinkManager: Mengubah nama channel tujuan (${targetChanId}) dari #${oldChan.name} menjadi #${newChan.name}...`);
        await discordBotPool.updateChannel(targetChanId, {
          name: newChan.name,
          topic: newChan.topic || `Mirror dari #${newChan.name}`,
        });
      }

      // Update di channelStore
      if (existing) {
        existing.name = newChan.name;
        if (targetChanId) existing.targetChannelId = targetChanId;
        if (rule?.targetGuildId) existing.targetGuildId = rule.targetGuildId;
        channelStore.add(existing);
      }

      logger.success(`AutoLinkManager: Channel #${oldChan.name} sukses diubah namanya menjadi #${newChan.name}`);
      this._notify('success', `✏️ Auto-Rename: Channel <b>#${oldChan.name}</b> otomatis diubah namanya menjadi <b>#${newChan.name}</b> di server tujuan!`);
    } catch (err) {
      logger.error(`AutoLinkManager: Gagal auto-rename channel #${newChan.name}`, err.message);
      this._notify('error', `⚠️ Auto-Rename gagal untuk #${newChan.name}: ${err.message}`);
    }
  }

  /**
   * Menghapus channel tujuan dan membersihkan mapping ketika channel dihapus di server sumber
   */
  async syncRemovedChannel(channel, rule) {
    try {
      const existing = channelStore.find(channel.id);
      let targetChanId = existing?.targetChannelId;

      if (!targetChanId && existing?.dcWebhookUrl) {
        const wh = await discordBotPool.getWebhookDetails(existing.dcWebhookUrl);
        if (wh?.channel_id) targetChanId = wh.channel_id;
      }

      if (!targetChanId && rule?.targetGuildId) {
        const destChannels = await discordBotPool.getGuildChannels(rule.targetGuildId);
        const nameNorm = channel.name.toLowerCase().replace(/\s+/g, '-');
        const match = destChannels.find(d => 
          d.type === 0 && 
          String(d.parent_id) === String(rule.targetCategoryId) && 
          d.name.toLowerCase().replace(/\s+/g, '-') === nameNorm
        );
        if (match) targetChanId = match.id;
      }

      // Pindahkan channel ke [📁 ARSIP LAMA] alih-alih dihapus permanen agar chat history tidak hilang
      if (targetChanId && discordBotPool.size > 0 && rule?.targetGuildId) {
        try {
          const archiveCatId = await this._getOrCreateArchiveCategory(rule.targetGuildId);
          logger.info(`AutoLinkManager: Memindahkan channel tujuan #${channel.name} (${targetChanId}) ke [📁 ARSIP LAMA]...`);
          const archiveName = channel.name.toLowerCase().startsWith('arsip-') ? channel.name : `arsip-${channel.name}`;
          await discordBotPool.updateChannel(targetChanId, {
            parent_id: archiveCatId || null,
            name: archiveName,
          });
          logger.success(`AutoLinkManager: Channel #${channel.name} berhasil dipindahkan ke kategori [📁 ARSIP LAMA].`);
          this._notify('warning', `📦 Auto-Arsip: Channel <b>#${channel.name}</b> telah dihapus dari sumber dan dipindahkan ke <b>[📁 ARSIP LAMA]</b>. Chat lama tetap aman!`);
        } catch (archErr) {
          logger.warn(`AutoLinkManager: Gagal memindahkan channel ke arsip: ${archErr.message}`);
        }
      }

      // Hapus dari channelStore agar tidak meneruskan chat lagi
      channelStore.remove(channel.id);
    } catch (err) {
      logger.error(`AutoLinkManager: Gagal auto-reduce channel #${channel.name}`, err.message);
      this._notify('error', `⚠️ Gagal auto-reduce untuk #${channel.name}: ${err.message}`);
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
