// ============================================================
//   UTILS / ENVMANAGER.JS
//   Helper untuk membaca dan mengedit file .env secara programatik
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const tgManager = require('./telegramManager');
const discordRegistry = require('./discordRegistry');

const ENV_PATH = path.join(__dirname, '..', '.env');

class EnvManager {
  /**
   * Membaca semua key-value dari .env
   */
  readEnv() {
    if (!fs.existsSync(ENV_PATH)) return {};
    
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const result = {};
    
    content.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const key = line.substring(0, idx).trim();
        const val = line.substring(idx + 1).trim();
        result[key] = val;
      }
    });
    
    return result;
  }

  /**
   * Mengupdate atau menambahkan key ke .env
   * @param {Object} updates Object berisi key-value yang mau diupdate
   */
  updateEnv(updates) {
    if (!fs.existsSync(ENV_PATH)) {
      fs.writeFileSync(ENV_PATH, '', 'utf8');
    }
    
    let content = fs.readFileSync(ENV_PATH, 'utf8');
    const lines = content.split('\n');
    const updatedKeys = new Set();
    const newLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line || line.startsWith('#')) {
        newLines.push(lines[i]);
        continue;
      }
      
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const key = line.substring(0, idx).trim();
        
        // If it's a Telegram Bot key that is not in the updates payload, AND we are told to delete missing ones, delete it!
        if (key.startsWith('TELEGRAM_BOT_') && !updates.hasOwnProperty(key) && updates._deleteMissingTelegramBots === true) {
          continue;
        }
        
        if (updates.hasOwnProperty(key) && !key.startsWith('_')) {
          newLines.push(`${key}=${updates[key]}`);
          updatedKeys.add(key);
        } else {
          newLines.push(lines[i]);
        }
      } else {
        newLines.push(lines[i]);
      }
    }
    
    // Tambahkan key baru di bagian paling bawah (kecuali internal flags yang diawali _)
    for (const [key, val] of Object.entries(updates)) {
      if (!key.startsWith('_') && !updatedKeys.has(key)) {
        newLines.push(`${key}=${val}`);
      }
    }
    
    fs.writeFileSync(ENV_PATH, newLines.join('\n'), 'utf8');
    logger.info(`Updated .env file with ${Object.keys(updates).length} keys`);
  }

  /**
   * Ambil data discord tokens & telegram bots terstruktur untuk UI
   */
  getConfig() {
    const env = this.readEnv();
    
    // Parse Discord Tokens
    const discordTokens = [];
    if (env.DISCORD_TOKENS && !env.DISCORD_TOKENS.includes('ISI_')) {
      env.DISCORD_TOKENS.split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
        const tag = discordRegistry.getTag(t) || '';
        discordTokens.push({ token: t, tag });
      });
    }
    
    // Parse Telegram Bots
    const telegramBots = [];
    for (let i = 1; i <= 20; i++) {
      const key = `TELEGRAM_BOT_${i}`;
      if (env[key] && !env[key].includes('ISI_')) {
        const username = tgManager.names ? tgManager.names.get(String(i)) || '' : '';
        telegramBots.push({ id: i, token: env[key], username });
      }
    }
    
    return {
      discordTokens,
      telegramBots,
      watermark: env.WATERMARK || '',
      adminId: env.ADMIN_TELEGRAM_ID || '',
      adminBotKey: env.ADMIN_BOT_KEY || '1',
      blockedUserIds: env.BLOCKED_USER_IDS || '',
      forwardBotMessages: env.FORWARD_BOT_MESSAGES !== 'false', // Default true based on env structure
      forwardEdits: env.FORWARD_EDITS !== 'false',
      showChannelName: env.SHOW_CHANNEL_NAME === 'true', // Default false
      showServerName: env.SHOW_SERVER_NAME === 'true', // Default false
      showAuthorName: env.SHOW_AUTHOR_NAME !== 'false', // Default true
      blacklistWords: env.BLACKLIST_WORDS || '',
      whitelistWords: env.WHITELIST_WORDS || '',
      maxMessageLength: env.MAX_MESSAGE_LENGTH || '4000',
      rateLimitDelay: env.RATE_LIMIT_DELAY || '200',
      healthPort: env.HEALTH_PORT || '3000',
      forwardReactions: env.FORWARD_REACTIONS !== 'false', // Default true
      tgApiId: env.TG_API_ID || '',
      tgApiHash: env.TG_API_HASH || '',
      tgUserSession: env.TG_USER_SESSIONS || env.TG_USER_SESSION || '',
      dcReplyQuote: env.DC_TO_DC_REPLY_QUOTE !== 'false',
      dcStripInvites: env.DC_TO_DC_STRIP_INVITES !== 'false',
      dcOnlyWithMedia: env.DC_TO_DC_ONLY_WITH_MEDIA === 'true',
      dcCustomName: env.DC_TO_DC_CUSTOM_NAME || '',
      dcCustomAvatar: env.DC_TO_DC_CUSTOM_AVATAR || '',
      dcAutoPing: env.DC_TO_DC_AUTO_PING || ''
    };
  }
}

module.exports = new EnvManager();
