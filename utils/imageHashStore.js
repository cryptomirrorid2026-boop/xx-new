'use strict';

// ============================================================
//   UTILS / IMAGEHASHSTORE.JS — Perceptual Image Fingerprint
//   Menyimpan "sidik jari visual" dari gambar spam.
//   Gambar baru yang MIRIP secara visual (> threshold)
//   langsung dikenali sebagai spam tanpa OCR.
//
//   Algoritma: Average Hash (aHash) 8x8 greyscale via sharp
//   Perbandingan: Hamming Distance (jumlah bit berbeda)
//   Threshold: <= 10 bit berbeda = gambar MIRIP (dari 64 bit)
// ============================================================

const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');
const logger = require('./logger');

const STORE_PATH   = path.join(__dirname, '..', 'data', 'spam-hashes.json');
const HASH_SIZE    = 8;   // 8x8 = 64 bit hash
const MAX_DISTANCE = parseInt(process.env.SPAM_HASH_THRESHOLD || '10'); // Bit berbeda

// In-memory store: Array of { hash: string, addedAt: number, label: string }
let hashDb = [];

function _ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _load() {
  try {
    _ensureDir();
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      if (Array.isArray(raw)) hashDb = raw;
    }
  } catch (err) {
    logger.warn('ImageHashStore: Gagal load hash DB', err.message);
  }
}

function _save() {
  try {
    _ensureDir();
    fs.writeFileSync(STORE_PATH, JSON.stringify(hashDb, null, 2));
  } catch (err) {
    logger.warn('ImageHashStore: Gagal simpan hash DB', err.message);
  }
}

/**
 * Hitung Average Hash (aHash) dari image buffer.
 * Returns 64-char binary string ('0' dan '1').
 */
async function computeHash(imageBuffer) {
  try {
    const { data } = await sharp(imageBuffer)
      .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = Array.from(data);
    const avg = pixels.reduce((a, b) => a + b, 0) / pixels.length;

    return pixels.map(p => (p >= avg ? '1' : '0')).join('');
  } catch (err) {
    logger.warn('ImageHashStore: Gagal hitung hash', err.message);
    return null;
  }
}

/**
 * Hitung Hamming Distance antara dua hash string.
 * Lebih rendah = lebih mirip. 0 = identik.
 */
function hammingDistance(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return 64;
  let dist = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) dist++;
  }
  return dist;
}

/**
 * Cek apakah gambar (buffer) mirip dengan hash spam yang tersimpan.
 * @returns {{ matched: boolean, distance: number, label: string|null }}
 */
async function checkImage(imageBuffer) {
  if (hashDb.length === 0) return { matched: false, distance: 64, label: null };

  const hash = await computeHash(imageBuffer);
  if (!hash) return { matched: false, distance: 64, label: null };

  let bestDistance = 64;
  let bestLabel    = null;

  for (const entry of hashDb) {
    const dist = hammingDistance(hash, entry.hash);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestLabel    = entry.label;
    }
  }

  const matched = bestDistance <= MAX_DISTANCE;
  if (matched) {
    logger.info(`ImageHash: Gambar MIRIP spam (distance: ${bestDistance}/${HASH_SIZE * HASH_SIZE}, label: ${bestLabel})`);
  }

  return { matched, distance: bestDistance, label: bestLabel };
}

/**
 * Simpan hash gambar spam baru ke database.
 * @param {Buffer} imageBuffer
 * @param {string} label - deskripsi singkat spam ini
 */
async function addSpamHash(imageBuffer, label = 'spam') {
  const hash = await computeHash(imageBuffer);
  if (!hash) return false;

  // Cek duplikat sebelum simpan
  for (const entry of hashDb) {
    if (hammingDistance(hash, entry.hash) <= 3) {
      logger.info(`ImageHash: Hash mirip sudah ada (label: ${entry.label}), skip.`);
      return false;
    }
  }

  hashDb.push({ hash, label, addedAt: Date.now() });
  _save();
  logger.info(`ImageHash: ✅ Hash spam baru disimpan (label: "${label}", total: ${hashDb.length})`);
  return true;
}

/**
 * Hapus semua hash dari database (reset)
 */
function clearAll() {
  hashDb = [];
  _save();
}

/**
 * Info jumlah hash tersimpan
 */
function stats() {
  return { count: hashDb.length, threshold: MAX_DISTANCE };
}

// Load saat module pertama kali diimport
_load();
logger.info(`ImageHash DB dimuat: ${hashDb.length} hash spam tersimpan (threshold: ${MAX_DISTANCE} bit)`);

module.exports = { computeHash, hammingDistance, checkImage, addSpamHash, clearAll, stats };
