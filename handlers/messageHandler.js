// ============================================================
//   HANDLERS / MESSAGEHANDLER.JS — v3 (Anti-Gagal)
//   Core logic: forward, delete sync, edit sync,
//               reply sync, anti-duplicate, whitelist,
//               block user, mute channel, reaction forward
//
//   PERBAIKAN v3:
//     - Jika forward gagal → masuk ForwardQueue (DLQ) untuk retry otomatis
//     - safeSendMessage: fallback HTML → plain text
//     - Semua error dicatat + dihitung
//     - Partial message di-fetch sebelum diproses
// ============================================================

'use strict';

const axios = require('axios');
const FormData = require('form-data');
const { forwardMedia, processDiscordMedia } = require('./mediaHandler');

// Cache untuk webhook DC-to-DC agar tidak spam API
const dcWebhookCache = new Map();

async function getDcWebhookGuildId(webhookUrl) {
  if (dcWebhookCache.has(webhookUrl)) return dcWebhookCache.get(webhookUrl);
  try {
    const res = await axios.get(webhookUrl, { timeout: 10000 });
    if (res.data && res.data.guild_id) {
      dcWebhookCache.set(webhookUrl, res.data.guild_id);
      return res.data.guild_id;
    }
  } catch (err) {
    // Abaikan error
  }
  return null;
}

// Fungsi untuk menerjemahkan mention antar server Discord (DC-to-DC)
async function translateDcToDcMentions(client, text, sourceGuild, targetWebhookUrl) {
  if (!text || !text.includes('<@&')) return text;
  
  const targetGuildId = await getDcWebhookGuildId(targetWebhookUrl);
  if (!targetGuildId) return text;

  const targetGuild = client.guilds.cache.get(targetGuildId);
  if (!targetGuild) return text;

  const regex = /<@&(\d+)>/g;
  let newText = text;
  const matches = [...text.matchAll(regex)];
  
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const sourceRoleId = match[1];
    
    // Cari nama role di server asal
    const sourceRole = sourceGuild.roles.cache.get(sourceRoleId);
    if (!sourceRole) continue;
    
    const roleName = sourceRole.name.toLowerCase();
    
    // Cari role dengan nama yang sama di server tujuan
    let targetRoleId = null;
    let targetRole = targetGuild.roles.cache.find(r => r.name.toLowerCase() === roleName);
    
    if (targetRole) {
      targetRoleId = targetRole.id;
    } else {
      try {
        const roles = await targetGuild.roles.fetch();
        targetRole = roles.find(r => r.name.toLowerCase() === roleName);
        if (targetRole) targetRoleId = targetRole.id;
      } catch (err) {
        // Abaikan
      }
    }
    
    const index = match.index;
    const length = match[0].length;
    
    if (targetRoleId) {
      // Ganti dengan Role ID di server tujuan
      newText = newText.slice(0, index) + `<@&${targetRoleId}>` + newText.slice(index + length);
    } else {
      // Jika tidak ketemu di server tujuan, jadikan plain text agar tidak menjadi @unknown-role
      newText = newText.slice(0, index) + `@${sourceRole.name}` + newText.slice(index + length);
    }
  }
  
  return newText;
}

const {
  formatMessage,
  formatEditedMessage,
  buildHeader,
} = require('../utils/formatter');
const messageStore          = require('../utils/messageStore');
const blockedUsersStore     = require('../utils/blockedUsersStore');
const mutedChannels         = require('../utils/mutedChannels');
const duplicateGuard        = require('../utils/duplicateGuard');
const forwardQueue          = require('../utils/forwardQueue');
const logger                = require('../utils/logger');
const stats                 = require('../utils/stats');
const wordFilter            = require('../utils/wordFilterManager');
const spamPattern           = require('../utils/spamPatternDetector');
const userRateLimiter       = require('../utils/userRateLimiter');

// pushEvent dari webServer — safe import (mungkin belum di-init saat test)
let pushEvent = () => {};
try { ({ pushEvent } = require('../utils/webServer')); } catch {}

// ─── Helper untuk Forum / Thread ─────────────────────────────────────────────
function getTargetChannelId(channel) {
  if (!channel) return null;
  const isThread = (typeof channel.isThread === 'function' && channel.isThread()) ||
                   channel.type === 'GUILD_PUBLIC_THREAD' || channel.type === 11 ||
                   channel.type === 'GUILD_PRIVATE_THREAD' || channel.type === 12 ||
                   channel.type === 'GUILD_NEWS_THREAD' || channel.type === 10;
                   
  if (isThread) {
    return channel.parentId || channel.parentID;
  }
  return channel.id;
}

// ─── Kirim Admin Alert ke Telegram ───────────────────────────────────────────
async function sendSpamAdminAlert(tgManager, message, reason, action, isDeleted = true) {
  const adminId     = process.env.ADMIN_TELEGRAM_ID;
  const adminBotKey = String(process.env.ADMIN_BOT_KEY || '1');
  if (!adminId) return;

  const tgBot = tgManager?.get(adminBotKey);
  if (!tgBot) return;

  const userId    = message.author?.id || '?';
  const username  = message.member?.displayName || message.author?.username || '?';
  const tag       = message.author?.tag || '?';
  const server    = message.guild?.name || '?';
  const channel   = message.channel?.name || message.channelId;
  const now       = new Date().toLocaleString('id-ID', { hour12: false });
  const mediaInfo = message.attachments?.size > 0
    ? `🖼️ Mengandung <b>${message.attachments.size} gambar/file</b>`
    : `💬 Teks: "<code>${(message.content || '').substring(0, 100).replace(/</g,'&lt;')}</code>"`;

  const title = isDeleted ? `🚨 <b>SPAM DIHAPUS OTOMATIS!</b>` : `⚠️ <b>SPAM DIBLOKIR OTOMATIS!</b> (Tidak dihapus)`;

  const text = [
    title,
    ``,
    `👤 <b>User:</b> ${username} (<code>${tag}</code>)`,
    `🆔 <b>User ID:</b> <code>${userId}</code>`,
    `📢 <b>Server:</b> ${server}`,
    `#️⃣ <b>Channel:</b> #${channel}`,
    ``,
    `🔍 <b>Alasan:</b> ${reason}`,
    `⚡ <b>Tindakan:</b> ${action}`,
    `${mediaInfo}`,
    ``,
    `⏰ <b>Waktu:</b> ${now}`,
  ].join('\n');

  try {
    await tgBot.sendMessage(adminId, text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn('Admin Alert: Gagal kirim notif', err.message?.substring(0, 60));
  }
}

// ─── Auto-block + Admin Alert helper ─────────────────────────────────────────
async function handleSpamDetected(message, reason, tgManager, opts = { autoDelete: true }) {
  const userId   = message.author?.id;
  const username = message.member?.displayName || message.author?.username || '?';
  const channel  = message.channel?.name || message.channelId;
  
  // autoDelete bisa dikirim boolean (legacy) atau via object
  const autoDelete = typeof opts === 'boolean' ? opts : (opts.autoDelete !== false);

  let action = 'Pesan diblokir (tidak diteruskan)';

  if (autoDelete) {
    // Hapus pesan spam
    message.delete().catch(() => {});
    action = 'Pesan dihapus';
    logger.info(`🗑️ Pesan spam dihapus (Alasan: ${reason})`, `#${channel}`);
    pushEvent('error', `🚨 Spam dihapus: <b>#${channel}</b> — ${reason.substring(0, 80)}`);
  } else {
    logger.info(`🚫 Pesan spam diblokir (TIDAK dihapus) (Alasan: ${reason})`, `#${channel}`);
    pushEvent('warn', `⚠️ Spam diblokir: <b>#${channel}</b> — ${reason.substring(0, 80)}`);
  }

  // Kirim alert ke admin
  await sendSpamAdminAlert(tgManager, message, reason, action, autoDelete);
}

// ─── Helper: Kirim teks ke TG dengan 3-layer fallback ────────────────────────
// Layer 1: MarkdownV2
// Layer 2: Plain text (strip escape)
// Layer 3: HTML
async function safeSendMessage(tgBot, chatId, text, replyToMsgId = null, threadId = null) {
  const baseOpts = {};
  if (replyToMsgId) baseOpts.reply_to_message_id = replyToMsgId;
  if (threadId)     baseOpts.message_thread_id   = threadId;

  // Layer 1: MarkdownV2
  try {
    return await tgBot.sendMessage(chatId, text, { ...baseOpts, parse_mode: 'MarkdownV2' });
  } catch { /* lanjut */ }

  // Layer 2: Plain text
  try {
    const plain = text.replace(/\\([_*[\]()~`>#+=|{}.!\\-])/g, '$1');
    return await tgBot.sendMessage(chatId, plain, { ...baseOpts });
  } catch { /* lanjut */ }

  // Layer 3: HTML — coba kirim sebagai plain (tanpa format)
  try {
    const stripped = text
      .replace(/\\([_*[\]()~`>#+=|{}.!\\-])/g, '$1') // strip MD escape
      .replace(/[*_`[\]]/g, '');                       // strip sisa MD chars
    return await tgBot.sendMessage(chatId, stripped, { ...baseOpts });
  } catch (err) {
    throw err; // biarkan handler atas yang tangani
  }
}

// ─── Helper: Edit teks TG ────────────────────────────────────────────────────
async function safeEditMessage(tgBot, chatId, msgId, text) {
  try {
    return await tgBot.editMessageText(text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'MarkdownV2',
    });
  } catch {
    try {
      const plain = text.replace(/\\([_*[\]()~`>#+=|{}.!\\-])/g, '$1');
      return await tgBot.editMessageText(plain, { chat_id: chatId, message_id: msgId });
    } catch (err2) { throw err2; }
  }
}

// ─── Filter pesan ──────────────────────────────────────────────────────────────
function shouldFilter(message, config) {
  const targetChannelId = getTargetChannelId(message.channel) || message.channelId;
  if (mutedChannels.isMuted(targetChannelId)) {
    return { filtered: true, reason: `channel di-mute (${targetChannelId})` };
  }

  if (blockedUsersStore.has(message.author?.id)) {
    return { filtered: true, reason: `user diblok (${message.author.id})` };
  }

  if (message.author?.bot && !config.forwardBotMessages) {
    return { filtered: true, reason: 'pesan dari bot' };
  }

  if (config.blacklistWords?.length > 0) {
    let fullText = (message.content || '').toLowerCase();
    if (message.embeds?.length > 0) {
      for (const embed of message.embeds) {
        fullText += ' ' + (embed.title || '').toLowerCase();
        fullText += ' ' + (embed.description || '').toLowerCase();
        if (embed.fields) {
           for (const field of embed.fields) {
              fullText += ' ' + (field.name || '').toLowerCase() + ' ' + (field.value || '').toLowerCase();
           }
        }
        if (embed.author) fullText += ' ' + (embed.author.name || '').toLowerCase();
        if (embed.footer) fullText += ' ' + (embed.footer.text || '').toLowerCase();
      }
    }
    for (const word of config.blacklistWords) {
      if (fullText.includes(word.toLowerCase())) {
        return { filtered: true, reason: `kata blacklist: "${word}"` };
      }
    }
  }

  if (config.whitelistWords?.length > 0) {
    const content = (message.content || '').toLowerCase();
    const hasWord = config.whitelistWords.some(w => content.includes(w.toLowerCase()));
    if (!hasWord) {
      return { filtered: true, reason: 'tidak ada kata whitelist' };
    }
  }

  const hasContent = message.content ||
    message.attachments?.size > 0 ||
    message.embeds?.length    > 0 ||
    message.stickers?.size    > 0;

  if (!hasContent) return { filtered: true, reason: 'pesan kosong' };

  return { filtered: false };
}

// ─── Terapkan partial word filter (hanya hapus kata, bukan tolak pesan) ─────────
function applyWordFilter(message) {
  if (!message.content) return message; // Tidak ada teks, lewat

  const originalContent = message.content;
  const { filtered, result, removedWords } = wordFilter.filterContent(originalContent);
  if (!filtered) return message;

  logger.info(
    `🛡️  Word filter: hapus [${removedWords.join(', ')}]`,
    `Content: "${originalContent.substring(0, 80)}" → "${result.substring(0, 80)}"`
  );
  pushEvent('info',
    `🛡️ Word filter hapus: <b>${removedWords.map(w => w.substring(0,30)).join(', ')}</b>`
  );

  // Return object proxy dengan content yang telah difilter
  // result bisa berupa string kosong jika seluruh teks adalah kata terlarang
  // (pesan tetap diteruskan jika ada media/embed)
  return new Proxy(message, {
    get(target, prop) {
      if (prop === 'content') return result; // '' jika semua dihapus, string jika ada sisa
      return target[prop];
    }
  });
}

// ─── Cari reply_to_message_id di Telegram ────────────────────────────────────
function getReplyToTgMsgId(message) {
  const refId = message.reference?.messageId;
  if (!refId) return null;
  const stored = messageStore.get(refId);
  return stored?.tgMsgId || null;
}

// ─── Buat label pesan untuk logging / DLQ ────────────────────────────────────
function makeLabel(message, botKey) {
  const ch  = message.channel?.name || message.channelId;
  const usr = message.member?.displayName || message.author?.username || '?';
  return `[#${ch}] ${usr} (Bot#${botKey}) msgId:${message.id}`;
}

/**
 * Format kutipan pesan reply untuk Discord Webhook.
 */
async function formatReplyQuote(message) {
  if (!message.reference?.messageId) return '';
  try {
    let refMsg = message.referencedMessage;
    if (!refMsg && message.channel?.messages) {
      refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    }
    if (!refMsg) return '';

    const author = refMsg.member?.displayName || refMsg.author?.username || 'User';
    let snippet = (refMsg.content || '').replace(/[\r\n]+/g, ' ').trim();
    if (!snippet && refMsg.attachments?.size > 0) {
      snippet = `[Lampiran: ${refMsg.attachments.first()?.name || 'Media'}]`;
    } else if (!snippet && refMsg.embeds?.length > 0) {
      snippet = `[Embed: ${refMsg.embeds[0].title || refMsg.embeds[0].description || 'Info'}]`;
    }
    if (snippet.length > 90) snippet = snippet.substring(0, 87) + '...';
    return `> ↩️ **Membalas @${author}**: _"${snippet || '...'}"_\n\n`;
  } catch {
    return '';
  }
}

/**
 * Hapus link invite Discord sumber (discord.gg / discord.com/invite).
 */
function stripDiscordInvites(text) {
  if (!text) return '';
  return text
    .replace(/https?:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-zA-Z0-9_-]+/gi, '')
    .replace(/(?:^|\s)discord\.gg\/[a-zA-Z0-9_-]+/gi, '')
    .trim();
}

// ─── Core forward logic (dipakai oleh handleNewMessage & DLQ retry) ──────────
async function doForward(message, target, tgManager, config, rateLimiter) {
  const { tgChatId, botKey, tgThreadId, dcWebhookUrl } = target;
  
  let tgMsgId = null;
  let msgType = 'text';
  let dcMsgIdOut = null;

  // 1. Eksekutor Telegram
  const forwardToTelegram = async () => {
    if (!tgChatId) return null;
    const tgBot = tgManager.get(botKey);
    if (!tgBot) {
      logger.warn(`TG Bot #${botKey} tidak ditemukan untuk forward`);
      return null;
    }

    const replyToTgMsgId = getReplyToTgMsgId(message);
    if (message.attachments?.size > 0) {
      if (message.content || message.embeds?.length > 0) {
        const text = formatMessage(message, config);
        const sent = await rateLimiter.add(() => safeSendMessage(tgBot, tgChatId, text, replyToTgMsgId, tgThreadId));
        if (sent) tgMsgId = sent.message_id;
      }

      const targetChannelId = getTargetChannelId(message.channel) || message.channelId;
      const headerText = buildHeader(message, config);
      const mediaMsgId = await forwardMedia(tgBot, tgChatId, message, headerText, rateLimiter, replyToTgMsgId, tgThreadId, targetChannelId);
      if (!tgMsgId && mediaMsgId) {
        tgMsgId = mediaMsgId;
        msgType = 'media';
      }
    } else {
      const text = formatMessage(message, config);
      const sent = await rateLimiter.add(() => safeSendMessage(tgBot, tgChatId, text, replyToTgMsgId, tgThreadId));
      if (sent) tgMsgId = sent.message_id;
    }
    return tgMsgId;
  };

  // 2. Eksekutor Discord Webhook (DC ➔ DC)
  const forwardToDiscord = async () => {
    if (!dcWebhookUrl) return null;

    // Filter: Only with media / embeds (abaikan pure chatter jika aktif)
    const onlyWithMedia = target.dcOnlyWithMedia || process.env.DC_TO_DC_ONLY_WITH_MEDIA === 'true';
    const hasMediaOrEmbed = (message.attachments?.size > 0) || (message.embeds?.length > 0);
    if (onlyWithMedia && !hasMediaOrEmbed) {
      logger.info('DC→DC: Pesan teks tanpa media/embed diabaikan (OnlyWithMedia)', makeLabel(message, 'DC'));
      return null;
    }

    try {
      // Whitelabeling / Profile Masking
      const customUsername = target.dcCustomUsername || process.env.DC_TO_DC_CUSTOM_NAME;
      const customAvatar = target.dcCustomAvatarUrl || process.env.DC_TO_DC_CUSTOM_AVATAR;

      const payload = {
        username: (customUsername || message.member?.displayName || message.author?.username || 'Nexus Mirror').substring(0, 80),
        avatar_url: customAvatar || message.author?.displayAvatarURL(),
        allowed_mentions: { parse: ['roles', 'users', 'everyone'] }
      };

      let content = message.content ? message.content.trim() : '';

      // Auto-strip invite links
      const shouldStrip = target.dcStripInvites !== false && process.env.DC_TO_DC_STRIP_INVITES !== 'false';
      if (shouldStrip && content) {
        content = stripDiscordInvites(content);
      }

      // Mentions translation
      if (content !== '') {
        content = await translateDcToDcMentions(message.client, content, message.guild, dcWebhookUrl);
      }

      // Reply Quote Context
      const enableReplyQuote = process.env.DC_TO_DC_REPLY_QUOTE !== 'false';
      if (enableReplyQuote && message.reference?.messageId) {
        const quoteHeader = await formatReplyQuote(message);
        if (quoteHeader) {
          content = quoteHeader + content;
        }
      }

      // Auto-Ping
      const autoPing = target.dcAutoPing || process.env.DC_TO_DC_AUTO_PING;
      if (autoPing && autoPing.trim() !== '') {
        content = (content ? content + '\n\n' : '') + autoPing.trim();
      }

      if (content !== '') {
        payload.content = content;
      }

      if (message.embeds?.length > 0) {
        const validEmbeds = message.embeds
          .filter(e => e.type === 'rich' || e.type === 'article')
          .map(e => e.toJSON ? e.toJSON() : e);
        if (validEmbeds.length > 0) payload.embeds = validEmbeds;
      }

      const formData = new FormData();
      let hasFiles = false;

      if (message.attachments?.size > 0) {
        const attachArray = Array.from(message.attachments.values());
        const targetChannelId = getTargetChannelId(message.channel) || message.channelId;
        const processed = await Promise.all(attachArray.map(a => processDiscordMedia(a, targetChannelId)));
        processed.forEach((p, index) => {
          if (typeof p === 'string') {
            payload.content = (payload.content ? payload.content + '\n' : '') + p;
          } else {
            formData.append(`file${index}`, p.attachment, { filename: p.name });
            hasFiles = true;
          }
        });
      }

      formData.append('payload_json', JSON.stringify(payload));

      if (payload.content || payload.embeds?.length > 0 || hasFiles) {
        let postUrl = dcWebhookUrl;
        const threadId = target.dcThreadId;
        const urlParams = new URLSearchParams();
        urlParams.append('wait', 'true');
        if (threadId) {
          urlParams.append('thread_id', threadId);
        }
        postUrl = `${postUrl}${postUrl.includes('?') ? '&' : '?'}${urlParams.toString()}`;

        const res = await axios.post(postUrl, formData, {
          headers: formData.getHeaders(),
          timeout: 30000,
        });

        if (res.data && res.data.id) {
          dcMsgIdOut = res.data.id;
        }
        logger.info('✅ Ter-forward ke DC Webhook', makeLabel(message, 'DC'));
      }
    } catch (err) {
      const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      logger.error('❌ Gagal forward ke DC Webhook', errMsg);
    }
    return dcMsgIdOut;
  };

  // Eksekusi Paralel (Telegram & Discord Webhook dikirim bersamaan)
  await Promise.allSettled([
    forwardToTelegram(),
    forwardToDiscord()
  ]);

  // Simpan mapping untuk delete/edit/reply sync
  if (tgMsgId || dcMsgIdOut) {
    const targetChannelId = getTargetChannelId(message.channel) || message.channelId;
    messageStore.set(message.id, tgChatId, tgMsgId, botKey, msgType, dcWebhookUrl, dcMsgIdOut);
    stats.recordForward(targetChannelId);
  }

  return tgMsgId;
}

// ─── Handler: Pesan Baru ──────────────────────────────────────────────────────
async function handleNewMessage(message, channelMap, tgManager, config, rateLimiter) {
  const targetChannelId = getTargetChannelId(message.channel) || message.channelId;
  const target = channelMap.get(targetChannelId);
  if (!target) return;

  // ① Anti-duplicate (multi-akun & persisten)
  if (duplicateGuard.isDuplicate(message.id) || !messageStore.lock(message.id)) {
    logger.info('Duplikat dilewati', `msgId: ${message.id}`);
    return;
  }

  // Fetch partial message jika belum lengkap
  if (message.partial) {
    try { message = await message.fetch(); } catch { return; }
  }

  // Skip bot jika tidak diforward
  if (message.author?.bot && !config.forwardBotMessages) return;

  // ② GODMODE LAYER 1 — Rate Limiter (Anti Flood)
  // Jika user kirim > X gambar/pesan dalam Y detik → FLOOD BAN
  if (message.author?.id && !message.author?.bot) {
    const mediaCount = message.attachments?.size || 0;
    if (mediaCount > 0) {
      const { flooded, count, max } = userRateLimiter.recordAndCheck(message.author.id, mediaCount);
      if (flooded) {
        await handleSpamDetected(
          message,
          `Flood spam: ${count} gambar dalam ${userRateLimiter.WINDOW_MS / 1000}s (maks: ${max})`,
          tgManager,
          true
        );
        return;
      }
    }
  }

  // ③ GODMODE LAYER 2 — Filter Standar (mute/block/blacklist/whitelist)
  const { filtered, reason } = shouldFilter(message, config);
  if (filtered) {
    logger.info(`Dilewati: ${reason}`, `#${message.channel?.name}`);
    // Jika blacklist → hapus + block + alert
    if (reason.startsWith('kata blacklist:')) {
      const autoDel = process.env.AUTO_DELETE_BLACKLIST !== 'false';
      await handleSpamDetected(message, reason, tgManager, { autoDelete: autoDel });
    }
    return;
  }

  // ④ GODMODE LAYER 3 — Regex Pattern Detection (teks + embed)
  {

    let fullText = (message.content || '');
    if (message.embeds?.length > 0) {
      for (const embed of message.embeds) {
        fullText += ' ' + (embed.title || '') + ' ' + (embed.description || '');
        if (embed.fields) fullText += embed.fields.map(f => f.name + ' ' + f.value).join(' ');
        if (embed.footer) fullText += ' ' + (embed.footer.text || '');
        if (embed.author) fullText += ' ' + (embed.author.name || '');
      }
    }
    const regexResult = spamPattern.detect(fullText);
    if (regexResult.detected) {
      await handleSpamDetected(
        message,
        `Pola spam: ${regexResult.label} ("${(regexResult.match || '').substring(0, 40)}")`,
        tgManager,
        { autoDelete: regexResult.autoDelete }
      );
      return;
    }
  }

  // ⑤ GODMODE LAYER 4 — OCR Scan Gambar (Blacklist + Hash + Regex)
  /* --- FITUR DIMATIKAN SEMENTARA SESUAI PERMINTAAN (AGAR BISA FORWARD GAMBAR) ---
  if (message.attachments?.size > 0) {
    const ocrScanner = require('../utils/ocrScanner');
    for (const attachment of message.attachments.values()) {
      const spamResult = await ocrScanner.isSpamImage(attachment, config.blacklistWords);
      if (spamResult) {
        const spamReason = typeof spamResult === 'string' ? spamResult : spamResult.reason;
        const autoDel = typeof spamResult === 'string' ? true : spamResult.autoDelete;

        await handleSpamDetected(
          message,
          `Spam gambar: "${spamReason}"`,
          tgManager,
          { autoDelete: autoDel }
        );
        return; // <--- INI YANG MEMBUAT GAMBAR GAGAL DITERUSKAN
      }
    }
  }
  ------------------------------------------------------------------------------- */

  // ③ Partial word filter — hanya hapus kata terlarang, pesan tetap diteruskan
  message = applyWordFilter(message);

  // Jika setelah filter konten menjadi kosong dan tidak ada media, lewati
  if (!message.content && !(message.attachments?.size > 0) && !(message.embeds?.length > 0)) {
    logger.info('Pesan kosong setelah word filter, dilewati', `#${message.channel?.name}`);
    return;
  }

  const authorName  = message.member?.displayName || message.author?.username || 'Unknown';
  const channelName = message.channel?.name || message.channelId;
  const { botKey, tgThreadId } = target;
  const hasMedia = (message.attachments?.size || 0) > 0;

  logger.forward(
    `${authorName} → TG Bot#${botKey}`,
    `#${channelName} | media: ${message.attachments?.size || 0}${tgThreadId ? ' | topic' : ''}`
  );

  try {
    const tgMsgId = await doForward(message, target, tgManager, config, rateLimiter);
    logger.success(`Diteruskan → TG Bot#${botKey}`, `msgId: ${tgMsgId}`);
    // Push ke SSE live log
    if (hasMedia) {
      pushEvent('media', `🖼️ Media sent: <b>#${channelName}</b> → Bot #${botKey}`);
    } else {
      const preview = (message.content || '').substring(0, 60).replace(/</g,'&lt;');
      pushEvent('success', `🟢 Forwarded: "${preview}" → <b>#${channelName}</b> (Bot #${botKey})`);
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    logger.error('Gagal meneruskan pesan', errMsg);
    stats.recordFailed();
    pushEvent('error', `🔴 Failed: <b>#${channelName}</b> — ${errMsg.substring(0,80)}`);

    // ③ Masukkan ke DLQ untuk retry otomatis
    const label = makeLabel(message, botKey);
    // Snapshot data yang diperlukan sebelum async lambda
    const msgSnapshot = message;
    const tgtSnapshot = { ...target };
    forwardQueue.addFailed(
      () => doForward(msgSnapshot, tgtSnapshot, tgManager, config, rateLimiter),
      label
    );
  }
}

// ─── Handler: Pesan Dihapus ───────────────────────────────────────────────────
async function handleDeletedMessage(message, tgManager) {
  const stored = messageStore.get(message.id);
  if (!stored) return;

  const { tgChatId, tgMsgId, botKey, dcWebhookUrl, dcMsgId } = stored;

  if (tgChatId && tgMsgId) {
    const tgBot = tgManager.get(botKey);
    if (tgBot) {
      try {
        await tgBot.deleteMessage(tgChatId, tgMsgId);
        logger.info('🗑️  Delete sync OK', `tgMsgId: ${tgMsgId}`);
      } catch (err) {
        logger.warn('Gagal hapus pesan TG', err.message?.substring(0, 80));
      }
    }
  }

  if (dcWebhookUrl && dcMsgId) {
    try {
      await axios.delete(`${dcWebhookUrl}/messages/${dcMsgId}`);
      logger.info('🗑️  DC Delete sync OK', `dcMsgId: ${dcMsgId}`);
    } catch(err) {
      if (err.response?.status === 404 || err.response?.data?.code === 10008) {
        logger.info('🗑️  DC message already deleted / not found (404)');
      } else {
        logger.warn('Gagal hapus pesan DC', err.message?.substring(0, 80));
      }
    }
  }

  messageStore.delete(message.id);
}

// ─── Handler: Pesan Diedit ────────────────────────────────────────────────────
async function handleEditedMessage(oldMessage, newMessage, channelMap, tgManager, config, rateLimiter) {
  if (!config.forwardEdits) return;
  const oldEmbeds = JSON.stringify(oldMessage.embeds || []);
  const newEmbeds = JSON.stringify(newMessage.embeds || []);
  if (oldMessage.content === newMessage.content && oldEmbeds === newEmbeds) return;

  let message = newMessage;
  if (message.partial) {
    try { message = await message.fetch(); } catch { return; }
  }

  if (blockedUsersStore.has(message.author?.id)) return;

  const stored = messageStore.get(message.id);

  if (stored) {
    const { tgChatId, tgMsgId, botKey, type, dcWebhookUrl, dcMsgId } = stored;
    
    let editedTg = false;
    if (tgChatId && tgMsgId) {
      const tgBot = tgManager.get(botKey);
      if (tgBot) {
        try {
          const newText = formatEditedMessage(message, config);

          if (type === 'media') {
            await tgBot.editMessageCaption(newText, {
              chat_id: tgChatId, message_id: tgMsgId, parse_mode: 'MarkdownV2',
            }).catch(() =>
              rateLimiter.add(() => safeSendMessage(tgBot, tgChatId, newText))
            );
          } else {
            await rateLimiter.add(() => safeEditMessage(tgBot, tgChatId, tgMsgId, newText));
          }

          stats.recordEdit();
          logger.info('✏️  Edit sync OK', `tgMsgId: ${tgMsgId}`);
          editedTg = true;
        } catch (err) {
          logger.warn('Edit sync gagal, kirim baru', err.message?.substring(0, 60));
        }
      }
    }

    if (dcWebhookUrl && dcMsgId) {
      try {
        const payload = { content: message.content || null };
        if (message.embeds?.length > 0) {
          const validEmbeds = message.embeds
            .filter(e => e.type === 'rich' || e.type === 'article')
            .map(e => e.toJSON ? e.toJSON() : e);
          payload.embeds = validEmbeds;
        } else {
          payload.embeds = [];
        }

        await axios.patch(`${dcWebhookUrl}/messages/${dcMsgId}`, payload);
        logger.info('✏️  DC Edit sync OK', `dcMsgId: ${dcMsgId}`);
        if (!editedTg) return; // Prevent fallthrough if TG edit didn't happen but DC did
      } catch (err) {
        if (err.response?.status === 404 || err.response?.data?.code === 10008) {
          logger.info('✏️  DC message not found to edit (already deleted)');
        } else {
          logger.error('Gagal edit pesan DC', err.message?.substring(0, 80));
        }
      }
    }
    
    if (editedTg || (dcWebhookUrl && dcMsgId)) return;
  }

  // Fallback: kirim pesan edit sebagai pesan baru
  const targetChannelId = getTargetChannelId(message.channel) || message.channelId;
  const target = channelMap.get(targetChannelId);
  if (!target) return;

  const { tgChatId, botKey } = target;
  if (!tgChatId) return; // Hindari error chat_id is empty jika channel khusus DC Webhook
  const tgBot = tgManager.get(botKey);
  if (!tgBot) return;

  const { filtered } = shouldFilter(message, config);
  if (filtered) return;

  try {
    const text = formatEditedMessage(message, config);
    await rateLimiter.add(() => safeSendMessage(tgBot, tgChatId, text));
    stats.recordEdit();
    logger.info('✏️  Edit diteruskan (baru)', `#${message.channel?.name}`);
  } catch (err) {
    logger.error('Gagal forward edit', err.message);
  }
}

// ─── Handler: Reaction Discord ─────────────────────────────────────────────────────────
async function handleReaction(reaction, user, tgManager) {
  if (reaction.partial) {
    try { reaction = await reaction.fetch(); } catch { return; }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch(); } catch { return; }
  }

  const stored = messageStore.get(reaction.message.id);
  if (!stored) return;

  const targetChannelId = getTargetChannelId(reaction.message.channel) || reaction.message.channelId;
  if (mutedChannels.isMuted(targetChannelId)) return;

  const { tgChatId, tgMsgId, botKey } = stored;
  const tgBot = tgManager.get(botKey);
  if (!tgBot) return;

  const emoji    = reaction.emoji.name || reaction.emoji.id || '?';
  const count    = reaction.count || 1;
  const username = user?.username || 'Someone';
  const countStr = count > 1 ? ` x${count}` : '';
  const text     = `${emoji}${countStr} — _${username}_`;

  try {
    await tgBot.sendMessage(tgChatId, text, {
      reply_to_message_id: tgMsgId,
      disable_notification: true,
    });
    logger.info(`Reaction forwarded: ${emoji} dari ${username}`);
  } catch {
    // Reaction tidak krusial, gagal diam saja
  }
}

// ─── Register semua event ─────────────────────────────────────────────────────
function registerHandlers(discordClient, tgManager, channelMap, config, rateLimiter) {
  discordClient.on('messageCreate', (msg) => {
    handleNewMessage(msg, channelMap, tgManager, config, rateLimiter)
      .catch(err => logger.error('Error messageCreate', err.message));
  });

  discordClient.on('messageDelete', (msg) => {
    handleDeletedMessage(msg, tgManager)
      .catch(err => logger.error('Error messageDelete', err.message));
  });

  discordClient.on('messageUpdate', (old, nw) => {
    handleEditedMessage(old, nw, channelMap, tgManager, config, rateLimiter)
      .catch(err => logger.error('Error messageUpdate', err.message));
  });

  if (process.env.FORWARD_REACTIONS === 'true') {
    discordClient.on('messageReactionAdd', (reaction, user) => {
      handleReaction(reaction, user, tgManager)
        .catch(err => logger.error('Error messageReactionAdd', err.message));
    });
    logger.info('Reaction forwarding aktif (FORWARD_REACTIONS=true)');
  }

  logger.success('Event handlers Discord terdaftar (create / delete / update / reaction)');
}

module.exports = {
  registerHandlers,
  handleNewMessage,
  handleDeletedMessage,
  handleEditedMessage,
  handleReaction,
  formatReplyQuote,
  stripDiscordInvites,
};
