// ============================================================
//   UTILS / BLOCKEDUSERSSTORE.JS
//   Penyimpanan user Discord yang diblok secara persisten
//   Sumber: .env (BLOCKED_USER_IDS) + command /block di Telegram
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'blockedUsers.json');

class BlockedUsersStore {
  constructor() {
    this.blocked = new Set();
    this._load();
  }

  _ensureDir() {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      this._ensureDir();
      if (fs.existsSync(STORE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
        if (Array.isArray(data)) {
          data.forEach(id => this.blocked.add(String(id)));
        }
      }
    } catch (_) {}
  }

  _save() {
    try {
      this._ensureDir();
      fs.writeFileSync(STORE_FILE, JSON.stringify([...this.blocked], null, 2));
    } catch (_) {}
  }

  /** Cek apakah user diblok */
  has(userId) {
    return this.blocked.has(String(userId));
  }

  /** Tambah user ke blok list (otomatis tersimpan) */
  add(userId) {
    this.blocked.add(String(userId));
    this._save();
  }

  /** Hapus user dari blok list */
  remove(userId) {
    const existed = this.blocked.delete(String(userId));
    if (existed) this._save();
    return existed;
  }

  /** Daftar semua user yang diblok */
  list() {
    return [...this.blocked];
  }

  get size() { return this.blocked.size; }
}

module.exports = new BlockedUsersStore();
