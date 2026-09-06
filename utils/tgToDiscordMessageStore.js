// ============================================================
//   UTILS / TGTODISCORDMESSAGESTORE.JS
//   Simpan mapping: TG Message ID → Discord Webhook Message ID
//   Digunakan untuk:
//     - Edit sync: TG edit → edit pesan Discord
//     - Pseudo-delete: TG hapus (terdeteksi) → edit Discord jadi [DIHAPUS]
//
//   Menggunakan SQLite (tabel terpisah di DB yang sama)
// ============================================================

'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '..', 'data', 'messages.db');

class TgToDiscordMessageStore {
  constructor() {
    // Gunakan DB yang sama dengan messageStore (multi-table)
    this.db = new Database(DB_FILE);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tg_dc_messages (
        tgChatId      TEXT NOT NULL,
        tgMsgId       TEXT NOT NULL,
        dcWebhookUrl  TEXT NOT NULL,
        dcMsgId       TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        PRIMARY KEY (tgChatId, tgMsgId)
      )
    `);

    this.getStmt = this.db.prepare(
      'SELECT * FROM tg_dc_messages WHERE tgChatId = ? AND tgMsgId = ?'
    );
    this.upsertStmt = this.db.prepare(`
      INSERT INTO tg_dc_messages (tgChatId, tgMsgId, dcWebhookUrl, dcMsgId, timestamp)
      VALUES (@tgChatId, @tgMsgId, @dcWebhookUrl, @dcMsgId, @timestamp)
      ON CONFLICT(tgChatId, tgMsgId) DO UPDATE SET
        dcWebhookUrl = excluded.dcWebhookUrl,
        dcMsgId      = excluded.dcMsgId,
        timestamp    = excluded.timestamp
    `);
    this.deleteStmt = this.db.prepare(
      'DELETE FROM tg_dc_messages WHERE tgChatId = ? AND tgMsgId = ?'
    );
    this.cleanStmt = this.db.prepare(
      'DELETE FROM tg_dc_messages WHERE timestamp < ?'
    );
    this.insertLockStmt = this.db.prepare(`
      INSERT INTO tg_dc_messages (tgChatId, tgMsgId, dcWebhookUrl, dcMsgId, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  /**
   * Simpan mapping TG → DC
   */
  set(tgChatId, tgMsgId, dcWebhookUrl, dcMsgId) {
    this.upsertStmt.run({
      tgChatId:     String(tgChatId),
      tgMsgId:      String(tgMsgId),
      dcWebhookUrl: String(dcWebhookUrl),
      dcMsgId:      String(dcMsgId),
      timestamp:    Date.now(),
    });
  }

  /**
   * Mengunci pesan secara sinkron menggunakan constraint database.
   * Return true jika berhasil mengunci, false jika sudah dikunci/diproses.
   */
  lock(tgChatId, tgMsgId) {
    try {
      this.insertLockStmt.run(String(tgChatId), String(tgMsgId), 'pending', 'pending', Date.now());
      return true;
    } catch (err) {
      if (err.code && err.code.includes('CONSTRAINT')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Ambil mapping berdasarkan TG Chat ID + Message ID
   * @returns {{ tgChatId, tgMsgId, dcWebhookUrl, dcMsgId, timestamp } | null}
   */
  get(tgChatId, tgMsgId) {
    return this.getStmt.get(String(tgChatId), String(tgMsgId)) || null;
  }

  /**
   * Hapus entri
   */
  delete(tgChatId, tgMsgId) {
    this.deleteStmt.run(String(tgChatId), String(tgMsgId));
  }

  /**
   * Bersihkan entri lama (dipanggil periodic)
   * @param {number} maxAgeMs default 7 hari
   */
  cleanOldEntries(maxAgeMs = 7 * 24 * 3600000) {
    const cutoff = Date.now() - maxAgeMs;
    const info   = this.cleanStmt.run(cutoff);
    return info.changes > 0;
  }
}

module.exports = new TgToDiscordMessageStore();
