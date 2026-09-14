// ============================================================
//   UTILS / WEBSERVER.JS  v5 — PowerBlur Edition
//   Express server: Dashboard UI, REST API, SSE Activity Log
// ============================================================
'use strict';
const fs = require('fs');

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const os      = require('os');
const multer  = require('multer');

const logger            = require('./logger');
const stats             = require('./stats');
const messageStore      = require('./messageStore');
const blockedUsersStore = require('./blockedUsersStore');
const mutedChannels     = require('./mutedChannels');
const channelStore      = require('./channelStore');
const envManager        = require('./envManager');
const watermarkManager  = require('./watermarkManager');
const cropManager       = require('./cropManager');
const blurManager       = require('./blurManager');
const wordFilterManager = require('./wordFilterManager');

// ─── Multer: Watermark upload ─────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(__dirname, '..', 'data')),
  filename:    (_, __, cb) => cb(null, 'watermark.png'),
});
const upload = multer({
  storage,
  fileFilter: (_, file, cb) => {
    if (['image/png','image/jpeg'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG or JPG allowed'));
  },
});

// ─── Multer: Source template upload (for Template Matching) ───
const sourceTemplateStorage = multer.diskStorage({
  destination: (_, __, cb) => {
    const dir = path.join(__dirname, '..', 'data', 'source-templates');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_, file, cb) => {
    const ext  = path.extname(file.originalname) || '.png';
    const name = `tpl_${Date.now()}${ext}`;
    cb(null, name);
  },
});
const uploadTemplate = multer({
  storage: sourceTemplateStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (['image/png','image/jpeg','image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPG, or WEBP allowed'));
  },
});

// ─── SSE Clients ─────────────────────────────────────────────
const sseClients = new Set();
const eventBuffer = [];   // Rolling buffer (max 300) for polling fallback
const MAX_BUFFER  = 300;

/**
 * Push an activity event to all SSE clients + buffer.
 * type: 'success' | 'error' | 'media' | 'info' | 'warning'
 */
function pushEvent(type, message) {
  const evt = {
    type,
    message,
    time: new Date().toLocaleTimeString('id-ID', { hour12: false }),
    ts:   Date.now(),
  };
  eventBuffer.push(evt);
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift();

  const data = `data: ${JSON.stringify(evt)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(data); } catch { sseClients.delete(res); }
  });
}

// ─── Main ────────────────────────────────────────────────────
function startWebServer(tgManager, channelMap, port = 3000, tg2dcStore = null) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Serve avatar profil Telegram yang di-download oleh TG→DC userbot
  const avatarDir = path.join(__dirname, '..', 'data', 'avatars');
  if (!require('fs').existsSync(avatarDir)) require('fs').mkdirSync(avatarDir, { recursive: true });
  app.use('/avatars', express.static(avatarDir));

  // Serve downloads
  const downloadsDir = path.join(__dirname, '..', 'public', 'downloads');
  if (!require('fs').existsSync(downloadsDir)) require('fs').mkdirSync(downloadsDir, { recursive: true });
  app.use('/downloads', express.static(downloadsDir));

  // Cleanup task for public/downloads files older than 24 hours
  setInterval(() => {
    if (fs.existsSync(downloadsDir)) {
      fs.readdir(downloadsDir, (err, files) => {
        if (err) return;
        const now = Date.now();
        const cutoff = 24 * 60 * 60 * 1000; // 24 hours
        for (const file of files) {
          const filePath = path.join(downloadsDir, file);
          fs.stat(filePath, (err, stats) => {
            if (err) return;
            if (now - stats.mtimeMs > cutoff) {
              fs.unlink(filePath, (err) => {
                if (err) logger.warn(`Gagal hapus file download expired: ${file}`, err.message);
              });
            }
          });
        }
      });
    }
  }, 60 * 60 * 1000); // Check every hour

  // ── Dashboard Authentication Middleware ────────────────────
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || process.env.ADMIN_PASSWORD || '';

  // Endpoint cek status auth
  app.get('/api/auth/status', (req, res) => {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
                  req.headers['x-dashboard-key'] ||
                  req.query.key;
    const isAuthenticated = !DASHBOARD_PASSWORD || (token === DASHBOARD_PASSWORD);
    res.json({
      authRequired: Boolean(DASHBOARD_PASSWORD),
      authenticated: isAuthenticated
    });
  });

  // Endpoint login verifikasi password
  app.post('/api/auth/login', (req, res) => {
    const { password } = req.body || {};
    if (!DASHBOARD_PASSWORD) {
      return res.json({ success: true, message: 'No password configured' });
    }
    if (password === DASHBOARD_PASSWORD) {
      return res.json({ success: true, token: DASHBOARD_PASSWORD });
    }
    return res.status(401).json({ success: false, error: 'Password dashboard salah!' });
  });

  // Middleware wajib login jika DASHBOARD_PASSWORD diset
  const requireAuth = (req, res, next) => {
    if (!DASHBOARD_PASSWORD) return next();

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') ||
                  req.headers['x-dashboard-key'] ||
                  req.query.key;

    if (token === DASHBOARD_PASSWORD) {
      return next();
    }

    return res.status(401).json({
      error: 'Unauthorized: Akses dashboard dilindungi password',
      authRequired: true
    });
  };

  // Lindungi semua rute /api kecuali endpoint auth
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    return requireAuth(req, res, next);
  });

  // ── Status & Stats ──────────────────────────────────────────
  app.get('/api/status', (req, res) => {
    const s   = stats.getSummary();
    const mem = process.memoryUsage();
    const toMB = b => parseFloat((b / 1024 / 1024).toFixed(2));
    res.json({
      status: 'ok',
      uptime: s.uptime,
      stats: { forwarded: s.totalForwarded, edits: s.totalEdits, media: s.totalMedia, failed: s.totalFailed },
      system: { heapUsedMB: toMB(mem.heapUsed), freeRamMB: Math.round(os.freemem() / 1024 / 1024), cpuLoad1m: os.loadavg()[0].toFixed(2) },
      bot:    { telegramBots: tgManager.size, activeChannels: channelMap.size, mutedChannels: mutedChannels.size, blockedUsers: blockedUsersStore.size, storedMessages: messageStore.size },
    });
  });

  // ── Channels CRUD ───────────────────────────────────────────
  app.get('/api/channels', (_, res) => res.json(channelStore.list()));

  // ── TG→DC Channels CRUD ──────────────────────────────────────────────
  app.get('/api/tg2dc', (_, res) => {
    if (!tg2dcStore) return res.json([]);
    res.json(tg2dcStore.list());
  });

  app.post('/api/tg2dc', (req, res) => {
    if (!tg2dcStore) return res.status(503).json({ error: 'TG→DC store tidak aktif' });
    const { name, tgChatId, tgThreadId, botKey, dcWebhookUrl } = req.body;
    if (!tgChatId) return res.status(400).json({ error: 'tgChatId wajib diisi' });
    if (!dcWebhookUrl) return res.status(400).json({ error: 'dcWebhookUrl wajib diisi' });
    const ch = tg2dcStore.add({ name, tgChatId, tgThreadId, botKey, dcWebhookUrl });
    if (!ch) return res.status(500).json({ error: 'Gagal menambah mapping' });
    pushEvent('info', `TG→DC mapping <b>${ch.name}</b> ditambahkan`);
    res.json({ success: true, channel: ch });
  });

  app.put('/api/tg2dc/:idx', (req, res) => {
    if (!tg2dcStore) return res.status(503).json({ error: 'TG→DC store tidak aktif' });
    const { name, tgChatId, tgThreadId, botKey, dcWebhookUrl } = req.body;
    // Hapus lama via index lalu tambah baru
    const idx = parseInt(req.params.idx);
    const list = tg2dcStore.list();
    if (idx < 0 || idx >= list.length) return res.status(404).json({ error: 'Index tidak valid' });
    tg2dcStore.removeByIndex(idx);
    const ch = tg2dcStore.add({ name, tgChatId, tgThreadId, botKey, dcWebhookUrl });
    pushEvent('info', `TG→DC mapping <b>${ch?.name}</b> diperbarui`);
    res.json({ success: true, channel: ch });
  });

  app.delete('/api/tg2dc/:idx', (req, res) => {
    if (!tg2dcStore) return res.status(503).json({ error: 'TG→DC store tidak aktif' });
    const idx = parseInt(req.params.idx);
    const ok  = tg2dcStore.removeByIndex(idx);
    if (ok) { pushEvent('warning', `TG→DC mapping #${idx} dihapus`); res.json({ success: true }); }
    else res.status(404).json({ error: 'Index tidak valid' });
  });

  app.post('/api/tg2dc/:idx/test', async (req, res) => {
    if (!tg2dcStore) return res.status(503).json({ error: 'TG→DC store tidak aktif' });
    const idx = parseInt(req.params.idx);
    const list = tg2dcStore.list();
    if (idx < 0 || idx >= list.length) return res.status(404).json({ error: 'Index tidak valid' });
    const ch = list[idx];
    const axios = require('axios');
    const testPayload = {
      username: 'Test TG→DC Mirror',
      content:  `🧪 **TEST MIRROR TG→DC**\n\n📌 Channel: **${ch.name}**\n✅ Jika Anda melihat ini, mirror TG→DC aktif!`,
    };
    try {
      await axios.post(ch.dcWebhookUrl, testPayload, { timeout: 10000 });
      pushEvent('success', `TG→DC test OK → <b>${ch.name}</b>`);
      res.json({ success: true });
    } catch (err) {
      pushEvent('error', `TG→DC test gagal untuk <b>${ch.name}</b>: ${err.message?.substring(0,60)}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/channels', (req, res) => {
    const { name, discordId, tgChatId, botKey, threadId, dcWebhookUrl, dcThreadId, dcCustomUsername, dcCustomAvatarUrl, dcAutoPing, dcOnlyWithMedia, dcStripInvites } = req.body;
    if (!discordId)
      return res.status(400).json({ error: 'Discord ID is required' });
    if (!tgChatId && !dcWebhookUrl)
      return res.status(400).json({ error: 'Must provide either Telegram Chat ID or Discord Webhook URL' });
    
    if (channelStore.find(discordId))
      return res.status(400).json({ error: 'Discord ID is already mapped' });

    const ch = channelStore.add({ 
      name, discordId, tgChatId: tgChatId || '', botKey: botKey || '1', threadId, dcWebhookUrl,
      dcThreadId, dcCustomUsername, dcCustomAvatarUrl, dcAutoPing, dcOnlyWithMedia, dcStripInvites 
    });
    pushEvent('info', `Channel <b>${ch.name}</b> added via dashboard`);
    res.json({ success: true, channel: ch });
  });

  app.put('/api/channels/:id', (req, res) => {
    const oldId = req.params.id;
    const { name, discordId, tgChatId, botKey, threadId, dcWebhookUrl, dcThreadId, dcCustomUsername, dcCustomAvatarUrl, dcAutoPing, dcOnlyWithMedia, dcStripInvites } = req.body;
    
    if (!discordId)
      return res.status(400).json({ error: 'Discord ID is required' });
    if (!tgChatId && !dcWebhookUrl)
      return res.status(400).json({ error: 'Must provide either Telegram Chat ID or Discord Webhook URL' });
    
    if (oldId !== discordId && channelStore.find(discordId)) {
      return res.status(400).json({ error: 'New Discord ID is already mapped' });
    }

    if (oldId !== discordId) {
      channelStore.remove(oldId);
    }
    
    const ch = channelStore.add({ 
      name, discordId, tgChatId: tgChatId || '', botKey: botKey || '1', threadId, dcWebhookUrl,
      dcThreadId, dcCustomUsername, dcCustomAvatarUrl, dcAutoPing, dcOnlyWithMedia, dcStripInvites 
    });
    pushEvent('info', `Channel <b>${ch.name}</b> updated via dashboard`);
    res.json({ success: true, channel: ch });
  });

  app.delete('/api/channels/:id', (req, res) => {
    const ok = channelStore.remove(req.params.id);
    if (ok) { pushEvent('warning', `Channel mapping <b>${req.params.id}</b> deleted`); res.json({ success: true }); }
    else res.status(404).json({ error: 'Channel not found' });
  });

  // ── Test Message ────────────────────────────────────────────
  app.post('/api/channels/:id/test', async (req, res) => {
    const ch = channelStore.find(req.params.id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });

    const bot = tgManager.get(String(ch.botKey));
    if (!bot) return res.status(400).json({ error: `Bot #${ch.botKey} not loaded` });

    const text = req.body.message?.trim() || '🧪 <b>Test dari Nexus Mirror Bot!</b>\nKoneksi berhasil ✅';
    const opts = { parse_mode: 'HTML' };
    if (ch.threadId) opts.message_thread_id = parseInt(ch.threadId);

    try {
      await bot.sendMessage(ch.tgChatId, text, opts);
      pushEvent('success', `Test message sent → <b>${ch.name}</b> (TG: ${ch.tgChatId})`);
      res.json({ success: true });
    } catch (err) {
      pushEvent('error', `Test failed for <b>${ch.name}</b>: ${err.message?.substring(0,60)}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Mute / Unmute ────────────────────────────────────────────
  app.get('/api/mute', (_, res) => res.json(mutedChannels.list()));

  app.post('/api/mute/:id/mute', (req, res) => {
    mutedChannels.mute(req.params.id);
    const ch = channelStore.find(req.params.id);
    pushEvent('warning', `Channel <b>${ch?.name || req.params.id}</b> muted via dashboard`);
    res.json({ success: true });
  });

  app.post('/api/mute/:id/unmute', (req, res) => {
    mutedChannels.unmute(req.params.id);
    const ch = channelStore.find(req.params.id);
    pushEvent('success', `Channel <b>${ch?.name || req.params.id}</b> unmuted via dashboard`);
    res.json({ success: true });
  });

  // ── Config / Env ────────────────────────────────────────────
  app.get('/api/config', (_, res) => res.json(envManager.getConfig()));

  app.post('/api/config', (req, res) => {
    const { 
      discordTokens, telegramBots, watermark, adminId, adminBotKey,
      blockedUserIds, forwardBotMessages, forwardEdits,
      showChannelName, showServerName, showAuthorName,
      blacklistWords, whitelistWords, maxMessageLength,
      rateLimitDelay, healthPort, forwardReactions,
      tgApiId, tgApiHash, tgUserSession,
      dcReplyQuote, dcStripInvites, dcOnlyWithMedia,
      dcCustomName, dcCustomAvatar, dcAutoPing
    } = req.body;
    
    const updates = {};
    if (discordTokens !== undefined)
      updates['DISCORD_TOKENS'] = Array.isArray(discordTokens) ? discordTokens.join(',') : discordTokens;
    if (Array.isArray(telegramBots)) {
      telegramBots.forEach(b => { updates[`TELEGRAM_BOT_${b.id}`] = b.token; });
    }
    
    if (tgApiId !== undefined) updates['TG_API_ID'] = tgApiId;
    if (tgApiHash !== undefined) updates['TG_API_HASH'] = tgApiHash;
    if (tgUserSession !== undefined) updates['TG_USER_SESSIONS'] = tgUserSession;

    if (dcReplyQuote !== undefined) updates['DC_TO_DC_REPLY_QUOTE'] = dcReplyQuote ? 'true' : 'false';
    if (dcStripInvites !== undefined) updates['DC_TO_DC_STRIP_INVITES'] = dcStripInvites ? 'true' : 'false';
    if (dcOnlyWithMedia !== undefined) updates['DC_TO_DC_ONLY_WITH_MEDIA'] = dcOnlyWithMedia ? 'true' : 'false';
    if (dcCustomName !== undefined) updates['DC_TO_DC_CUSTOM_NAME'] = dcCustomName;
    if (dcCustomAvatar !== undefined) updates['DC_TO_DC_CUSTOM_AVATAR'] = dcCustomAvatar;
    if (dcAutoPing !== undefined) updates['DC_TO_DC_AUTO_PING'] = dcAutoPing;

    if (watermark !== undefined) updates['WATERMARK'] = watermark;
    if (adminId !== undefined) updates['ADMIN_TELEGRAM_ID'] = adminId;
    if (adminBotKey !== undefined) updates['ADMIN_BOT_KEY'] = adminBotKey;
    if (blockedUserIds !== undefined) updates['BLOCKED_USER_IDS'] = blockedUserIds;
    
    if (forwardBotMessages !== undefined) updates['FORWARD_BOT_MESSAGES'] = forwardBotMessages ? 'true' : 'false';
    if (forwardEdits !== undefined) updates['FORWARD_EDITS'] = forwardEdits ? 'true' : 'false';
    if (showChannelName !== undefined) updates['SHOW_CHANNEL_NAME'] = showChannelName ? 'true' : 'false';
    if (showServerName !== undefined) updates['SHOW_SERVER_NAME'] = showServerName ? 'true' : 'false';
    if (showAuthorName !== undefined) updates['SHOW_AUTHOR_NAME'] = showAuthorName ? 'true' : 'false';
    if (forwardReactions !== undefined) updates['FORWARD_REACTIONS'] = forwardReactions ? 'true' : 'false';
    
    if (blacklistWords !== undefined) updates['BLACKLIST_WORDS'] = blacklistWords;
    if (whitelistWords !== undefined) updates['WHITELIST_WORDS'] = whitelistWords;
    
    if (maxMessageLength !== undefined) updates['MAX_MESSAGE_LENGTH'] = maxMessageLength;
    if (rateLimitDelay !== undefined) updates['RATE_LIMIT_DELAY'] = rateLimitDelay;
    if (healthPort !== undefined) updates['HEALTH_PORT'] = healthPort;

    updates._deleteMissingTelegramBots = true;
    envManager.updateEnv(updates);
    pushEvent('info', 'Configuration updated via dashboard — restart required');
    res.json({ success: true, message: 'Config updated. Please restart the bot.' });
  });

  // ── Watermark ────────────────────────────────────────────────
  app.get('/api/watermark', (_, res) => res.json(watermarkManager.getSettings()));

  app.get('/api/watermark/image', (_, res) => {
    const wmPath = path.join(__dirname, '..', 'data', 'watermark.png');
    res.sendFile(wmPath);
  });

  app.post('/api/watermark', upload.single('watermarkImage'), (req, res) => {
    try {
      const { enabled, position, sizePercent, opacity, customPosition, blurBoxes } = req.body;
      const upd = {};
      if (enabled    !== undefined) upd.enabled    = enabled === 'true' || enabled === true;
      if (position   !== undefined) upd.position   = position;
      if (sizePercent!== undefined) upd.sizePercent= parseInt(sizePercent);
      if (opacity    !== undefined) upd.opacity    = parseFloat(opacity);
      if (customPosition !== undefined) upd.customPosition = typeof customPosition === 'string' ? JSON.parse(customPosition) : customPosition;
      if (blurBoxes !== undefined) upd.blurBoxes = typeof blurBoxes === 'string' ? JSON.parse(blurBoxes) : blurBoxes;
      
      watermarkManager.saveSettings(upd);
      res.json({ success: true, settings: watermarkManager.getSettings() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Crop Settings per Discord Channel ─────────────────────────────

  // GET semua crop config
  app.get('/api/crop', (_, res) => res.json(cropManager.getAll()));

  // GET crop config untuk satu channel
  app.get('/api/crop/:channelId', (req, res) => {
    const cfg = cropManager.getChannel(req.params.channelId);
    if (!cfg) return res.status(404).json({ error: 'No crop config for this channel' });
    res.json(cfg);
  });

  // POST / PUT - Simpan atau update crop config untuk satu channel
  app.post('/api/crop/:channelId', (req, res) => {
    const { enabled, x, y, w, h } = req.body;
    if (w === undefined || h === undefined)
      return res.status(400).json({ error: 'w (width%) and h (height%) are required' });
    const ok = cropManager.setChannel(req.params.channelId, { enabled, x, y, w, h });
    if (ok) {
      const ch = channelStore.find(req.params.channelId);
      pushEvent('info', `Crop config saved for channel <b>${ch?.name || req.params.channelId}</b>`);
      res.json({ success: true, config: cropManager.getChannel(req.params.channelId) });
    } else res.status(500).json({ error: 'Failed to save crop config' });
  });

  // PATCH - Toggle enabled saja
  app.patch('/api/crop/:channelId/toggle', (req, res) => {
    const { enabled } = req.body;
    const ok = cropManager.toggleChannel(req.params.channelId, enabled);
    if (ok) res.json({ success: true });
    else res.status(404).json({ error: 'No crop config for this channel' });
  });

  // DELETE - Hapus crop config channel
  app.delete('/api/crop/:channelId', (req, res) => {
    const ok = cropManager.removeChannel(req.params.channelId);
    if (ok) {
      pushEvent('warning', `Crop config deleted for channel <b>${req.params.channelId}</b>`);
      res.json({ success: true });
    } else res.status(404).json({ error: 'Channel crop config not found' });
  });

  // ── Blur Settings per Discord Channel ─────────────────────────────

  // GET semua blur config
  app.get('/api/blur', (_, res) => res.json(blurManager.getAll()));

  // GET blur config untuk satu channel
  app.get('/api/blur/:channelId', (req, res) => {
    const cfg = blurManager.getChannel(req.params.channelId);
    if (!cfg) return res.status(404).json({ error: 'No blur config for this channel' });
    res.json(cfg);
  });

  // POST / PUT - Simpan atau update blur config untuk satu channel
  app.post('/api/blur/:channelId', (req, res) => {
    const { enabled, templates } = req.body;
    const ok = blurManager.setChannel(req.params.channelId, { enabled, templates });
    if (ok) {
      const ch = channelStore.find(req.params.channelId);
      pushEvent('info', `Blur config saved for channel <b>${ch?.name || req.params.channelId}</b>`);
      res.json({ success: true, config: blurManager.getChannel(req.params.channelId) });
    } else res.status(500).json({ error: 'Failed to save blur config' });
  });

  // DELETE - Hapus blur config channel
  app.delete('/api/blur/:channelId', (req, res) => {
    const ok = blurManager.removeChannel(req.params.channelId);
    if (ok) {
      pushEvent('warning', `Blur config deleted for channel <b>${req.params.channelId}</b>`);
      res.json({ success: true });
    } else res.status(404).json({ error: 'Channel blur config not found' });
  });

  // ── OCR Settings ────────────────────────────────────────────
  app.get('/api/blur/settings/ocr', (_, res) => {
    res.json(blurManager.getOcrSettings());
  });

  app.post('/api/blur/settings/ocr', (req, res) => {
    const { enabled, keywords, blurPadding, action } = req.body;
    const update = {};
    if (enabled      !== undefined) update.enabled      = !!enabled;
    if (keywords     !== undefined) update.keywords      = Array.isArray(keywords) ? keywords : String(keywords).split('\n').map(s=>s.trim()).filter(Boolean);
    if (blurPadding  !== undefined) update.blurPadding   = parseInt(blurPadding) || 20;
    if (action       !== undefined) update.action        = action;
    if (update.enabled !== undefined) {
      process.env.ENABLE_AI_WATERMARK = update.enabled ? 'true' : 'false';
    }
    const ok = blurManager.setOcrSettings(update);
    if (ok) {
      pushEvent('info', `AI OCR settings updated (enabled: ${update.enabled !== undefined ? update.enabled : blurManager.getOcrSettings().enabled})`);
      res.json({ success: true, settings: blurManager.getOcrSettings() });
    } else res.status(500).json({ error: 'Failed to save OCR settings' });
  });

  // ── Template Matching Settings ───────────────────────────────
  app.get('/api/blur/settings/match', (_, res) => {
    res.json(blurManager.getMatchSettings());
  });

  app.post('/api/blur/settings/match', (req, res) => {
    const { enabled, threshold, blurStrength, action } = req.body;
    const update = {};
    if (enabled      !== undefined) update.enabled      = !!enabled;
    if (threshold    !== undefined) update.threshold    = parseFloat(threshold);
    if (blurStrength !== undefined) update.blurStrength = parseInt(blurStrength) || 50;
    if (action       !== undefined) update.action       = action;
    const ok = blurManager.setMatchSettings(update);
    if (ok) {
      pushEvent('info', `Template Matching settings updated`);
      res.json({ success: true, settings: blurManager.getMatchSettings() });
    } else res.status(500).json({ error: 'Failed to save template matching settings' });
  });

  // ── Source Template Files (for Template Matching) ────────────
  app.get('/api/blur/templates/source', (_, res) => {
    res.json(blurManager.listSourceTemplates().map(t => t.name));
  });

  app.get('/api/blur/templates/source/:filename', (req, res) => {
    const filePath = path.join(__dirname, '..', 'data', 'source-templates', req.params.filename);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).json({ error: 'File not found' });
  });

  app.post('/api/blur/templates/source', uploadTemplate.single('templateImage'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    pushEvent('info', `Source template uploaded: <b>${req.file.filename}</b>`);
    res.json({ success: true, filename: req.file.filename });
  });

  app.delete('/api/blur/templates/source/:filename', (req, res) => {
    const ok = blurManager.deleteSourceTemplate(req.params.filename);
    if (ok) {
      pushEvent('warning', `Source template deleted: <b>${req.params.filename}</b>`);
      res.json({ success: true });
    } else res.status(404).json({ error: 'File not found' });
  });

  // ── SSE — Live Activity Stream ────────────────────────────────
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(': connected\n\n');

    // Send last 50 buffered events on connect
    const recent = eventBuffer.slice(-50);
    recent.forEach(evt => res.write(`data: ${JSON.stringify(evt)}\n\n`));

    sseClients.add(res);
    const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(keepalive); } }, 25000);
    req.on('close', () => { clearInterval(keepalive); sseClients.delete(res); });
  });

  // ── SSE Polling Fallback ──────────────────────────────────────
  app.get('/api/events/poll', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const events = eventBuffer.filter(e => e.ts > since);
    res.json({ events });
  });

  // ── Word Filter ─────────────────────────────────────────────

  // GET settings & kata terlarang
  app.get('/api/wordfilter', (_, res) => res.json(wordFilterManager.getSettings()));

  // POST update settings (enabled, logFiltered)
  app.post('/api/wordfilter/settings', (req, res) => {
    const ok = wordFilterManager.updateSettings(req.body);
    if (ok) {
      pushEvent('info', `Word filter ${req.body.enabled ? 'diaktifkan' : 'dinonaktifkan'} via dashboard`);
      res.json({ success: true, settings: wordFilterManager.getSettings() });
    } else res.status(500).json({ error: 'Gagal simpan settings' });
  });

  // POST tambah satu kata
  app.post('/api/wordfilter/words', (req, res) => {
    const { word } = req.body;
    if (!word || !word.trim()) return res.status(400).json({ error: 'Kata tidak boleh kosong' });
    const ok = wordFilterManager.addWord(word);
    if (ok) {
      pushEvent('info', `Kata terlarang ditambah: <b>${word.trim()}</b>`);
      res.json({ success: true, settings: wordFilterManager.getSettings() });
    } else res.status(409).json({ error: 'Kata sudah ada atau tidak valid' });
  });

  // DELETE hapus satu kata berdasarkan index
  app.delete('/api/wordfilter/words/:index', (req, res) => {
    const settings = wordFilterManager.getSettings();
    const word = settings.words[parseInt(req.params.index)];
    const ok = wordFilterManager.removeWord(req.params.index);
    if (ok) {
      pushEvent('warning', `Kata terlarang dihapus: <b>${word}</b>`);
      res.json({ success: true, settings: wordFilterManager.getSettings() });
    } else res.status(404).json({ error: 'Index tidak valid' });
  });

  // PUT ganti seluruh daftar kata
  app.put('/api/wordfilter/words', (req, res) => {
    const { words } = req.body;
    if (!Array.isArray(words)) return res.status(400).json({ error: 'words harus array' });
    const ok = wordFilterManager.setWords(words);
    if (ok) {
      pushEvent('info', `Daftar kata terlarang diperbarui: ${words.length} kata`);
      res.json({ success: true, settings: wordFilterManager.getSettings() });
    } else res.status(500).json({ error: 'Gagal simpan' });
  });

  // POST test filter (simulasi)
  app.post('/api/wordfilter/test', (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text wajib diisi' });
    res.json(wordFilterManager.testFilter(text));
  });


  // ── Anti-Spam GODMODE API ────────────────────────────────────
  const imageHashStore    = require('./imageHashStore');
  const spamPatternDetect = require('./spamPatternDetector');

  // GET: Ambil semua konfigurasi anti-spam saat ini
  app.get('/api/antispam/settings', (_, res) => {
    const env = envManager.readEnv();
    res.json({
      blacklistWords:    (env.BLACKLIST_WORDS || '').split(',').map(w => w.trim()).filter(Boolean),
      rateLimit:         parseInt(env.SPAM_RATE_LIMIT || '10'),
      floodWindowMs:     parseInt(env.SPAM_FLOOD_WINDOW_MS || '30000'),
      hashThreshold:     parseInt(env.SPAM_HASH_THRESHOLD || '10'),
      blockPhone:        env.SPAM_BLOCK_PHONE !== 'false',
      blockDiscordInvite: env.SPAM_BLOCK_DISCORD_INVITE !== 'false',
      blockTgLink:       env.SPAM_BLOCK_TG_LINK === 'true',
      blockPromo:        env.SPAM_BLOCK_PROMO !== 'false',
      blockFakeMirror:   env.SPAM_BLOCK_FAKE_MIRROR !== 'false',
      blockWaPattern:    env.SPAM_BLOCK_WA_PATTERN !== 'false',
      blockBodong:       env.SPAM_BLOCK_BODONG !== 'false',
      autoDeletePhone:         env.AUTO_DELETE_PHONE !== 'false',
      autoDeleteDiscordInvite: env.AUTO_DELETE_DISCORD_INVITE !== 'false',
      autoDeleteTgLink:        env.AUTO_DELETE_TG_LINK !== 'false',
      autoDeletePromo:         env.AUTO_DELETE_PROMO !== 'false',
      autoDeleteFakeMirror:    env.AUTO_DELETE_FAKE_MIRROR !== 'false',
      autoDeleteWaPattern:     env.AUTO_DELETE_WA_PATTERN !== 'false',
      autoDeleteBodong:        env.AUTO_DELETE_BODONG !== 'false',
      autoDeleteBlacklist:     env.AUTO_DELETE_BLACKLIST !== 'false',
      autoDeleteHash:          env.AUTO_DELETE_HASH !== 'false',
      hashStats:         imageHashStore.stats(),
    });
  });

  // POST: Simpan konfigurasi anti-spam
  app.post('/api/antispam/settings', (req, res) => {
    const {
      blacklistWords, rateLimit, floodWindowMs, hashThreshold,
      blockPhone, blockDiscordInvite, blockTgLink, blockPromo,
      blockFakeMirror, blockWaPattern, blockBodong,
      autoDeletePhone, autoDeleteDiscordInvite, autoDeleteTgLink, autoDeletePromo,
      autoDeleteFakeMirror, autoDeleteWaPattern, autoDeleteBodong, autoDeleteBlacklist, autoDeleteHash
    } = req.body;

    const updates = {};
    if (blacklistWords !== undefined)    updates.BLACKLIST_WORDS          = Array.isArray(blacklistWords) ? blacklistWords.join(',') : blacklistWords;
    if (rateLimit      !== undefined)    updates.SPAM_RATE_LIMIT          = String(parseInt(rateLimit) || 10);
    if (floodWindowMs  !== undefined)    updates.SPAM_FLOOD_WINDOW_MS     = String(parseInt(floodWindowMs) || 30000);
    if (hashThreshold  !== undefined)    updates.SPAM_HASH_THRESHOLD      = String(parseInt(hashThreshold) || 10);
    if (blockPhone        !== undefined) updates.SPAM_BLOCK_PHONE         = blockPhone        ? 'true' : 'false';
    if (blockDiscordInvite!== undefined) updates.SPAM_BLOCK_DISCORD_INVITE= blockDiscordInvite? 'true' : 'false';
    if (blockTgLink       !== undefined) updates.SPAM_BLOCK_TG_LINK       = blockTgLink       ? 'true' : 'false';
    if (blockPromo        !== undefined) updates.SPAM_BLOCK_PROMO         = blockPromo        ? 'true' : 'false';
    if (blockFakeMirror   !== undefined) updates.SPAM_BLOCK_FAKE_MIRROR   = blockFakeMirror   ? 'true' : 'false';
    if (blockWaPattern    !== undefined) updates.SPAM_BLOCK_WA_PATTERN    = blockWaPattern    ? 'true' : 'false';
    if (blockBodong       !== undefined) updates.SPAM_BLOCK_BODONG        = blockBodong       ? 'true' : 'false';
    
    if (autoDeletePhone        !== undefined) updates.AUTO_DELETE_PHONE         = autoDeletePhone        ? 'true' : 'false';
    if (autoDeleteDiscordInvite!== undefined) updates.AUTO_DELETE_DISCORD_INVITE= autoDeleteDiscordInvite? 'true' : 'false';
    if (autoDeleteTgLink       !== undefined) updates.AUTO_DELETE_TG_LINK       = autoDeleteTgLink       ? 'true' : 'false';
    if (autoDeletePromo        !== undefined) updates.AUTO_DELETE_PROMO         = autoDeletePromo        ? 'true' : 'false';
    if (autoDeleteFakeMirror   !== undefined) updates.AUTO_DELETE_FAKE_MIRROR   = autoDeleteFakeMirror   ? 'true' : 'false';
    if (autoDeleteWaPattern    !== undefined) updates.AUTO_DELETE_WA_PATTERN    = autoDeleteWaPattern    ? 'true' : 'false';
    if (autoDeleteBodong       !== undefined) updates.AUTO_DELETE_BODONG        = autoDeleteBodong       ? 'true' : 'false';
    if (autoDeleteBlacklist    !== undefined) updates.AUTO_DELETE_BLACKLIST     = autoDeleteBlacklist    ? 'true' : 'false';
    if (autoDeleteHash         !== undefined) updates.AUTO_DELETE_HASH          = autoDeleteHash         ? 'true' : 'false';

    envManager.updateEnv(updates);
    pushEvent('info', `🛡️ Anti-Spam GODMODE settings diperbarui via dashboard`);
    res.json({ success: true });
  });

  // GET: Daftar hash spam
  app.get('/api/antispam/hashes', (_, res) => {
    res.json(imageHashStore.stats());
  });

  // DELETE: Reset semua hash spam
  app.delete('/api/antispam/hashes', (_, res) => {
    imageHashStore.clearAll();
    pushEvent('warning', `🗑️ Image hash database di-reset via dashboard`);
    res.json({ success: true, stats: imageHashStore.stats() });
  });

  // POST: Test teks apakah terdeteksi spam oleh pattern detector
  app.post('/api/antispam/test', (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text wajib diisi' });
    const result = spamPatternDetect.detect(text);
    res.json(result);
  });

  // GET: Daftar pattern aktif
  app.get('/api/antispam/patterns', (_, res) => {
    res.json(spamPatternDetect.listPatterns());
  });

  // ── Restart ──────────────────────────────────────────────────
  app.post('/api/restart', (_, res) => {
    res.json({ success: true });
    pushEvent('warning', 'Bot restarting via dashboard...');
    // Di cloud (Railway/Render), exit code 1 memicu auto-restart container (On Failure).
    // Exit code 0 membuat Railway menganggap selesai (Completed) dan mati permanen.
    const exitCode = (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER) ? 1 : 0;
    setTimeout(() => process.exit(exitCode), 1000);
  });

  // ── Fallback SPA ─────────────────────────────────────────────
  app.use((_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  const server = app.listen(port, '0.0.0.0', () =>
    logger.success('🌐 Dashboard & API aktif di', `http://0.0.0.0:${port}`)
  );

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Port ${port} dipakai, coba ${port + 1}`);
      server.close();
      startWebServer(tgManager, channelMap, port + 1);
    } else logger.error('Web server error', err.message);
  });

  return server;
}

module.exports = { startWebServer, pushEvent };
