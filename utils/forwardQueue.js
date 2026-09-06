// ============================================================
//   UTILS / FORWARDQUEUE.JS  — v1 (Anti-Gagal Dead-Letter Queue)
//   Jika pengiriman ke Telegram gagal setelah semua retry,
//   pesan masuk ke "dead-letter queue" dan akan dicoba ulang
//   setelah RETRY_INTERVAL_MS (default 2 menit).
//
//   Fitur:
//     - Max DLQ_MAX_SIZE item (500) agar RAM aman
//     - Max 3 kali coba ulang dari DLQ → setelah itu buang + alert admin
//     - Alert admin Telegram jika ada kegagalan permanen
// ============================================================

'use strict';

const logger = require('./logger');

const DLQ_MAX_SIZE       = 500;          // Max item dalam antrian ulang
const DLQ_MAX_ATTEMPTS   = 3;            // Max percobaan dari DLQ
const RETRY_INTERVAL_MS  = 2 * 60_000;  // Coba ulang tiap 2 menit

class ForwardQueue {
  constructor() {
    this._dlq       = [];       // Dead-letter queue: item yang gagal
    this._adminFn   = null;     // Callback kirim alert ke admin
    this._timer     = null;
    this._stats     = { retried: 0, permanent: 0 };
  }

  /**
   * Daftarkan callback untuk alert admin (opsional).
   * @param {Function} fn  - async (text) => void
   */
  setAdminAlertFn(fn) {
    this._adminFn = fn;
  }

  /**
   * Tambahkan item yang gagal ke antrian ulang.
   * @param {{ fn, label }} item
   *   fn    - async function yang akan dicoba ulang
   *   label - string deskripsi (untuk log & alert)
   */
  addFailed(fn, label = 'pesan') {
    if (this._dlq.length >= DLQ_MAX_SIZE) {
      logger.warn(`ForwardQueue: DLQ penuh (${DLQ_MAX_SIZE}), drop "${label}"`);
      return;
    }
    this._dlq.push({ fn, label, attempts: 0, addedAt: Date.now() });

    // Pastikan timer retry berjalan
    if (!this._timer) {
      this._startTimer();
    }
    logger.warn(`📥 DLQ: "${label}" masuk antrian ulang (DLQ size: ${this._dlq.length})`);
  }

  _startTimer() {
    this._timer = setInterval(() => this._processRetry(), RETRY_INTERVAL_MS);
  }

  async _processRetry() {
    if (this._dlq.length === 0) {
      clearInterval(this._timer);
      this._timer = null;
      return;
    }

    logger.info(`🔄 DLQ retry: ${this._dlq.length} item menunggu...`);
    const batch = [...this._dlq];
    this._dlq   = [];

    for (const item of batch) {
      item.attempts++;
      try {
        await item.fn();
        this._stats.retried++;
        logger.success(`✅ DLQ retry berhasil (attempt ${item.attempts}): "${item.label}"`);
      } catch (err) {
        if (item.attempts >= DLQ_MAX_ATTEMPTS) {
          // Gagal permanen — buang & alert admin
          this._stats.permanent++;
          logger.error(`❌ DLQ: "${item.label}" gagal permanen setelah ${item.attempts}x`, err.message?.substring(0, 60));
          await this._alertAdmin(item.label, err.message);
        } else {
          // Masukkan kembali ke DLQ untuk percobaan berikutnya
          this._dlq.push(item);
          logger.warn(`⏳ DLQ: "${item.label}" retry ${item.attempts}/${DLQ_MAX_ATTEMPTS} gagal, jadwal ulang...`);
        }
      }

      // Jeda kecil antar item agar tidak flood
      await new Promise(r => setTimeout(r, 300));
    }
  }

  async _alertAdmin(label, errMsg) {
    if (!this._adminFn) return;
    try {
      const text = [
        `⚠️ <b>Forward GAGAL PERMANEN</b>`,
        ``,
        `📌 <b>Pesan:</b> ${label}`,
        `❌ <b>Error:</b> <code>${(errMsg || 'unknown').substring(0, 120)}</code>`,
        `🔢 <b>Total gagal permanen:</b> ${this._stats.permanent}`,
        ``,
        `Pesan ini tidak berhasil dikirim ke Telegram setelah ${DLQ_MAX_ATTEMPTS}x percobaan.`,
      ].join('\n');
      await this._adminFn(text);
    } catch { /* alert gagal pun tidak perlu crash */ }
  }

  get stats() {
    return {
      queued:    this._dlq.length,
      retried:   this._stats.retried,
      permanent: this._stats.permanent,
    };
  }
}

module.exports = new ForwardQueue();
