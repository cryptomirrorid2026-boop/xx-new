// ============================================================
//   UTILS / DISCORDREGISTRY.JS
//   Penyimpan sementara (registry) token Discord ke user tag (username) & status
// ============================================================

'use strict';

class DiscordRegistry {
  constructor() {
    this.tags     = new Map(); // token string -> tag string (e.g. user#1234)
    this.statuses = new Map(); // token string -> status ('online' | 'connecting' | 'error')
    this.errors   = new Map(); // token string -> error message string
  }

  /**
   * Simpan mapping token ke user tag dan set status online
   * @param {string} token 
   * @param {string} tag 
   */
  setTag(token, tag) {
    if (token) {
      const t = String(token).trim();
      this.tags.set(t, tag);
      this.statuses.set(t, 'online');
      this.errors.delete(t);
    }
  }

  /**
   * Simpan status koneksi akun
   * @param {string} token 
   * @param {'online'|'connecting'|'error'} status 
   * @param {string|null} tag 
   * @param {string|null} error 
   */
  setStatus(token, status, tag = null, error = null) {
    if (token) {
      const t = String(token).trim();
      this.statuses.set(t, status);
      if (tag) this.tags.set(t, tag);
      if (error) this.errors.set(t, error);
      else if (status === 'online') this.errors.delete(t);
    }
  }

  /**
   * Ambil data lengkap token (tag, status, error)
   * @param {string} token 
   */
  getInfo(token) {
    if (!token) return { tag: '', status: '', error: '' };
    const t = String(token).trim();
    return {
      tag: this.tags.get(t) || '',
      status: this.statuses.get(t) || '',
      error: this.errors.get(t) || ''
    };
  }

  /**
   * Dapatkan user tag berdasarkan token
   * @param {string} token 
   * @returns {string|null}
   */
  getTag(token) {
    if (!token) return null;
    return this.tags.get(String(token).trim()) || null;
  }
}

module.exports = new DiscordRegistry();
