/**
 * PATCH SCRIPT v2: script.js — Fix Patch A & B yang gagal
 * Menggunakan indexOf untuk menemukan exact position
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'script.js');
let src = fs.readFileSync(FILE, 'utf8');

let changed = false;

// ── PATCH A: Tambah kolom Delay di thead ──
// Cari <th>Status</th> diikuti whitespace + <th>Actions</th>
const thStatusIdx = src.indexOf('<th>Status</th>');
if (thStatusIdx >= 0) {
  const thActionsIdx = src.indexOf('<th>Actions</th>', thStatusIdx);
  if (thActionsIdx >= 0 && thActionsIdx - thStatusIdx < 200) {
    // Cek apakah <th>Delay</th> sudah ada di antara
    const between = src.substring(thStatusIdx, thActionsIdx);
    if (!between.includes('Delay')) {
      // Insert <th>Delay</th> sebelum <th>Status</th> pada baris yang sama indentasinya
      // Cari awal baris <th>Status
      const lineStart = src.lastIndexOf('\n', thStatusIdx) + 1;
      const indent = src.substring(lineStart, thStatusIdx);
      const insertStr = indent + '<th>Delay</th>\r\n';
      src = src.substring(0, lineStart) + insertStr + src.substring(lineStart);
      changed = true;
      console.log('✅ Patch A: kolom Delay di thead');
    } else {
      console.log('⏭️  Patch A: sudah ada');
    }
  }
} else {
  console.error('❌ Patch A: <th>Status</th> tidak ditemukan');
}

// ── PATCH B: Tambah delay cell sebelum status cell ──
// Cari pattern: <td>${isMuted ? '<span class="tag muted-tag">
const mutedPatternStr = "${isMuted ? '<span class=\"tag muted-tag\">";
const mutedIdx = src.indexOf(mutedPatternStr);
if (mutedIdx >= 0) {
  // Mundur ke <td> sebelumnya
  const tdStart = src.lastIndexOf('<td>', mutedIdx);
  if (tdStart >= 0 && mutedIdx - tdStart < 10) {
    // Cek apakah delay-input-ch sudah ada sebelumnya
    const checkRange = src.substring(Math.max(0, tdStart - 500), tdStart);
    if (checkRange.includes('delay-input-ch')) {
      console.log('⏭️  Patch B: sudah ada');
    } else {
      // Cari awal baris <td>
      const lineStart = src.lastIndexOf('\n', tdStart) + 1;
      const indent = src.substring(lineStart, tdStart);
      
      const delayCellLines = [
        indent + '<td>',
        indent + '  <div class="delay-cell" style="display:flex;align-items:center;gap:5px;min-width:110px;">',
        indent + '    <input type="number" min="0" step="1" class="delay-input-ch" data-id="${ch.discordId}"',
        indent + "      value=\"${typeof ch.forwardDelayMs === 'number' && ch.forwardDelayMs >= 0 ? Math.round(ch.forwardDelayMs/1000) : ''}\"",
        indent + '      placeholder="cat" title="Delay (detik). Kosong = ikut delay kategori"',
        indent + '      style="width:65px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.3);color:inherit;font-size:0.8rem;text-align:center;">',
        indent + '    <span style="font-size:0.72rem;color:var(--text-secondary)">s</span>',
        indent + '    <button class="btn-set-delay" data-id="${ch.discordId}" title="Simpan delay"',
        indent + '      style="padding:3px 6px;border-radius:5px;border:1px solid rgba(14,165,233,0.35);background:rgba(14,165,233,0.12);color:#38bdf8;cursor:pointer;font-size:0.76rem;">',
        indent + "      <i class='bx bx-save'></i>",
        indent + '    </button>',
        indent + '  </div>',
        indent + '</td>',
      ].join('\r\n');
      
      src = src.substring(0, lineStart) + delayCellLines + '\r\n' + src.substring(lineStart);
      changed = true;
      console.log('✅ Patch B: delay cell per channel row');
    }
  }
} else {
  console.error('❌ Patch B: muted pattern tidak ditemukan');
}

if (changed) {
  const tmpFile = FILE + '.tmp';
  fs.writeFileSync(tmpFile, src, 'utf8');
  fs.renameSync(tmpFile, FILE);
  console.log('\n🎉 script.js berhasil di-update!');
} else {
  console.log('\nTidak ada perubahan yang perlu dilakukan.');
}

