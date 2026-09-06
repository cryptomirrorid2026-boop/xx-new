// ============================================================
//   UTILS / DUPLICATEGUARD.JS
//   Cegah pesan yang sama di-forward 2x oleh multi-akun
// ============================================================

'use strict';

class DuplicateGuard {
  /**
   * @param {number} ttlMs - Berapa lama (ms) ID tersimpan sebelum dihapus
   */
  constructor(ttlMs = 10000) {
    this.ttlMs  = ttlMs;
    this.recent = new Map(); // messageId -> timestamp
  }

  /**
   * Cek apakah message ID sudah pernah diproses.
   * Jika belum, langsung tandai sebagai sudah diproses.
   * @param {string} messageId
   * @returns {boolean} true = duplikat (skip), false = pertama kali (proses)
   */
  isDuplicate(messageId) {
    this._cleanup();
    const id = String(messageId);
    if (this.recent.has(id)) return true;
    this.recent.set(id, Date.now());
    return false;
  }

  // Hapus entri yang sudah expired
  _cleanup() {
    const now = Date.now();
    for (const [id, ts] of this.recent) {
      if (now - ts > this.ttlMs) this.recent.delete(id);
    }
  }

  get size() { return this.recent.size; }
}

const defaultInstance = new DuplicateGuard(10000);
defaultInstance.DuplicateGuard = DuplicateGuard;

module.exports = defaultInstance;
