// ============================================================
//   UTILS / TELEGRAMMANAGER.JS
//   Mengelola beberapa instance Telegram Bot sekaligus
//   Setiap bot punya key: '1', '2', '3', dst.
// ============================================================

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const logger = require('./logger');

class TelegramManager {
  constructor() {
    this.bots   = new Map(); // key (string) -> TelegramBot instance
    this.tokens = new Map(); // key (string) -> token string
    this.names  = new Map(); // key (string) -> username string (e.g. @MyBot)
  }

  /**
   * Daftarkan bot baru
   * @param {string|number} key  - Nomor bot (1, 2, 3, ...)
   * @param {string} token       - Bot token dari BotFather
   */
  add(key, token) {
    const k = String(key);
    const bot = new TelegramBot(token, { polling: false });
    this.bots.set(k, bot);
    this.tokens.set(k, token);
    logger.info(`Telegram Bot #${k} didaftarkan`);
    return bot;
  }

  /**
   * Ambil raw token berdasarkan key (untuk polling bot)
   * @param {string|number} key
   * @returns {string|null}
   */
  getToken(key) {
    return this.tokens.get(String(key)) || null;
  }

  /**
   * Ambil instance bot berdasarkan key
   * @param {string|number} key
   * @returns {TelegramBot|null}
   */
  get(key) {
    return this.bots.get(String(key)) || null;
  }

  /**
   * Ambil semua pasangan [key, bot]
   */
  getAll() {
    return [...this.bots.entries()];
  }

  get size() {
    return this.bots.size;
  }

  /**
   * Test koneksi semua bot ke Telegram API
   */
  async verifyAll() {
    const results = [];
    for (const [key, bot] of this.bots) {
      try {
        const me = await bot.getMe();
        logger.success(`Telegram Bot #${key} terhubung: @${me.username} (${me.first_name})`);
        this.names.set(key, `@${me.username}`);
        results.push({ key, ok: true, username: me.username });
      } catch (err) {
        logger.error(`Telegram Bot #${key} GAGAL terhubung!`, err.message);
        results.push({ key, ok: false, error: err.message });
      }
    }
    return results;
  }
}

module.exports = new TelegramManager();
