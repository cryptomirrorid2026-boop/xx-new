// ============================================================
//   INDEX.JS — Entry Point Utama  v4 (Dual Mirror)
//   Bot Mirroring Discord ↔ Telegram (Dua Arah)
//   Support: Multi Discord Token, Multi Telegram Bot,
//            Delete/Edit Sync, Block User, Mute Channel,
//            Health Check, Reaction Forward, Startup Alert,
//            Dead-Letter Queue (DLQ) Anti-Gagal Forward
//            TG → Discord Mirror (BARU!)
// ============================================================

'use strict';

// Polyfill global File untuk kompatibilitas Node 18+ di cloud
if (typeof globalThis.File === 'undefined') {
  try {
    const { File } = require('node:buffer');
    if (File) globalThis.File = File;
  } catch (_) {}
}

require('dotenv').config();

const { Client }         = require('discord.js-selfbot-v13');
const tgManager             = require('./utils/telegramManager');
const discordRegistry       = require('./utils/discordRegistry');
const logger                = require('./utils/logger');
const RateLimiter           = require('./utils/rateLimiter');
const stats                 = require('./utils/stats');
const messageStore          = require('./utils/messageStore');
const blockedUsersStore     = require('./utils/blockedUsersStore');
const mutedChannels         = require('./utils/mutedChannels');
const channelStore          = require('./utils/channelStore');
const forwardQueue          = require('./utils/forwardQueue');
const { startWebServer }    = require('./utils/webServer');
const { registerHandlers }  = require('./handlers/messageHandler');
const { registerTelegramCommands } = require('./handlers/telegramCommands');
const tg2dcStore            = require('./utils/tgToDiscordStore');
const tg2dcMsgStore         = require('./utils/tgToDiscordMessageStore');
const { registerTgToDiscordHandlers } = require('./handlers/tgToDiscordHandler');
const memoryGuard           = require('./utils/memoryGuard');

// ─── Banner ───────────────────────────────────────────────────────────────────
logger.banner();
memoryGuard.start();


function cleanToken(t) {
  if (!t || typeof t !== 'string') return '';
  return t
    .replace(/^["']|["']$/g, '')
    .replace(/^(TOKEN\d*|DISCORD_TOKENS?)\s*[:=]\s*/i, '')
    .trim();
}

// ─── Validasi .env ────────────────────────────────────────────────────────────
function validateEnv() {
  const tokens = parseDiscordTokens(false);
  if (tokens.length === 0) {
    logger.warn('⚠️ PERINGATAN: Belum ada Discord Token valid. Masukkan DISCORD_TOKENS atau TOKEN1 di Variables.');
  }
}

// ─── Parse Discord Tokens ─────────────────────────────────────────────────────
function parseDiscordTokens(exitOnError = false) {
  const tokens = [];

  const add = (val) => {
    if (!val) return;
    const cleaned = cleanToken(val);
    if (cleaned && !cleaned.includes('ISI_') && !tokens.includes(cleaned)) {
      tokens.push(cleaned);
    }
  };

  // 1. DISCORD_TOKENS (koma atau baris baru)
  if (process.env.DISCORD_TOKENS) {
    process.env.DISCORD_TOKENS.split(/[\r\n,]+/).forEach(add);
  }

  // 2. DISCORD_TOKEN
  if (process.env.DISCORD_TOKEN) {
    process.env.DISCORD_TOKEN.split(/[\r\n,]+/).forEach(add);
  }

  // 3. Support TOKEN1, TOKEN2, DISCORD_TOKEN_1, dll.
  for (const [key, val] of Object.entries(process.env)) {
    if (/^(TOKEN\d+|DISCORD_TOKEN_\d+)$/i.test(key)) {
      add(val);
    }
  }

  if (tokens.length === 0) {
    logger.error('Tidak ada Discord token valid di environment variables!');
    if (exitOnError) process.exit(1);
  } else {
    logger.info(`Ditemukan ${tokens.length} Discord token`);
  }

  return tokens;
}

// ─── Parse Telegram Bots ──────────────────────────────────────────────────────
function parseTelegramBots() {
  let count = 0;

  const addBot = (key, token) => {
    const cleaned = cleanToken(token);
    if (cleaned && !cleaned.includes('ISI_')) {
      tgManager.add(key, cleaned);
      count++;
    }
  };

  let i = 1;
  while (process.env[`TELEGRAM_BOT_${i}`]) {
    addBot(i, process.env[`TELEGRAM_BOT_${i}`]);
    i++;
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    addBot(1, process.env.TELEGRAM_BOT_TOKEN);
  }

  if (process.env.BOT_TOKEN) {
    addBot(1, process.env.BOT_TOKEN);
  }

  // Validasi jika belum ada token Telegram yang dikonfigurasi
  if (count === 0) {
    logger.error('❌ Tidak ada Telegram Bot token yang valid di environment variables!');
    logger.warn('Silakan atur TELEGRAM_BOT_TOKEN atau TELEGRAM_BOT_1 di file .env');
  }

  logger.info(`Ditemukan ${count} Telegram Bot`);
}

// ─── Build Channel Map via ChannelStore ──────────────────────────────────────
function buildChannelMap() {
  const channelMap = new Map();

  if (channelStore.size === 0) {
    const envMapping = process.env.CHANNEL_MAPPING || '';
    if (envMapping && !envMapping.includes('DISCORD_CHANNEL')) {
      channelStore.importFromEnv(envMapping);
    }
  }

  channelStore.attachMap(channelMap, tgManager);
  channelStore.startWatcher();

  if (channelMap.size === 0) {
    logger.error('Tidak ada mapping channel yang valid! Cek data/channels.json atau CHANNEL_MAPPING di .env');
    process.exit(1);
  }

  for (const [dcId, { tgChatId, botKey, tgThreadId, name }] of channelMap) {
    const threadLog = tgThreadId ? ` (Topic: ${tgThreadId})` : '';
    logger.info(`Mapping: [${name}] #${dcId} → TG ${tgChatId}${threadLog} (Bot #${botKey})`);
  }

  return channelMap;
}

// ─── Konfigurasi ──────────────────────────────────────────────────────────────
parseTelegramBots();

const config = {
  watermark:          process.env.WATERMARK || '🔄 Discord Mirror',
  forwardBotMessages: process.env.FORWARD_BOT_MESSAGES === 'true',
  forwardEdits:       process.env.FORWARD_EDITS !== 'false',
  showChannelName:    process.env.SHOW_CHANNEL_NAME !== 'false',
  showServerName:     process.env.SHOW_SERVER_NAME !== 'false',
  showAuthorName:     process.env.SHOW_AUTHOR_NAME !== 'false',
  maxMessageLength:   parseInt(process.env.MAX_MESSAGE_LENGTH || '4000'),
  blacklistWords:     (process.env.BLACKLIST_WORDS  || '').split(',').map(w => w.trim()).filter(Boolean),
  whitelistWords:     (process.env.WHITELIST_WORDS  || '').split(',').map(w => w.trim()).filter(Boolean),
};

// ─── Konfigurasi TG→DC ────────────────────────────────────────────────────────
const tg2dcConfig = {
  enabled:            process.env.TG_TO_DC_ENABLED !== 'false',
  forwardBotMessages: process.env.TG_TO_DC_FORWARD_BOT_MESSAGES === 'true',
  blacklistWords:     config.blacklistWords, // pakai filter yang sama
  whitelistWords:     config.whitelistWords,
};

(process.env.BLOCKED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  .forEach(id => blockedUsersStore.add(id));

logger.info('Konfigurasi dimuat', `watermark: "${config.watermark}"`);
logger.info(`BlockedUsers store: ${blockedUsersStore.size} user diblok`);
logger.info(`MessageStore: ${messageStore.size} entri tersimpan`);

// ─── Rate Limiter ──────────────────────────────────────────────────────────────
const rateLimiter = new RateLimiter(parseInt(process.env.RATE_LIMIT_DELAY || '500'));

// ─── Verifikasi Telegram Bots + Startup Alert ──────────────────────────────────
async function sendStartupAlert(channelMap) {
  const adminId     = process.env.ADMIN_TELEGRAM_ID;
  const adminBotKey = String(process.env.ADMIN_BOT_KEY || '1');
  if (!adminId) return;

  const tgBot = tgManager.get(adminBotKey);
  if (!tgBot) return;

  const now  = new Date().toLocaleString('id-ID', { hour12: false });
  const text = [
    `🚀 <b>Bot Mirror DC→TG Online! v3</b>`,
    ``,
    `⏰ <b>Waktu start:</b> ${now}`,
    `📡 <b>Channel aktif:</b> ${channelMap.size}`,
    `🤖 <b>Telegram Bots:</b> ${tgManager.size}`,
    `🔇 <b>Channel di-mute:</b> ${mutedChannels.size}`,
    `🚫 <b>User diblok:</b> ${blockedUsersStore.size}`,
    `💾 <b>Cache pesan:</b> ${messageStore.size} entri`,
    `🛡️ <b>Anti-gagal DLQ:</b> aktif`,
    ``,
    `ℹ️ Ketik /help untuk daftar command admin.`,
    `📋 Ketik /testmirror untuk tes semua channel.`,
  ].join('\n');

  try {
    await tgBot.sendMessage(adminId, text, { parse_mode: 'HTML' });
    logger.success('🔔 Startup alert dikirim ke admin Telegram');
  } catch (err) {
    logger.warn('Gagal kirim startup alert', err.message?.substring(0, 60));
  }
}

// ─── Setup DLQ Admin Alert ────────────────────────────────────────────────────
function setupDLQAdminAlert() {
  const adminId     = process.env.ADMIN_TELEGRAM_ID;
  const adminBotKey = String(process.env.ADMIN_BOT_KEY || '1');
  if (!adminId) return;

  forwardQueue.setAdminAlertFn(async (text) => {
    const tgBot = tgManager.get(adminBotKey);
    if (!tgBot) return;
    await tgBot.sendMessage(adminId, text, { parse_mode: 'HTML' });
  });

  logger.info('DLQ admin alert siap (kegagalan permanen akan dikirim ke admin TG)');
}

// ─── Parse channel mapping SETELAH telegram bots siap ────────────────────────
const channelMap = buildChannelMap();
logger.success(`${channelMap.size} pasangan channel aktif`);

// ─── Setup DLQ ───────────────────────────────────────────────────────────────
setupDLQAdminAlert();

// ─── Daftarkan Telegram Command Handler ──────────────────────────────────────
registerTelegramCommands(tgManager, channelMap, config, channelStore, tg2dcStore);

// ─── Health Check HTTP Server / Web Dashboard ────────────────────────────────
const ENABLE_WEB = process.env.ENABLE_WEB_SERVER !== 'false';
const HEALTH_PORT = parseInt(process.env.PORT || process.env.HEALTH_PORT || '5000');
if (ENABLE_WEB) {
  startWebServer(tgManager, channelMap, HEALTH_PORT, tg2dcStore);

  // Otomatis aktifkan Tunnel (Ngrok / Cloudflare) hanya jika BUKAN di cloud dan BUKAN dikelola PM2
  const isCloudEnv = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.ENABLE_TUNNEL === 'false');
  const isManagedByPM2 = Boolean(process.env.pm_id !== undefined || process.env.PM2_HOME);

  if (isCloudEnv) {
    logger.info('☁️ Cloud Environment terdeteksi (Railway/Render) — Tunnel dinonaktifkan (gunakan domain Railway).');
  } else if (isManagedByPM2) {
    logger.info('⚙️ PM2 terdeteksi — Tunnel process dikelola mandiri oleh PM2 (mencegah tabrakan ganda).');
  } else {
    try {
      const { fork } = require('child_process');
      const path = require('path');
      const tunnelScript = path.join(__dirname, 'tunnel.js');
      if (require('fs').existsSync(tunnelScript)) {
        logger.info('🚀 Memulai Tunnel Process standalone (Ngrok / Cloudflare)...');
        fork(tunnelScript, [], { stdio: 'inherit' });
      }
    } catch (err) {
      logger.warn('Gagal memulai tunnel process:', err.message);
    }
  }
} else {
  logger.info('🌐 Web Server / Dashboard dinonaktifkan via .env (ENABLE_WEB_SERVER=false)');
}

// ─── Verifikasi + Startup Alert ───────────────────────────────────────────────
tgManager.verifyAll().then(results => {
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    logger.warn(`${failed.length} Telegram Bot gagal terhubung. Periksa token di .env`);
  }
  sendStartupAlert(channelMap);

  // TG->DC Handler initialization dipindah ke dalam client.once('ready')
  // agar mendapatkan instance Discord Client yang sudah siap (beserta cache guilds-nya).

});

// ─── Buat Discord Clients (Multi Token) ──────────────────────────────────────
const discordTokens = parseDiscordTokens();
let tg2dcInitialized = false;

discordTokens.forEach((token, idx) => {
  const accountNum = idx + 1;

  const client = new Client({ checkUpdate: false });

  client.once('ready', (c) => {
    logger.success(`Discord Akun #${accountNum} online: ${c.user.tag}`);
    discordRegistry.setTag(token, c.user.tag);
    logger.info(`Akun #${accountNum} terdaftar di ${c.guilds.cache.size} server`);
    registerHandlers(client, tgManager, channelMap, config, rateLimiter);
    
    // Inisialisasi TG->DC menggunakan client pertama yang ready
    if (!tg2dcInitialized && tg2dcConfig.enabled) {
      tg2dcInitialized = true;
      const hasSessions = !!(process.env.TG_USER_SESSIONS || process.env.TG_USER_SESSION);
      const hasApiCreds = !!(process.env.TG_API_ID && process.env.TG_API_HASH);

      if (!hasSessions || !hasApiCreds) {
        logger.warn('TG→DC: Tidak aktif — TG_API_ID, TG_API_HASH, atau TG_USER_SESSIONS belum diset.');
      } else {
        logger.info(`TG→DC: ${tg2dcStore.size} mapping ditemukan, memulai userbot...`);
        registerTgToDiscordHandlers(client, tg2dcConfig).catch(err => {
          logger.error('TG→DC: Gagal inisialisasi userbot', err.message?.substring(0, 80));
        });
      }
    } else if (!tg2dcInitialized && !tg2dcConfig.enabled && accountNum === 1) {
      tg2dcInitialized = true;
      logger.info('TG→DC: Dinonaktifkan (TG_TO_DC_ENABLED=false di .env)');
    }
  });

  client.on('error', err => {
    logger.error(`Discord Akun #${accountNum} error`, err.message);
  });

  client.on('warn', warn => {
    logger.warn(`Discord Akun #${accountNum} warn`, warn);
  });

  // ─── Auto-Reconnect saat putus ────────────────────────────────────────────
  let reconnectTimer = null;

  client.on('shardDisconnect', (event, shardId) => {
    logger.warn(`Discord Akun #${accountNum} (Shard ${shardId}) terputus! Code: ${event.code}. Auto-reconnect berjalan...`);
  });

  client.on('shardReconnecting', (shardId) => {
    logger.info(`Discord Akun #${accountNum} (Shard ${shardId}) mencoba terhubung kembali...`);
  });

  client.on('shardResume', (shardId, replayedEvents) => {
    logger.success(`Discord Akun #${accountNum} (Shard ${shardId}) koneksi pulih (${replayedEvents} event di-replay)!`);
  });

  logger.info(`Login Discord Akun #${accountNum}...`);
  client.login(token).catch(err => {
    logger.error(`Akun #${accountNum} gagal login!`, err.message);
    logger.warn('Periksa token di DISCORD_TOKENS');
  });
});

// ─── Statistik Periodik (tiap 30 menit) ──────────────────────────────────────
setInterval(() => {
  const s   = stats.getSummary();
  const dlq = forwardQueue.stats;
  const mem = memoryGuard.getStats();
  logger.bot(
    `📊 Statistik | Uptime: ${s.uptime} | RAM: ${mem.rssMB}/${mem.maxLimitMB}MB (Heap: ${mem.heapUsedMB}MB)`,
    `Forward: ${s.totalForwarded} | Edit: ${s.totalEdits} | Gagal: ${s.totalFailed} | Media: ${s.totalMedia} | DLQ: ${dlq.queued} (retry: ${dlq.retried} permanen: ${dlq.permanent})`
  );
}, 30 * 60 * 1000);


// ─── Auto Cleanup cache pesan (7 hari) ─────────────────────────────────────────
setInterval(() => {
  const cleaned = messageStore.cleanOldEntries(7 * 24 * 60 * 60 * 1000);
  if (cleaned) {
    logger.info('🧹 Auto-reset: Cache pesan DC→TG lama telah dibersihkan.');
  }
  // Bersihkan juga cache TG→DC
  tg2dcMsgStore.cleanOldEntries(7 * 24 * 60 * 60 * 1000);
}, 60 * 60 * 1000);

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  logger.warn('Menghentikan bot...');
  const s   = stats.getSummary();
  const dlq = forwardQueue.stats;
  logger.info(
    `📊 Statistik Akhir | Uptime: ${s.uptime}`,
    `Forward: ${s.totalForwarded} | Gagal: ${s.totalFailed} | DLQ: ${dlq.queued} queued, ${dlq.permanent} permanen`
  );
  process.exit(0);
});

process.on('unhandledRejection', err => {
  logger.error('Unhandled Rejection (Safe Guard)', err?.stack || err?.message || String(err));
});

process.on('uncaughtException', err => {
  logger.error('Uncaught Exception (Safe Guard)', err?.stack || err?.message || String(err));
  // Jangan langsung exit jika error bisa diabaikan, kecuali fatal memory error
  if (err?.message?.includes('JavaScript heap out of memory')) {
    logger.error('FATAL: Out of Memory! Restarting via PM2...');
    process.exit(1);
  }
});
