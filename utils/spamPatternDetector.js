'use strict';

// ============================================================
//   UTILS / SPAMPATTERNDETECTOR.JS — Regex Pattern Detector
//   Mendeteksi pola umum spam tanpa perlu tahu kata persisnya:
//     - Nomor WA / HP Indonesia
//     - Link Discord invite
//     - Link Telegram
//     - Kalimat promo / ajakan bergabung
//     - Tanda-tanda jual beli sinyal ilegal
// ============================================================

/**
 * Setiap pattern memiliki:
 *   regex   : RegExp
 *   label   : string  — alasan yang muncul di log
 *   enabled : boolean — bisa di-config dari .env
 */
const PATTERNS = [
  // ── Nomor WA / HP Indonesia ──────────────────────────────
  {
    regex:   /(?:\+62|62|0)8[0-9]{8,12}/g,
    label:   'nomor HP/WA Indonesia',
    key:     'SPAM_BLOCK_PHONE',
    enabled: process.env.SPAM_BLOCK_PHONE !== 'false',
    autoDelete: process.env.AUTO_DELETE_PHONE !== 'false',
  },

  // ── Link Discord invite ──────────────────────────────────
  {
    regex:   /discord\.gg\/[a-zA-Z0-9\-]{2,}/gi,
    label:   'link invite Discord',
    key:     'SPAM_BLOCK_DISCORD_INVITE',
    enabled: process.env.SPAM_BLOCK_DISCORD_INVITE !== 'false',
    autoDelete: process.env.AUTO_DELETE_DISCORD_INVITE !== 'false',
  },

  // ── Link Telegram ─────────────────────────────────────────
  {
    regex:   /(?:t\.me|telegram\.me)\/[a-zA-Z0-9_\-]{3,}/gi,
    label:   'link Telegram',
    key:     'SPAM_BLOCK_TG_LINK',
    enabled: process.env.SPAM_BLOCK_TG_LINK === 'true', // default OFF (banyak false positive)
    autoDelete: process.env.AUTO_DELETE_TG_LINK !== 'false',
  },

  // ── Kalimat promo khas spammer ───────────────────────────
  {
    regex:   /(?:join|gabung|daftar)\s+(?:sekarang|gratis|kami|kita|di sini|disini)/gi,
    label:   'kalimat ajakan spam',
    key:     'SPAM_BLOCK_PROMO',
    enabled: process.env.SPAM_BLOCK_PROMO !== 'false',
    autoDelete: process.env.AUTO_DELETE_PROMO !== 'false',
  },

  // ── Klaim palsu / penipuan ───────────────────────────────
  {
    regex:   /(?:mirror\s+bodong|asli\s+hanya\s+di|bukan\s+asli|hati[\s-]+hati\s+(?:jika|dengan)\s+(?:melihat|ada))/gi,
    label:   'klaim penipuan mirror',
    key:     'SPAM_BLOCK_FAKE_MIRROR',
    enabled: process.env.SPAM_BLOCK_FAKE_MIRROR !== 'false',
    autoDelete: process.env.AUTO_DELETE_FAKE_MIRROR !== 'false',
  },

  // ── Nomor WA dalam format gambar / OCR (dengan spasi) ───
  {
    regex:   /0\s*8\s*9\s*[\s\-]?7\s*7\s*7\s*[\s\-]?\d{4,6}/g,
    label:   'nomor WA format spam',
    key:     'SPAM_BLOCK_WA_PATTERN',
    enabled: process.env.SPAM_BLOCK_WA_PATTERN !== 'false',
    autoDelete: process.env.AUTO_DELETE_WA_PATTERN !== 'false',
  },

  // ── Kata "BODONG" dikombinasikan konteks keuangan ────────
  {
    regex:   /bodong/gi,
    label:   'kata "bodong"',
    key:     'SPAM_BLOCK_BODONG',
    enabled: process.env.SPAM_BLOCK_BODONG !== 'false',
    autoDelete: process.env.AUTO_DELETE_BODONG !== 'false',
  },
];

/**
 * Cek apakah teks mengandung pola spam.
 * @param {string} text
 * @returns {{ detected: boolean, label: string|null, match: string|null, autoDelete: boolean }}
 */
function detect(text) {
  if (!text) return { detected: false, label: null, match: null, autoDelete: false };

  for (const pattern of PATTERNS) {
    if (!pattern.enabled) continue;

    const match = text.match(pattern.regex);
    if (match) {
      return { 
        detected: true, 
        label: pattern.label, 
        match: match[0],
        autoDelete: pattern.autoDelete !== false // ensure boolean
      };
    }
  }

  return { detected: false, label: null, match: null, autoDelete: false };
}

/**
 * Kembalikan semua pola yang aktif (untuk logging/dashboard)
 */
function listPatterns() {
  return PATTERNS.map(p => ({
    key:     p.key,
    label:   p.label,
    enabled: p.enabled,
    regex:   p.regex.toString(),
  }));
}

module.exports = { detect, listPatterns };
