// ============================================================
//   UTILS / CROPMANAGER.JS
//   Manajemen fitur Crop gambar khusus per Discord Channel ID
//
//   File penyimpanan: data/crop-settings.json
//   Format:
//   {
//     "channelId1": {
//       "enabled": true,
//       "x": 10,       ← % dari lebar gambar (kiri)
//       "y": 5,        ← % dari tinggi gambar (atas)
//       "w": 80,       ← % lebar area yang diambil
//       "h": 90        ← % tinggi area yang diambil
//     },
//     "channelId2": { ... }
//   }
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const sharp  = require('sharp');
const logger = require('./logger');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'crop-settings.json');

class CropManager {
  constructor() {
    this.settings = {}; // { [discordChannelId]: { enabled, x, y, w, h } }
    this._ensureDir();
    this.loadSettings();
  }

  _ensureDir() {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  loadSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        this.settings = JSON.parse(raw) || {};
      }
    } catch (err) {
      logger.warn('cropManager: gagal baca crop-settings.json', err.message);
      this.settings = {};
    }
  }

  _save() {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2), 'utf-8');
      return true;
    } catch (err) {
      logger.error('cropManager: gagal simpan crop-settings.json', err.message);
      return false;
    }
  }

  /**
   * Ambil semua setting crop
   * @returns {Object} semua channel crop config
   */
  getAll() {
    return { ...this.settings };
  }

  /**
   * Ambil setting crop untuk satu channel
   * @param {string} channelId
   */
  getChannel(channelId) {
    return this.settings[String(channelId)] || null;
  }

  /**
   * Simpan atau update setting crop untuk satu channel
   * @param {string} channelId
   * @param {{ enabled, x, y, w, h }} cropConfig
   */
  setChannel(channelId, cropConfig) {
    const id = String(channelId);
    this.settings[id] = {
      enabled: cropConfig.enabled === true || cropConfig.enabled === 'true',
      x: parseFloat(cropConfig.x) || 0,
      y: parseFloat(cropConfig.y) || 0,
      w: parseFloat(cropConfig.w) || 100,
      h: parseFloat(cropConfig.h) || 100,
    };
    return this._save();
  }

  /**
   * Hapus setting crop untuk satu channel
   * @param {string} channelId
   */
  removeChannel(channelId) {
    const id = String(channelId);
    if (this.settings[id]) {
      delete this.settings[id];
      return this._save();
    }
    return false;
  }

  /**
   * Toggle enabled/disabled untuk channel tertentu
   */
  toggleChannel(channelId, enabled) {
    const id = String(channelId);
    if (this.settings[id]) {
      this.settings[id].enabled = Boolean(enabled);
      return this._save();
    }
    return false;
  }

  /**
   * Terapkan crop ke image buffer menggunakan Sharp.
   * Hanya dijalankan jika channel ID punya config crop yang enabled.
   *
   * @param {Buffer} imageBuffer
   * @param {string} mediaType   - hanya berlaku untuk 'photo'
   * @param {string} channelId   - Discord Channel ID untuk lookup config
   * @returns {Promise<Buffer>}
   */
  async applyCrop(imageBuffer, mediaType, channelId) {
    // Hanya proses foto
    if (mediaType !== 'photo') return imageBuffer;

    const config = this.getChannel(channelId);
    if (!config || !config.enabled) return imageBuffer;

    try {
      const meta = await sharp(imageBuffer).metadata();
      const W = meta.width;
      const H = meta.height;

      if (!W || !H) return imageBuffer;

      // Konversi persentase ke piksel
      const left   = Math.max(0, Math.floor((config.x / 100) * W));
      const top    = Math.max(0, Math.floor((config.y / 100) * H));
      const width  = Math.min(W - left, Math.max(1, Math.floor((config.w / 100) * W)));
      const height = Math.min(H - top,  Math.max(1, Math.floor((config.h / 100) * H)));

      if (width <= 0 || height <= 0) return imageBuffer;

      logger.info(`Crop channel ${channelId}: left=${left} top=${top} w=${width} h=${height}`);

      const cropped = await sharp(imageBuffer)
        .extract({ left, top, width, height })
        .toBuffer();

      return cropped;
    } catch (err) {
      logger.warn(`cropManager: gagal crop gambar: ${err.message}`);
      return imageBuffer;
    }
  }
}

module.exports = new CropManager();
