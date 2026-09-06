// ============================================================
//   UTILS / WATERMARKMANAGER.JS
//   Menangani penambahan gambar watermark ke media (foto)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const logger = require('./logger');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'watermark-settings.json');
const WATERMARK_IMAGE = path.join(__dirname, '..', 'data', 'watermark.png');

class WatermarkManager {
  constructor() {
    this.settings = {
      enabled: false,
      position: 'bottom-right', // top-left, top-right, bottom-left, bottom-right, center
      sizePercent: 20,          // Ukuran watermark relatif terhadap lebar gambar utama (20%)
      opacity: 0.8              // Transparansi watermark
    };
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
        this.settings = { ...this.settings, ...JSON.parse(raw) };
      }
    } catch (err) {
      logger.warn('Gagal membaca watermark-settings.json', err.message);
    }
  }

  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2), 'utf-8');
      return true;
    } catch (err) {
      logger.error('Gagal menyimpan watermark-settings.json', err.message);
      return false;
    }
  }

  getSettings() {
    return {
      ...this.settings,
      hasImage: fs.existsSync(WATERMARK_IMAGE)
    };
  }

  /**
   * Terapkan watermark dan blur ke image buffer menggunakan Sharp
   * @param {Buffer} imageBuffer
   * @param {string} mediaType
   * @param {string} channelId - Optional, untuk per-channel blur settings
   */
  async applyWatermark(imageBuffer, mediaType, channelId = '') {
    if (mediaType !== 'photo' || !this.settings.enabled) {
      return imageBuffer;
    }

    try {
      const mainImage = sharp(imageBuffer);
      const metadata = await mainImage.metadata();
      const mainW = metadata.width;
      const mainH = metadata.height;

      if (!mainW || !mainH) return imageBuffer;

      const composites = [];

      // 1. Terapkan efek Blur/Pixelate pada area yang dipilih
      // Ambil boxes dari settings global
      let boxesToApply = (this.settings.blurBoxes && Array.isArray(this.settings.blurBoxes)) ? [...this.settings.blurBoxes] : [];
      
      // Jika ada channelId, kita bisa kembangkan untuk meload channel-specific boxes
      // Untuk saat ini kita optimalkan perhitungan box agar 'smart' (anchor-based)
      
      for (const box of boxesToApply) {
        let bx, by, bw, bh;
        
        // Default anchor: top-left
        const anchor = box.anchor || 'top-left';
        
        // Hitung lebar dan tinggi box dalam piksel
        bw = Math.floor((box.w / 100) * mainW);
        bh = Math.floor((box.h / 100) * mainH);
        
        // Hitung posisi X dan Y berdasarkan anchor
        if (anchor === 'bottom-right') {
          bx = mainW - Math.floor((box.x / 100) * mainW) - bw;
          by = mainH - Math.floor((box.y / 100) * mainH) - bh;
        } else if (anchor === 'bottom-left') {
          bx = Math.floor((box.x / 100) * mainW);
          by = mainH - Math.floor((box.y / 100) * mainH) - bh;
        } else if (anchor === 'top-right') {
          bx = mainW - Math.floor((box.x / 100) * mainW) - bw;
          by = Math.floor((box.y / 100) * mainH);
        } else { // top-left
          bx = Math.floor((box.x / 100) * mainW);
          by = Math.floor((box.y / 100) * mainH);
        }

        // Penyesuaian agar tidak keluar batas
        bx = Math.max(0, Math.min(bx, mainW - 1));
        by = Math.max(0, Math.min(by, mainH - 1));
        bw = Math.min(bw, mainW - bx);
        bh = Math.min(bh, mainH - by);

        if (bw > 1 && bh > 1) {
          try {
            // Gunakan native blur dari Sharp
            const regionBuffer = await sharp(imageBuffer)
              .extract({ left: bx, top: by, width: bw, height: bh })
              .blur(30) // Tingkatkan sedikit blurnya
              .toBuffer();

            composites.push({
              input: regionBuffer,
              left: bx,
              top: by
            });
            logger.info(`Terapkan smart blur (${anchor}) di X:${bx} Y:${by} W:${bw} H:${bh}`);
          } catch (err) {
            logger.warn(`Gagal memproses blur area: ${err.message}`);
          }
        }
      }

      // 2. Terapkan Watermark Logo jika file ada
      if (fs.existsSync(WATERMARK_IMAGE)) {
        try {
          const targetWidth = Math.max(10, Math.floor(mainW * ((this.settings.sizePercent || 20) / 100)));
          
          let wmBuffer = await sharp(WATERMARK_IMAGE)
            .resize({ width: targetWidth })
            .ensureAlpha()
            .toBuffer();

          // Terapkan opacity jika tidak 1.0
          const opacity = this.settings.opacity !== undefined ? this.settings.opacity : 0.8;
          if (opacity < 1.0) {
             wmBuffer = await sharp(wmBuffer)
               .composite([{
                  input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]),
                  raw: { width: 1, height: 1, channels: 4 },
                  tile: true,
                  blend: 'dest-in'
               }])
               .toBuffer();
          }

          const wmMeta = await sharp(wmBuffer).metadata();
          const wmstrW = wmMeta.width;
          const wmstrH = wmMeta.height;

          let x = 0, y = 0;
          if (this.settings.customPosition) {
            x = Math.floor((this.settings.customPosition.x / 100) * mainW);
            y = Math.floor((this.settings.customPosition.y / 100) * mainH);
          } else {
            // Fallback bottom-right
            const padding = Math.floor(mainW * 0.02);
            x = mainW - wmstrW - padding;
            y = mainH - wmstrH - padding;
          }

          x = Math.max(0, Math.min(x, mainW - wmstrW));
          y = Math.max(0, Math.min(y, mainH - wmstrH));

          composites.push({
            input: wmBuffer,
            left: x,
            top: y
          });
        } catch(err) {
           logger.warn(`Gagal load watermark logo: ${err.message}`);
        }
      }

      if (composites.length === 0) return imageBuffer;

      // Gabungkan semuanya
      return await mainImage
        .composite(composites)
        .toBuffer();

    } catch (err) {
      logger.warn(`Gagal memproses gambar (watermark/blur): ${err.message}`);
      return imageBuffer;
    }
  }
}

module.exports = new WatermarkManager();

