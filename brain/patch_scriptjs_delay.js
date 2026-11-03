/**
 * PATCH SCRIPT: script.js — UI for per-channel and per-category delay
 * Uses pure string operations (no template literals that contain ${})
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'script.js');
let src = fs.readFileSync(FILE, 'utf8');

if (src.includes('btn-set-delay') || src.includes('cat-delay-input')) {
  console.log('script.js sudah di-patch (skip)');
  process.exit(0);
}

let patchCount = 0;

// ── PATCH A: Tambah kolom "Delay" di header tabel channel ──
const thOld = '<th>Status</th>\r\n                                 <th>Actions</th>';
const thNew = '<th>Delay</th>\r\n                                 <th>Status</th>\r\n                                 <th>Actions</th>';
if (src.includes(thOld)) {
  src = src.replace(thOld, thNew);
  patchCount++;
  console.log('✅ Patch A: kolom Delay di thead');
} else {
  // try LF only
  const thOldLF = '<th>Status</th>\n                                 <th>Actions</th>';
  const thNewLF = '<th>Delay</th>\n                                 <th>Status</th>\n                                 <th>Actions</th>';
  if (src.includes(thOldLF)) {
    src = src.replace(thOldLF, thNewLF);
    patchCount++;
    console.log('✅ Patch A (LF): kolom Delay di thead');
  } else {
    console.error('❌ Patch A gagal: thead target tidak ditemukan');
  }
}

// ── PATCH B: Tambah cell delay sebelum cell Status di tiap baris channel ──
// Kita cari pattern unik yang ada di setiap row: tag status cell
const statusCellStart = "                                     <td>${isMuted ? '<span class=\"tag muted-tag\">🔇 Muted</span>' : '<span class=\"tag\" style=\"background:rgba(16,185,129,.1);color:var(--success-color)\">🟢 Active</span>'}</td>";

const delayCellHtml = [
  '                                     <td>',
  '                                        <div class="delay-cell" style="display:flex;align-items:center;gap:5px;min-width:110px;">',
  '                                          <input type="number" min="0" step="1" class="delay-input-ch" data-id="${ch.discordId}"',
  '                                            value="${typeof ch.forwardDelayMs === \'number\' && ch.forwardDelayMs >= 0 ? Math.round(ch.forwardDelayMs/1000) : \'\'}"',
  '                                            placeholder="cat" title="Delay (detik). Kosong = ikut delay kategori"',
  '                                            style="width:65px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.3);color:inherit;font-size:0.8rem;text-align:center;">',
  '                                          <span style="font-size:0.72rem;color:var(--text-secondary)">s</span>',
  '                                          <button class="btn-set-delay" data-id="${ch.discordId}" title="Simpan delay"',
  '                                            style="padding:3px 6px;border-radius:5px;border:1px solid rgba(14,165,233,0.35);background:rgba(14,165,233,0.12);color:#38bdf8;cursor:pointer;font-size:0.76rem;">',
  '                                            <i class=\'bx bx-save\'></i>',
  '                                          </button>',
  '                                        </div>',
  '                                     </td>',
].join('\r\n');

if (src.includes(statusCellStart)) {
  src = src.replace(statusCellStart, delayCellHtml + '\r\n' + statusCellStart);
  patchCount++;
  console.log('✅ Patch B: delay cell per channel row');
} else {
  console.error('❌ Patch B gagal: status cell target tidak ditemukan');
  // Debug: cari terdekat
  const idx = src.indexOf("isMuted ? '<span class=\"tag muted-tag\">");
  console.log('  Debug: isMuted index =', idx);
}

// ── PATCH C: Tambah delay input di category header (sebelum Rename button) ──
const renameBtn = '                    <button class="btn-secondary btn-sm btn-cat-rename" data-category="${escapeHtml(catName)}" title="Ubah Nama Kategori" style="font-size:0.75rem; padding:4px 9px;">';

const catDelayWidget = [
  '                    <span class="cat-delay-wrapper" style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);border-radius:7px;padding:3px 8px;" title="Delay kategori (detik, 0=tanpa delay)">',
  '                        <i class=\'bx bx-time-five\' style="color:#a78bfa;font-size:0.9rem;"></i>',
  '                        <input type="number" min="0" step="1" class="cat-delay-input" data-category="${escapeHtml(catName)}"',
  '                          placeholder="0" title="Delay kategori (detik)"',
  '                          style="width:52px;padding:2px 4px;border-radius:5px;border:1px solid rgba(167,139,250,0.3);background:rgba(0,0,0,0.3);color:inherit;font-size:0.78rem;text-align:center;">',
  '                        <span style="font-size:0.7rem;color:var(--text-secondary)">s</span>',
  '                        <button class="btn-save-cat-delay" data-category="${escapeHtml(catName)}" title="Simpan delay kategori"',
  '                          style="padding:2px 6px;border-radius:5px;border:1px solid rgba(167,139,250,0.3);background:rgba(167,139,250,0.12);color:#a78bfa;cursor:pointer;font-size:0.76rem;">',
  '                          <i class=\'bx bx-save\'></i>',
  '                        </button>',
  '                    </span>',
].join('\r\n');

if (src.includes(renameBtn)) {
  src = src.replace(renameBtn, catDelayWidget + '\r\n' + renameBtn);
  patchCount++;
  console.log('✅ Patch C: delay widget di category header');
} else {
  console.error('❌ Patch C gagal: rename button target tidak ditemukan');
}

// ── PATCH D: Tambah event listeners untuk btn-set-delay dan btn-save-cat-delay ──
const editChTarget = "    // Edit channel\r\n    document.querySelectorAll('.btn-edit-ch').forEach";
const editChTargetLF = "    // Edit channel\n    document.querySelectorAll('.btn-edit-ch').forEach";

const delayListeners = `    // ── Delay per-channel: simpan saat tombol save diklik ──
    document.querySelectorAll('.btn-set-delay').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id  = btn.dataset.id;
            const inp = document.querySelector('.delay-input-ch[data-id="' + id + '"]');
            const valStr = (inp && inp.value !== undefined ? inp.value : '').trim();
            const delayMs = valStr === '' ? -1 : Math.max(0, Math.round(Number(valStr) * 1000));
            try {
                const resp = await fetch(API + '/channels/' + id + '/delay', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ delayMs: delayMs })
                });
                if (!resp.ok) throw new Error(await resp.text());
                const label = delayMs < 0 ? 'ikut kategori' : (delayMs === 0 ? 'tanpa delay' : valStr + 's');
                showToast('Delay channel diset: ' + label, 'success');
                loadChannels();
            } catch (err) { showToast('Gagal simpan delay: ' + err.message, 'error'); }
        });
    });

    // ── Delay per-kategori: simpan saat tombol save diklik ──
    document.querySelectorAll('.btn-save-cat-delay').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const cat = btn.dataset.category;
            const inp = document.querySelector('.cat-delay-input[data-category="' + cat + '"]');
            const valStr = (inp && inp.value !== undefined ? inp.value : '0').trim();
            const delayMs = Math.max(0, Math.round(Number(valStr || 0) * 1000));
            try {
                const resp = await fetch(API + '/categories/' + encodeURIComponent(cat) + '/delay', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ delayMs: delayMs })
                });
                if (!resp.ok) throw new Error(await resp.text());
                const label = delayMs === 0 ? 'tanpa delay' : valStr + 's';
                showToast('Delay kategori "' + cat + '": ' + label, 'success');
            } catch (err) { showToast('Gagal simpan delay kategori: ' + err.message, 'error'); }
        });
    });

`;

if (src.includes(editChTarget)) {
  src = src.replace(editChTarget, delayListeners + editChTarget);
  patchCount++;
  console.log('✅ Patch D: event listeners delay');
} else if (src.includes(editChTargetLF)) {
  src = src.replace(editChTargetLF, delayListeners + editChTargetLF);
  patchCount++;
  console.log('✅ Patch D (LF): event listeners delay');
} else {
  console.error('❌ Patch D gagal: edit channel target tidak ditemukan');
}

// ── PATCH E: Load category delays dan isi value input setelah render ──
const wireUpTarget = "    // Wire-up event buttons di dalam tabel\r\n    attachChannelActionListeners();";
const wireUpTargetLF = "    // Wire-up event buttons di dalam tabel\n    attachChannelActionListeners();";

const catDelayLoader = `    // Load & isi nilai delay kategori di input
    fetch(API + '/categories/delays').then(function(r) { return r.json(); }).then(function(delayMap) {
        document.querySelectorAll('.cat-delay-input').forEach(function(inp) {
            var cat = inp.dataset.category;
            if (delayMap[cat] !== undefined) {
                var secs = Math.round(delayMap[cat] / 1000);
                inp.value = secs > 0 ? secs : '';
            }
        });
    }).catch(function() {});

`;

if (src.includes(wireUpTarget)) {
  src = src.replace(wireUpTarget, catDelayLoader + wireUpTarget);
  patchCount++;
  console.log('✅ Patch E: load category delays');
} else if (src.includes(wireUpTargetLF)) {
  src = src.replace(wireUpTargetLF, catDelayLoader + wireUpTargetLF);
  patchCount++;
  console.log('✅ Patch E (LF): load category delays');
} else {
  console.error('❌ Patch E gagal: wireUp target tidak ditemukan');
}

// ── Save ──
const tmpFile = FILE + '.tmp';
fs.writeFileSync(tmpFile, src, 'utf8');
fs.renameSync(tmpFile, FILE);

console.log('');
console.log('Patches applied: ' + patchCount + '/5');
if (patchCount >= 4) {
  console.log('🎉 script.js berhasil di-patch!');
} else {
  console.log('⚠️  Beberapa patch gagal');
  process.exit(1);
}

