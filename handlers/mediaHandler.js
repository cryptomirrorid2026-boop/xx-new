// ============================================================
//   HANDLERS / MEDIAHANDLER.JS — v4 (Crop + Anti-Gagal)
//   Handle pengiriman media (gambar, video, file, sticker)
//
//   FITUR v4:
//     - Fitur Crop per Discord Channel ID (didahulukan)
//     - Download retry 3x dengan backoff
//     - Upload timeout diperpanjang ke 60 detik
//     - Lebih banyak fallback chain (buffer → url → text link)
//     - Caption fallback ke plain text jika MarkdownV2 error
//     - Skip caption jika terlalu panjang
//     - Stats media diperbaiki (hitung per attachment)
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const logger = require('../utils/logger');
const stats  = require('../utils/stats');
const watermarkManager = require('../utils/watermarkManager');
const cropManager      = require('../utils/cropManager');
const blurManager      = require('../utils/blurManager');

// Batas file yang di-download & upload ke Telegram via Bot API (maks 50 MB)
const MAX_FILE_BYTES   = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 60_000;  // 60 detik download timeout
const UPLOAD_TIMEOUT   = 120_000; // 120 detik untuk upload ke TG
const MAX_CAPTION_LEN  = 1024;

/** Helper untuk download file dari URL langsung ke disk */
async function downloadFileToDisk(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 120_000,
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Map ekstensi → MIME type untuk hint ke Telegram
const MIME_MAP = {
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', webm: 'video/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', aac: 'audio/aac',
};

/** Tentukan tipe media dari attachment Discord */
function getMediaType(attachment) {
  const ct   = attachment.contentType || '';
  const name = (attachment.name || '').toLowerCase();

  if (ct.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(name)) return 'photo';
  if (ct.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm)$/i.test(name))       return 'video';
  if (ct.startsWith('audio/') || /\.(mp3|wav|ogg|flac|aac)$/i.test(name))       return 'audio';
  return 'document';
}

/** Ambil MIME type dari nama file */
function getMimeType(filename, fallback = 'application/octet-stream') {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return MIME_MAP[ext] || fallback;
}

/** Delay helper */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Download attachment Discord CDN sebagai Buffer.
 * Retry sampai 3x dengan exponential backoff.
 * Return: { buffer, filename, contentType } atau null jika gagal / terlalu besar.
 */
async function downloadAttachment(attachment, attempt = 1) {
  // Skip download jika ukuran diketahui > 50 MB
  if (attachment.size && attachment.size > MAX_FILE_BYTES) {
    logger.warn(
      `File terlalu besar (${(attachment.size / 1024 / 1024).toFixed(1)} MB > 50 MB), pakai URL`,
      attachment.name
    );
    return null;
  }

  try {
    const res = await axios.get(attachment.url, {
      responseType:      'arraybuffer',
      timeout:           DOWNLOAD_TIMEOUT,
      maxContentLength:  MAX_FILE_BYTES,
      headers:           { 'User-Agent': 'TelegramBotMirror/2.0' },
    });

    return {
      buffer:      Buffer.from(res.data),
      filename:    attachment.name || 'file',
      contentType: res.headers['content-type'] || getMimeType(attachment.name),
    };
  } catch (err) {
    if (attempt < 3) {
      const wait = 1000 * attempt;
      logger.warn(`Download retry ${attempt}/3 dalam ${wait}ms`, err.message?.substring(0, 50));
      await sleep(wait);
      return downloadAttachment(attachment, attempt + 1);
    }
    logger.warn(`Download attachment gagal total (3/3), akan pakai URL`, err.message?.substring(0, 60));
    return null;
  }
}

/**
 * Trim caption agar tidak melebihi batas Telegram.
 */
function safeCaption(text) {
  if (!text) return '';
  if (text.length <= MAX_CAPTION_LEN) return text;
  return text.substring(0, MAX_CAPTION_LEN - 3) + '...';
}

/**
 * Kirim satu attachment ke Telegram dengan fallback chain lengkap.
 * Chain: Buffer(typed) → Buffer(document) → URL(typed) → URL(document) → text link
 */
async function sendAttachment(tgBot, chatId, attachment, caption, extraOpts = {}) {
  const mediaType = getMediaType(attachment);
  const capText   = safeCaption(caption || '');

  // Ekstrak _discordChannelId (internal flag) agar tidak dikirim ke Telegram API
  const { _discordChannelId, ...tgExtraOpts } = extraOpts;

  const mdOpts    = { caption: capText, parse_mode: 'MarkdownV2', ...tgExtraOpts };
  const plainOpts = { caption: capText.replace(/\\([_*[\]()~`>#+=|{}.!\\-])/g, '$1'), ...tgExtraOpts };
  const noCapOpts = { ...tgExtraOpts };

  // ─── Helper inner: kirim link teks (last resort) ──────────────────────────
  async function tryTextLink() {
    const url = attachment.url;
    const name = attachment.name || 'file';
    const text = `📎 <b>Media:</b> <a href="${url}">${name}</a>`;
    logger.warn(`Kirim media sebagai text link (last resort)`, name);
    return await tgBot.sendMessage(chatId, text, { parse_mode: 'HTML', ...noCapOpts });
  }

  // Jika file > 50 MB, coba kirim menggunakan Userbot (GramJS) jika tersedia
  const isLargeFile = attachment.size && attachment.size > MAX_FILE_BYTES;
  if (isLargeFile) {
    const tgToDiscordHandler = require('./tgToDiscordHandler');
    const userbot = tgToDiscordHandler.getActiveUserbot ? tgToDiscordHandler.getActiveUserbot() : null;
    
    if (userbot) {
      try {
        const downloadsDir = path.join(__dirname, '..', 'public', 'downloads');
        if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
        
        const ext = attachment.name ? attachment.name.split('.').pop().toLowerCase() : 'bin';
        const safeName = `dc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
        const tempFilePath = path.join(downloadsDir, safeName);
        
        logger.info(`DC→TG: Mendownload file besar (${(attachment.size / 1024 / 1024).toFixed(1)} MB) ke disk...`);
        await downloadFileToDisk(attachment.url, tempFilePath);
        
        logger.info(`DC→TG: Mengirim file besar via Userbot...`, attachment.name);
        const sendParams = {
          file: tempFilePath,
          caption: capText,
        };
        if (tgExtraOpts.reply_to_message_id) {
          sendParams.replyTo = Number(tgExtraOpts.reply_to_message_id);
        } else if (tgExtraOpts.message_thread_id) {
          sendParams.replyTo = Number(tgExtraOpts.message_thread_id);
        }
        
        const sentMsg = await userbot.sendFile(chatId, sendParams);
        
        try { fs.unlinkSync(tempFilePath); } catch {}
        
        if (sentMsg) {
          logger.success(`DC→TG: Berhasil mengirim file besar via Userbot! msgId: ${sentMsg.id}`);
          return { message_id: sentMsg.id };
        }
      } catch (err) {
        logger.error(`DC→TG: Gagal mengirim file besar via Userbot`, err.message);
      }
    }
    
    // Fallback jika tidak ada userbot atau gagal
    return await tryTextLink();
  }

  // ─── Helper inner: kirim via buffer ───────────────────────────────────────
  async function tryBuffer(dl) {
    const buf      = dl.buffer;
    const fileOpts = { filename: dl.filename, contentType: dl.contentType };
    const sizeKB   = (buf.length / 1024).toFixed(0);
    logger.info(`Upload buffer ${sizeKB} KB (${mediaType})`, dl.filename);

    // Coba dengan MarkdownV2 caption dulu, fallback ke plain
    const sendWithCaption = async (sendFn) => {
      try { return await sendFn(mdOpts, fileOpts); }
      catch { return await sendFn(plainOpts, fileOpts); }
    };

    switch (mediaType) {
      case 'photo':
        try { return await sendWithCaption((o, f) => tgBot.sendPhoto(chatId, buf, o, f)); }
        catch { return await sendWithCaption((o, f) => tgBot.sendDocument(chatId, buf, o, f)); }

      case 'video':
        try { return await sendWithCaption((o, f) => tgBot.sendVideo(chatId, buf, o, f)); }
        catch { return await sendWithCaption((o, f) => tgBot.sendDocument(chatId, buf, o, f)); }

      case 'audio':
        try { return await sendWithCaption((o, f) => tgBot.sendAudio(chatId, buf, o, f)); }
        catch { return await sendWithCaption((o, f) => tgBot.sendDocument(chatId, buf, o, f)); }

      default:
        return await sendWithCaption((o, f) => tgBot.sendDocument(chatId, buf, o, f));
    }
  }

  // ─── Helper inner: kirim via URL ──────────────────────────────────────────
  async function tryUrl() {
    const url = attachment.url;
    logger.info(`Kirim media via URL (fallback)`, url?.substring(0, 60));

    const sendWithCaption = async (sendFn) => {
      try { return await sendFn(mdOpts); }
      catch { return await sendFn(plainOpts); }
    };

    switch (mediaType) {
      case 'photo':
        try { return await sendWithCaption(o => tgBot.sendPhoto(chatId, url, o)); }
        catch { return await sendWithCaption(o => tgBot.sendDocument(chatId, url, o)); }

      case 'video':
        try { return await sendWithCaption(o => tgBot.sendVideo(chatId, url, o)); }
        catch { return await sendWithCaption(o => tgBot.sendDocument(chatId, url, o)); }

      case 'audio':
        try { return await sendWithCaption(o => tgBot.sendAudio(chatId, url, o)); }
        catch { return await sendWithCaption(o => tgBot.sendDocument(chatId, url, o)); }

      default:
        return await sendWithCaption(o => tgBot.sendDocument(chatId, url, o));
    }
  }

  // ─── Main chain ──────────────────────────────────────────────────────────
  // 1. Coba download → buffer
  const dl = await downloadAttachment(attachment);
  if (dl) {
    // Terapkan crop terlebih dahulu (jika aktif untuk channel ini)
    dl.buffer = await cropManager.applyCrop(dl.buffer, mediaType, extraOpts._discordChannelId || '');
    // Terapkan per-channel blur (Smart Blur)
    dl.buffer = await blurManager.applyBlur(dl.buffer, extraOpts._discordChannelId || '');
    // Lalu terapkan watermark global (hanya jika gambar dan fitur aktif)
    dl.buffer = await watermarkManager.applyWatermark(dl.buffer, mediaType, extraOpts._discordChannelId || '');

    try { return await tryBuffer(dl); }
    catch (err) {
      logger.warn(`Buffer upload gagal (${err.message?.substring(0, 50)}), coba URL...`);
    }
  }

  // 2. Coba via URL
  try { return await tryUrl(); }
  catch (err) {
    logger.warn(`URL upload gagal (${err.message?.substring(0, 50)}), coba text link...`);
  }

  // 3. Last resort: kirim link teks
  try { return await tryTextLink(); }
  catch (err) {
    logger.error(`Gagal kirim media & link (${mediaType})`, err.message);
    stats.recordFailed();
    return null;
  }
}

/**
 * Kirim semua attachment dari satu pesan Discord ke Telegram.
 * @param {string} [discordChannelId] - Discord Channel ID untuk lookup crop config
 * @returns {number|null} message_id TG dari attachment pertama
 */
async function forwardMedia(tgBot, chatId, discordMessage, headerText, rateLimiter, replyToMsgId = null, threadId = null, discordChannelId = '') {
  const attachments = [...discordMessage.attachments.values()];
  if (attachments.length === 0) return null;

  let firstMsgId = null;

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const caption    = i === 0 ? (headerText || '').substring(0, MAX_CAPTION_LEN) : '';
    const sendOpts   = { _discordChannelId: discordChannelId };
    if (i === 0 && replyToMsgId) sendOpts.reply_to_message_id = replyToMsgId;
    if (threadId) sendOpts.message_thread_id = threadId;

    try {
      const sent = await rateLimiter.add(() =>
        sendAttachment(tgBot, chatId, attachment, caption, sendOpts)
      );

      if (sent) {
        if (i === 0) firstMsgId = sent.message_id;
        stats.recordMedia();
      }
    } catch (err) {
      logger.error(`Media upload gagal untuk ${attachment.name || 'file'}`, err.message?.substring(0, 80));
      // Jangan melempar (throw) error ke atas, agar pesan teks yang sudah terkirim tidak diulang oleh DLQ
    }
  }

  return firstMsgId;
}

/**
 * Memproses media (download, crop & watermark) khusus untuk dikirim via Discord Webhook.
 * @param {object} attachment
 * @param {string} [discordChannelId] - Discord Channel ID untuk lookup crop config
 * @returns {Promise<{attachment: Buffer, name: string} | string>}
 */
async function processDiscordMedia(attachment, discordChannelId = '') {
  const mediaType = getMediaType(attachment);

  // Jika file > 25 MB, coba simpan ke folder downloads lokal dan kembalikan URL publik jika ada
  const isLargeFile = attachment.size && attachment.size > 25 * 1024 * 1024;
  if (isLargeFile) {
    const tgToDiscordHandler = require('./tgToDiscordHandler');
    const publicUrl = tgToDiscordHandler.getPublicUrl ? tgToDiscordHandler.getPublicUrl() : null;
    
    if (publicUrl) {
      try {
        const downloadsDir = path.join(__dirname, '..', 'public', 'downloads');
        if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
        
        const ext = attachment.name ? attachment.name.split('.').pop().toLowerCase() : 'bin';
        const safeName = `dc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
        const filePath = path.join(downloadsDir, safeName);
        
        logger.info(`DC→DC: Mendownload file besar (${(attachment.size / 1024 / 1024).toFixed(1)} MB) langsung ke disk...`);
        await downloadFileToDisk(attachment.url, filePath);
        
        if (fs.existsSync(filePath)) {
          const fileUrl = `${publicUrl}/downloads/${safeName}`;
          return `📎 **[Video/File Besar: ${attachment.name || 'file'} (${(attachment.size / 1024 / 1024).toFixed(1)} MB)]**\n${fileUrl}`;
        }
      } catch (err) {
        logger.error('DC→DC: Gagal memproses file besar via static URL', err.message);
      }
    }
  }

  const dl = await downloadAttachment(attachment);
  if (dl) {
    // Terapkan crop dulu, per-channel blur, lalu watermark
    dl.buffer = await cropManager.applyCrop(dl.buffer, mediaType, discordChannelId);
    dl.buffer = await blurManager.applyBlur(dl.buffer, discordChannelId);
    dl.buffer = await watermarkManager.applyWatermark(dl.buffer, mediaType, discordChannelId);
    
    // Cegah error payload/entity too large di Discord Webhook (limit 25 MB)
    if (dl.buffer.length > 25 * 1024 * 1024) {
      logger.warn(`Media hasil proses terlalu besar untuk Discord Webhook (${(dl.buffer.length / 1024 / 1024).toFixed(1)} MB > 25 MB), pakai URL fallback`, dl.filename);
      
      const tgToDiscordHandler = require('./tgToDiscordHandler');
      const publicUrl = tgToDiscordHandler.getPublicUrl ? tgToDiscordHandler.getPublicUrl() : null;
      if (publicUrl) {
        try {
          const downloadsDir = path.join(__dirname, '..', 'public', 'downloads');
          if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
          
          const ext = dl.filename.split('.').pop().toLowerCase();
          const safeName = `dc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
          const filePath = path.join(downloadsDir, safeName);
          
          fs.writeFileSync(filePath, dl.buffer);
          
          const fileUrl = `${publicUrl}/downloads/${safeName}`;
          return `📎 **[Video/File Besar: ${dl.filename} (${(dl.buffer.length / 1024 / 1024).toFixed(1)} MB)]**\n${fileUrl}`;
        } catch (err) {
          logger.error('DC→DC: Gagal memproses buffer besar via static URL', err.message);
        }
      }
      
      return attachment.url;
    }
    
    return { attachment: dl.buffer, name: dl.filename };
  }
  // Fallback url jika gagal download
  return attachment.url;
}

module.exports = { forwardMedia, getMediaType, processDiscordMedia };
