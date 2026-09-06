// ============================================================
//   UTILS / WORDFILTERNANAGER.JS
//   Menyimpan & mengelola daftar kata/frasa terlarang.
//   Data disimpan di data/word-filter.json
//   Fitur: filter partial (hanya hapus kata terlarang, pesan
//          lain tetap diteruskan)
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'word-filter.json');

// ─── Default state ────────────────────────────────────────────
let state = {
  enabled: false,       // Aktifkan filter partial
  words: [],            // Array of string (kata/frasa terlarang)
  logFiltered: true,    // Log pesan yang sudah difilter
};

// ─── Strip karakter invisible (zero-width, dsb) ───────────────
function stripInvisible(str) {
  // Hapus zero-width space, zero-width joiner, zero-width non-joiner,
  // word joiner, invisible separator, left-to-right mark, dll.
  return str.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');
}

// ─── Load dari disk ───────────────────────────────────────────
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      state = { ...state, ...parsed };
      // Pastikan words adalah array
      if (!Array.isArray(state.words)) state.words = [];
    }
  } catch (err) {
    console.error('[WordFilter] Gagal load:', err.message);
  }
}

// ─── Simpan ke disk ───────────────────────────────────────────
function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[WordFilter] Gagal simpan:', err.message);
    return false;
  }
}

// ─── Load on startup ─────────────────────────────────────────
load();

// ─── Public API ───────────────────────────────────────────────

/** Dapatkan semua settings */
function getSettings() {
  return { ...state, wordCount: state.words.length };
}

/** Update settings (enabled, logFiltered) */
function updateSettings(updates) {
  if (updates.enabled   !== undefined) state.enabled   = !!updates.enabled;
  if (updates.logFiltered !== undefined) state.logFiltered = !!updates.logFiltered;
  return save();
}

/** Tambah kata/frasa terlarang */
function addWord(word) {
  const w = stripInvisible(word.trim());
  if (!w) return false;
  // Hindari duplikat (case-insensitive check)
  const lc = w.toLowerCase();
  if (state.words.some(x => stripInvisible(x).toLowerCase() === lc)) return false;
  state.words.push(w);
  return save();
}

/** Hapus kata/frasa terlarang berdasarkan index */
function removeWord(index) {
  const idx = parseInt(index);
  if (isNaN(idx) || idx < 0 || idx >= state.words.length) return false;
  state.words.splice(idx, 1);
  return save();
}

/** Ganti seluruh daftar kata */
function setWords(words) {
  if (!Array.isArray(words)) return false;
  state.words = words.map(w => stripInvisible(String(w).trim())).filter(Boolean);
  return save();
}

/**
 * Filter pesan: hapus hanya bagian kata/frasa terlarang
 * @param {string} content - Isi pesan asli
 * @returns {{ filtered: boolean, result: string, removedWords: string[] }}
 */
function filterContent(content) {
  if (!state.enabled || !content || state.words.length === 0) {
    return { filtered: false, result: content, removedWords: [] };
  }

  // Strip invisible chars dari content juga agar bisa dicocokkan
  let result = content;
  const cleanContent = stripInvisible(content);
  const removedWords = [];

  // Sort by length descending agar frasa panjang diproses duluan
  const sortedWords = [...state.words].sort((a, b) => b.length - a.length);

  for (const word of sortedWords) {
    // Strip invisible chars dari kata terlarang sebelum buat regex
    const cleanWord = stripInvisible(word);
    if (!cleanWord) continue;

    // Escape semua special regex chars dengan benar
    const escaped = cleanWord.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');

    // Cek apakah kata ini ada di dalam hasil (pakai versi clean untuk match)
    const plainRegex = new RegExp(escaped, 'gi');
    let matched = false;

    // Kerja pada versi clean untuk deteksi, hapus dari result asli
    let cleanResult = stripInvisible(result);

    // ── 1. Hapus pola Discord markdown yang MENGANDUNG kata ini ──────────────
    // Format: [`teks mengandung kata`](url)  atau  [teks mengandung kata](url)
    const mdPattern = `\\[\`?[^\\]]*${escaped}[^\\]]*\`?\\]\\(<[^)]+>\\)|\\[\`?[^\\]]*${escaped}[^\\]]*\`?\\]\\([^)]+\\)`;
    const discordMdRegex = new RegExp(mdPattern, 'gi');
    if (discordMdRegex.test(cleanResult)) {
      // Hapus dari result asli menggunakan posisi yang sama
      result = stripInvisible(result).replace(new RegExp(mdPattern, 'gi'), '');
      matched = true;
    }

    // ── 2. Hapus kata biasa yang masih tersisa ────────────────────────────────
    cleanResult = stripInvisible(result);
    if (plainRegex.test(cleanResult)) {
      result = cleanResult.replace(new RegExp(escaped, 'gi'), '');
      matched = true;
    }

    if (matched) removedWords.push(word);
  }

  // Bersihkan spasi & baris kosong berlebih setelah penghapusan
  result = result
    .replace(/[ \t]{2,}/g, ' ')   // spasi ganda → satu spasi
    .replace(/\n{3,}/g, '\n\n')   // lebih dari 2 newline → 2 newline
    .trim();

  const filtered = removedWords.length > 0;
  return { filtered, result, removedWords };
}

/**
 * Test filter: simulasikan filter pada teks tertentu
 * @returns {{ original: string, result: string, removedWords: string[], hasContent: boolean }}
 */
function testFilter(text) {
  const { result, removedWords } = filterContent(text);
  return {
    original: text,
    result,
    removedWords,
    hasContent: result.trim().length > 0,
  };
}

module.exports = {
  getSettings,
  updateSettings,
  addWord,
  removeWord,
  setWords,
  filterContent,
  testFilter,
};
