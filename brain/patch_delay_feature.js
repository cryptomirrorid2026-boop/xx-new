/**
 * PATCH SCRIPT: Per-Channel & Per-Category Forward Delay Feature
 * 
 * Files modified:
 *  1. utils/channelStore.js        — tambah forwardDelayMs per channel + categoryDelays
 *  2. handlers/messageHandler.js   — apply delay sebelum doForward()
 *  3. utils/webServer.js           — API endpoints PATCH delay
 *  4. public/script.js             — UI delay input per channel row + category header
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}
function writeFile(relPath, content) {
  const tmpPath = path.join(ROOT, relPath) + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, path.join(ROOT, relPath));
  console.log(`✅ Patched: ${relPath}`);
}

let errors = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 1: channelStore.js — tambah forwardDelayMs + categoryDelays
// ═══════════════════════════════════════════════════════════════════════════════
(function patchChannelStore() {
  let src = readFile('utils/channelStore.js');

  // Cek apakah sudah di-patch
  if (src.includes('forwardDelayMs') && src.includes('categoryDelays')) {
    console.log('⏭️  channelStore.js sudah di-patch (skip)');
    return;
  }

  // 1a. Tambah CATEGORY_DELAYS_FILE constant setelah CATEGORIES_FILE
  src = src.replace(
    "const CATEGORIES_FILE = path.join(__dirname, '..', 'data', 'categories.json');",
    `const CATEGORIES_FILE    = path.join(__dirname, '..', 'data', 'categories.json');
const CAT_DELAYS_FILE    = path.join(__dirname, '..', 'data', 'categoryDelays.json');`
  );
  if (!src.includes('CAT_DELAYS_FILE')) { console.error('❌ channelStore patch 1a gagal'); errors++; return; }

  // 1b. Tambah categoryDelays Map di constructor
  src = src.replace(
    "this.customCategories = new Set(['General']); // Set of category names",
    `this.customCategories = new Set(['General']); // Set of category names
    this.categoryDelays   = new Map();            // Map<categoryName, delayMs>`
  );

  // 1c. Tambah load categoryDelays di _load()
  src = src.replace(
    "    try {\n      if (fs.existsSync(CATEGORIES_FILE)) {",
    `    // Load category delays
    try {
      if (fs.existsSync(CAT_DELAYS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CAT_DELAYS_FILE, 'utf-8'));
        if (raw && typeof raw === 'object') {
          this.categoryDelays = new Map(Object.entries(raw).map(([k,v]) => [k, Number(v) || 0]));
        }
      }
    } catch (_) {}

    try {
      if (fs.existsSync(CATEGORIES_FILE)) {`
  );

  // 1d. Tambah forwardDelayMs di schema _load()
  src = src.replace(
    "            dcStripInvites: ch.dcStripInvites !== false,\n          }));\n          return true;",
    `            dcStripInvites: ch.dcStripInvites !== false,
            forwardDelayMs: typeof ch.forwardDelayMs === 'number' ? ch.forwardDelayMs : -1,
          }));
          return true;`
  );

  // 1e. Tambah forwardDelayMs di add()
  src = src.replace(
    "      dcOnlyWithMedia: channel.dcOnlyWithMedia === true,\n      dcStripInvites: channel.dcStripInvites !== false,\n    };\n\n    const idx = this.channels.findIndex",
    `      dcOnlyWithMedia: channel.dcOnlyWithMedia === true,
      dcStripInvites: channel.dcStripInvites !== false,
      forwardDelayMs: typeof channel.forwardDelayMs === 'number' ? channel.forwardDelayMs : -1,
    };

    const idx = this.channels.findIndex`
  );

  // 1f. Tambah forwardDelayMs di _rebuildMap()
  src = src.replace(
    "        dcOnlyWithMedia: ch.dcOnlyWithMedia === true,\n        dcStripInvites: ch.dcStripInvites !== false,\n        name:       ch.name,",
    `        dcOnlyWithMedia: ch.dcOnlyWithMedia === true,
        dcStripInvites: ch.dcStripInvites !== false,
        forwardDelayMs: typeof ch.forwardDelayMs === 'number' ? ch.forwardDelayMs : -1,
        name:       ch.name,`
  );

  // 1g. Tambah method _saveCategoryDelays() setelah _saveCategories()
  src = src.replace(
    "  _save() {",
    `  _saveCategoryDelays() {
    try {
      this._ensureDir();
      const obj = Object.fromEntries(this.categoryDelays);
      fs.writeFileSync(CAT_DELAYS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('channelStore: gagal simpan categoryDelays.json', err.message);
    }
  }

  _save() {`
  );

  // 1h. Tambah method setChannelDelay() & setCategoryDelay() & getEffectiveDelay() sebelah size getter
  src = src.replace(
    "  get size() { return this.channels.length; }",
    `  /**
   * Set forward delay untuk satu channel (dalam ms).
   * Nilai -1 berarti ikut delay kategori. 0 = tanpa delay.
   */
  setChannelDelay(discordId, delayMs) {
    const ch = this.channels.find(c => c.discordId === String(discordId));
    if (!ch) return false;
    ch.forwardDelayMs = typeof delayMs === 'number' ? Math.max(-1, delayMs) : -1;
    this._save();
    this._rebuildMap();
    return true;
  }

  /**
   * Set forward delay untuk seluruh channel di kategori tertentu.
   * @param {string} categoryName
   * @param {number} delayMs  — dalam milidetik (0 = tanpa delay)
   */
  setCategoryDelay(categoryName, delayMs) {
    const name = String(categoryName || '').trim();
    if (!name) return false;
    const ms = typeof delayMs === 'number' ? Math.max(0, delayMs) : 0;
    this.categoryDelays.set(name, ms);
    this._saveCategoryDelays();
    this._rebuildMap();
    return true;
  }

  /**
   * Ambil delay efektif sebuah channel (dalam ms).
   * Priority: channel delay (-1 = pakai kategori) → category delay → 0
   */
  getEffectiveDelay(discordId) {
    const ch = this.channels.find(c => c.discordId === String(discordId));
    if (!ch) return 0;
    if (typeof ch.forwardDelayMs === 'number' && ch.forwardDelayMs >= 0) {
      return ch.forwardDelayMs;
    }
    const catDelay = this.categoryDelays.get(ch.category || 'General');
    return typeof catDelay === 'number' ? catDelay : 0;
  }

  /** Ambil semua category delays sebagai plain object */
  getCategoryDelays() {
    return Object.fromEntries(this.categoryDelays);
  }

  get size() { return this.channels.length; }`
  );

  writeFile('utils/channelStore.js', src);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 2: messageHandler.js — apply delay sebelum doForward()
// ═══════════════════════════════════════════════════════════════════════════════
(function patchMessageHandler() {
  let src = readFile('handlers/messageHandler.js');

  if (src.includes('forwardDelayMs') || src.includes('effectiveDelay')) {
    console.log('⏭️  messageHandler.js sudah di-patch (skip)');
    return;
  }

  // Patch di handleNewMessage() — inject delay sebelum doForward()
  // Target: sebelah `try {` sebelum `const tgMsgId = await doForward(`
  const oldBlock = `  try {
    const tgMsgId = await doForward(message, target, tgManager, config, rateLimiter);
    logger.success(\`Diteruskan → TG Bot#\${botKey}\`, \`msgId: \${tgMsgId}\`);`;

  const newBlock = `  // ── Forward Delay (per-channel / per-category) ────────────────────────────
  const effectiveDelay = channelStore.getEffectiveDelay(targetChannelId);
  if (effectiveDelay > 0) {
    logger.info(\`⏳ Delay \${effectiveDelay}ms sebelum forward\`, \`#\${channelName}\`);
    pushEvent('info', \`⏳ Delay \${(effectiveDelay/1000).toFixed(1)}s — \${escapeHtmlMin(channelName)}\`);
    await new Promise(r => setTimeout(r, effectiveDelay));
  }

  try {
    const tgMsgId = await doForward(message, target, tgManager, config, rateLimiter);
    logger.success(\`Diteruskan → TG Bot#\${botKey}\`, \`msgId: \${tgMsgId}\`);`;

  if (!src.includes(oldBlock.trim().slice(0, 60))) {
    console.error('❌ messageHandler patch 2a: target tidak ditemukan');
    errors++;
    return;
  }
  src = src.replace(oldBlock, newBlock);

  // Tambah helper escapeHtmlMin di atas handleNewMessage
  const helperInsert = `// ─── Mini HTML escape untuk log string ───────────────────────────────────────
function escapeHtmlMin(str) {
  return String(str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

`;
  src = src.replace(
    "// ─── Handler: Pesan Baru ────────────────────────────────",
    helperInsert + "// ─── Handler: Pesan Baru ────────────────────────────────"
  );

  writeFile('handlers/messageHandler.js', src);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 3: webServer.js — tambah API endpoint PATCH /api/channels/:id/delay
//          dan PATCH /api/categories/:name/delay
// ═══════════════════════════════════════════════════════════════════════════════
(function patchWebServer() {
  let src = readFile('utils/webServer.js');

  if (src.includes('/delay') || src.includes('forwardDelayMs')) {
    console.log('⏭️  webServer.js sudah di-patch (delay endpoint) (skip)');
    return;
  }

  // Insert sebelum app.delete('/api/channels/:id'
  const target = "  app.delete('/api/channels/:id', (req, res) => {";
  const insert = `  // ── Channel Delay ─────────────────────────────────────────────────────────
  app.patch('/api/channels/:id/delay', (req, res) => {
    const discordId = req.params.id;
    // delayMs: angka ms, atau -1 untuk ikut kategori
    const delayMs = typeof req.body.delayMs === 'number' ? req.body.delayMs : Number(req.body.delayMs ?? -1);
    const ok = channelStore.setChannelDelay(discordId, delayMs);
    if (!ok) return res.status(404).json({ error: 'Channel tidak ditemukan' });
    const label = delayMs < 0 ? 'ikut kategori' : (delayMs === 0 ? 'tanpa delay' : \`\${delayMs}ms\`);
    pushEvent('info', \`⏳ Delay channel <b>\${discordId}</b> diset: \${label}\`);
    res.json({ success: true, discordId, delayMs });
  });

  `;

  if (!src.includes(target)) {
    console.error('❌ webServer patch 3a: target tidak ditemukan');
    errors++;
    return;
  }
  src = src.replace(target, insert + target);

  // Insert setelah app.put('/api/categories/:name/rename'
  const target2 = "  // ── Auto-Link & Bot Pool Endpoints ────────────────────────";
  const insert2 = `  // ── Category Delay ─────────────────────────────────────────────────────────
  app.patch('/api/categories/:name/delay', (req, res) => {
    const catName = req.params.name;
    const delayMs = typeof req.body.delayMs === 'number' ? req.body.delayMs : Number(req.body.delayMs ?? 0);
    const ok = channelStore.setCategoryDelay(catName, delayMs);
    if (!ok) return res.status(400).json({ error: 'Nama kategori tidak valid' });
    const label = delayMs === 0 ? 'tanpa delay' : \`\${delayMs}ms\`;
    pushEvent('info', \`⏳ Delay kategori <b>\${catName}</b> diset: \${label}\`);
    res.json({ success: true, catName, delayMs });
  });

  app.get('/api/categories/delays', (_, res) => {
    res.json(channelStore.getCategoryDelays());
  });

  `;

  if (!src.includes(target2)) {
    console.error('❌ webServer patch 3b: target tidak ditemukan');
    errors++;
    return;
  }
  src = src.replace(target2, insert2 + target2);

  writeFile('utils/webServer.js', src);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 4: public/script.js — tambah delay UI di channel row + category header
// ═══════════════════════════════════════════════════════════════════════════════
(function patchScriptJs() {
  let src = readFile('public/script.js');

  if (src.includes('btn-set-delay') || src.includes('cat-delay-input')) {
    console.log('⏭️  script.js sudah di-patch (delay UI) (skip)');
    return;
  }

  // ── 4a. Tambah kolom "Delay" di header tabel ──
  src = src.replace(
    `                                 <th>Status</th>\r\n                                 <th>Actions</th>`,
    `                                 <th>Delay</th>\r\n                                 <th>Status</th>\r\n                                 <th>Actions</th>`
  );
  // fallback LF
  src = src.replace(
    `                                 <th>Status</th>\n                                 <th>Actions</th>`,
    `                                 <th>Delay</th>\n                                 <th>Status</th>\n                                 <th>Actions</th>`
  );

  // ── 4b. Tambah kolom delay di tiap baris channel ──
  // Target: sebelah <td>${isMuted ? ... }</td>   (kolom Status)
  const oldStatusCell = `                                     <td>\${isMuted ? '<span class=\\"tag muted-tag\\">🔇 Muted</span>' : '<span class=\\"tag\\" style=\\"background:rgba(16,185,129,.1);color:var(--success-color)\\">🟢 Active</span>'}</td>`;
  const newStatusCell = `                                     <td>
                                        <div class="delay-cell" style="display:flex;align-items:center;gap:5px;min-width:110px;">
                                          <input type="number" min="0" step="1" class="delay-input-ch" data-id="\${ch.discordId}"
                                            value="\${typeof ch.forwardDelayMs === 'number' && ch.forwardDelayMs >= 0 ? Math.round(ch.forwardDelayMs/1000) : ''}"
                                            placeholder="ikut cat" title="Delay (detik). Kosong = ikut delay kategori"
                                            style="width:72px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.3);color:inherit;font-size:0.8rem;text-align:center;">
                                          <button class="btn-set-delay" data-id="\${ch.discordId}" title="Simpan delay channel ini"
                                            style="padding:4px 7px;border-radius:5px;border:1px solid rgba(14,165,233,0.35);background:rgba(14,165,233,0.12);color:#38bdf8;cursor:pointer;font-size:0.78rem;">
                                            <i class='bx bx-save'></i>
                                          </button>
                                        </div>
                                     </td>
                                     <td>\${isMuted ? '<span class=\\"tag muted-tag\\">🔇 Muted</span>' : '<span class=\\"tag\\" style=\\"background:rgba(16,185,129,.1);color:var(--success-color)\\">🟢 Active</span>'}</td>`;

  if (src.includes(oldStatusCell)) {
    src = src.replace(oldStatusCell, newStatusCell);
  } else {
    // Coba versi tanpa escaped quotes (raw template literal di JS)
    const altOld = `<td>\${isMuted ? '<span class="tag muted-tag">🔇 Muted</span>' : '<span class="tag" style="background:rgba(16,185,129,.1);color:var(--success-color)">🟢 Active</span>'}</td>`;
    const altNew = `<td>
                                        <div class="delay-cell" style="display:flex;align-items:center;gap:5px;min-width:110px;">
                                          <input type="number" min="0" step="1" class="delay-input-ch" data-id="\${ch.discordId}"
                                            value="\${typeof ch.forwardDelayMs === 'number' && ch.forwardDelayMs >= 0 ? Math.round(ch.forwardDelayMs/1000) : ''}"
                                            placeholder="ikut cat" title="Delay (detik). Kosong = ikut delay kategori"
                                            style="width:72px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.3);color:inherit;font-size:0.8rem;text-align:center;">
                                          <button class="btn-set-delay" data-id="\${ch.discordId}" title="Simpan delay channel ini"
                                            style="padding:4px 7px;border-radius:5px;border:1px solid rgba(14,165,233,0.35);background:rgba(14,165,233,0.12);color:#38bdf8;cursor:pointer;font-size:0.78rem;">
                                            <i class='bx bx-save'></i>
                                          </button>
                                        </div>
                                     </td>
                                     <td>\${isMuted ? '<span class="tag muted-tag">🔇 Muted</span>' : '<span class="tag" style="background:rgba(16,185,129,.1);color:var(--success-color)">🟢 Active</span>'}</td>`;
    if (src.includes(altOld)) {
      src = src.replace(altOld, altNew);
    } else {
      console.error('❌ script.js patch 4b: target status cell tidak ditemukan');
      errors++;
    }
  }

  // ── 4c. Tambah input delay kategori di category header actions ──
  // Sisipkan setelah <button ... btn-cat-rename ...>
  const oldCatDelay = `                    <button class="btn-secondary btn-sm btn-cat-rename" data-category="${escapeHtml(catName)}"`;
  // Versi yang ada di file (tanpa escapeHtml dipanggil — raw string)
  const catRenameTarget = `                    <button class="btn-secondary btn-sm btn-cat-rename" data-category="\${escapeHtml(catName)}" title="Ubah Nama Kategori" style="font-size:0.75rem; padding:4px 9px;">`;
  const catRenameReplace = `                    <span class="cat-delay-wrapper" style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);border-radius:7px;padding:3px 8px;" title="Delay kategori \${escapeHtml(catName)} (detik, 0=tanpa delay)">
                        <i class='bx bx-time-five' style="color:#a78bfa;font-size:0.9rem;"></i>
                        <input type="number" min="0" step="1" class="cat-delay-input" data-category="\${escapeHtml(catName)}"
                          placeholder="0" title="Delay kategori (detik)"
                          style="width:52px;padding:2px 4px;border-radius:5px;border:1px solid rgba(167,139,250,0.3);background:rgba(0,0,0,0.3);color:inherit;font-size:0.78rem;text-align:center;">
                        <button class="btn-save-cat-delay" data-category="\${escapeHtml(catName)}" title="Simpan delay kategori ini"
                          style="padding:2px 6px;border-radius:5px;border:1px solid rgba(167,139,250,0.3);background:rgba(167,139,250,0.12);color:#a78bfa;cursor:pointer;font-size:0.76rem;">
                          <i class='bx bx-save'></i>
                        </button>
                    </span>
                    <button class="btn-secondary btn-sm btn-cat-rename" data-category="\${escapeHtml(catName)}" title="Ubah Nama Kategori" style="font-size:0.75rem; padding:4px 9px;">`;

  if (src.includes(catRenameTarget)) {
    src = src.replace(catRenameTarget, catRenameReplace);
  } else {
    console.warn('⚠️  script.js patch 4c: cat-rename button tidak ditemukan (mungkin sudah di-patch)');
  }

  // ── 4d. Tambah event listeners di attachChannelActionListeners() ──
  const attachTarget = `    // Edit channel\n    document.querySelectorAll('.btn-edit-ch').forEach`;
  const attachInsert = `    // Delay per-channel: simpan saat tombol save diklik
    document.querySelectorAll('.btn-set-delay').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id  = btn.dataset.id;
            const inp = document.querySelector(\`.delay-input-ch[data-id="\${id}"]\`);
            const valStr = (inp?.value ?? '').trim();
            // Kosong = -1 (ikut kategori), angka = detik → ms
            const delayMs = valStr === '' ? -1 : Math.max(0, Math.round(Number(valStr) * 1000));
            try {
                const resp = await fetch(\`\${API}/channels/\${id}/delay\`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ delayMs })
                });
                if (!resp.ok) throw new Error(await resp.text());
                const label = delayMs < 0 ? 'ikut kategori' : (delayMs === 0 ? 'tanpa delay' : \`\${valStr}s\`);
                showToast(\`Delay channel diset: \${label}\`, 'success');
                loadChannels();
            } catch (err) { showToast('Gagal simpan delay: ' + err.message, 'error'); }
        });
    });

    // Delay per-kategori: simpan saat tombol save diklik
    document.querySelectorAll('.btn-save-cat-delay').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const cat = btn.dataset.category;
            const inp = document.querySelector(\`.cat-delay-input[data-category="\${cat}"]\`);
            const valStr = (inp?.value ?? '0').trim();
            const delayMs = Math.max(0, Math.round(Number(valStr || 0) * 1000));
            try {
                const resp = await fetch(\`\${API}/categories/\${encodeURIComponent(cat)}/delay\`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ delayMs })
                });
                if (!resp.ok) throw new Error(await resp.text());
                const label = delayMs === 0 ? 'tanpa delay' : \`\${valStr}s\`;
                showToast(\`Delay kategori "\${cat}": \${label}\`, 'success');
            } catch (err) { showToast('Gagal simpan delay kategori: ' + err.message, 'error'); }
        });
    });

    // Edit channel\n    document.querySelectorAll('.btn-edit-ch').forEach`;

  if (src.includes(attachTarget)) {
    src = src.replace(attachTarget, attachInsert);
  } else {
    console.error('❌ script.js patch 4d: attachTarget tidak ditemukan');
    errors++;
  }

  // ── 4e. Load category delays saat render channel (isi value input kategori) ──
  // Kita inject fetch categoryDelays dan set value setelah render
  const renderEndTarget = `    // Wire-up event buttons di dalam tabel\n    attachChannelActionListeners();`;
  const renderEndInsert = `    // Load & isi nilai delay kategori di input
    fetch(\`\${API}/categories/delays\`).then(r => r.json()).then(delayMap => {
        document.querySelectorAll('.cat-delay-input').forEach(inp => {
            const cat = inp.dataset.category;
            if (delayMap[cat] !== undefined) {
                const secs = Math.round(delayMap[cat] / 1000);
                inp.value = secs > 0 ? secs : '';
            }
        });
    }).catch(() => {});

    // Wire-up event buttons di dalam tabel\n    attachChannelActionListeners();`;

  if (src.includes(renderEndTarget)) {
    src = src.replace(renderEndTarget, renderEndInsert);
  } else {
    console.warn('⚠️  script.js patch 4e: renderEndTarget tidak ditemukan');
  }

  writeFile('public/script.js', src);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════
console.log('');
if (errors === 0) {
  console.log('🎉 Semua patch berhasil! Fitur delay per-channel/per-category sudah aktif.');
  console.log('   Restart bot dengan: start.bat');
} else {
  console.log(`❌ Ada ${errors} patch yang gagal. Periksa pesan error di atas.`);
  process.exit(1);
}

