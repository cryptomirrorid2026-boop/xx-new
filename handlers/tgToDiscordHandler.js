// ============================================================
//   HANDLERS / TGTODISCORDHANDLER.JS  v2 — Userbot Edition
//   Core logic: Forward pesan Telegram → Discord Webhook
//
//   MENGGUNAKAN: Telegram User Account (MTProto via GramJS)
//   BUKAN: Telegram Bot API
//   → Bisa monitor grup/channel apapun yang akun user ikuti
//   → Nama, avatar, forward info persis asli dari Telegram
//
//   FITUR:
//     - Text, Photo, Video, Audio, Document, Sticker, Voice, GIF
//     - Nama & avatar pengirim ASLI (via username Discord webhook)
//     - Avatar asli dari profil Telegram (di-download via userbot)
//     - Edit sync (TG edited_message → PATCH Discord webhook msg)
//     - Pseudo-delete: hapus di TG → edit Discord jadi ~~[DIHAPUS]~~
//     - Anti-duplikat (per message ID)
//     - Mute channel support
//     - Blacklist / Whitelist kata
//     - Support banyak akun TG (TG_USER_SESSIONS=session1,session2)
// ============================================================

'use strict';

const { TelegramClient }   = require('telegram');
const { NewMessage }       = require('telegram/events');
const { EditedMessage }    = require('telegram/events/EditedMessage');
const { DeletedMessage }   = require('telegram/events/DeletedMessage');
const { StringSession }    = require('telegram/sessions');
const { Api }              = require('telegram');
const axios                = require('axios');
const FormData             = require('form-data');
const path                 = require('path');
const fs                   = require('fs');

const logger        = require('../utils/logger');
const stats         = require('../utils/stats');
const tg2dcStore    = require('../utils/tgToDiscordStore');
const tg2dcMsgStore = require('../utils/tgToDiscordMessageStore');
const mutedChannels = require('../utils/mutedChannels');
const mappingStore  = require('../utils/mappingStore');

// ─── Cache avatar (chatId → Buffer base64 PNG) ──────────────────────────────
// Menghindari re-download avatar setiap pesan
const avatarCache = new Map();

// Global Discord Client reference for dynamic role search
let _discordClient = null;

// ─── Cache webhook info (Webhook URL → info) ─────────────────────
const webhookCache = new Map();

async function getDiscordWebhookInfo(webhookUrl) {
  if (webhookCache.has(webhookUrl)) return webhookCache.get(webhookUrl);
  try {
    const res = await axios.get(webhookUrl, { timeout: 10_000 });
    if (res.data && res.data.channel_id) {
      const info = { channel_id: res.data.channel_id, guild_id: res.data.guild_id };
      webhookCache.set(webhookUrl, info);
      return info;
    }
  } catch (err) {
    logger.warn('Gagal fetch webhook info', err.message?.substring(0, 80));
  }
  return null;
}

async function resolveDynamicRole(guildId, roleName) {
  if (!_discordClient || !guildId) return null;
  const guild = _discordClient.guilds.cache.get(guildId);
  if (!guild) return null;
  
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
  if (role) return role.id;
  
  try {
    const roles = await guild.roles.fetch();
    role = roles.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    return role ? role.id : null;
  } catch {
    return null;
  }
}

// ─── Helper: Dapatkan Public URL dari tunnel atau env ────────────────────────
function getPublicUrl() {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/\/$/, '');
  }
  try {
    const tunnelPath = path.join(__dirname, '..', 'data', 'tunnel.json');
    if (fs.existsSync(tunnelPath)) {
      const data = JSON.parse(fs.readFileSync(tunnelPath, 'utf8'));
      if (data && data.url) {
        return data.url.replace(/\/$/, '');
      }
    }
  } catch (err) {
    // Abaikan
  }
  return null;
}

// ─── Anti-duplikat menggunakan duplicateGuard global ─────────────────────────
const tgDuplicateGuard = new (require('../utils/duplicateGuard').DuplicateGuard)(60000); // 60s TTL

// ─── Konversi entities Telegram (formatting) ke Discord Markdown ─────────────
function convertEntities(text, entities) {
  if (!text || !entities || entities.length === 0) return escapeForDiscord(text);

  // Build karakter per karakter dengan formatting overlay
  const chars = [...text]; // Handle Unicode properly
  const result = [];
  let i = 0;

  // Sort entities by offset
  const sorted = [...entities].sort((a, b) => a.offset - b.offset);

  let entityIdx = 0;
  const openTags = [];

  // Simple approach: apply entity markers to ranges
  const tags = new Array(chars.length).fill(null).map(() => ({ open: [], close: [] }));

  for (const entity of sorted) {
    const start = entity.offset;
    const end   = entity.offset + entity.length;

    let openTag  = '';
    let closeTag = '';

    if (entity.className === 'MessageEntityBold') {
      openTag = '**'; closeTag = '**';
    } else if (entity.className === 'MessageEntityItalic') {
      openTag = '*'; closeTag = '*';
    } else if (entity.className === 'MessageEntityCode') {
      openTag = '`'; closeTag = '`';
    } else if (entity.className === 'MessageEntityPre') {
      openTag = '```\n'; closeTag = '\n```';
    } else if (entity.className === 'MessageEntityStrike') {
      openTag = '~~'; closeTag = '~~';
    } else if (entity.className === 'MessageEntitySpoiler') {
      openTag = '||'; closeTag = '||';
    } else if (entity.className === 'MessageEntityUrl') {
      // URL: keep as is
    } else if (entity.className === 'MessageEntityTextUrl') {
      openTag  = `[`;
      closeTag = `](${entity.url})`;
    } else if (entity.className === 'MessageEntityUnderline') {
      openTag = '__'; closeTag = '__';
    }

    if (openTag && start < chars.length) {
      if (tags[start]) tags[start].open.push(openTag);
      if (tags[Math.min(end - 1, chars.length - 1)]) tags[Math.min(end - 1, chars.length - 1)].close.unshift(closeTag);
    }
  }

  let out = '';
  for (let ci = 0; ci < chars.length; ci++) {
    if (tags[ci]) out += tags[ci].open.join('');
    out += chars[ci] === '\\' ? '\\\\' : chars[ci]; // escape backslash only
    if (tags[ci]) out += tags[ci].close.join('');
  }

  return out;
}

function escapeForDiscord(text) {
  if (!text) return '';
  // Minimal escaping untuk Discord — jangan escape terlalu banyak
  return text;
}

// ─── Ambil nama tampilan pengirim ─────────────────────────────────────────────
function getSenderName(message) {
  const sender = message.sender;
  if (!sender) {
    // Anonymous channel post
    const chat = message.chat;
    if (chat) return chat.title || chat.username || 'Channel';
    return 'Unknown';
  }

  if (sender.className === 'User') {
    const parts = [sender.firstName, sender.lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : (sender.username || `User_${sender.id}`);
  }

  if (sender.className === 'Channel' || sender.className === 'Chat') {
    return sender.title || sender.username || 'Channel';
  }

  return 'Unknown';
}

// ─── Download avatar profil via GramJS (dengan cache) ────────────────────────
async function getSenderAvatarUrl(client, message) {
  try {
    const sender = message.sender;
    if (!sender) return getFallbackAvatar(getSenderName(message));

    const senderId = String(sender.id);
    if (avatarCache.has(senderId)) return avatarCache.get(senderId);

    // Download foto profil
    const photoBuffer = await client.downloadProfilePhoto(sender, { isBig: false });
    if (photoBuffer && photoBuffer.length > 0) {
      // Konversi ke base64 data URL untuk dikirim ke Discord webhook
      // Discord webhook avatar_url harus berupa URL, bukan data URL
      // Jadi simpan ke file sementara dan buat URL lokal — atau
      // gunakan fallback (Discord tidak support data: URL di avatar_url)
      // SOLUSI: Simpan ke folder temp dan serve via webserver lokal
      const tmpDir = path.join(__dirname, '..', 'data', 'avatars');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const avatarPath = path.join(tmpDir, `${senderId}.jpg`);
      fs.writeFileSync(avatarPath, photoBuffer);

      // Gunakan PUBLIC_URL dari .env atau domain publik dari data/tunnel.json
      const publicBaseUrl = getPublicUrl();
      if (publicBaseUrl) {
        const avatarUrl = `${publicBaseUrl}/avatars/${senderId}.jpg`;
        avatarCache.set(senderId, avatarUrl);
        return avatarUrl;
      } else {
        // Fallback ke inisial nama jika tidak ada public URL
        const fallback = getFallbackAvatar(getSenderName(message));
        avatarCache.set(senderId, fallback);
        return fallback;
      }
    }
  } catch (err) {
    // Gagal download avatar → pakai fallback
  }

  const fallback = getFallbackAvatar(getSenderName(message));
  return fallback;
}

function getFallbackAvatar(name) {
  return `https://api.dicebear.com/7.x/initials/png?seed=${encodeURIComponent(name)}&size=64`;
}

// ─── Download media dari pesan TG ────────────────────────────────────────────
async function downloadMedia(client, message) {
  try {
    const buffer = await client.downloadMedia(message, {
      progressCallback: () => {},
    });
    if (!buffer) return null;

    // Tentukan nama file & content type
    let fileName    = 'file';
    let contentType = 'application/octet-stream';

    const media = message.media;
    if (media?.className === 'MessageMediaPhoto') {
      fileName = 'photo.jpg'; contentType = 'image/jpeg';
    } else if (media?.className === 'MessageMediaDocument') {
      const doc  = media.document;
      const fnAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
      const vidAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeVideo');
      const audAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeAudio');
      const stkAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeSticker');
      const animAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeAnimated');

      if (stkAttr) {
        fileName = 'sticker.webp'; contentType = 'image/webp';
      } else if (animAttr) {
        fileName = fnAttr?.fileName || 'animation.gif';
        contentType = doc.mimeType || 'image/gif';
      } else if (vidAttr) {
        fileName = fnAttr?.fileName || 'video.mp4';
        contentType = doc.mimeType || 'video/mp4';
      } else if (audAttr) {
        if (audAttr.voice) {
          fileName = 'voice.ogg'; contentType = 'audio/ogg';
        } else {
          fileName = fnAttr?.fileName || 'audio.mp3';
          contentType = doc.mimeType || 'audio/mpeg';
        }
      } else {
        fileName = fnAttr?.fileName || 'document';
        contentType = doc.mimeType || 'application/octet-stream';
      }
    }

    return { buffer, fileName, contentType };
  } catch (err) {
    logger.warn('TG→DC: Gagal download media', err.message?.substring(0, 80));
    return null;
  }
}

// ─── Kirim ke Discord Webhook ─────────────────────────────────────────────────
async function sendToDiscordWebhook(webhookUrl, payload, formData = null) {
  const urlWithWait = webhookUrl.includes('?')
    ? `${webhookUrl}&wait=true`
    : `${webhookUrl}?wait=true`;

  try {
    let res;
    if (formData) {
      formData.append('payload_json', JSON.stringify(payload));
      res = await axios.post(urlWithWait, formData, {
        headers: formData.getHeaders(),
        timeout: 120_000,
        maxContentLength: 100 * 1024 * 1024,
      });
    } else {
      res = await axios.post(urlWithWait, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30_000,
      });
    }
    return res.data?.id || null;
  } catch (err) {
    const errData = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`DC Webhook error: ${errData?.substring(0, 150)}`);
  }
}

// ─── Edit pesan di Discord Webhook ───────────────────────────────────────────
async function editDiscordWebhookMessage(webhookUrl, dcMsgId, payload) {
  try {
    await axios.patch(`${webhookUrl}/messages/${dcMsgId}`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
    return true;
  } catch (err) {
    logger.warn(`TG→DC: Gagal edit DC webhook msg ${dcMsgId}`, err.message?.substring(0, 80));
    return false;
  }
}

// ─── Filter kata ──────────────────────────────────────────────────────────────
function passesWordFilter(text, config) {
  const content = (text || '').toLowerCase();

  if (config.blacklistWords?.length > 0) {
    for (const w of config.blacklistWords) {
      if (content.includes(w.toLowerCase())) return false;
    }
  }

  if (config.whitelistWords?.length > 0) {
    const hasWord = config.whitelistWords.some(w => content.includes(w.toLowerCase()));
    if (!hasWord && text) return false;
  }

  return true;
}

// ─── Translator Mentions & Roles ─────────────────────────────────────────────
async function translateMentions(text, targetGuildId) {
  if (!text) return text;
  
  const regex = /([@#])([a-zA-Z0-9_-]+)/g;
  let matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({ full: match[0], prefix: match[1], keyword: match[2], index: match.index });
  }

  if (matches.length === 0) return text;

  for (let i = matches.length - 1; i >= 0; i--) {
    const { full, prefix, keyword, index } = matches[i];
    let dcId = null;

    if (prefix === '@') {
      dcId = mappingStore.getMention(full) || mappingStore.getMention(keyword);
      if (dcId) {
        text = text.slice(0, index) + `<@${dcId}>` + text.slice(index + full.length);
        continue;
      }
      
      dcId = mappingStore.getRole(full) || mappingStore.getRole(keyword) || await resolveDynamicRole(targetGuildId, keyword);
      if (dcId) {
        text = text.slice(0, index) + `<@&${dcId}>` + text.slice(index + full.length);
        continue;
      }
    } else if (prefix === '#') {
      dcId = mappingStore.getRole(full) || mappingStore.getRole(keyword) || await resolveDynamicRole(targetGuildId, keyword);
      if (dcId) {
        text = text.slice(0, index) + `<@&${dcId}>` + text.slice(index + full.length);
        continue;
      }
    }
  }

  return text;
}

// ─── Ambil teks pesan (dengan entity formatting) ──────────────────────────────
async function getMessageText(message, targetGuildId) {
  const raw = message.message || '';
  if (!raw) return '';
  // Konversi entities TG → Discord markdown
  return await translateMentions(convertEntities(raw, message.entities), targetGuildId);
}

// ─── Ambil chat ID dari event GramJS ─────────────────────────────────────────
function getChatId(message) {
  // GramJS: peerId bisa PeerChannel, PeerChat, PeerUser
  const peer = message.peerId;
  if (!peer) return null;

  if (peer.className === 'PeerChannel') return String(-100 * 1e9 - Number(peer.channelId)).split('.')[0];
  if (peer.className === 'PeerChat')    return String(-Number(peer.chatId));
  if (peer.className === 'PeerUser')    return String(peer.userId);
  return null;
}

// Alternatif: ambil dari chatId property GramJS (lebih andal)
function resolveChatId(message) {
  // GramJS message.chatId sudah berupa BigInt dengan format benar
  if (message.chatId !== undefined && message.chatId !== null) {
    return String(message.chatId);
  }
  return getChatId(message);
}

// ─── Proses & Forward Pesan Baru ─────────────────────────────────────────────
async function processNewMessage(event, client, config) {
  const message = event.message;
  if (!message) return;

  const chatId = resolveChatId(message);
  if (!chatId) return;

  // Cek mapping TG→DC
  const target = tg2dcStore.findByTgChat(chatId);
  if (!target) return;

  const msgId = String(message.id);

  // Anti-duplikat menggunakan in-memory guard + SQLite constraint-based lock
  if (tgDuplicateGuard.isDuplicate(`${chatId}:${msgId}`) || !tg2dcMsgStore.lock(chatId, msgId)) {
    logger.info(`TG→DC: Duplikat dilewati msgId: ${msgId}`);
    return;
  }

  // Mute check
  const muteKey = `tg:${chatId}`;
  if (mutedChannels.isMuted(muteKey)) {
    logger.info(`TG→DC: Channel TG ${chatId} di-mute, skip`);
    return;
  }

  // Filter pesan dari bot/service
  if (message.fromScheduled || (message.sender?.bot && !config.forwardBotMessages)) return;

  const { dcWebhookUrl, name: channelName } = target;

  const webhookInfo = await getDiscordWebhookInfo(dcWebhookUrl);
  const targetGuildId = webhookInfo ? webhookInfo.guild_id : null;

  // Ambil teks
  const textContent = await getMessageText(message, targetGuildId);

  // Word filter
  if (!passesWordFilter(textContent, config)) {
    logger.info(`TG→DC: Pesan difilter (word filter) di chat ${chatId}`);
    return;
  }

  // Cek ada konten
  const hasMedia = !!(message.media && message.media.className !== 'MessageMediaEmpty');
  if (!textContent && !hasMedia) return;

  // Nama & avatar pengirim
  const senderName = getSenderName(message);
  const avatarUrl  = await getSenderAvatarUrl(client, message);

  logger.forward(`TG→DC: ${senderName} → DC [${channelName}]`, `chat: ${chatId} msgId: ${msgId}`);

  try {
    // ── Bangun forward info (jika pesan di-forward dari tempat lain) ──
    let forwardPrefix = '';
    if (message.fwdFrom) {
      const fwd = message.fwdFrom;
      let srcName = 'Unknown';
      if (fwd.fromName)             srcName = fwd.fromName;
      else if (fwd.savedFromPeer)   srcName = '(tersimpan)';
      forwardPrefix = `> 📨 **Diteruskan dari:** ${srcName}\n`;
    }

    // ── Bangun Header & Footer sesuai konfigurasi ──
    let header = '';
    if (target.channelTag) {
      const targetChannelId = webhookInfo ? webhookInfo.channel_id : null;
      if (targetChannelId) {
        header = `💬 | <#${targetChannelId}> 💭\n\n`;
      }
    }

    let footer = '';
    if (target.autoPingText) {
      if (target.autoPingPosition === 'top') {
        header += `${target.autoPingText}\n\n`;
      } else {
        footer = `\n\n${target.autoPingText}`;
      }
    }

    const fullContent = (header + forwardPrefix + textContent + footer).trim();

    // ── Payload dasar webhook ──
    const payload = {
      username:   senderName.substring(0, 80),   // Discord webhook max 80 char
      avatar_url: avatarUrl,
      allowed_mentions: {
        parse: target.ghostPing ? ["roles", "everyone"] : ["users", "roles", "everyone"]
      }
    };
    if (fullContent) payload.content = fullContent.substring(0, 2000);

    let dcMsgId = null;

    // ── Media download & upload ke Discord ──
    if (hasMedia) {
      const publicUrl = getPublicUrl();
      const fileParams = message.file;
      
      // Jika file > 25 MB dan ada public URL, unduh langsung ke static downloads folder
      if (fileParams && fileParams.size > 25 * 1024 * 1024 && publicUrl) {
        try {
          const downloadsDir = path.join(__dirname, '..', 'public', 'downloads');
          if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
          
          const ext = fileParams.ext || 'bin';
          const safeName = `tg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
          const filePath = path.join(downloadsDir, safeName);
          
          logger.info(`TG→DC: Mendownload file besar (${(fileParams.size / 1024 / 1024).toFixed(1)} MB) langsung ke disk...`);
          await client.downloadMedia(message, { outputFile: filePath });
          
          if (fs.existsSync(filePath)) {
            const fileUrl = `${publicUrl}/downloads/${safeName}`;
            payload.content = (payload.content ? payload.content + '\n' : '') +
              `📎 **[Video/File Besar: ${fileParams.name || 'file'} (${(fileParams.size / 1024 / 1024).toFixed(1)} MB)]**\n${fileUrl}`;
            dcMsgId = await sendToDiscordWebhook(dcWebhookUrl, payload);
          }
        } catch (err) {
          logger.error('TG→DC: Gagal memproses file besar via static URL', err.message);
        }
      }
      
      // Jika belum terkirim (belum dapat dcMsgId), jalankan flow normal (buffer atau url fallback)
      if (!dcMsgId) {
        const dl = await downloadMedia(client, message);

        if (dl && dl.buffer) {
          // Cek ukuran (Discord webhook limit 25 MB)
          if (dl.buffer.length <= 25 * 1024 * 1024) {
            const formData = new FormData();
            formData.append('file0', dl.buffer, {
              filename:    dl.fileName,
              contentType: dl.contentType,
            });
            dcMsgId = await sendToDiscordWebhook(dcWebhookUrl, payload, formData);
          } else {
            // File terlalu besar dan tidak ada public URL
            const sizeStr = (dl.buffer.length / 1024 / 1024).toFixed(1);
            payload.content = (payload.content ? payload.content + '\n' : '') +
              `📎 *[File terlalu besar untuk Discord: ${dl.fileName} (${sizeStr} MB)]*`;
            if (payload.content) dcMsgId = await sendToDiscordWebhook(dcWebhookUrl, payload);
          }
        } else {
          // Gagal download — kirim teks saja
          if (payload.content) dcMsgId = await sendToDiscordWebhook(dcWebhookUrl, payload);
          else {
            payload.content = `📎 *[Media tidak dapat diunduh]*`;
            dcMsgId = await sendToDiscordWebhook(dcWebhookUrl, payload);
          }
        }
      }
    } else {
      // Teks saja
      if (payload.content) dcMsgId = await sendToDiscordWebhook(dcWebhookUrl, payload);
    }

    if (dcMsgId) {
      tg2dcMsgStore.set(chatId, msgId, dcWebhookUrl, dcMsgId);
      stats.recordForward(chatId);
      logger.success(`TG→DC: ✅ OK → DC msg ${dcMsgId} [${channelName}]`);
    }
  } catch (err) {
    logger.error(`TG→DC: ❌ Gagal forward dari chat ${chatId}`, err.message?.substring(0, 120));
    stats.recordFailed();
  }
}

// ─── Proses Pesan Diedit ──────────────────────────────────────────────────────
async function processEditedMessage(event, config) {
  const message = event.message;
  if (!message) return;

  const chatId = resolveChatId(message);
  if (!chatId) return;

  const msgId = String(message.id);

  // Cari DC message ID dari store
  const stored = tg2dcMsgStore.get(chatId, msgId);
  if (!stored) return;

  const { dcWebhookUrl, dcMsgId } = stored;
  const textContent = await getMessageText(message);

  if (!passesWordFilter(textContent, config)) return;

  const editPayload = {
    content: `✏️ **[DIEDIT]**\n${textContent || ''}`.substring(0, 2000),
  };

  const ok = await editDiscordWebhookMessage(dcWebhookUrl, dcMsgId, editPayload);
  if (ok) {
    stats.recordEdit();
    logger.info(`TG→DC: Edit sync ✅ → DC msg ${dcMsgId}`);
  }
}

// ─── Proses Pesan Dihapus ─────────────────────────────────────────────────────
async function processDeletedMessage(event, config) {
  // GramJS DeletedMessage memberikan array ID pesan yang dihapus
  // dan chatId (jika dari channel/supergroup)
  const deletedIds = event.deletedIds || [];
  const chatPeer   = event.peer;

  if (!chatPeer || deletedIds.length === 0) return;

  // Resolve chatId dari peer
  let chatId = null;
  if (chatPeer.channelId) chatId = String(-100 * 1e9 - Number(chatPeer.channelId)).split('.')[0];
  else if (chatPeer.chatId) chatId = String(-Number(chatPeer.chatId));

  if (!chatId) return;

  for (const msgId of deletedIds) {
    const stored = tg2dcMsgStore.get(chatId, String(msgId));
    if (!stored) continue;

    const { dcWebhookUrl, dcMsgId } = stored;

    // Pseudo-delete: edit pesan Discord menjadi [DIHAPUS]
    const deletePayload = { content: `~~[PESAN DIHAPUS]~~` };
    const ok = await editDiscordWebhookMessage(dcWebhookUrl, dcMsgId, deletePayload);

    if (ok) {
      logger.info(`TG→DC: Delete sync ✅ → DC msg ${dcMsgId} (pseudo-delete)`);
      tg2dcMsgStore.delete(chatId, String(msgId));
    }
  }
}

// ─── Instances userbot yang aktif ────────────────────────────────────────────
const _userbots = [];

// ─── Buat & Login Telegram Userbot ───────────────────────────────────────────
async function _createUserbot(sessionString, accountNum, config) {
  const apiId   = parseInt(process.env.TG_API_ID   || '0');
  const apiHash = process.env.TG_API_HASH || '';

  if (!apiId || !apiHash) {
    logger.error('TG→DC: TG_API_ID dan TG_API_HASH belum diset di .env!');
    logger.error('TG→DC: Dapatkan di https://my.telegram.org → App credentials');
    return null;
  }

  const session = new StringSession(sessionString.trim());

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    retryDelay:        2000,
    autoReconnect:     true,
    // Jangan tanya apapun ke stdin — sudah pakai session string
    // yang bisa di-generate dengan script generate-session.js
  });

  try {
    logger.info(`TG→DC: Menghubungkan akun Telegram #${accountNum}...`);
    await client.connect();

    const me = await client.getMe();
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'Unknown';
    logger.success(`TG→DC: ✅ Akun Telegram #${accountNum} online: ${name} (@${me.username || me.id})`);

    return client;
  } catch (err) {
    logger.error(`TG→DC: ❌ Akun Telegram #${accountNum} gagal login`, err.message?.substring(0, 100));
    logger.error('TG→DC: Pastikan TG_USER_SESSION sudah benar. Jalankan: node generate-tg-session.js');
    return null;
  }
}

// ─── Register event handlers ke satu client ──────────────────────────────────
function _registerClientEvents(client, accountNum, config) {
  // ── Pesan Baru ──
  client.addEventHandler(async (event) => {
    try {
      await processNewMessage(event, client, config);
    } catch (err) {
      logger.error('TG→DC: Error pesan baru', err.message?.substring(0, 80));
    }
  }, new NewMessage({}));

  // ── Pesan Diedit ──
  client.addEventHandler(async (event) => {
    try {
      await processEditedMessage(event, config);
    } catch (err) {
      logger.error('TG→DC: Error edited message', err.message?.substring(0, 80));
    }
  }, new EditedMessage({}));

  // ── Pesan Dihapus ──
  client.addEventHandler(async (event) => {
    try {
      await processDeletedMessage(event, config);
    } catch (err) {
      logger.error('TG→DC: Error deleted message', err.message?.substring(0, 80));
    }
  }, new DeletedMessage({}));

  logger.success(`TG→DC: Event handler aktif untuk akun #${accountNum}`);
}

// ─── Daftarkan Static file route untuk avatar (dipanggil dari webServer) ──────
function getAvatarDir() {
  return path.join(__dirname, '..', 'data', 'avatars');
}

// ─── Main: Inisialisasi semua userbot ────────────────────────────────────────
/**
 * @param {object} discordClient  - Client Discord.js (opsional, untuk fetch dynamic roles)
 * @param {object} config  - Config dari index.js (tg2dcConfig)
 */
async function registerTgToDiscordHandlers(discordClient, config) {
  _discordClient = discordClient;
  // Parse session strings dari env
  const rawSessions = process.env.TG_USER_SESSIONS || process.env.TG_USER_SESSION || '';
  const sessions = rawSessions.split(',').map(s => s.trim()).filter(Boolean);

  if (sessions.length === 0) {
    logger.warn('TG→DC: Tidak ada TG_USER_SESSIONS di .env!');
    logger.warn('TG→DC: Buat session dengan: node generate-tg-session.js');
    logger.warn('TG→DC: TG→DC handler TIDAK aktif.');
    return;
  }

  if (tg2dcStore.size === 0) {
    logger.info('TG→DC: Tidak ada mapping TG→DC. Tambah via /addtg2dc atau dashboard.');
    logger.info('TG→DC: Handler tetap aktif dan siap saat mapping ditambah.');
  }

  logger.info(`TG→DC: Memulai ${sessions.length} Telegram userbot...`);

  for (let i = 0; i < sessions.length; i++) {
    const client = await _createUserbot(sessions[i], i + 1, config);
    if (!client) continue;

    _userbots.push(client);
    _registerClientEvents(client, i + 1, config);
  }

  if (_userbots.length === 0) {
    logger.error('TG→DC: Tidak ada userbot yang berhasil login. TG→DC tidak aktif.');
    return;
  }

  tg2dcStore.startWatcher();
  logger.success(`TG→DC: ✅ ${_userbots.length} akun Telegram aktif, siap mirror ke Discord`);
}

/**
 * Disconnect semua userbot (untuk graceful shutdown)
 */
async function disconnectAll() {
  for (const client of _userbots) {
    try { await client.disconnect(); } catch {}
  }
}

function getActiveUserbot() {
  return _userbots && _userbots.length > 0 ? _userbots[0] : null;
}

module.exports = {
  registerTgToDiscordHandlers,
  disconnectAll,
  getAvatarDir,
  getActiveUserbot,
};
