/**
 * Script untuk mengimplementasikan fitur Channel Health / Active Status Detection:
 * 1. utils/channelStore.js:
 *    - schema channel: lastActiveAt, lastCheckStatus ('ok' | 'not_found' | 'no_access' | 'unknown')
 *    - recordActivity(discordId)
 *    - updateHealthStatus(discordId, status, details)
 *    - checkAllChannelsHealth(discordRegistry)
 * 2. handlers/messageHandler.js:
 *    - memanggil channelStore.recordActivity(targetChannelId) saat pesan masuk
 * 3. utils/webServer.js:
 *    - API POST /api/channels/check-health
 *    - API GET /api/channels/health-status
 * 4. public/index.html & public/script.js:
 *    - Filter status: Semua / Active / Inactive / Muted
 *    - Tombol "Cek Status Channel"
 *    - Tampilan badge status (🟢 Active, 🔴 Inactive / Not Found, 🟡 No Access, 🔇 Muted)
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function writeFile(relPath, content) {
  const tmp = path.join(ROOT, relPath) + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, path.join(ROOT, relPath));
  console.log(`✅ Patched: ${relPath}`);
}

// ══════════════════════════════════════════════════════════════
// 1. PATCH utils/channelStore.js
// ══════════════════════════════════════════════════════════════
(function patchChannelStore() {
  let src = readFile('utils/channelStore.js');

  if (src.includes('checkAllChannelsHealth')) {
    console.log('⏭️ channelStore.js sudah memiliki checkAllChannelsHealth');
    return;
  }

  // 1a. Update di _load() untuk memuat lastActiveAt dan lastCheckStatus
  const loadTarget = `            forwardDelayMs: typeof ch.forwardDelayMs === 'number' ? ch.forwardDelayMs : -1,
          }));`;
  const loadReplacement = `            forwardDelayMs: typeof ch.forwardDelayMs === 'number' ? ch.forwardDelayMs : -1,
            lastActiveAt: ch.lastActiveAt || null,
            lastCheckStatus: ch.lastCheckStatus || 'unknown',
            lastCheckError: ch.lastCheckError || null,
          }));`;

  if (src.includes(loadTarget)) {
    src = src.replace(loadTarget, loadReplacement);
  } else {
    console.error('❌ Gagal patch _load() di channelStore.js');
    process.exit(1);
  }

  // 1b. Update di add()
  const addTarget = `      forwardDelayMs: typeof channel.forwardDelayMs === 'number' ? channel.forwardDelayMs : -1,
    };

    const idx = this.channels.findIndex(c => c.discordId === ch.discordId);`;
  const addReplacement = `      forwardDelayMs: typeof channel.forwardDelayMs === 'number' ? channel.forwardDelayMs : -1,
      lastActiveAt: channel.lastActiveAt || null,
      lastCheckStatus: channel.lastCheckStatus || 'unknown',
      lastCheckError: channel.lastCheckError || null,
    };

    const idx = this.channels.findIndex(c => c.discordId === ch.discordId);
    if (idx >= 0) {
      ch.lastActiveAt = this.channels[idx].lastActiveAt || ch.lastActiveAt;
      ch.lastCheckStatus = this.channels[idx].lastCheckStatus || ch.lastCheckStatus;
      ch.lastCheckError = this.channels[idx].lastCheckError || ch.lastCheckError;
    }`;

  if (src.includes(addTarget)) {
    src = src.replace(addTarget, addReplacement);
  } else {
    console.error('❌ Gagal patch add() di channelStore.js');
    process.exit(1);
  }

  // 1c. Tambahkan method recordActivity, updateHealthStatus, dan checkAllChannelsHealth
  const methodsToAdd = `  /**
   * Catat aktivitas terbaru saat ada pesan masuk / forward dari channel Discord ini
   */
  recordActivity(discordId) {
    if (!discordId) return;
    const ch = this.channels.find(c => c.discordId === String(discordId));
    if (ch) {
      ch.lastActiveAt = new Date().toISOString();
      ch.lastCheckStatus = 'ok';
      ch.lastCheckError = null;
      this._save();
    }
  }

  /**
   * Update status hasil pengecekan keberadaan channel
   */
  updateHealthStatus(discordId, status, errorMsg = null) {
    const ch = this.channels.find(c => c.discordId === String(discordId));
    if (ch) {
      ch.lastCheckStatus = status;
      ch.lastCheckError = errorMsg;
      this._save();
    }
  }

  /**
   * Periksa apakah setiap channel Discord masih ada dan bisa diakses oleh bot token
   */
  async checkAllChannelsHealth(discordRegistry) {
    if (!discordRegistry) return { checked: 0, results: {} };
    const clients = discordRegistry.getClients ? discordRegistry.getClients() : [];
    const results = {};
    let checked = 0;

    for (const ch of this.channels) {
      const id = String(ch.discordId);
      checked++;
      let found = false;
      let errorReason = null;

      if (clients.length === 0) {
        // Jika client belum online/terhubung
        results[id] = { status: 'unknown', reason: 'Bot Discord belum online' };
        ch.lastCheckStatus = 'unknown';
        ch.lastCheckError = 'Bot Discord belum online';
        continue;
      }

      // 1. Cek di cache seluruh client
      for (const c of clients) {
        if (c.channels?.cache?.has(id)) {
          found = true;
          break;
        }
      }

      // 2. Jika tidak ada di cache, coba fetch via API Discord
      if (!found) {
        for (const c of clients) {
          try {
            const fetched = await c.channels?.fetch(id).catch(err => {
              if (err.code === 10003) errorReason = 'Channel dihapus/tidak ditemukan (Unknown Channel)';
              else if (err.code === 50001) errorReason = 'Bot tidak memiliki akses ke channel (Missing Access)';
              else errorReason = err.message;
              return null;
            });
            if (fetched) {
              found = true;
              errorReason = null;
              break;
            }
          } catch (e) {
            errorReason = e.message;
          }
        }
      }

      if (found) {
        ch.lastCheckStatus = 'ok';
        ch.lastCheckError = null;
        results[id] = { status: 'ok', name: ch.name };
      } else {
        const isDeleted = errorReason && (errorReason.includes('Unknown Channel') || errorReason.includes('10003'));
        ch.lastCheckStatus = isDeleted ? 'not_found' : (errorReason && errorReason.includes('Missing Access') ? 'no_access' : 'inactive');
        ch.lastCheckError = errorReason || 'Channel tidak ditemukan di server Discord';
        results[id] = { status: ch.lastCheckStatus, reason: ch.lastCheckError, name: ch.name };
      }
    }

    this._save();
    return { checked, results };
  }
`;

  const insertBefore = `  /**
   * Set forward delay untuk satu channel (dalam ms).`;

  if (src.includes(insertBefore)) {
    src = src.replace(insertBefore, methodsToAdd + '\n' + insertBefore);
  } else {
    console.error('❌ Gagal menemukan posisi insert method di channelStore.js');
    process.exit(1);
  }

  writeFile('utils/channelStore.js', src);
})();

// ══════════════════════════════════════════════════════════════
// 2. PATCH handlers/messageHandler.js
// ══════════════════════════════════════════════════════════════
(function patchMessageHandler() {
  let src = readFile('handlers/messageHandler.js');

  if (src.includes('channelStore.recordActivity')) {
    console.log('⏭️ messageHandler.js sudah memiliki recordActivity');
    return;
  }

  const target = `  if (tgMsgId || dcMsgIdOut) {
    const targetChannelId = getTargetChannelId(message.channel) || message.channelId;
    messageStore.set(message.id, tgChatId, tgMsgId, botKey, msgType, dcWebhookUrl, dcMsgIdOut);
    stats.recordForward(targetChannelId);
  }`;

  const replacement = `  if (tgMsgId || dcMsgIdOut) {
    const targetChannelId = getTargetChannelId(message.channel) || message.channelId;
    messageStore.set(message.id, tgChatId, tgMsgId, botKey, msgType, dcWebhookUrl, dcMsgIdOut);
    stats.recordForward(targetChannelId);
    if (channelStore?.recordActivity) {
      channelStore.recordActivity(targetChannelId);
    }
  }`;

  if (src.includes(target)) {
    src = src.replace(target, replacement);
    writeFile('handlers/messageHandler.js', src);
  } else {
    console.error('❌ Gagal patch messageHandler.js');
    process.exit(1);
  }
})();

// ══════════════════════════════════════════════════════════════
// 3. PATCH utils/webServer.js
// ══════════════════════════════════════════════════════════════
(function patchWebServer() {
  let src = readFile('utils/webServer.js');

  if (src.includes('/api/channels/check-health')) {
    console.log('⏭️ webServer.js sudah memiliki /api/channels/check-health');
    return;
  }

  // Tambahkan discordRegistry di import jika belum ada
  if (!src.includes("require('./discordRegistry')")) {
    src = src.replace(
      "const channelStore      = require('./channelStore');",
      "const channelStore      = require('./channelStore');\nconst discordRegistry   = require('./discordRegistry');"
    );
  }

  // Tambahkan endpoint check-health dan health-status
  const endpoints = `
  // ── Channels Health & Active Check ────────────────────────────
  app.post('/api/channels/check-health', async (_, res) => {
    try {
      pushEvent('info', '🔍 Sedang memeriksa status keaktifan seluruh channel Discord...');
      const checkResult = await channelStore.checkAllChannelsHealth(discordRegistry);
      const notFoundCount = Object.values(checkResult.results).filter(r => r.status === 'not_found' || r.status === 'inactive').length;
      if (notFoundCount > 0) {
        pushEvent('warning', \`⚠️ Pemeriksaan selesai: <b>\${notFoundCount} channel</b> terdeteksi tidak aktif / sudah dihapus!\`);
      } else {
        pushEvent('success', '✅ Semua channel Discord terdeteksi aktif dan dapat diakses.');
      }
      res.json({ success: true, ...checkResult });
    } catch (err) {
      pushEvent('error', \`Gagal memeriksa channel: \${err.message}\`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/channels/health-status', (_, res) => {
    const channels = channelStore.list();
    const statusMap = {};
    channels.forEach(c => {
      statusMap[c.discordId] = {
        status: c.lastCheckStatus || 'unknown',
        lastActiveAt: c.lastActiveAt || null,
        error: c.lastCheckError || null,
      };
    });
    res.json(statusMap);
  });
`;

  const target = `  // ── Channels CRUD ───────────────────────────────────────────`;
  if (src.includes(target)) {
    src = src.replace(target, endpoints + '\n' + target);
    writeFile('utils/webServer.js', src);
  } else {
    console.error('❌ Gagal patch webServer.js');
    process.exit(1);
  }
})();

// ══════════════════════════════════════════════════════════════
// 4. PATCH public/index.html
// ══════════════════════════════════════════════════════════════
(function patchIndexHtml() {
  let src = readFile('public/index.html');

  if (src.includes('btn-check-channels-health')) {
    console.log('⏭️ index.html sudah memiliki btn-check-channels-health');
    return;
  }

  // 4a. Tambahkan tombol "Cek Status Channel" di samping Expand/Collapse
  const targetBtn = `<button type="button" id="btn-toggle-all-cats" class="btn-secondary" style="font-size: 0.82rem; padding: 8px 14px;">`;
  const btnToAdd = `<button type="button" id="btn-check-channels-health" class="btn-secondary" style="font-size: 0.82rem; padding: 8px 14px; background: rgba(56, 189, 248, 0.1); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3);" title="Periksa apakah channel Discord masih ada atau sudah dihapus">
                                <i class='bx bx-pulse'></i> Cek Keaktifan Channel
                            </button>
                            <button type="button" id="btn-toggle-all-cats" class="btn-secondary" style="font-size: 0.82rem; padding: 8px 14px;">`;

  if (src.includes(targetBtn)) {
    src = src.replace(targetBtn, btnToAdd);
  } else {
    console.error('❌ Gagal patch tombol di index.html');
    process.exit(1);
  }

  // 4b. Tambahkan filter status channel (All / Active / Inactive / Muted)
  const targetFilter = `                            <select id="channels-category-filter" class="category-select-filter">
                                <option value="all">Semua Kategori (All)</option>
                            </select>`;
  const statusFilterSelect = `                            <select id="channels-category-filter" class="category-select-filter">
                                <option value="all">Semua Kategori (All)</option>
                            </select>
                            <select id="channels-status-filter" class="category-select-filter" style="min-width: 150px;">
                                <option value="all">Status: Semua</option>
                                <option value="active">🟢 Hanya Aktif (On)</option>
                                <option value="inactive">🔴 Tidak Aktif / Hilang</option>
                                <option value="muted">🔇 Muted</option>
                            </select>`;

  if (src.includes(targetFilter)) {
    src = src.replace(targetFilter, statusFilterSelect);
    writeFile('public/index.html', src);
  } else {
    console.error('❌ Gagal patch filter di index.html');
    process.exit(1);
  }
})();

// ══════════════════════════════════════════════════════════════
// 5. PATCH public/script.js
// ══════════════════════════════════════════════════════════════
(function patchScriptJs() {
  let src = readFile('public/script.js');

  if (src.includes('btn-check-channels-health')) {
    console.log('⏭️ script.js sudah memiliki btn-check-channels-health');
    return;
  }

  // 5a. Tambahkan variabel currentStatusFilter
  const varTarget = `let currentCategoryFilter = 'all';`;
  const varReplacement = `let currentCategoryFilter = 'all';\nlet currentStatusFilter = 'all';`;
  if (src.includes(varTarget)) {
    src = src.replace(varTarget, varReplacement);
  }

  // 5b. Update filter logic di renderGroupedChannels()
  const filterTarget = `        const matchCat = currentCategoryFilter === 'all' || cat.toLowerCase() === currentCategoryFilter.toLowerCase();
        if (!matchCat) return false;`;

  const filterReplacement = `        const matchCat = currentCategoryFilter === 'all' || cat.toLowerCase() === currentCategoryFilter.toLowerCase();
        if (!matchCat) return false;

        const isMuted = allMutedSet.has(ch.discordId);
        const isInactive = ch.lastCheckStatus === 'not_found' || ch.lastCheckStatus === 'no_access' || ch.lastCheckStatus === 'inactive';
        if (currentStatusFilter === 'active' && (isInactive || isMuted)) return false;
        if (currentStatusFilter === 'inactive' && !isInactive) return false;
        if (currentStatusFilter === 'muted' && !isMuted) return false;`;

  if (src.includes(filterTarget)) {
    src = src.replace(filterTarget, filterReplacement);
  }

  // 5c. Update badge status di render baris channel
  // Target baris:
  // <td>${isMuted ? '<span class="tag muted-tag">🔇 Muted</span>' : '<span class="tag" style="background:rgba(16,185,129,.1);color:var(--success-color)">🟢 Active</span>'}</td>
  const badgeTarget = `<td>\${isMuted ? '<span class="tag muted-tag">🔇 Muted</span>' : '<span class="tag" style="background:rgba(16,185,129,.1);color:var(--success-color)">🟢 Active</span>'}</td>`;
  const badgeReplacement = `<td>\${(() => {
                                        if (isMuted) return '<span class="tag muted-tag">🔇 Muted</span>';
                                        if (ch.lastCheckStatus === 'not_found') {
                                            return '<span class="tag" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);font-weight:700;" title="' + escapeHtml(ch.lastCheckError || 'Channel dihapus di Discord') + '">🔴 Tidak Ditemukan</span>';
                                        }
                                        if (ch.lastCheckStatus === 'no_access') {
                                            return '<span class="tag" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3);font-weight:700;" title="' + escapeHtml(ch.lastCheckError || 'Bot tidak ada akses') + '">🟡 No Access</span>';
                                        }
                                        if (ch.lastCheckStatus === 'inactive') {
                                            return '<span class="tag" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);" title="' + escapeHtml(ch.lastCheckError || 'Tidak aktif') + '">🔴 Inactive</span>';
                                        }
                                        return '<span class="tag" style="background:rgba(16,185,129,.1);color:var(--success-color)">🟢 Active</span>';
                                    })()}</td>`;

  if (src.includes(badgeTarget)) {
    src = src.replace(badgeTarget, badgeReplacement);
  } else {
    console.warn('⚠️ Tidak menemukan template badgeTarget exact, mencari alternatif...');
    const altIdx = src.indexOf("isMuted ? '<span class=\"tag muted-tag\">");
    if (altIdx !== -1) {
      const tdStart = src.lastIndexOf('<td>', altIdx);
      const tdEnd = src.indexOf('</td>', altIdx) + 5;
      src = src.substring(0, tdStart) + badgeReplacement + src.substring(tdEnd);
    }
  }

  // 5d. Tambahkan listener untuk channels-status-filter dan btn-check-channels-health
  const listenersTarget = `const channelsCategoryFilter = document.getElementById('channels-category-filter');`;
  const listenersCode = `// Status Filter (All / Active / Inactive / Muted)
const channelsStatusFilter = document.getElementById('channels-status-filter');
if (channelsStatusFilter) {
    channelsStatusFilter.addEventListener('change', e => {
        currentStatusFilter = e.target.value;
        renderGroupedChannels();
    });
}

// Tombol Cek Keaktifan Channel
const btnCheckHealth = document.getElementById('btn-check-channels-health');
if (btnCheckHealth) {
    btnCheckHealth.addEventListener('click', async () => {
        const origHtml = btnCheckHealth.innerHTML;
        btnCheckHealth.disabled = true;
        btnCheckHealth.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Memeriksa...";
        showToast('Sedang memeriksa keaktifan seluruh channel Discord...', 'info');

        try {
            const resp = await fetch(API + '/channels/check-health', { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
                const results = data.results || {};
                let notFoundCount = 0;
                Object.values(results).forEach(r => {
                    if (r.status === 'not_found' || r.status === 'no_access' || r.status === 'inactive') notFoundCount++;
                });

                if (notFoundCount > 0) {
                    showToast('Pemeriksaan selesai: Ditemukan ' + notFoundCount + ' channel tidak aktif!', 'warning');
                } else {
                    showToast('Pemeriksaan selesai: Semua channel aktif & normal!', 'success');
                }
                await loadChannels();
            } else {
                showToast('Gagal memeriksa channel: ' + (data.error || 'Unknown error'), 'error');
            }
        } catch (err) {
            showToast('Error cek channel: ' + err.message, 'error');
        } finally {
            btnCheckHealth.disabled = false;
            btnCheckHealth.innerHTML = origHtml;
        }
    });
}

const channelsCategoryFilter = document.getElementById('channels-category-filter');`;

  if (src.includes(listenersTarget)) {
    src = src.replace(listenersTarget, listenersCode);
  } else {
    console.error('❌ Gagal patch listeners di script.js');
    process.exit(1);
  }

  writeFile('public/script.js', src);
})();

console.log('\n🎉 Semua patch untuk status keaktifan channel berhasil diterapkan!');
