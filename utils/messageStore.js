// ============================================================
//   UTILS / MESSAGESTORE.JS (SQLite Version)
//   Simpan mapping Discord MsgID → Telegram MsgID
//   Digunakan untuk delete sync dan edit sync
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'messages.db');
const OLD_STORE_FILE = path.join(DATA_DIR, 'messageStore.json');

class MessageStore {
  constructor() {
    this._ensureDir();
    this.db = new Database(DB_FILE);
    this._initDB();
    this._migrateFromJSON();
  }

  _ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _initDB() {
    // Mode WAL & busy_timeout sangat direkomendasikan untuk performa konkurensi (mencegah lock error)
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    
    // Buat tabel utama jika belum ada
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        discordMsgId TEXT PRIMARY KEY,
        tgChatId TEXT,
        tgMsgId INTEGER,
        botKey TEXT,
        type TEXT,
        dcWebhookUrl TEXT,
        dcMsgId TEXT,
        timestamp INTEGER
      )
    `);

    // Prepare statements agar eksekusi sangat cepat
    this.getStmt = this.db.prepare('SELECT * FROM messages WHERE discordMsgId = ?');
    
    this.upsertStmt = this.db.prepare(`
      INSERT INTO messages (discordMsgId, tgChatId, tgMsgId, botKey, type, dcWebhookUrl, dcMsgId, timestamp)
      VALUES (@discordMsgId, @tgChatId, @tgMsgId, @botKey, @type, @dcWebhookUrl, @dcMsgId, @timestamp)
      ON CONFLICT(discordMsgId) DO UPDATE SET
        tgChatId = excluded.tgChatId,
        tgMsgId = excluded.tgMsgId,
        botKey = excluded.botKey,
        type = excluded.type,
        dcWebhookUrl = excluded.dcWebhookUrl,
        dcMsgId = excluded.dcMsgId,
        timestamp = excluded.timestamp
    `);
    
    this.deleteStmt = this.db.prepare('DELETE FROM messages WHERE discordMsgId = ?');
    this.cleanStmt = this.db.prepare('DELETE FROM messages WHERE timestamp < ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
    this.insertLockStmt = this.db.prepare(`
      INSERT INTO messages (discordMsgId, tgChatId, tgMsgId, botKey, type, dcWebhookUrl, dcMsgId, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  _migrateFromJSON() {
    // Jika file json lama masih ada, pindahkan isinya ke DB lalu backup
    if (fs.existsSync(OLD_STORE_FILE)) {
      try {
        if (this.size === 0) {
          const raw = JSON.parse(fs.readFileSync(OLD_STORE_FILE, 'utf-8'));
          
          // Lakukan insert dalam 1 transaction agar sangat cepat
          const insertMany = this.db.transaction((entries) => {
            for (const [k, v] of entries) {
              this.upsertStmt.run({
                discordMsgId: String(k),
                tgChatId: v.tgChatId ? String(v.tgChatId) : null,
                tgMsgId: v.tgMsgId ? Number(v.tgMsgId) : null,
                botKey: v.botKey ? String(v.botKey) : null,
                type: v.type || 'text',
                dcWebhookUrl: v.dcWebhookUrl || null,
                dcMsgId: v.dcMsgId || null,
                timestamp: v.timestamp || Date.now()
              });
            }
          });
          
          insertMany(Object.entries(raw));
          // Ubah nama file json agar migrasi tidak dilakukan dua kali
          fs.renameSync(OLD_STORE_FILE, OLD_STORE_FILE + '.bak');
          console.log(`✅ Berhasil migrasi data lama ke SQLite.`);
        }
      } catch (err) {
        console.error('❌ Gagal migrasi messageStore.json:', err.message);
      }
    }
  }

  /**
   * Simpan mapping pesan (Upsert)
   * @param {string} discordMsgId
   * @param {string} tgChatId
   * @param {number} tgMsgId
   * @param {string} botKey
   * @param {string} type
   * @param {string} dcWebhookUrl
   * @param {string} dcMsgId
   */
  set(discordMsgId, tgChatId, tgMsgId, botKey, type = 'text', dcWebhookUrl = null, dcMsgId = null) {
    const existing = this.get(String(discordMsgId)) || {};
    
    this.upsertStmt.run({
      discordMsgId: String(discordMsgId),
      tgChatId: tgChatId ? String(tgChatId) : existing.tgChatId || null,
      tgMsgId: tgMsgId ? Number(tgMsgId) : existing.tgMsgId || null,
      botKey: botKey ? String(botKey) : existing.botKey || null,
      type: type || existing.type || 'text',
      dcWebhookUrl: dcWebhookUrl || existing.dcWebhookUrl || null,
      dcMsgId: dcMsgId || existing.dcMsgId || null,
      timestamp: Date.now()
    });
  }

  /**
   * Mengunci pesan secara sinkron menggunakan constraint database.
   * Return true jika berhasil mengunci, false jika sudah dikunci/diproses.
   */
  lock(discordMsgId) {
    try {
      this.insertLockStmt.run(String(discordMsgId), null, null, null, 'pending', null, null, Date.now());
      return true;
    } catch (err) {
      if (err.code && err.code.includes('CONSTRAINT')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Hapus entri yang sudah terlalu lama (untuk auto-reset, dipanggil via interval di index.js)
   * @param {number} maxAgeMs - Umur maksimum dalam ms, default 7 hari
   */
  cleanOldEntries(maxAgeMs = 7 * 24 * 3600000) {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.cleanStmt.run(cutoff);
    return info.changes > 0;
  }

  /**
   * Ambil mapping berdasarkan Discord message ID
   * @param {string} discordMsgId
   */
  get(discordMsgId) {
    return this.getStmt.get(String(discordMsgId)) || null;
  }

  /**
   * Hapus mapping (setelah pesan TG dihapus)
   * @param {string} discordMsgId
   */
  delete(discordMsgId) {
    this.deleteStmt.run(String(discordMsgId));
  }

  get size() {
    return this.countStmt.get().count;
  }
}

module.exports = new MessageStore();
