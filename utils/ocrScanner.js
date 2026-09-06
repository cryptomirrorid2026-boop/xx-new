'use strict';

// ============================================================
//   UTILS / OCRSCANNER.JS — v2 (GODMODE Edition)
//   OCR scan gambar untuk mendeteksi teks spam.
//   + Setelah spam ditemukan, simpan hash gambar ke imageHashStore
//     agar gambar serupa langsung terblokir di masa depan.
// ============================================================

const axios  = require('axios');
const sharp  = require('sharp');
const logger = require('./logger');

let tesseractWorker  = null;
let tesseractReady   = false;
let tesseractLoading = false;

async function getOcrWorker() {
  if (tesseractReady && tesseractWorker) return tesseractWorker;
  if (tesseractLoading) {
    await new Promise(resolve => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (tesseractReady || !tesseractLoading || attempts > 50) {
          clearInterval(interval);
          resolve();
        }
      }, 200);
    });
    return tesseractReady ? tesseractWorker : null;
  }

  tesseractLoading = true;
  try {
    const { createWorker } = require('tesseract.js');
    tesseractWorker = await createWorker('eng', 1, {
      logger:       () => {},
      errorHandler: () => {},
    });
    tesseractReady   = true;
    tesseractLoading = false;
    logger.info('✅ Tesseract OCR Scanner siap untuk deteksi spam.');
  } catch (err) {
    tesseractLoading = false;
    tesseractReady   = false;
    tesseractWorker  = null;
    logger.error('❌ Gagal init Tesseract OCR Scanner:', err.message);
    return null;
  }
  return tesseractWorker;
}

/**
 * Scan gambar dengan OCR. Jika mengandung kata blacklist:
 *   1. Kembalikan kata yang ditemukan
 *   2. Simpan hash gambar ke imageHashStore (learn dari spam ini)
 *
 * @param {object} attachment - Discord attachment object
 * @param {string[]} blacklistWords
 * @returns {string|false} - kata blacklist yang ditemukan, atau false
 */
async function isSpamImage(attachment, blacklistWords) {
  if (!blacklistWords || blacklistWords.length === 0) return false;

  const ct   = attachment.contentType || '';
  const name = (attachment.name || '').toLowerCase();

  // Hanya proses gambar standar
  if (!ct.startsWith('image/') && !/\.(jpg|jpeg|png|webp|bmp)$/i.test(name)) return false;

  // Skip jika gambar terlalu besar
  if (attachment.size > 10 * 1024 * 1024) return false;

  let buffer;
  try {
    const res = await axios.get(attachment.url, {
      responseType: 'arraybuffer',
      timeout:       10000,
    });
    buffer = Buffer.from(res.data);
  } catch (err) {
    logger.warn('OCR Scanner: Gagal download gambar', err.message);
    return false;
  }

  // ── Step 1: Cek Image Hash Database dulu (lebih cepat dari OCR) ──
  try {
    const imageHashStore = require('./imageHashStore');
    const { matched, distance, label } = await imageHashStore.checkImage(buffer);
    const envManager = require('./envManager');
    const env = envManager.readEnv();
    
    if (matched) {
      logger.info(`OCR Scanner: Gambar cocok dengan hash spam (dist: ${distance}, label: ${label})`);
      return { 
        reason: label || 'spam (visual match)', 
        autoDelete: env.AUTO_DELETE_HASH !== 'false', 
        fromPattern: false 
      };
    }
  } catch (err) {
    logger.warn('OCR Scanner: Image hash check error', err.message);
  }

  // ── Step 2: OCR Text Scan ─────────────────────────────────────────
  const worker = await getOcrWorker();
  if (!worker) return false;

  try {
    // Resize untuk OCR yang lebih cepat & akurat
    const meta = await sharp(buffer).metadata();
    let ocrBuffer = buffer;
    if (meta.width > 1200 || meta.height > 1200) {
      ocrBuffer = await sharp(buffer).resize({ width: 1200, withoutEnlargement: true }).toBuffer();
    }

    const { data } = await worker.recognize(ocrBuffer);
    const text = (data.text || '').toLowerCase();

    for (const word of blacklistWords) {
      if (text.includes(word.toLowerCase())) {
        // Spam ditemukan via OCR → simpan hash agar gambar serupa langsung diblokir
        try {
          const imageHashStore = require('./imageHashStore');
          await imageHashStore.addSpamHash(buffer, word);
        } catch (_) {}
        const envManager = require('./envManager');
        const env = envManager.readEnv();
        return { 
          reason: word, 
          autoDelete: env.AUTO_DELETE_BLACKLIST !== 'false', 
          fromPattern: false 
        };
      }
    }

    // ── Step 3: Cek Regex Pattern pada hasil OCR ──────────────────────
    try {
      const spamPattern = require('./spamPatternDetector');
      const result = spamPattern.detect(text);
      if (result.detected) {
        try {
          const imageHashStore = require('./imageHashStore');
          await imageHashStore.addSpamHash(buffer, result.label);
        } catch (_) {}
        return { 
          reason: result.label, 
          autoDelete: result.autoDelete, 
          fromPattern: true 
        };
      }
    } catch (err) {
      logger.warn('OCR Scanner: Regex pattern error', err.message);
    }

  } catch (err) {
    logger.error('OCR Scanner: Recognition error', err.message);
  }

  return false;
}

module.exports = { isSpamImage };
