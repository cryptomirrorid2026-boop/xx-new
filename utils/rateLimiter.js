// ============================================================
//   UTILS / RATELIMITER.JS  — v3 (Anti-Gagal)
//   Antrian pengiriman pesan ke Telegram dengan:
//     - Max 5 retry per pesan
//     - Exponential backoff + jitter
//     - Handle 429 flood, 5xx server error, network timeout
//     - Batas antrian (10.000 item) agar RAM tidak meledak
// ============================================================

'use strict';

const logger = require('./logger');

// Error codes yang layak di-retry
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'ETELEGRAM', 'EFATAL',
]);

const MAX_QUEUE  = 10_000;  // Batas antrian agar RAM tidak meledak
const MAX_RETRY  = 5;       // Max percobaan per item

class RateLimiter {
  /**
   * @param {number} delayMs  - Jeda minimum antar pengiriman (ms)
   */
  constructor(delayMs = 500) {
    this.delayMs    = delayMs;
    this.queue      = [];
    this.processing = false;
    this._dropped   = 0; // Counter item yang didrop karena queue penuh
  }

  /**
   * Tambahkan fungsi ke antrian.
   * @param {Function} fn - Async function () => Promise<any>
   * @returns {Promise<any>}
   */
  add(fn) {
    // Tolak jika antrian sudah terlalu panjang (bukan drop senyap)
    if (this.queue.length >= MAX_QUEUE) {
      this._dropped++;
      if (this._dropped % 100 === 1) {
        logger.warn(`RateLimiter: antrian penuh (${MAX_QUEUE}), ${this._dropped} item di-drop!`);
      }
      return Promise.reject(new Error('RateLimiter queue penuh'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (!this.processing) this._process();
    });
  }

  async _process() {
    this.processing = true;

    while (this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();

      try {
        const result = await this._runWithRetry(fn);
        resolve(result);
      } catch (err) {
        reject(err);
      }

      // Jeda antar pesan agar tidak flood
      if (this.queue.length > 0) {
        await this._delay(this.delayMs);
      }
    }

    this.processing = false;
  }

  /**
   * Jalankan fn dengan retry otomatis.
   * Strategi:
   *   - 429 flood → tunggu retry_after + 1s
   *   - 5xx / network error → exponential backoff + jitter
   *   - 400 / 403 → tidak retry (kesalahan permanen)
   */
  async _runWithRetry(fn, attempt = 1) {
    try {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Telegram API request timeout (25s)');
          err.code = 'ETIMEDOUT';
          reject(err);
        }, 25000);
      });

      try {
        const res = await Promise.race([fn(), timeoutPromise]);
        clearTimeout(timer);
        return res;
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    } catch (err) {

      const errMsg = err?.message || String(err);
      const status = err?.response?.statusCode
        || (errMsg.includes('429') ? 429 : 0)
        || (errMsg.includes('502') ? 502 : 0)
        || (errMsg.includes('503') ? 503 : 0)
        || (errMsg.includes('504') ? 504 : 0);

      // ─── 429 Flood Control ───────────────────────────────────────────────
      const retryAfter = err?.response?.body?.parameters?.retry_after
        || (status === 429 ? 30 : 0);

      if (retryAfter && attempt <= MAX_RETRY) {
        const waitMs = (retryAfter * 1000) + 1000;
        logger.warn(`Telegram 429 flood wait ${retryAfter}s (attempt ${attempt}/${MAX_RETRY})...`);
        await this._delay(waitMs);
        return this._runWithRetry(fn, attempt + 1);
      }

      // ─── 5xx Server Error (Telegram down sementara) ──────────────────────
      if ((status >= 500 && status < 600) && attempt <= MAX_RETRY) {
        const backoff = this._backoff(attempt);
        logger.warn(`Telegram ${status} server error, retry ${attempt}/${MAX_RETRY} dalam ${backoff}ms...`);
        await this._delay(backoff);
        return this._runWithRetry(fn, attempt + 1);
      }

      // ─── Network error (timeout, reset, dll) ────────────────────────────
      const code = err?.code || '';
      if (RETRYABLE_CODES.has(code) && attempt <= MAX_RETRY) {
        const backoff = this._backoff(attempt);
        logger.warn(`Network error [${code}], retry ${attempt}/${MAX_RETRY} dalam ${backoff}ms...`);
        await this._delay(backoff);
        return this._runWithRetry(fn, attempt + 1);
      }

      // ─── Error permanen (400 Bad Request, 403 Forbidden, dll) ───────────
      // Tidak retry, langsung lempar
      throw err;
    }
  }

  /**
   * Hitung waktu tunggu exponential backoff + jitter
   * attempt 1 → ~1s, 2 → ~2s, 3 → ~4s, 4 → ~8s, 5 → ~16s
   */
  _backoff(attempt) {
    const base  = Math.min(this.delayMs * Math.pow(2, attempt - 1), 30_000);
    const jitter = Math.random() * 0.3 * base; // ±30% jitter
    return Math.round(base + jitter);
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  get pendingCount() { return this.queue.length; }
  get droppedCount() { return this._dropped; }
}

module.exports = RateLimiter;
