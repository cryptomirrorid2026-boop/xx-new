// ============================================================
//   UTILS / MAPPINGSTORE.JS
//   Manajemen mapping untuk Mention dan Role
//   Persistent ke: data/mappings.json
//   Hot-reload: edit file → berlaku tanpa restart
//
//   Format JSON:
//   {
//     "mentions": {
//       "Ardalyn": "1494966942568550441"
//     },
//     "roles": {
//       "#Signal": "123456789012345678"
//     }
//   }
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const MAPPINGS_FILE = path.join(__dirname, '..', 'data', 'mappings.json');

class MappingStore {
  constructor() {
    this.mappings = { mentions: {}, roles: {} };
    this._watcher  = null;
    this._debounce = null;
    this._ensureDir();
    this._load();
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  _ensureDir() {
    const dir = path.dirname(MAPPINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(MAPPINGS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf-8'));
        this.mappings = {
          mentions: raw.mentions || {},
          roles: raw.roles || {}
        };
        return true;
      } else {
        this._save();
      }
    } catch (err) {
      logger.warn('MappingStore: gagal baca mappings.json', err.message);
    }
    return false;
  }

  _save() {
    try {
      this._ensureDir();
      fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(this.mappings, null, 2), 'utf-8');
      return true;
    } catch (err) {
      logger.warn('MappingStore: gagal simpan mappings.json', err.message);
      return false;
    }
  }

  // ─── Publik: Getter ─────────────────────────────────────────────────────────

  getMention(username) {
    // case-insensitive lookup
    const key = Object.keys(this.mappings.mentions).find(k => k.toLowerCase() === username.toLowerCase());
    return key ? this.mappings.mentions[key] : null;
  }

  getRole(hashtag) {
    // case-insensitive lookup
    const key = Object.keys(this.mappings.roles).find(k => k.toLowerCase() === hashtag.toLowerCase());
    return key ? this.mappings.roles[key] : null;
  }

  getAllMentions() {
    return this.mappings.mentions;
  }

  getAllRoles() {
    return this.mappings.roles;
  }

  // ─── Publik: CRUD ───────────────────────────────────────────────────────────

  addMention(username, discordId) {
    if (!username || !discordId) return false;
    // Simpan persis seperti yang diketik user, tapi simpan juga tanpa @ untuk fallback
    const cleanUsername = username.replace(/^@/, '');
    this.mappings.mentions[username] = String(discordId);
    if (username !== cleanUsername) this.mappings.mentions[cleanUsername] = String(discordId);
    
    this._save();
    logger.info(`MappingStore: mention ${username} → <@${discordId}> ditambahkan`);
    return true;
  }

  addRole(hashtag, roleId) {
    if (!hashtag || !roleId) return false;
    // Simpan persis seperti yang diketik user
    this.mappings.roles[hashtag] = String(roleId);
    
    // Fallback: Jika user tidak pakai # atau @, tambahkan #
    if (!hashtag.startsWith('#') && !hashtag.startsWith('@')) {
      this.mappings.roles[`#${hashtag}`] = String(roleId);
    }
    
    this._save();
    logger.info(`MappingStore: role ${hashtag} → <@&${roleId}> ditambahkan`);
    return true;
  }

  removeMention(username) {
    const cleanUsername = username.replace(/^@/, '');
    const keys = Object.keys(this.mappings.mentions).filter(k => 
      k.toLowerCase() === username.toLowerCase() || k.toLowerCase() === cleanUsername.toLowerCase()
    );
    if (keys.length > 0) {
      keys.forEach(k => delete this.mappings.mentions[k]);
      this._save();
      return true;
    }
    return false;
  }

  removeRole(hashtag) {
    const keys = Object.keys(this.mappings.roles).filter(k => 
      k.toLowerCase() === hashtag.toLowerCase() || k.toLowerCase() === `#${hashtag.toLowerCase()}`
    );
    if (keys.length > 0) {
      keys.forEach(k => delete this.mappings.roles[k]);
      this._save();
      return true;
    }
    return false;
  }

  // ─── Hot-reload ─────────────────────────────────────────────────────────────

  startWatcher() {
    if (this._watcher) return;
    if (!fs.existsSync(MAPPINGS_FILE)) return;

    try {
      this._watcher = fs.watch(MAPPINGS_FILE, (event) => {
        if (event !== 'change') return;
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
          const ok = this._load();
          if (ok) {
            logger.success(`🔄 mappings.json hot-reload!`);
          }
        }, 600);
      });
      logger.info('MappingStore: hot-reload aktif');
    } catch (err) {
      logger.warn('MappingStore: hot-reload tidak aktif', err.message);
    }
  }
}

module.exports = new MappingStore();
