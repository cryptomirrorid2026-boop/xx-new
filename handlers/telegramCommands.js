// ============================================================
//   HANDLERS / TELEGRAMCOMMANDS.JS
//   Remote control bot via Telegram commands
//   Commands: /status, /sysinfo, /mapping, /block, /unblock,
//             /blocklist, /mute, /unmute, /clearstore,
//             /restart, /help
//
//   ⚠️  HANYA MERESPONS DI PRIVATE CHAT (DM) KE ADMIN
//       Command dari grup/channel akan DIABAIKAN SEPENUHNYA
// ============================================================

'use strict';

const TelegramBot       = require('node-telegram-bot-api');
const stats             = require('../utils/stats');
const blockedUsersStore = require('../utils/blockedUsersStore');
const mutedChannels     = require('../utils/mutedChannels');
const messageStore      = require('../utils/messageStore');
const forwardQueue      = require('../utils/forwardQueue');
const logger            = require('../utils/logger');
const os                = require('os');
const mappingStore      = require('../utils/mappingStore');

/**
 * Format angka dengan pemisah ribuan
 */
function fmt(n) {
  return Number(n || 0).toLocaleString('id-ID');
}

/**
 * Daftarkan polling bot untuk menerima commands dari admin
 * @param {object}  tgManager    - Instance TelegramManager
 * @param {Map}     channelMap   - Mapping channel DC→TG (shared reference)
 * @param {object}  config       - Config bot
 * @param {object}  channelStore - ChannelStore instance (CRUD + hot-reload)
 */
function registerTelegramCommands(tgManager, channelMap, config, channelStore = null, tg2dcStore = null) {
  const adminId    = process.env.ADMIN_TELEGRAM_ID;
  const adminBotKey = String(process.env.ADMIN_BOT_KEY || '1');

  if (!adminId) {
    logger.warn('ADMIN_TELEGRAM_ID tidak diset — Telegram commands dinonaktifkan');
    return;
  }

  // Ambil token admin bot dari manager
  const token = tgManager.getToken(adminBotKey);
  if (!token) {
    logger.warn(`Admin bot #${adminBotKey} tidak ditemukan — Telegram commands dinonaktifkan`);
    return;
  }

  // Buat instance polling TERPISAH dari yang dipakai kirim pesan
  let pollingBot;
  try {
    pollingBot = new TelegramBot(token, {
      polling: {
        interval: 1000,
        autoStart: true,
        params: { timeout: 10 },
      },
    });

    let lastPollingWarnTime = 0;
    let lastPollingWarnMsg = '';

    pollingBot.on('polling_error', (err) => {
      // Tangkap polling error agar tidak crash uncaught exception
      const msg = err.message || String(err);
      const now = Date.now();

      if (msg.includes('409 Conflict')) return;

      // Throttle repeating transient network errors (502 Bad Gateway, 504, ETIMEDOUT, ECONNRESET)
      const isTransientNetworkErr = msg.includes('502 Bad Gateway') || 
                                     msg.includes('504 Gateway') || 
                                     msg.includes('ETIMEDOUT') || 
                                     msg.includes('ECONNRESET') ||
                                     msg.includes('ENOTFOUND');

      if (isTransientNetworkErr) {
        if (msg === lastPollingWarnMsg && now - lastPollingWarnTime < 60000) {
          return; // Suppress spam logging for 60 seconds during Telegram API hiccups
        }
        lastPollingWarnTime = now;
        lastPollingWarnMsg = msg;
        logger.warn('Telegram API network/502 hiccup (auto-retry):', msg.substring(0, 80));
        return;
      }

      logger.warn('Telegram Polling warning:', msg.substring(0, 80));
    });
  } catch (err) {
    logger.error('Gagal membuat polling bot untuk commands', err.message);
    return;
  }

  logger.success(`Telegram command handler aktif (Admin: ${adminId}, Bot #${adminBotKey})`);

  // ─── Helper: cek apakah pengirim adalah admin VIA DM PRIBADI ───────────────
  // Mengembalikan true HANYA jika:
  //   1. Pengirim adalah ADMIN_TELEGRAM_ID
  //   2. Chat-nya adalah private (DM langsung), BUKAN grup atau channel
  function isAdminDM(msg) {
    const fromAdmin  = String(msg.from?.id) === String(adminId);
    const isPrivate  = msg.chat?.type === 'private';
    return fromAdmin && isPrivate;
  }

  // ─── Helper: kirim reply ke admin via DM ───────────────────────────────────
  function reply(chatId, text) {
    pollingBot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => {
      pollingBot.sendMessage(chatId, text).catch(() => {});
    });
  }

  // ─── Tangkap SEMUA pesan — abaikan diam-diam jika bukan admin DM ───────────
  // Ini mencegah bot merespons command apapun di grup sehingga member grup
  // tidak mengetahui adanya bot admin ini.
  pollingBot.on('message', (msg) => {
    if (msg.chat?.type !== 'private') return; // abaikan semua pesan dari grup
    // Jika private tapi bukan admin, diam saja (no reply)
  });

  // ─── /status ────────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/status/, (msg) => {
    if (!isAdminDM(msg)) return;

    const s = stats.getSummary();
    let dashboardUrl = 'Belum tersedia (tunggu beberapa detik)';
    try {
      const fs = require('fs');
      const path = require('path');
      const tunnelData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tunnel.json'), 'utf8'));
      if (tunnelData && tunnelData.url) {
        dashboardUrl = `<a href="${tunnelData.url}">${tunnelData.url}</a>`;
      }
    } catch (err) {}

    const text = [
      `📊 <b>Status Bot Mirror DC→TG</b>`,
      ``,
      `🌐 <b>Dashboard Web:</b> ${dashboardUrl}`,
      ``,
      `⏱ <b>Uptime:</b> ${s.uptime}`,
      `✅ <b>Diteruskan:</b> ${fmt(s.totalForwarded)}`,
      `✏️ <b>Edit sync:</b> ${fmt(s.totalEdits)}`,
      `🖼️ <b>Media:</b> ${fmt(s.totalMedia)}`,
      `❌ <b>Gagal:</b> ${fmt(s.totalFailed)}`,
      ``,
      `🚫 <b>User diblok:</b> ${blockedUsersStore.size}`,
      `🔇 <b>Channel di-mute:</b> ${mutedChannels.size}`,
      `💾 <b>Pesan tersimpan:</b> ${fmt(messageStore.size)}`,
      `📡 <b>Channel aktif:</b> ${channelMap.size}`,
      `🤖 <b>Telegram Bots:</b> ${tgManager.size}`,
      `⚡ <b>AI Cleaner:</b> ${require('../utils/blurManager').isOcrEnabled() ? '🟢 AKTIF' : '🔴 NONAKTIF (Mode Super Cepat)'}`,
      ``,
      s.lastForwardedAt
        ? `🕐 <b>Terakhir forward:</b>\n${new Date(s.lastForwardedAt).toLocaleString('id-ID')}`
        : `🕐 <b>Belum ada pesan diteruskan</b>`,
    ].join('\n');

    reply(msg.chat.id, text);
    logger.bot('Admin request: /status', `dari ${msg.from?.username || adminId}`);
  });

  // ─── /block [ID] ────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/block(?:\s+(\S+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;

    const userId = match[1]?.trim();

    if (!userId) {
      reply(msg.chat.id,
        `🚫 <b>Block User Discord</b>\n\nUsage: <code>/block USER_ID</code>\n\nContoh:\n<code>/block 123456789012345678</code>`
      );
      return;
    }

    if (!/^\d+$/.test(userId)) {
      reply(msg.chat.id, `❌ ID tidak valid. ID Discord hanya berisi angka.\n\nContoh: <code>/block 123456789012345678</code>`);
      return;
    }

    if (blockedUsersStore.has(userId)) {
      reply(msg.chat.id, `⚠️ User <code>${userId}</code> sudah ada di blok list.`);
      return;
    }

    blockedUsersStore.add(userId);
    reply(msg.chat.id,
      `✅ <b>User berhasil diblok!</b>\n\n<code>${userId}</code>\n\nTotal diblok: <b>${blockedUsersStore.size}</b>`
    );
    logger.info(`Admin memblok user: ${userId}`);
  });

  // ─── /unblock [ID] ──────────────────────────────────────────────────────────
  pollingBot.onText(/^\/unblock(?:\s+(\S+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;

    const userId = match[1]?.trim();

    if (!userId) {
      reply(msg.chat.id, `✅ <b>Unblock User Discord</b>\n\nUsage: <code>/unblock USER_ID</code>`);
      return;
    }

    const removed = blockedUsersStore.remove(userId);
    if (removed) {
      reply(msg.chat.id, `✅ User <code>${userId}</code> berhasil diunblok.`);
      logger.info(`Admin meng-unblok user: ${userId}`);
    } else {
      reply(msg.chat.id, `⚠️ User <code>${userId}</code> tidak ada di blok list.`);
    }
  });

  // ─── /blocklist ─────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/blocklist/, (msg) => {
    if (!isAdminDM(msg)) return;

    const list = blockedUsersStore.list();
    if (list.length === 0) {
      reply(msg.chat.id, `🚫 <b>Blok List</b>\n\nTidak ada user yang diblok.`);
      return;
    }

    const listText = list.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n');
    reply(msg.chat.id, `🚫 <b>Blok List (${list.length} user)</b>\n\n${listText}`);
  });

  // ─── /mapping ───────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/mapping/, (msg) => {
    if (!isAdminDM(msg)) return;

    if (channelMap.size === 0) {
      reply(msg.chat.id, `📌 <b>Channel Mapping</b>\n\nTidak ada mapping aktif.`);
      return;
    }

    const lines = [];
    let i = 1;
    for (const [dcId, { tgChatId, botKey, tgThreadId, name }] of channelMap) {
      const threadLog = tgThreadId ? `\n   📢 Topic: <code>${tgThreadId}</code>` : '';
      const label     = name ? ` — <b>${name}</b>` : '';
      lines.push(
        `${i}.${label}\n` +
        `   DC: <code>${dcId}</code>\n` +
        `   TG: <code>${tgChatId}</code>${threadLog} (Bot #${botKey})`
      );
      i++;
    }

    reply(msg.chat.id,
      `📌 <b>Channel Mapping (${channelMap.size} aktif)</b>\n\n${lines.join('\n\n')}`
    );
    logger.bot('Admin request: /mapping');
  });

  // ─── /channels ───────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/channels/, (msg) => {
    if (!isAdminDM(msg)) return;

    const list = channelStore ? channelStore.list() : [];
    if (list.length === 0) {
      reply(msg.chat.id,
        `📡 <b>Channels</b>\n\nBelum ada channel.\n\nGunakan:\n<code>/addch nama dcId tgId botKey [threadId]</code>`
      );
      return;
    }

    const lines = list.map((ch, i) => {
      const thread = ch.threadId ? `\n   📢 Thread: <code>${ch.threadId}</code>` : '';
      const active = channelMap.has(ch.discordId) ? '✅' : '⚠️';
      return (
        `${active} <b>${ch.name}</b>\n` +
        `   DC: <code>${ch.discordId}</code>\n` +
        `   TG: <code>${ch.tgChatId}</code>${thread} (Bot #${ch.botKey})`
      );
    });

    reply(msg.chat.id,
      `📡 <b>Daftar Channel (${list.length})</b>\n\n` +
      lines.join('\n\n') +
      `\n\n➕ <code>/addch</code>  ➖ <code>/removech</code>`
    );
    logger.bot('Admin request: /channels');
  });

  // ─── /addch [name] [dcId] [tgId] [botKey] [threadId] ──────────────────────────
  pollingBot.onText(/^\/addch(?:\s+(.+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    if (!channelStore) {
      reply(msg.chat.id, `❌ ChannelStore tidak aktif.`);
      return;
    }

    const args = (match[1] || '').trim().split(/\s+/);
    // Format: /addch <name> <dcId> <tgId> <botKey> [threadId]
    if (args.length < 4 || !args[0]) {
      reply(msg.chat.id, [
        `➕ <b>Tambah Channel</b>`,
        ``,
        `<b>Format:</b>`,
        `<code>/addch nama dcId tgChatId botKey [threadId]</code>`,
        ``,
        `<b>Contoh (tanpa Topic):</b>`,
        `<code>/addch akademicrypto 1494966942568550441 -1003991448470 2</code>`,
        ``,
        `<b>Contoh (dengan Topic/Thread):</b>`,
        `<code>/addch akademicrypto 1494966942568550441 -1003991448470 2 94</code>`,
        ``,
        `💡 <i>Setelah ditambah, berlaku langsung tanpa restart!</i>`,
      ].join('\n'));
      return;
    }

    const [name, discordId, tgChatId, botKey, threadId] = args;

    if (!/^\d+$/.test(discordId)) {
      reply(msg.chat.id, `❌ Discord Channel ID harus berupa angka.\nContoh: <code>1494966942568550441</code>`);
      return;
    }

    if (!tgManager.get(botKey)) {
      reply(msg.chat.id, `❌ Bot #${botKey} tidak ditemukan. Cek TELEGRAM_BOT_${botKey} di .env`);
      return;
    }

    const ch = channelStore.add({
      name,
      discordId,
      tgChatId,
      botKey,
      threadId: threadId || null,
    });

    const threadInfo = ch.threadId ? `\n📢 Topic: <code>${ch.threadId}</code>` : '';
    reply(msg.chat.id, [
      `✅ <b>Channel berhasil ditambahkan!</b>`,
      ``,
      `🏷️ <b>Nama:</b> ${ch.name}`,
      `🔵 <b>Discord:</b> <code>${ch.discordId}</code>`,
      `🟢 <b>Telegram:</b> <code>${ch.tgChatId}</code>${threadInfo}`,
      `🤖 <b>Bot:</b> #${ch.botKey}`,
      ``,
      `🔄 Berlaku sekarang tanpa restart!`,
    ].join('\n'));
    logger.info(`Admin tambah channel: [${ch.name}] DC:${ch.discordId} → TG:${ch.tgChatId}`);
  });

  // ─── /removech [dcId] ──────────────────────────────────────────────────────────
  pollingBot.onText(/^\/removech(?:\s+(\S+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    if (!channelStore) {
      reply(msg.chat.id, `❌ ChannelStore tidak aktif.`);
      return;
    }

    const dcId = match[1]?.trim();
    if (!dcId) {
      const list = channelStore.list();
      if (list.length === 0) {
        reply(msg.chat.id, `➖ Tidak ada channel untuk dihapus.`);
        return;
      }
      const lines = list.map((ch, i) =>
        `${i + 1}. <b>${ch.name}</b>\n   <code>${ch.discordId}</code>`
      ).join('\n\n');
      reply(msg.chat.id,
        `➖ <b>Hapus Channel</b>\n\nFormat: <code>/removech DISCORD_ID</code>\n\n<b>Channel tersedia:</b>\n\n${lines}`
      );
      return;
    }

    const ch = channelStore.find(dcId);
    const ok = channelStore.remove(dcId);
    if (ok) {
      reply(msg.chat.id,
        `✅ Channel <b>${ch?.name || dcId}</b> berhasil dihapus!\n\n<code>${dcId}</code>\n\n🔄 Berlaku sekarang tanpa restart!`
      );
      logger.info(`Admin hapus channel: [${ch?.name || dcId}] DC:${dcId}`);
    } else {
      reply(msg.chat.id,
        `⚠️ Channel <code>${dcId}</code> tidak ditemukan.\n\nGunakan /channels untuk lihat daftar.`
      );
    }
  });

  // ─── /mute [CHANNEL_ID] ─────────────────────────────────────────────────────────
  pollingBot.onText(/^\/mute(?:\s+(\S+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;

    const channelId = match[1]?.trim();
    if (!channelId) {
      // Tampilkan daftar channel yang bisa di-mute
      const available = [...channelMap.keys()]
        .map((id, i) => {
          const muted = mutedChannels.isMuted(id) ? ' 🔇' : '';
          return `${i + 1}. <code>${id}</code>${muted}`;
        }).join('\n');
      reply(msg.chat.id,
        `🔇 <b>Mute Channel</b>\n\nUsage: <code>/mute CHANNEL_ID</code>\n\n<b>Channel tersedia:</b>\n${available || 'Tidak ada'}`
      );
      return;
    }

    if (!channelMap.has(channelId)) {
      reply(msg.chat.id, `❌ Channel <code>${channelId}</code> tidak ada di mapping.\n\nGunakan /mute tanpa ID untuk melihat daftar channel.`);
      return;
    }

    if (mutedChannels.isMuted(channelId)) {
      reply(msg.chat.id, `⚠️ Channel <code>${channelId}</code> sudah di-mute.\n\nGunakan /unmute untuk mengaktifkan kembali.`);
      return;
    }

    mutedChannels.mute(channelId);
    reply(msg.chat.id, `🔇 <b>Channel berhasil di-mute!</b>\n\n<code>${channelId}</code>\n\nPesan dari channel ini tidak akan diteruskan.\nGunakan /unmute untuk mengaktifkan kembali.`);
    logger.info(`Admin mute channel: ${channelId}`);
  });

  // ─── /unmute [CHANNEL_ID] ─────────────────────────────────────────────────────
  pollingBot.onText(/^\/unmute(?:\s+(\S+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;

    const channelId = match[1]?.trim();
    if (!channelId) {
      const muteList = mutedChannels.list();
      if (muteList.length === 0) {
        reply(msg.chat.id, `🔇 <b>Mute List</b>\n\nTidak ada channel yang di-mute.`);
      } else {
        const list = muteList.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n');
        reply(msg.chat.id, `🔇 <b>Channel yang di-mute (${muteList.length})</b>\n\n${list}\n\nUsage: <code>/unmute CHANNEL_ID</code>`);
      }
      return;
    }

    const ok = mutedChannels.unmute(channelId);
    if (ok) {
      reply(msg.chat.id, `✅ Channel <code>${channelId}</code> aktif kembali! Pesan akan diteruskan lagi.`);
      logger.info(`Admin unmute channel: ${channelId}`);
    } else {
      reply(msg.chat.id, `⚠️ Channel <code>${channelId}</code> tidak ada di mute list.`);
    }
  });

  // ─── /help ──────────────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/help|^\/start/, (msg) => {
    if (!isAdminDM(msg)) return;

    reply(msg.chat.id, [
      `🤖 <b>COMMAND CENTER (ADMIN ONLY)</b>`,
      `<i>Remote control mirror bot via DM.</i>`,
      ``,
      `📊 <b>STATUS & INFO</b>`,
      `🔸 /dashboard - Dapatkan link Web Dashboard (Online 24/7)`,
      `🔸 /status - Pantau performa & uptime`,
      `🔸 /sysinfo - Cek beban server (RAM/CPU)`,
      `🔸 /channels - List semua channel mirror DC→TG`,
      `🔸 /mapping - Cek link channel DC & TG`,
      `🔸 /dlq - Status antrian pesan yang gagal`,
      ``,
      `🧪 <b>TEST & VERIFIKASI</b>`,
      `🔸 /testmirror - Kirim pesan tes ke SEMUA channel`,
      `   <i>└ Cek apakah semua mirror aktif & bisa menerima pesan.</i>`,
      ``,
      `⚙️ <b>PENGATURAN CHANNEL DC→TG</b>`,
      `🔹 /addch <code>[nama] [dcId] [tgId] [bot#] [topic]</code>`,
      `   <i>└ Tambah mirror. Topik opsional.</i>`,
      `🔹 /removech <code>[dcId]</code>`,
      `   <i>└ Hapus mirror (berhenti forward).</i>`,
      `🔹 /mute <code>[dcId]</code> | /unmute <code>[dcId]</code>`,
      `   <i>└ Jeda/lanjutkan forward sementara.</i>`,
      ``,
      `📡 <b>PENGATURAN CHANNEL TG→DC</b>`,
      `🔹 /tg2dc - List semua mapping TG→Discord`,
      `🔹 /addtg2dc <code>[nama] [tgChatId] [threadId|-] [botKey] [webhookUrl]</code>`,
      `   <i>└ Tambah mirror TG→DC. Gunakan - jika tidak ada thread.</i>`,
      `🔹 /removetg2dc <code>[tgChatId]</code>`,
      `   <i>└ Hapus mapping TG→DC.</i>`,
      ``,
      `🛡️ <b>MODERASI USER</b>`,
      `🔸 /block <code>[dcUserId]</code> | /unblock <code>[dcUserId]</code>`,
      `   <i>└ Blokir/buka blok user.</i>`,
      `🔸 /blocklist - List user diblokir`,
      ``,
      `🔧 <b>MAINTENANCE & KONTROL AI</b>`,
      `🔸 /ai <code>[on|off]</code> - Aktifkan/matikan pembersih watermark AI`,
      `   <i>└ Gunakan <code>/ai off</code> untuk forward media INSTAN & super cepat!</i>`,
      `🔹 /clearstore - Hapus cache (lega-in RAM)`,
      `🔹 /restart - Restart bot (butuh PM2)`,
      ``,
      `📌 <i>Tips: Command tanpa ID (contoh: <code>/mute</code>) akan menampilkan panduan / daftar ID.</i>`,
    ].join('\n'));
  });

  // ─── /dashboard ─────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/dashboard/, (msg) => {
    if (!isAdminDM(msg)) return;

    const providerName = (process.env.TUNNEL_PROVIDER || 'Cloudflare').toUpperCase();
    let dashboardUrl = `Belum tersedia (tunggu beberapa detik sampai ${providerName} selesai membuat tunnel)`;
    try {
      const fs = require('fs');
      const path = require('path');
      const tunnelData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tunnel.json'), 'utf8'));
      if (tunnelData && tunnelData.url) {
        dashboardUrl = `<a href="${tunnelData.url}">${tunnelData.url}</a>`;
      }
    } catch (err) {}

    reply(msg.chat.id, [
      `🌐 <b>WEB DASHBOARD (${providerName})</b>`,
      ``,
      `🔗 ${dashboardUrl}`,
      ``,
      `<i>Link ini menggunakan ${providerName} Tunnel. Jika Anda me-restart bot, silakan gunakan /dashboard lagi untuk memperbarui link.</i>`
    ].join('\n'));
    logger.bot('Admin request: /dashboard');
  });

  // ─── /ai [on|off] or /ocr [on|off] ──────────────────────────────────────────
  pollingBot.onText(/^\/(?:ai|ocr)(?:\s+(on|off|status))?/i, (msg, match) => {
    if (!isAdminDM(msg)) return;
    const blurManager = require('../utils/blurManager');
    const action = match[1]?.toLowerCase();

    if (!action || action === 'status') {
      const isAiOn = blurManager.isOcrEnabled();
      reply(msg.chat.id, [
        `🤖 <b>AI Watermark & OCR Cleaner</b>`,
        ``,
        `Status saat ini: <b>${isAiOn ? '🟢 AKTIF' : '🔴 NONAKTIF (Mode Super Cepat)'}</b>`,
        ``,
        `💡 <i>Cara Mengatur:</i>`,
        `• Ketik <code>/ai off</code> untuk mematikan AI (forward gambar <b>INSTAN & SUPER CEPAT</b>).`,
        `• Ketik <code>/ai on</code> untuk mengaktifkan AI (membersihkan watermark/teks).`
      ].join('\n'));
      return;
    }

    const setOn = action === 'on';
    blurManager.setOcrSettings({ enabled: setOn });
    process.env.ENABLE_AI_WATERMARK = setOn ? 'true' : 'false';
    logger.info(`Admin ${setOn ? 'mengaktifkan' : 'menonaktifkan'} AI OCR Scanner via Telegram`);

    if (setOn) {
      reply(msg.chat.id, `✅ <b>AI Watermark Cleaner DIAKTIFKAN</b> 🟢\nWatermark teks/logo pada gambar akan dideteksi dan dibersihkan otomatis.`);
    } else {
      reply(msg.chat.id, `⚡ <b>AI Watermark Cleaner DINONAKTIFKAN</b> 🔴\nMode <b>SUPER CEPAT</b> aktif! Gambar akan diteruskan secara <b>instan tanpa delay AI</b>.`);
    }
  });

  // ─── /clearstore ────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/clearstore/, (msg) => {
    if (!isAdminDM(msg)) return;
    const before = messageStore.size;
    messageStore.cleanOldEntries(0);
    reply(msg.chat.id,
      `🧹 <b>Cache dibersihkan!</b>\n\nDihapus: <b>${before - messageStore.size}</b> entri\nSisa: <b>${messageStore.size}</b> entri`
    );
    logger.info('Admin membersihkan message store');
  });

  // ─── /dlq ───────────────────────────────────────────────────────────────────
  // Status Dead-Letter Queue (antrian pesan yang gagal & akan dicoba ulang)
  pollingBot.onText(/^\/dlq/, (msg) => {
    if (!isAdminDM(msg)) return;
    const dlq = forwardQueue.stats;
    reply(msg.chat.id, [
      `📥 <b>Status Dead-Letter Queue (Anti-Gagal)</b>`,
      ``,
      `⏳ <b>Dalam antrian:</b> ${dlq.queued} pesan`,
      `✅ <b>Berhasil diretry:</b> ${dlq.retried} pesan`,
      `❌ <b>Gagal permanen:</b> ${dlq.permanent} pesan`,
      ``,
      `<i>Pesan yang gagal akan dicoba ulang otomatis tiap 2 menit (max 3x).\nJika tetap gagal, admin akan mendapat notif.</i>`,
    ].join('\n'));
    logger.bot('Admin request: /dlq');
  });

  // ─── /testmirror ─────────────────────────────────────────────────────────────
  // Kirim pesan tes ke SEMUA channel Telegram yang terdaftar
  pollingBot.onText(/^\/testmirror(?:\s+(\S+))?/, async (msg, match) => {
    if (!isAdminDM(msg)) return;

    const targetBotKey = match[1]?.trim(); // opsional: filter per bot key
    reply(msg.chat.id, `🧪 <b>Test Mirror dimulai...</b>\n\nMengirim pesan tes ke ${channelMap.size} channel.`);

    const results = [];
    const now = new Date().toLocaleString('id-ID', { hour12: false });

    for (const [dcId, { tgChatId, botKey, tgThreadId, name }] of channelMap) {
      if (targetBotKey && botKey !== targetBotKey) continue;

      const tgBot = tgManager.get(botKey);
      if (!tgBot) {
        results.push(`❌ [${name}] Bot #${botKey} tidak ditemukan`);
        continue;
      }

      const threadInfo = tgThreadId ? ` (Topic: ${tgThreadId})` : '';
      const testMsg = [
        `🧪 <b>TEST MIRROR</b>`,
        ``,
        `📌 Channel: <b>${name}</b>`,
        `🕐 Waktu: ${now}`,
        `🤖 Bot: #${botKey}`,
        `📡 TG Chat: <code>${tgChatId}</code>${threadInfo}`,
        `🔵 DC Channel: <code>${dcId}</code>`,
        ``,
        `✅ Jika Anda melihat pesan ini, mirror channel aktif!`,
      ].join('\n');

      try {
        const sendOpts = { parse_mode: 'HTML' };
        if (tgThreadId) sendOpts.message_thread_id = tgThreadId;
        await tgBot.sendMessage(tgChatId, testMsg, sendOpts);
        results.push(`✅ [${name}] → TG ${tgChatId}${threadInfo} OK`);
        logger.success(`Test mirror OK: [${name}] → ${tgChatId}`);
      } catch (err) {
        results.push(`❌ [${name}] → ${tgChatId}: ${err.message?.substring(0, 60)}`);
        logger.error(`Test mirror GAGAL: [${name}] → ${tgChatId}`, err.message);
      }

      // Jeda 1 detik antar channel
      await new Promise(r => setTimeout(r, 1000));
    }

    const okCount   = results.filter(r => r.startsWith('✅')).length;
    const failCount = results.filter(r => r.startsWith('❌')).length;

    reply(msg.chat.id, [
      `🧪 <b>Hasil Test Mirror</b>`,
      ``,
      `✅ Berhasil: <b>${okCount}</b>`,
      `❌ Gagal: <b>${failCount}</b>`,
      ``,
      results.join('\n'),
      ``,
      failCount > 0
        ? `⚠️ Channel yang gagal: periksa TG Chat ID, Bot Key, dan Thread ID di <code>/channels</code>`
        : `🎉 Semua channel mirror aktif dengan baik!`,
    ].join('\n'));
    logger.bot(`Admin test mirror: ${okCount} OK, ${failCount} gagal`);
  });

  // ─── /tg2dc ──────────────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/tg2dc/, (msg) => {
    if (!isAdminDM(msg)) return;
    if (!tg2dcStore) {
      reply(msg.chat.id, `❌ TG→DC Store tidak aktif.`);
      return;
    }
    const list = tg2dcStore.list();
    if (list.length === 0) {
      reply(msg.chat.id, [
        `📡 <b>Mapping TG→Discord</b>`,
        ``,
        `Belum ada mapping.`,
        ``,
        `Tambah dengan:`,
        `<code>/addtg2dc nama tgChatId threadId|-  botKey webhookUrl</code>`,
      ].join('\n'));
      return;
    }

    const lines = list.map((ch, i) => {
      const thread = ch.tgThreadId ? `\n   📢 Thread: <code>${ch.tgThreadId}</code>` : '';
      const webhook = ch.dcWebhookUrl?.substring(0, 60) + (ch.dcWebhookUrl?.length > 60 ? '...' : '');
      return (
        `${i + 1}. <b>${ch.name}</b>\n` +
        `   TG: <code>${ch.tgChatId}</code>${thread}\n` +
        `   Bot: #${ch.botKey}\n` +
        `   DC Webhook: <code>${webhook}</code>`
      );
    });
    reply(msg.chat.id,
      `📡 <b>Mapping TG→Discord (${list.length})</b>\n\n` +
      lines.join('\n\n') +
      `\n\n➕ <code>/addtg2dc</code>  ➖ <code>/removetg2dc</code>`
    );
    logger.bot('Admin request: /tg2dc');
  });

  // ─── /addtg2dc [nama] [tgChatId] [threadId|-] [botKey] [webhookUrl] ──────────
  pollingBot.onText(/^\/addtg2dc(?:\s+(.+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    if (!tg2dcStore) {
      reply(msg.chat.id, `❌ TG→DC Store tidak aktif.`);
      return;
    }

    const args = (match[1] || '').trim().split(/\s+/);
    // Format: /addtg2dc <nama> <tgChatId> <threadId|-> <botKey> <webhookUrl>
    if (args.length < 5 || !args[0]) {
      reply(msg.chat.id, [
        `➕ <b>Tambah Mapping TG→Discord</b>`,
        ``,
        `<b>Format:</b>`,
        `<code>/addtg2dc nama tgChatId threadId botKey webhookUrl</code>`,
        ``,
        `💡 <b>Gunakan - jika tidak ada Thread/Topic</b>`,
        ``,
        `<b>Contoh (tanpa thread):</b>`,
        `<code>/addtg2dc "Signal Premium" -1001234567890 - 1 https://discord.com/api/webhooks/xxx/yyy</code>`,
        ``,
        `<b>Contoh (dengan thread):</b>`,
        `<code>/addtg2dc "Signal VIP" -1001234567890 456 1 https://discord.com/api/webhooks/xxx/yyy</code>`,
        ``,
        `ℹ️ Bot TG (#botKey) HARUS sudah jadi member di grup TG tersebut!`,
        `🔄 Berlaku sekarang tanpa restart!`,
      ].join('\n'));
      return;
    }

    const [name, tgChatId, rawThread, botKey, ...webhookParts] = args;
    const tgThreadId  = (rawThread === '-' || !rawThread) ? null : rawThread;
    const dcWebhookUrl = webhookParts.join(' ').trim(); // gabungkan jika webhook URL ada spasi

    if (!dcWebhookUrl.includes('discord.com/api/webhooks')) {
      reply(msg.chat.id, `❌ URL webhook tidak valid!\n\nHarus berupa URL Discord Webhook.\nContoh: <code>https://discord.com/api/webhooks/123/abc</code>`);
      return;
    }

    if (!tgManager.get(botKey)) {
      reply(msg.chat.id, `❌ Bot #${botKey} tidak ditemukan. Cek TELEGRAM_BOT_${botKey} di .env`);
      return;
    }

    const ch = tg2dcStore.add({ name, tgChatId, tgThreadId, botKey, dcWebhookUrl });
    if (!ch) {
      reply(msg.chat.id, `❌ Gagal menambah mapping. Pastikan tgChatId dan webhookUrl terisi.`);
      return;
    }

    const threadInfo = ch.tgThreadId ? `\n📢 Thread: <code>${ch.tgThreadId}</code>` : '';
    reply(msg.chat.id, [
      `✅ <b>Mapping TG→Discord ditambahkan!</b>`,
      ``,
      `🏷️ <b>Nama:</b> ${ch.name}`,
      `🟢 <b>TG Chat:</b> <code>${ch.tgChatId}</code>${threadInfo}`,
      `🤖 <b>Bot:</b> #${ch.botKey}`,
      `🔗 <b>DC Webhook:</b> <code>${ch.dcWebhookUrl?.substring(0, 60)}...</code>`,
      ``,
      `⚠️ Pastikan Bot #${ch.botKey} sudah jadi member di grup TG <code>${ch.tgChatId}</code>!`,
      `🔄 Berlaku sekarang tanpa restart!`,
    ].join('\n'));
    logger.info(`Admin tambah TG→DC: [${ch.name}] TG:${ch.tgChatId} → DC Webhook`);
  });

  // ─── /removetg2dc [tgChatId] ─────────────────────────────────────────────────────
  pollingBot.onText(/^\/removetg2dc(?:\s+(\S+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    if (!tg2dcStore) {
      reply(msg.chat.id, `❌ TG→DC Store tidak aktif.`);
      return;
    }

    const tgChatId = match[1]?.trim();
    if (!tgChatId) {
      const list = tg2dcStore.list();
      if (list.length === 0) {
        reply(msg.chat.id, `➖ Tidak ada mapping TG→DC untuk dihapus.`);
        return;
      }
      const lines = list.map((ch, i) =>
        `${i + 1}. <b>${ch.name}</b>\n   TG: <code>${ch.tgChatId}</code>`
      ).join('\n\n');
      reply(msg.chat.id,
        `➖ <b>Hapus Mapping TG→DC</b>\n\nFormat: <code>/removetg2dc TG_CHAT_ID</code>\n\n<b>Mapping tersedia:</b>\n\n${lines}`
      );
      return;
    }

    const ch = tg2dcStore.findAllByChat(tgChatId)[0];
    const ok = tg2dcStore.remove(tgChatId);
    if (ok) {
      reply(msg.chat.id,
        `✅ Mapping TG→DC <b>${ch?.name || tgChatId}</b> berhasil dihapus!\n\n<code>${tgChatId}</code>\n\n🔄 Berlaku sekarang tanpa restart!`
      );
      logger.info(`Admin hapus TG→DC: [${ch?.name || tgChatId}] TG:${tgChatId}`);
    } else {
      reply(msg.chat.id,
        `⚠️ Mapping TG Chat ID <code>${tgChatId}</code> tidak ditemukan.\n\nGunakan /tg2dc untuk melihat daftar.`
      );
    }
  });

  // ─── /restart ───────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/restart/, (msg) => {
    if (!isAdminDM(msg)) return;
    reply(msg.chat.id, `🔄 <b>Bot akan direstart...</b>\n\nPM2 akan menghidupkan kembali dalam beberapa detik.`);
    logger.warn('Admin meminta restart bot via Telegram');
    setTimeout(() => {
      messageStore._flushToDisk?.();
      process.exit(0);
    }, 2000);
  });

  // ─── /addmention [tgUsername] [dcUserId] ────────────────────────────────────
  pollingBot.onText(/^\/addmention(?:\s+(.+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    const args = (match[1] || '').trim().split(/\s+/);
    if (args.length < 2) {
      reply(msg.chat.id, `➕ <b>Tambah Mention Mapping</b>\n\nFormat: <code>/addmention username discordId</code>\nContoh: <code>/addmention Ardalyn 123456789</code>`);
      return;
    }
    const [username, discordId] = args;
    if (mappingStore.addMention(username, discordId)) {
      reply(msg.chat.id, `✅ Mapping mention ditambahkan:\n@${username.replace(/^@/, '')} → &lt;@${discordId}&gt;`);
    }
  });

  // ─── /addrole [hashtag] [roleId] ────────────────────────────────────────────
  pollingBot.onText(/^\/addrole(?:\s+(.+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    const args = (match[1] || '').trim().split(/\s+/);
    if (args.length < 2) {
      reply(msg.chat.id, `➕ <b>Tambah Role Mapping</b>\n\nFormat: <code>/addrole #hashtag roleId</code>\nContoh: <code>/addrole #Signal 123456789</code>`);
      return;
    }
    const [hashtag, roleId] = args;
    if (mappingStore.addRole(hashtag, roleId)) {
      const cleanHashtag = hashtag.startsWith('#') ? hashtag : `#${hashtag}`;
      reply(msg.chat.id, `✅ Mapping role ditambahkan:\n${cleanHashtag} → &lt;@&amp;${roleId}&gt;`);
    }
  });

  // ─── /removemap [keyword] ──────────────────────────────────────────────────
  pollingBot.onText(/^\/removemap(?:\s+(\S+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    const keyword = match[1]?.trim();
    if (!keyword) {
      reply(msg.chat.id, `➖ <b>Hapus Mapping</b>\n\nFormat: <code>/removemap [username/#hashtag]</code>\nContoh: <code>/removemap Ardalyn</code> atau <code>/removemap #Signal</code>`);
      return;
    }
    let removed = false;
    if (keyword.startsWith('#')) {
      removed = mappingStore.removeRole(keyword);
    } else {
      removed = mappingStore.removeMention(keyword) || mappingStore.removeRole(keyword);
    }
    if (removed) {
      reply(msg.chat.id, `✅ Mapping <b>${keyword}</b> berhasil dihapus.`);
    } else {
      reply(msg.chat.id, `⚠️ Mapping <b>${keyword}</b> tidak ditemukan.`);
    }
  });

  // ─── /mappings ─────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/mappings/, (msg) => {
    if (!isAdminDM(msg)) return;
    const mentions = mappingStore.getAllMentions();
    const roles = mappingStore.getAllRoles();
    const mentionCount = Object.keys(mentions).length;
    const roleCount = Object.keys(roles).length;
    
    if (mentionCount === 0 && roleCount === 0) {
      reply(msg.chat.id, `📌 <b>Daftar Mapping</b>\n\nBelum ada mapping mention/role.`);
      return;
    }

    const lines = [];
    if (mentionCount > 0) {
      lines.push(`👤 <b>User Mentions:</b>`);
      for (const [u, id] of Object.entries(mentions)) {
        lines.push(`@${u} → &lt;@${id}&gt;`);
      }
      lines.push('');
    }
    if (roleCount > 0) {
      lines.push(`💎 <b>Role Hashtags:</b>`);
      for (const [h, id] of Object.entries(roles)) {
        lines.push(`${h} → &lt;@&amp;${id}&gt;`);
      }
    }
    reply(msg.chat.id, `📌 <b>Daftar Mapping</b>\n\n${lines.join('\n')}`);
  });

  // ─── /setautoping [tgChatId] [top/bottom] [pingText|-] ──────────────────────
  pollingBot.onText(/^\/setautoping(?:\s+(.+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    const args = (match[1] || '').trim().split(/\s+/);
    if (args.length < 3) {
      reply(msg.chat.id, `⚙️ <b>Set Auto-Ping</b>\n\nFormat: <code>/setautoping tgChatId top|bottom pingText</code>\nGunakan <code>-</code> sebagai pingText untuk menghapus.\n\nContoh:\n<code>/setautoping -100123 bottom @everyone</code>\n<code>/setautoping -100123 - -</code>`);
      return;
    }
    const tgChatId = args[0];
    const pos = args[1].toLowerCase() === 'top' ? 'top' : 'bottom';
    const pingText = args.slice(2).join(' ');

    const channels = tg2dcStore.findAllByChat(tgChatId);
    if (channels.length === 0) {
      reply(msg.chat.id, `⚠️ Tidak ada mapping TG→DC untuk Chat ID <code>${tgChatId}</code>.`);
      return;
    }

    channels.forEach(ch => {
      if (pingText === '-') {
        ch.autoPingText = null;
      } else {
        ch.autoPingText = pingText;
        ch.autoPingPosition = pos;
      }
      tg2dcStore.add(ch);
    });

    if (pingText === '-') {
      reply(msg.chat.id, `✅ Auto-ping dihapus untuk chat <code>${tgChatId}</code>`);
    } else {
      reply(msg.chat.id, `✅ Auto-ping diatur untuk chat <code>${tgChatId}</code>:\nPosisi: <b>${pos}</b>\nTeks: <code>${pingText}</code>`);
    }
  });

  // ─── /setchanneltag [tgChatId] [on/off] ──────────────────────────────────────
  pollingBot.onText(/^\/setchanneltag(?:\s+(.+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    const args = (match[1] || '').trim().split(/\s+/);
    if (args.length < 2) {
      reply(msg.chat.id, `⚙️ <b>Set Channel Tag</b>\n\nFormat: <code>/setchanneltag tgChatId on|off</code>`);
      return;
    }
    const tgChatId = args[0];
    const isOn = args[1].toLowerCase() === 'on';

    const channels = tg2dcStore.findAllByChat(tgChatId);
    if (channels.length === 0) {
      reply(msg.chat.id, `⚠️ Tidak ada mapping TG→DC untuk Chat ID <code>${tgChatId}</code>.`);
      return;
    }

    channels.forEach(ch => {
      ch.channelTag = isOn;
      tg2dcStore.add(ch);
    });
    reply(msg.chat.id, `✅ Clickable Channel Tag <b>${isOn ? 'AKTIF' : 'MATI'}</b> untuk chat <code>${tgChatId}</code>`);
  });

  // ─── /setghostping [tgChatId] [on/off] ──────────────────────────────────────
  pollingBot.onText(/^\/setghostping(?:\s+(.+))?/, (msg, match) => {
    if (!isAdminDM(msg)) return;
    const args = (match[1] || '').trim().split(/\s+/);
    if (args.length < 2) {
      reply(msg.chat.id, `⚙️ <b>Set Ghost Ping (Silent Mention)</b>\n\nFormat: <code>/setghostping tgChatId on|off</code>`);
      return;
    }
    const tgChatId = args[0];
    const isOn = args[1].toLowerCase() === 'on';

    const channels = tg2dcStore.findAllByChat(tgChatId);
    if (channels.length === 0) {
      reply(msg.chat.id, `⚠️ Tidak ada mapping TG→DC untuk Chat ID <code>${tgChatId}</code>.`);
      return;
    }

    channels.forEach(ch => {
      ch.ghostPing = isOn;
      tg2dcStore.add(ch);
    });
    reply(msg.chat.id, `✅ Ghost Ping <b>${isOn ? 'AKTIF' : 'MATI'}</b> untuk chat <code>${tgChatId}</code>`);
  });

  // ─── /sysinfo ───────────────────────────────────────────────────────────────
  pollingBot.onText(/^\/sysinfo/, (msg) => {
    if (!isAdminDM(msg)) return;
    const mem     = process.memoryUsage();
    const toMB    = (b) => (b / 1024 / 1024).toFixed(1);
    const freeRam = (os.freemem()  / 1024 / 1024).toFixed(0);
    const totRam  = (os.totalmem() / 1024 / 1024).toFixed(0);
    const load    = os.loadavg()[0].toFixed(2);
    reply(msg.chat.id, [
      `🖥️ <b>System Info</b>`,
      ``,
      `🧠 <b>RAM Bot:</b> ${toMB(mem.heapUsed)}MB / ${toMB(mem.heapTotal)}MB`,
      `💾 <b>RAM Server:</b> ${freeRam}MB bebas dari ${totRam}MB`,
      `⚙️ <b>CPU Load (1m):</b> ${load}`,
      `🏷️ <b>Node.js:</b> ${process.version}`,
      `📂 <b>Uptime Process:</b> ${(process.uptime() / 60).toFixed(1)} menit`,
    ].join('\n'));
    logger.bot('Admin request: /sysinfo');
  });

  // ─── Error handler polling ──────────────────────────────────────────────────
  pollingBot.on('polling_error', (err) => {
    if (err.code !== 'ETELEGRAM') {
      logger.error('Polling bot error', err.message?.substring(0, 80));
    }
  });
}

module.exports = { registerTelegramCommands };
