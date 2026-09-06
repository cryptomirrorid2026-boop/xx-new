'use strict';

// ============================================================
//   UTILS / USERRATE LIMITER.JS — Anti Flood per User
//   Jika satu user mengirim > MAX_IMAGES gambar dalam
//   WINDOW_MS milidetik → dianggap flood spam.
// ============================================================

const MAX_IMAGES   = parseInt(process.env.SPAM_RATE_LIMIT     || '3');
const WINDOW_MS    = parseInt(process.env.SPAM_FLOOD_WINDOW_MS || '30000');

// Map<userId, { count: number, resetAt: number }>
const userCounters = new Map();

/**
 * Rekam satu pesan/gambar dari user dan cek apakah flood.
 * @param {string} userId
 * @param {number} mediaCount - jumlah attachment dalam pesan ini
 * @returns {{ flooded: boolean, count: number, max: number }}
 */
function recordAndCheck(userId, mediaCount = 1) {
  const now = Date.now();
  let entry = userCounters.get(userId);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
  }

  entry.count += mediaCount;
  userCounters.set(userId, entry);

  return {
    flooded: entry.count > MAX_IMAGES,
    count:   entry.count,
    max:     MAX_IMAGES,
  };
}

/**
 * Reset counter user (misal setelah diblok, bersihkan datanya)
 */
function reset(userId) {
  userCounters.delete(userId);
}

/**
 * Cleanup entries yang sudah kadaluarsa (panggil periodik)
 */
function cleanup() {
  const now = Date.now();
  for (const [id, entry] of userCounters.entries()) {
    if (now >= entry.resetAt) userCounters.delete(id);
  }
}

// Auto-cleanup tiap 5 menit
setInterval(cleanup, 5 * 60 * 1000);

module.exports = { recordAndCheck, reset, cleanup, MAX_IMAGES, WINDOW_MS };
