// ============================================================
//   UTILS / MUTEDCHANNELS.JS
//   Simpan daftar channel Discord yang di-mute (tidak di-forward)
//   Persisten ke file JSON agar bertahan saat restart
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const MUTE_FILE = path.join(__dirname, '..', 'data', 'mutedChannels.json');

class MutedChannelsStore {
  constructor() {
    this.muted = new Set();
    this._load();
  }

  _ensureDir() {
    const dir = path.dirname(MUTE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      this._ensureDir();
      if (fs.existsSync(MUTE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(MUTE_FILE, 'utf-8'));
        if (Array.isArray(raw)) raw.forEach(id => this.muted.add(String(id)));
      }
    } catch (_) {}
  }

  _save() {
    try {
      this._ensureDir();
      fs.writeFileSync(MUTE_FILE, JSON.stringify([...this.muted], null, 2));
    } catch (_) {}
  }

  /**
   * Cek apakah channel di-mute
   * @param {string} channelId
   */
  isMuted(channelId) {
    return this.muted.has(String(channelId));
  }

  /**
   * Mute sebuah channel
   * @param {string} channelId
   * @returns {boolean} true jika berhasil (belum ada sebelumnya)
   */
  mute(channelId) {
    const id = String(channelId);
    if (this.muted.has(id)) return false;
    this.muted.add(id);
    this._save();
    return true;
  }

  /**
   * Unmute sebuah channel
   * @param {string} channelId
   * @returns {boolean} true jika berhasil dihapus
   */
  unmute(channelId) {
    const id = String(channelId);
    if (!this.muted.has(id)) return false;
    this.muted.delete(id);
    this._save();
    return true;
  }

  /**
   * Daftar semua channel yang di-mute
   */
  list() {
    return [...this.muted];
  }

  get size() {
    return this.muted.size;
  }
}

module.exports = new MutedChannelsStore();
