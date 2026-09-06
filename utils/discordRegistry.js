// ============================================================
//   UTILS / DISCORDREGISTRY.JS
//   Penyimpan sementara (registry) token Discord ke user tag (username)
// ============================================================

'use strict';

class DiscordRegistry {
  constructor() {
    this.tags = new Map(); // token string -> tag string (e.g. user#1234)
  }

  /**
   * Simpan mapping token ke user tag
   * @param {string} token 
   * @param {string} tag 
   */
  setTag(token, tag) {
    if (token) {
      this.tags.set(String(token).trim(), tag);
    }
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
