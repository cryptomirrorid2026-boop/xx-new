'use strict';
/* ============================================================
   NEXUS MIRROR DASHBOARD — script.js v4
   Features: SSE Activity Log, Charts, Mute Toggle, Dark/Light Mode,
             Custom Delete Modal, Export/Import Config, Test Message
============================================================ */

document.addEventListener('DOMContentLoaded', () => {
const API = '/api';

// ─── Dashboard Authentication Manager ──────────────────────────
let dashboardToken = localStorage.getItem('nexus-dashboard-token') || '';
const modalAuth = document.getElementById('modal-auth');
const authPasswordInput = document.getElementById('auth-password-input');
const authErrorMsg = document.getElementById('auth-error-msg');
const btnAuthSubmit = document.getElementById('btn-auth-submit');
const btnToggleAuthPwd = document.getElementById('btn-toggle-auth-pwd');
const btnLockDashboard = document.getElementById('btn-lock-dashboard');

function showAuthModal() {
    if (modalAuth) {
        modalAuth.classList.add('show');
        if (authPasswordInput) {
            authPasswordInput.value = '';
            setTimeout(() => authPasswordInput.focus(), 150);
        }
        if (authErrorMsg) authErrorMsg.style.display = 'none';
    }
}

function hideAuthModal() {
    if (modalAuth) modalAuth.classList.remove('show');
}

// Override native fetch to automatically include Authorization token
const rawFetch = window.fetch;
window.fetch = async function(url, options = {}) {
    options = options || {};
    options.headers = options.headers || {};
    const token = localStorage.getItem('nexus-dashboard-token') || '';
    if (typeof url === 'string' && url.startsWith('/api')) {
        if (options.headers instanceof Headers) {
            if (token) options.headers.set('Authorization', `Bearer ${token}`);
        } else {
            if (token) options.headers['Authorization'] = `Bearer ${token}`;
        }
    }
    const res = await rawFetch(url, options);
    if (res.status === 401 && typeof url === 'string' && url.startsWith('/api') && !url.includes('/api/auth/')) {
        showAuthModal();
    }
    return res;
};

// Check Auth Status on Startup
async function checkAuthStatus() {
    try {
        const res = await rawFetch(`${API}/auth/status`, {
            headers: { 'Authorization': `Bearer ${dashboardToken}` }
        }).then(r => r.json());

        if (res.authRequired) {
            if (btnLockDashboard) btnLockDashboard.style.display = 'inline-flex';
            if (!res.authenticated) {
                showAuthModal();
            }
        } else {
            if (btnLockDashboard) btnLockDashboard.style.display = 'none';
        }
    } catch (_) {}
}

async function handleAuthLogin() {
    const password = authPasswordInput ? authPasswordInput.value.trim() : '';
    if (!password) {
        if (authErrorMsg) {
            authErrorMsg.textContent = 'Password tidak boleh kosong!';
            authErrorMsg.style.display = 'block';
        }
        return;
    }
    try {
        const res = await rawFetch(`${API}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            dashboardToken = data.token || password;
            localStorage.setItem('nexus-dashboard-token', dashboardToken);
            hideAuthModal();
            showToast('Berhasil login ke Dashboard!', 'success');
            loadStats();
            renderCharts();
        } else {
            if (authErrorMsg) {
                authErrorMsg.textContent = data.error || 'Password salah!';
                authErrorMsg.style.display = 'block';
            }
        }
    } catch (err) {
        if (authErrorMsg) {
            authErrorMsg.textContent = 'Gagal menghubungi server!';
            authErrorMsg.style.display = 'block';
        }
    }
}

if (btnAuthSubmit) btnAuthSubmit.addEventListener('click', handleAuthLogin);
if (authPasswordInput) {
    authPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAuthLogin();
    });
}
if (btnToggleAuthPwd) {
    btnToggleAuthPwd.addEventListener('click', () => {
        const isPwd = authPasswordInput.type === 'password';
        authPasswordInput.type = isPwd ? 'text' : 'password';
        btnToggleAuthPwd.className = isPwd ? 'bx bx-hide' : 'bx bx-show';
    });
}
if (btnLockDashboard) {
    btnLockDashboard.addEventListener('click', () => {
        localStorage.removeItem('nexus-dashboard-token');
        dashboardToken = '';
        showAuthModal();
        showToast('Dashboard dikunci.', 'warning');
    });
}

// Panggil cek status auth saat DOM siap
checkAuthStatus();


// ─── Theme ────────────────────────────────────────────────────
const htmlEl = document.documentElement;
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
let currentTheme = localStorage.getItem('nexus-theme') || 'dark';

function applyTheme(t) {
    htmlEl.setAttribute('data-theme', t);
    themeIcon.className = t === 'dark' ? 'bx bx-sun' : 'bx bx-moon';
    localStorage.setItem('nexus-theme', t);
    currentTheme = t;
}
applyTheme(currentTheme);
themeToggle.addEventListener('click', () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));

// ─── Sidebar & Nav ────────────────────────────────────────────
const sidebar = document.querySelector('.sidebar');
document.querySelector('.sidebarBtn').addEventListener('click', () => sidebar.classList.toggle('active'));

const navLinks = document.querySelectorAll('.nav-links a');
const sections = document.querySelectorAll('.section');
const pageTitle = document.getElementById('page-title');

navLinks.forEach(link => {
    link.addEventListener('click', e => {
        e.preventDefault();
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        const target = link.getAttribute('data-target');

        // Inject word filter section from <template> if not yet injected
        if (target === 'wordfilter' && !document.getElementById('section-wordfilter')) {
            const tpl = document.getElementById('tpl-wordfilter-section');
            if (tpl) {
                const clone = tpl.content.cloneNode(true);
                document.querySelector('.content-wrapper').appendChild(clone);
                initWordFilter();
            }
        }

        // Inject anti-spam section from <template> if not yet injected
        if (target === 'antispam' && !document.getElementById('section-antispam')) {
            const tpl = document.getElementById('tpl-antispam');
            if (tpl) {
                const clone = tpl.content.cloneNode(true);
                document.querySelector('.content-wrapper').appendChild(clone);
                initAntiSpam();
            }
        }

        // Refresh sections after potential DOM injection
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        const targetSection = document.getElementById(`section-${target}`);
        if (targetSection) targetSection.classList.add('active');
        pageTitle.textContent = link.querySelector('.links_name').textContent;
        if (window.innerWidth <= 768) sidebar.classList.remove('active');
        if (target === 'dashboard') { loadStats(); renderCharts(); }
        if (target === 'channels') loadChannels();
        if (target === 'tg2dc') loadTg2dcChannels();
        if (target === 'bots-tokens') loadConfig();
        if (target === 'crop') loadCropConfigs();
        if (target === 'blur') loadBlurConfigs();
        if (target === 'wordfilter') loadWordFilter();
        if (target === 'antispam') loadAntiSpam();
        if (target === 'activity') { document.getElementById('activity-badge').style.display = 'none'; }
    });
});

// ─── Guide Center & Onboarding ────────────────────────────────
const btnTopbarGuide = document.getElementById('btn-topbar-guide');
if (btnTopbarGuide) {
    btnTopbarGuide.addEventListener('click', () => {
        document.getElementById('nav-guide')?.click();
    });
}

// Onboarding banner state
const onboardingCard = document.getElementById('onboarding-card');
if (onboardingCard) {
    if (localStorage.getItem('nexus-banner-dismissed') === 'true') {
        onboardingCard.style.display = 'none';
    }
    document.getElementById('btn-dismiss-banner')?.addEventListener('click', () => {
        onboardingCard.style.display = 'none';
        localStorage.setItem('nexus-banner-dismissed', 'true');
    });
    document.getElementById('btn-open-guide-banner')?.addEventListener('click', () => {
        document.getElementById('nav-guide')?.click();
    });
    document.getElementById('btn-open-channel-banner')?.addEventListener('click', () => {
        document.getElementById('nav-channels')?.click();
        setTimeout(() => document.getElementById('btn-add-channel')?.click(), 150);
    });
    document.getElementById('step-guide-1')?.addEventListener('click', () => {
        document.getElementById('nav-bots-tokens')?.click();
    });
    document.getElementById('step-guide-2')?.addEventListener('click', () => {
        document.getElementById('nav-bots-tokens')?.click();
    });
    document.getElementById('step-guide-3')?.addEventListener('click', () => {
        document.getElementById('nav-channels')?.click();
    });
}

// Guide navigation tabs
document.querySelectorAll('.guide-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.guide-nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.guide-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const pane = document.getElementById(`pane-${btn.dataset.tab}`);
        if (pane) pane.classList.add('active');
    });
});

// FAQ Accordion
document.querySelectorAll('.faq-item').forEach(item => {
    const q = item.querySelector('.faq-question');
    if (q) {
        q.addEventListener('click', () => {
            item.classList.toggle('open');
        });
    }
});

// Copy snippet code buttons
document.querySelectorAll('.btn-copy-code').forEach(btn => {
    btn.addEventListener('click', () => {
        const text = btn.dataset.copy;
        if (text) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('Perintah disalin ke clipboard!', 'success');
            }).catch(() => {
                showToast('Gagal menyalin perintah', 'error');
            });
        }
    });
});

// view-all link on dashboard
document.querySelectorAll('.view-all-link').forEach(a => {
    a.addEventListener('click', e => {
        e.preventDefault();
        const target = a.getAttribute('data-target');
        document.querySelector(`[data-target="${target}"]`).click();
    });
});

// ─── Toast ────────────────────────────────────────────────────
const toast = document.getElementById('toast');
function showToast(msg, type = 'success') {
    const icons = { success: 'bx-check-circle', error: 'bx-error-circle', warning: 'bx-info-circle' };
    toast.innerHTML = `<i class='bx ${icons[type] || icons.success}'></i> ${msg}`;
    toast.className = `toast ${type} show`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ─── Modal Helpers ────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
});
window.addEventListener('click', e => {
    document.querySelectorAll('.modal.show').forEach(m => {
        if (e.target === m && m.id !== 'modal-auth') m.classList.remove('show');
    });
});
window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.show').forEach(m => {
            if (m.id !== 'modal-auth') m.classList.remove('show');
        });
    }
});

// ─── Custom Confirm Delete Modal ──────────────────────────────
let _deleteCallback = null;
function confirmDelete(channelName, callback) {
    document.getElementById('modal-delete-desc').textContent = `Delete "${channelName}"? This cannot be undone.`;
    _deleteCallback = callback;
    openModal('modal-confirm-delete');
}
document.getElementById('btn-confirm-cancel').addEventListener('click', () => closeModal('modal-confirm-delete'));
document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
    closeModal('modal-confirm-delete');
    if (_deleteCallback) { await _deleteCallback(); _deleteCallback = null; }
});

// ─── Custom Restart Modal ─────────────────────────────────────
document.getElementById('btn-restart').addEventListener('click', () => openModal('modal-confirm-restart'));
document.getElementById('btn-restart-cancel').addEventListener('click', () => closeModal('modal-confirm-restart'));
document.getElementById('btn-restart-confirm').addEventListener('click', async () => {
    closeModal('modal-confirm-restart');
    try {
        await fetch(`${API}/restart`, { method: 'POST' });
        showToast('Bot restarting...');
        setTimeout(() => location.reload(), 3500);
    } catch { showToast('Restart signal sent', 'warning'); }
});

// ─── Stats ────────────────────────────────────────────────────
async function loadStats() {
    try {
        const d = await fetch(`${API}/status`).then(r => r.json());
        if (d.status !== 'ok') return;
        document.getElementById('stat-forwarded').textContent = d.stats.forwarded.toLocaleString();
        document.getElementById('stat-media').textContent = d.stats.media.toLocaleString();
        document.getElementById('stat-failed').textContent = d.stats.failed.toLocaleString();
        document.getElementById('stat-channels').textContent = d.bot.activeChannels.toLocaleString();
        const ramPct = Math.min(100, (d.system.heapUsedMB / (d.system.heapUsedMB + d.system.freeRamMB)) * 100);
        document.getElementById('ram-text').textContent = `${d.system.heapUsedMB} MB`;
        document.getElementById('ram-bar').style.width = ramPct + '%';
        document.getElementById('cpu-text').textContent = d.system.cpuLoad1m;
        document.getElementById('cpu-bar').style.width = `${Math.min(100, d.system.cpuLoad1m * 10)}%`;
        document.getElementById('uptime-text').textContent = d.uptime;
        document.getElementById('stat-tbots').textContent = d.bot.telegramBots;
        document.getElementById('stat-muted').textContent = d.bot.mutedChannels;
        document.getElementById('stat-blocked').textContent = d.bot.blockedUsers;
        document.getElementById('stat-stored').textContent = d.bot.storedMessages;
        document.getElementById('status-text').textContent = 'Server Online';
        document.querySelector('.pulse-indicator').style.backgroundColor = 'var(--success-color)';
        updateRatioChart(d.stats.forwarded, d.stats.failed);
    } catch {
        document.getElementById('status-text').textContent = 'Offline';
        document.querySelector('.pulse-indicator').style.backgroundColor = 'var(--danger-color)';
    }
}
setInterval(() => { if (document.getElementById('section-dashboard').classList.contains('active')) loadStats(); }, 10000);

// ─── Charts ───────────────────────────────────────────────────
let chartMsg = null, chartRatio = null;
const chartHistory = { labels: [], forwarded: [], failed: [] };

function buildChartColors() {
    return { primary: '#3b82f6', success: '#10b981', danger: '#ef4444', textColor: currentTheme === 'dark' ? '#94a3b8' : '#64748b', gridColor: currentTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)' };
}

function renderCharts() {
    const c = buildChartColors();
    const msgCtx = document.getElementById('chart-messages').getContext('2d');
    const ratCtx = document.getElementById('chart-ratio').getContext('2d');
    if (chartMsg) chartMsg.destroy();
    if (chartRatio) chartRatio.destroy();

    chartMsg = new Chart(msgCtx, {
        type: 'line',
        data: {
            labels: chartHistory.labels.length ? chartHistory.labels : ['--'],
            datasets: [
                { label: 'Forwarded', data: chartHistory.forwarded.length ? chartHistory.forwarded : [0], borderColor: c.primary, backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 3 },
                { label: 'Failed',    data: chartHistory.failed.length ? chartHistory.failed : [0],    borderColor: c.danger, backgroundColor: 'rgba(239,68,68,0.07)', fill: true, tension: 0.4, pointRadius: 3 }
            ]
        },
        options: { responsive: true, plugins: { legend: { labels: { color: c.textColor, font: { size: 12 } } } }, scales: { x: { ticks: { color: c.textColor }, grid: { color: c.gridColor } }, y: { ticks: { color: c.textColor }, grid: { color: c.gridColor }, beginAtZero: true } } }
    });

    chartRatio = new Chart(ratCtx, {
        type: 'doughnut',
        data: {
            labels: ['Success', 'Failed'],
            datasets: [{ data: [1, 0], backgroundColor: [c.success, c.danger], borderWidth: 0, hoverOffset: 6 }]
        },
        options: { responsive: true, cutout: '70%', plugins: { legend: { position: 'bottom', labels: { color: c.textColor, padding: 16 } } } }
    });
}

function updateRatioChart(forwarded, failed) {
    if (!chartRatio) return;
    chartRatio.data.datasets[0].data = [forwarded || 0, failed || 0];
    chartRatio.update();
}

function pushChartPoint(label, forwarded, failed) {
    if (chartHistory.labels.length >= 20) { chartHistory.labels.shift(); chartHistory.forwarded.shift(); chartHistory.failed.shift(); }
    chartHistory.labels.push(label);
    chartHistory.forwarded.push(forwarded);
    chartHistory.failed.push(failed);
    if (chartMsg) {
        chartMsg.data.labels = chartHistory.labels;
        chartMsg.data.datasets[0].data = chartHistory.forwarded;
        chartMsg.data.datasets[1].data = chartHistory.failed;
        chartMsg.update();
    }
}

document.querySelectorAll('.chart-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// Periodically push chart data points
setInterval(async () => {
    try {
        const d = await fetch(`${API}/status`).then(r => r.json());
        if (d.status !== 'ok') return;
        const now = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        pushChartPoint(now, d.stats.forwarded, d.stats.failed);
    } catch {}
}, 60000);

// ─── Channels ─────────────────────────────────────────────────
// ─── Channels & Categorization ──────────────────────────────────
let allChannelsData = [];
let allMutedSet = new Set();
let currentCategoryFilter = 'all';
let currentSearchQuery = '';
let collapsedCategories = new Set(JSON.parse(localStorage.getItem('nexus_collapsed_cats') || '[]'));

function saveCollapsedState() {
    localStorage.setItem('nexus_collapsed_cats', JSON.stringify(Array.from(collapsedCategories)));
}

async function loadChannels() {
    try {
        const [channels, muteRes] = await Promise.all([
            fetch(`${API}/channels`).then(r => r.json()),
            fetch(`${API}/mute`).catch(() => ({ json: () => [] }))
        ]);
        const mutedList = await muteRes.json().catch(() => []);
        allMutedSet = new Set(mutedList);
        allChannelsData = Array.isArray(channels) ? channels : [];

        // Update Category Datalist untuk autocomplete di form Add Channel
        const distinctCats = Array.from(new Set(allChannelsData.map(c => c.category || 'General'))).sort();
        const datalist = document.getElementById('category-datalist');
        if (datalist) {
            datalist.innerHTML = distinctCats.map(cat => `<option value="${cat}">`).join('');
        }

        // Update Dropdown Filter Kategori
        const catFilter = document.getElementById('channels-category-filter');
        if (catFilter) {
            const currentVal = catFilter.value || currentCategoryFilter;
            const counts = {};
            allChannelsData.forEach(c => {
                const k = c.category || 'General';
                counts[k] = (counts[k] || 0) + 1;
            });

            catFilter.innerHTML = `<option value="all">Semua Kategori (Total: ${allChannelsData.length})</option>` +
                distinctCats.map(cat => `<option value="${cat}">${cat} (${counts[cat] || 0})</option>`).join('');
            
            if (distinctCats.includes(currentVal) || currentVal === 'all') {
                catFilter.value = currentVal;
                currentCategoryFilter = currentVal;
            } else {
                catFilter.value = 'all';
                currentCategoryFilter = 'all';
            }
        }

        renderGroupedChannels();
        updateAutoLinkBotStatus();
    } catch (err) {
        showToast('Failed to load channels: ' + err.message, 'error');
    }
}

function renderGroupedChannels() {
    const container = document.getElementById('channels-category-container');
    if (!container) return;

    // Filter data berdasarkan Kategori & Search Query
    const query = currentSearchQuery.toLowerCase().trim();
    const filtered = allChannelsData.filter(ch => {
        const cat = ch.category || 'General';
        const matchCat = currentCategoryFilter === 'all' || cat.toLowerCase() === currentCategoryFilter.toLowerCase();
        if (!matchCat) return false;

        if (!query) return true;
        return (
            (ch.name || '').toLowerCase().includes(query) ||
            String(ch.discordId || '').includes(query) ||
            cat.toLowerCase().includes(query) ||
            String(ch.tgChatId || '').includes(query) ||
            String(ch.dcWebhookUrl || '').toLowerCase().includes(query)
        );
    });

    if (!filtered.length) {
        container.innerHTML = `
            <div class="glass-card" style="text-align:center; padding:40px 20px; color:var(--text-secondary);">
                <i class='bx bx-search-alt' style="font-size:2.5rem; opacity:0.5; margin-bottom:8px;"></i>
                <div style="font-weight:600; font-size:1rem; color:var(--text-primary); margin-bottom:4px;">
                    ${allChannelsData.length === 0 ? 'Belum Ada Channel Mapping' : 'Tidak Ada Channel yang Cocok'}
                </div>
                <div style="font-size:0.85rem;">
                    ${allChannelsData.length === 0 
                        ? 'Gunakan tombol <b>Auto-Link Category</b> atau <b>Add Channel</b> untuk mulai menambahkan mapping.' 
                        : 'Coba ubah kata kunci pencarian atau pilih filter kategori lain.'}
                </div>
            </div>`;
        return;
    }

    // Kelompokkan per Kategori
    const groups = new Map();
    filtered.forEach(ch => {
        const cat = ch.category || 'General';
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(ch);
    });

    container.innerHTML = '';

    // Render masing-masing grup kategori
    groups.forEach((channels, catName) => {
        const isCollapsed = collapsedCategories.has(catName);
        const card = document.createElement('div');
        card.className = `category-group-card ${isCollapsed ? 'collapsed' : ''}`;
        card.dataset.category = catName;

        // Cek apakah seluruh channel di kategori ini di-mute
        const allMuted = channels.every(c => allMutedSet.has(c.discordId));

        card.innerHTML = `
            <div class="category-group-header" title="Klik untuk expand / collapse">
                <div class="category-header-title">
                    <i class='bx bx-chevron-down category-collapse-icon'></i>
                    <span class="category-group-name">
                        <i class='bx bx-folder-open'></i> ${escapeHtml(catName)}
                    </span>
                    <span class="category-count-badge">${channels.length} Channels</span>
                </div>
                <div class="category-header-actions" onclick="event.stopPropagation()">
                    <button class="btn-secondary btn-sm btn-cat-mute" data-category="${escapeHtml(catName)}" data-muted="${allMuted}" title="${allMuted ? 'Unmute Seluruh Kategori' : 'Mute Seluruh Kategori'}" style="font-size:0.75rem; padding:4px 9px;">
                        <i class='bx ${allMuted ? 'bx-volume-full' : 'bx-volume-mute'}'></i> ${allMuted ? 'Unmute All' : 'Mute All'}
                    </button>
                    <button class="btn-secondary btn-sm btn-cat-rename" data-category="${escapeHtml(catName)}" title="Ubah Nama Kategori" style="font-size:0.75rem; padding:4px 9px;">
                        <i class='bx bx-edit'></i> Rename
                    </button>
                    <button class="btn-danger btn-sm btn-cat-delete" data-category="${escapeHtml(catName)}" data-count="${channels.length}" title="Hapus Seluruh Kategori & Channel di dalamnya" style="font-size:0.75rem; padding:4px 9px;">
                        <i class='bx bx-trash'></i> Delete
                    </button>
                </div>
            </div>
            <div class="category-group-body">
                <div class="table-responsive no-padding">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Discord Channel ID</th>
                                <th>Telegram Chat ID</th>
                                <th>Bot Key / Thread</th>
                                <th>Discord Webhook (DC-to-DC)</th>
                                <th>Status</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${channels.map(ch => {
                                const isMuted = allMutedSet.has(ch.discordId);
                                return `
                                <tr>
                                    <td><strong>${escapeHtml(ch.name)}</strong></td>
                                    <td style="font-family:monospace;font-size:.82rem">${ch.discordId}</td>
                                    <td style="font-family:monospace;font-size:.82rem">${ch.tgChatId || '<span style="color:var(--text-secondary)">—</span>'}</td>
                                    <td>
                                        <span class="tag">Bot #${ch.botKey || '1'}</span>
                                        ${ch.threadId ? `<br><span class="tag" style="margin-top:4px;display:inline-block">Topic: ${ch.threadId}</span>` : ''}
                                    </td>
                                    <td style="font-family:monospace;font-size:.8rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${ch.dcWebhookUrl || ''}">
                                        ${ch.dcWebhookUrl ? '✅ Configured' + (ch.dcThreadId ? `<br><span class="tag" style="margin-top:2px;font-size:0.7rem;">Thread: ${ch.dcThreadId}</span>` : '') + (ch.dcAutoPing ? `<br><span class="tag" style="margin-top:2px;font-size:0.7rem;">Ping: ${ch.dcAutoPing}</span>` : '') : '<span style="color:var(--text-secondary)">—</span>'}
                                    </td>
                                    <td>${isMuted ? '<span class="tag muted-tag">🔇 Muted</span>' : '<span class="tag" style="background:rgba(16,185,129,.1);color:var(--success-color)">🟢 Active</span>'}</td>
                                    <td>
                                        <div class="action-btns">
                                            <button class="btn-mute ${isMuted ? 'muted' : ''}" data-id="${ch.discordId}" data-muted="${isMuted}" title="${isMuted ? 'Unmute' : 'Mute'}">
                                                <i class='bx ${isMuted ? 'bx-volume-full' : 'bx-volume-mute'}'></i>
                                            </button>
                                            <button class="btn-test" data-id="${ch.discordId}" data-name="${escapeHtml(ch.name)}" data-tg="${ch.tgChatId || ''}" data-bot="${ch.botKey || '1'}" title="Send Test Message">
                                                <i class='bx bx-send'></i>
                                            </button>
                                            <button class="btn-edit-ch" data-id="${ch.discordId}" data-name="${escapeHtml(ch.name)}" data-category="${escapeHtml(ch.category || 'General')}" data-tg="${ch.tgChatId || ''}" data-bot="${ch.botKey || '1'}" data-thread="${ch.threadId || ''}" data-dcwebhook="${ch.dcWebhookUrl || ''}" data-dcthread="${ch.dcThreadId || ''}" data-dcping="${ch.dcAutoPing || ''}" data-dcuser="${ch.dcCustomUsername || ''}" data-dcavatar="${ch.dcCustomAvatarUrl || ''}" data-dconlymedia="${ch.dcOnlyWithMedia ? 'true' : 'false'}" data-dcstripinvites="${ch.dcStripInvites !== false ? 'true' : 'false'}" title="Edit Mapping" style="background: rgba(59,130,246,0.1); color: var(--primary-color); padding: 5px 10px; border: 1px solid rgba(59,130,246,0.2); border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px; font-size: 0.8rem;">
                                                <i class='bx bx-edit'></i>
                                            </button>
                                            <button class="btn-danger btn-delete-ch" data-id="${ch.discordId}" data-name="${escapeHtml(ch.name)}" title="Delete">
                                                <i class='bx bx-trash'></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // Toggle collapse saat header diklik
        const header = card.querySelector('.category-group-header');
        header.addEventListener('click', () => {
            card.classList.toggle('collapsed');
            if (card.classList.contains('collapsed')) {
                collapsedCategories.add(catName);
            } else {
                collapsedCategories.delete(catName);
            }
            saveCollapsedState();
        });

        container.appendChild(card);
    });

    // Wire-up event buttons di dalam tabel
    attachChannelActionListeners();
}

function attachChannelActionListeners() {
    // Mute channel satuan
    document.querySelectorAll('.btn-mute').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const muted = btn.dataset.muted === 'true';
            const endpoint = muted ? `${API}/mute/${id}/unmute` : `${API}/mute/${id}/mute`;
            try {
                await fetch(endpoint, { method: 'POST' });
                showToast(muted ? 'Channel unmuted' : 'Channel muted', 'success');
                loadChannels();
            } catch { showToast('Gagal mengubah status mute', 'error'); }
        });
    });

    // Test message
    document.querySelectorAll('.btn-test').forEach(btn => {
        btn.addEventListener('click', () => {
            const info = document.getElementById('test-channel-info');
            info.innerHTML = `<b>Channel:</b> ${btn.dataset.name}<br><b>Telegram:</b> ${btn.dataset.tg || '—'} &nbsp; <b>Bot:</b> #${btn.dataset.bot}`;
            document.getElementById('test-msg-text').value = '';
            document.getElementById('btn-send-test').dataset.id = btn.dataset.id;
            openModal('modal-test-msg');
        });
    });

    // Edit channel
    document.querySelectorAll('.btn-edit-ch').forEach(btn => {
        btn.addEventListener('click', () => {
            currentEditingChannelId = btn.dataset.id;
            document.getElementById('modal-channel-title').textContent = 'Edit Mapping';
            document.getElementById('ch-category').value = btn.dataset.category || 'General';
            document.getElementById('ch-name').value = btn.dataset.name;
            document.getElementById('ch-discordId').value = btn.dataset.id;
            document.getElementById('ch-tgChatId').value = btn.dataset.tg;
            document.getElementById('ch-botKey').value = btn.dataset.bot;
            document.getElementById('ch-threadId').value = btn.dataset.thread;
            document.getElementById('ch-dcWebhookUrl').value = btn.dataset.dcwebhook;
            document.getElementById('ch-dcThreadId').value = btn.dataset.dcthread || '';
            document.getElementById('ch-dcAutoPing').value = btn.dataset.dcping || '';
            document.getElementById('ch-dcCustomUsername').value = btn.dataset.dcuser || '';
            document.getElementById('ch-dcCustomAvatarUrl').value = btn.dataset.dcavatar || '';
            document.getElementById('ch-dcOnlyWithMedia').checked = btn.dataset.dconlymedia === 'true';
            document.getElementById('ch-dcStripInvites').checked = btn.dataset.dcstripinvites !== 'false';
            const dcDetails = document.getElementById('dc-advanced-details');
            if (dcDetails) {
                dcDetails.open = Boolean(btn.dataset.dcthread || btn.dataset.dcping || btn.dataset.dcuser || btn.dataset.dcavatar);
            }
            openModal('modal-channel');
        });
    });

    // Delete channel satuan
    document.querySelectorAll('.btn-delete-ch').forEach(btn => {
        btn.addEventListener('click', () => {
            confirmDelete(btn.dataset.name, async () => {
                try {
                    const r = await fetch(`${API}/channels/${btn.dataset.id}`, { method: 'DELETE' });
                    if (r.ok) { showToast('Mapping berhasil dihapus'); loadChannels(); }
                    else showToast('Gagal menghapus mapping', 'error');
                } catch { showToast('Connection error', 'error'); }
            });
        });
    });

    // Category Mute All
    document.querySelectorAll('.btn-cat-mute').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const cat = btn.dataset.category;
            const isMuted = btn.dataset.muted === 'true';
            try {
                const r = await fetch(`${API}/categories/${encodeURIComponent(cat)}/mute`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mute: !isMuted })
                });
                const d = await r.json();
                if (d.success) {
                    showToast(`Kategori "${cat}" ${isMuted ? 'di-unmute' : 'di-mute'} (${d.affected.length} channel)`, 'success');
                    loadChannels();
                }
            } catch { showToast('Gagal mute kategori', 'error'); }
        });
    });

    // Category Rename
    document.querySelectorAll('.btn-cat-rename').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cat = btn.dataset.category;
            document.getElementById('rename-cat-old').value = cat;
            document.getElementById('rename-cat-new').value = cat;
            openModal('modal-rename-category');
        });
    });

    // Category Delete All
    document.querySelectorAll('.btn-cat-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cat = btn.dataset.category;
            const count = btn.dataset.count;
            if (confirm(`⚠️ PERINGATAN: Apakah Anda yakin ingin menghapus seluruh kategori "${cat}" beserta ${count} channel di dalamnya? Tindakan ini tidak dapat dibatalkan.`)) {
                fetch(`${API}/categories/${encodeURIComponent(cat)}`, { method: 'DELETE' })
                    .then(r => r.json())
                    .then(d => {
                        if (d.success) {
                            showToast(`Kategori "${cat}" (${d.count} channel) berhasil dihapus!`, 'success');
                            loadChannels();
                        } else {
                            showToast(d.error || 'Gagal menghapus kategori', 'error');
                        }
                    })
                    .catch(() => showToast('Connection error', 'error'));
            }
        });
    });
}

// ─── Toolbar Handlers (Search, Filter, Expand/Collapse) ─────────
const channelsSearchInput = document.getElementById('channels-search');
if (channelsSearchInput) {
    let searchDebounce = null;
    channelsSearchInput.addEventListener('input', e => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            currentSearchQuery = e.target.value.trim();
            renderGroupedChannels();
        }, 200);
    });
}

const channelsCategoryFilter = document.getElementById('channels-category-filter');
if (channelsCategoryFilter) {
    channelsCategoryFilter.addEventListener('change', e => {
        currentCategoryFilter = e.target.value;
        renderGroupedChannels();
    });
}

const btnToggleAllCats = document.getElementById('btn-toggle-all-cats');
if (btnToggleAllCats) {
    btnToggleAllCats.addEventListener('click', () => {
        const distinctCats = Array.from(new Set(allChannelsData.map(c => c.category || 'General')));
        const allAreCollapsed = distinctCats.every(c => collapsedCategories.has(c));
        if (allAreCollapsed) {
            collapsedCategories.clear();
        } else {
            distinctCats.forEach(c => collapsedCategories.add(c));
        }
        saveCollapsedState();
        renderGroupedChannels();
    });
}

// Form Rename Category
const formRenameCat = document.getElementById('form-rename-category');
if (formRenameCat) {
    formRenameCat.addEventListener('submit', async e => {
        e.preventDefault();
        const oldName = document.getElementById('rename-cat-old').value;
        const newName = document.getElementById('rename-cat-new').value.trim();
        if (!newName) return;
        try {
            const r = await fetch(`${API}/categories/${encodeURIComponent(oldName)}/rename`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newName })
            });
            const d = await r.json();
            if (d.success) {
                showToast(`Kategori berhasil diubah menjadi "${newName}"`, 'success');
                closeModal('modal-rename-category');
                loadChannels();
            } else {
                showToast(d.error || 'Gagal mengubah nama kategori', 'error');
            }
        } catch { showToast('Connection error', 'error'); }
    });
}

// ─── Auto-Link Category Manager ────────────────────────────────
const btnAutolinkModal = document.getElementById('btn-autolink-modal');
if (btnAutolinkModal) {
    btnAutolinkModal.addEventListener('click', () => {
        document.getElementById('form-autolink').reset();
        document.getElementById('autolink-preview-container').style.display = 'none';
        document.getElementById('autolink-progress-container').style.display = 'none';
        document.getElementById('autolink-log').innerHTML = '';
        updateAutoLinkBotStatus();
        openModal('modal-autolink');
    });
}

async function updateAutoLinkBotStatus() {
    const el = document.getElementById('autolink-botpool-status');
    if (!el) return;
    try {
        const bots = await fetch(`${API}/autolink/bots`).then(r => r.json());
        const validBots = bots.filter(b => b.valid);
        if (validBots.length === 0) {
            el.innerHTML = `<span style="color:#f87171;"><i class='bx bx-error-circle'></i> Belum ada bot terdaftar. Klik <b>Kelola Bot Tokens</b> untuk menambahkan 3-4 bot.</span>`;
        } else {
            el.innerHTML = `<span style="color:#34d399;"><i class='bx bx-check-circle'></i> <b>${validBots.length} Bot Siap</b> (Rotasi Multi-Bot Anti-Rate-Limit aktif)</span> &nbsp;·&nbsp; ${validBots.map(b => b.username).join(', ')}`;
        }
    } catch {
        el.textContent = 'Gagal memuat status bot.';
    }
}

// Preview Source Channels
const btnAutolinkPreview = document.getElementById('btn-autolink-preview');
if (btnAutolinkPreview) {
    btnAutolinkPreview.addEventListener('click', async () => {
        const srcGuild = document.getElementById('autolink-source-guild').value.trim();
        const srcCat = document.getElementById('autolink-source-category').value.trim();
        if (!srcGuild || !srcCat) {
            showToast('Isi ID Server Sumber & ID Kategori Sumber terlebih dahulu', 'warning');
            return;
        }

        btnAutolinkPreview.disabled = true;
        btnAutolinkPreview.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Membaca...`;
        try {
            const r = await fetch(`${API}/autolink/preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceGuildId: srcGuild, sourceCategoryId: srcCat })
            });
            const d = await r.json();
            if (d.success) {
                const prev = d.preview;
                document.getElementById('autolink-preview-container').style.display = 'block';
                document.getElementById('autolink-preview-title').textContent = `Kategori: "${prev.sourceCategoryName}" (${prev.sourceGuildName})`;
                document.getElementById('autolink-preview-badge').textContent = `${prev.channelCount} Text Channels`;
                
                // Auto-fill nama kategori jika masih kosong
                const catNameInput = document.getElementById('autolink-category-name');
                if (!catNameInput.value.trim()) {
                    catNameInput.value = prev.sourceCategoryName;
                }

                const listEl = document.getElementById('autolink-preview-list');
                listEl.innerHTML = prev.channels.map(c => `
                    <div style="display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.04);">
                        <span>#${c.name} <span style="opacity:0.6;font-size:0.75rem;">(${c.id})</span></span>
                        <span>${c.alreadyMapped ? '<span style="color:#fbbf24;">⚠️ Sudah Dimapping</span>' : '<span style="color:#34d399;">✅ Siap Di-link</span>'}</span>
                    </div>
                `).join('');
                showToast(`Ditemukan ${prev.channelCount} channel di kategori sumber!`, 'success');
            } else {
                showToast(d.error || 'Gagal membaca kategori sumber', 'error');
            }
        } catch (err) {
            showToast('Connection error: ' + err.message, 'error');
        } finally {
            btnAutolinkPreview.disabled = false;
            btnAutolinkPreview.innerHTML = `<i class='bx bx-search'></i> Preview Channel`;
        }
    });
}

// Execute AutoLink
const formAutolink = document.getElementById('form-autolink');
if (formAutolink) {
    formAutolink.addEventListener('submit', async e => {
        e.preventDefault();
        const payload = {
            sourceGuildId: document.getElementById('autolink-source-guild').value.trim(),
            sourceCategoryId: document.getElementById('autolink-source-category').value.trim(),
            targetGuildId: document.getElementById('autolink-target-guild').value.trim(),
            targetCategoryId: document.getElementById('autolink-target-category').value.trim() || null,
            categoryName: document.getElementById('autolink-category-name').value.trim(),
            autoSync: document.getElementById('autolink-autosync').checked
        };

        const progressContainer = document.getElementById('autolink-progress-container');
        const progressBar = document.getElementById('autolink-progress-bar');
        const progressPct = document.getElementById('autolink-progress-pct');
        const progressLabel = document.getElementById('autolink-progress-label');
        const logEl = document.getElementById('autolink-log');
        const btnStart = document.getElementById('btn-autolink-start');

        progressContainer.style.display = 'block';
        progressBar.style.width = '15%';
        progressPct.textContent = '15%';
        progressLabel.textContent = 'Memulai proses pembuatan channel & webhook...';
        logEl.innerHTML = `<div class="log-line">🚀 Memulai Auto-Link & Provisioning ke server tujuan...</div>`;

        btnStart.disabled = true;
        btnStart.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Sedang Memproses...`;

        try {
            // Simulasi progress halus sembari menunggu backend selesai
            let fakePct = 15;
            const progressTimer = setInterval(() => {
                if (fakePct < 85) {
                    fakePct += 5;
                    progressBar.style.width = `${fakePct}%`;
                    progressPct.textContent = `${fakePct}%`;
                }
            }, 500);

            const r = await fetch(`${API}/autolink/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            clearInterval(progressTimer);

            const d = await r.json();
            if (d.success) {
                progressBar.style.width = '100%';
                progressPct.textContent = '100%';
                progressLabel.textContent = 'Selesai!';

                const res = d.result;
                logEl.innerHTML += `
                    <div class="log-line log-success">✅ Berhasil membuat Kategori / Channel tujuan!</div>
                    <div class="log-line log-success">✅ ${res.created.length} channel baru dibuat & webhook terpasang.</div>
                    ${res.updated.length ? `<div class="log-line log-warn">ℹ️ ${res.updated.length} channel diperbarui mappingnya.</div>` : ''}
                    ${res.errors.length ? `<div class="log-line log-err">❌ ${res.errors.length} channel mengalami kendala: ${res.errors.map(e => e.name).join(', ')}</div>` : ''}
                    <div class="log-line log-success">✨ Seluruh mapping disimpan ke kategori "${res.categoryName}"!</div>
                `;

                showToast(`Auto-Link Selesai! ${res.created.length + res.updated.length} channel tersambung.`, 'success');
                setTimeout(() => {
                    closeModal('modal-autolink');
                    loadChannels();
                }, 2000);
            } else {
                progressBar.style.width = '0%';
                progressPct.textContent = '0%';
                progressLabel.textContent = 'Gagal!';
                logEl.innerHTML += `<div class="log-line log-err">❌ Error: ${d.error || 'Gagal mengeksekusi'}</div>`;
                showToast(d.error || 'Gagal mengeksekusi auto-link', 'error');
            }
        } catch (err) {
            logEl.innerHTML += `<div class="log-line log-err">❌ Connection error: ${err.message}</div>`;
            showToast('Connection error: ' + err.message, 'error');
        } finally {
            btnStart.disabled = false;
            btnStart.innerHTML = `<i class='bx bx-rocket'></i> Mulai Auto-Link & Provisioning`;
        }
    });
}

// ─── Bot Pool Modal Handlers ────────────────────────────────────
function openBotPoolModal() {
    loadBotPool();
    openModal('modal-botpool');
}

const btnOpenBotpool = document.getElementById('btn-open-botpool');
if (btnOpenBotpool) btnOpenBotpool.addEventListener('click', openBotPoolModal);

const btnOpenBotpoolMgr = document.getElementById('btn-open-botpool-mgr');
if (btnOpenBotpoolMgr) btnOpenBotpoolMgr.addEventListener('click', openBotPoolModal);

async function loadBotPool() {
    const tbody = document.getElementById('botpool-table-body');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:16px;">Memuat daftar bot...</td></tr>`;
    try {
        const bots = await fetch(`${API}/autolink/bots`).then(r => r.json());
        if (!bots.length) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-secondary);">Belum ada Bot Discord resmi di pool. Tambahkan minimal 1 bot token (disarankan 3-4).</td></tr>`;
            return;
        }

        tbody.innerHTML = bots.map((b, idx) => `
            <tr>
                <td>
                    <div style="display:flex;align-items:center;gap:8px;">
                        ${b.avatar ? `<img src="${b.avatar}" style="width:26px;height:26px;border-radius:50%;">` : `<i class='bx bxl-discord' style="font-size:1.4rem;color:#5865f2;"></i>`}
                        <strong>${escapeHtml(b.username || 'Bot #' + (idx+1))}</strong>
                    </div>
                </td>
                <td style="font-family:monospace;font-size:0.8rem;">${b.id || '—'}</td>
                <td style="font-family:monospace;font-size:0.8rem;">${b.tokenMasked || '••••••••'}</td>
                <td>${b.valid ? '<span class="tag" style="background:rgba(16,185,129,.1);color:var(--success-color);">🟢 Valid</span>' : '<span class="tag" style="background:rgba(239,68,68,.1);color:#f87171;">🔴 Error</span>'}</td>
                <td>
                    <button class="btn-danger btn-sm btn-delete-botpool" data-id="${b.id || b.token}" title="Hapus Bot" style="padding:4px 8px;">
                        <i class='bx bx-trash'></i>
                    </button>
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.btn-delete-botpool').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (confirm('Hapus bot ini dari pool?')) {
                    try {
                        const r = await fetch(`${API}/autolink/bots/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
                        if (r.ok) {
                            showToast('Bot dihapus dari pool', 'success');
                            loadBotPool();
                            updateAutoLinkBotStatus();
                        }
                    } catch { showToast('Gagal menghapus bot', 'error'); }
                }
            });
        });
    } catch {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#f87171;">Gagal memuat bot pool.</td></tr>`;
    }
}

const formAddBotpool = document.getElementById('form-add-botpool');
if (formAddBotpool) {
    formAddBotpool.addEventListener('submit', async e => {
        e.preventDefault();
        const input = document.getElementById('input-new-bot-token');
        const token = input.value.trim();
        if (!token) return;

        const btn = document.getElementById('btn-save-bot-token');
        btn.disabled = true;
        btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Memverifikasi...`;
        try {
            const r = await fetch(`${API}/autolink/bots`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            const d = await r.json();
            if (d.success) {
                showToast(`Bot "${d.bot.username}" berhasil ditambahkan ke pool!`, 'success');
                input.value = '';
                loadBotPool();
                updateAutoLinkBotStatus();
            } else {
                showToast(d.error || 'Gagal menambahkan bot', 'error');
            }
        } catch {
            showToast('Connection error', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<i class='bx bx-plus'></i> Tambah Bot`;
        }
    });
}

// Helper escape HTML
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ─── Test message send ──────────────────────────────────────────
document.getElementById('btn-send-test').addEventListener('click', async function() {
    const id = this.dataset.id;
    const msg = document.getElementById('test-msg-text').value.trim();
    try {
        const r = await fetch(`${API}/channels/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
        const d = await r.json();
        if (d.success) { showToast('Test message sent!', 'success'); closeModal('modal-test-msg'); }
        else showToast(d.error || 'Failed to send test', 'error');
    } catch { showToast('Connection error', 'error'); }
});

// Add/Edit channel modal
let currentEditingChannelId = null;
document.getElementById('btn-add-channel').addEventListener('click', () => { 
    currentEditingChannelId = null;
    document.getElementById('modal-channel-title').textContent = 'Add New Mapping';
    document.getElementById('form-channel').reset(); 
    document.getElementById('ch-category').value = currentCategoryFilter !== 'all' ? currentCategoryFilter : 'General';
    document.getElementById('ch-dcThreadId').value = '';
    document.getElementById('ch-dcAutoPing').value = '';
    document.getElementById('ch-dcCustomUsername').value = '';
    document.getElementById('ch-dcCustomAvatarUrl').value = '';
    document.getElementById('ch-dcOnlyWithMedia').checked = false;
    document.getElementById('ch-dcStripInvites').checked = true;
    const dcDetails = document.getElementById('dc-advanced-details');
    if (dcDetails) dcDetails.open = false;
    openModal('modal-channel'); 
});

document.getElementById('form-channel').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = { 
        category: document.getElementById('ch-category').value.trim() || 'General',
        name: document.getElementById('ch-name').value, 
        discordId: document.getElementById('ch-discordId').value, 
        tgChatId: document.getElementById('ch-tgChatId').value, 
        botKey: document.getElementById('ch-botKey').value, 
        threadId: document.getElementById('ch-threadId').value || null, 
        dcWebhookUrl: document.getElementById('ch-dcWebhookUrl').value || null,
        dcThreadId: document.getElementById('ch-dcThreadId').value.trim() || null,
        dcAutoPing: document.getElementById('ch-dcAutoPing').value.trim() || null,
        dcCustomUsername: document.getElementById('ch-dcCustomUsername').value.trim() || null,
        dcCustomAvatarUrl: document.getElementById('ch-dcCustomAvatarUrl').value.trim() || null,
        dcOnlyWithMedia: document.getElementById('ch-dcOnlyWithMedia').checked,
        dcStripInvites: document.getElementById('ch-dcStripInvites').checked
    };
    try {
        let url = `${API}/channels`;
        let method = 'POST';
        
        if (currentEditingChannelId) {
            url = `${API}/channels/${currentEditingChannelId}`;
            method = 'PUT';
        }
        
        const r = await fetch(url, { 
            method, 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        const data = await r.json();
        if (r.ok) { 
            showToast(currentEditingChannelId ? 'Mapping updated!' : 'Channel added!'); 
            closeModal('modal-channel'); 
            loadChannels(); 
        } else {
            showToast(data.error || 'Failed to save', 'error');
        }
    } catch { 
        showToast('Connection error', 'error'); 
    }
});

// ─── Config (Bots & Tokens) ───────────────────────────────────
let tgState = [], dcState = [];

async function loadConfig() {
    try {
        const d = await fetch(`${API}/config`).then(r => r.json());
        tgState = d.telegramBots || [];
        dcState = d.discordTokens || [];
        document.getElementById('config-watermark').value = d.watermark || '';
        document.getElementById('config-admin').value = d.adminId || '';
        document.getElementById('config-adminBotKey').value = d.adminBotKey || '1';
        document.getElementById('config-healthPort').value = d.healthPort || '3000';
        
        document.getElementById('config-forwardBot').checked = d.forwardBotMessages;
        document.getElementById('config-forwardEdits').checked = d.forwardEdits;
        document.getElementById('config-forwardReactions').checked = d.forwardReactions;
        document.getElementById('config-showAuthor').checked = d.showAuthorName;
        document.getElementById('config-showChannel').checked = d.showChannelName;
        document.getElementById('config-showServer').checked = d.showServerName;
        
        document.getElementById('config-blockedUsers').value = d.blockedUserIds || '';
        document.getElementById('config-blacklistWords').value = d.blacklistWords || '';
        document.getElementById('config-whitelistWords').value = d.whitelistWords || '';
        document.getElementById('config-maxLength').value = d.maxMessageLength || '4000';
        document.getElementById('config-rateLimit').value = d.rateLimitDelay || '200';
        
        document.getElementById('config-tgApiId').value = d.tgApiId || '';
        document.getElementById('config-tgApiHash').value = d.tgApiHash || '';
        document.getElementById('config-tgUserSession').value = d.tgUserSession || '';

        // DC to DC Global Settings
        document.getElementById('config-dcReplyQuote').checked = d.dcReplyQuote !== false;
        document.getElementById('config-dcStripInvites').checked = d.dcStripInvites !== false;
        document.getElementById('config-dcOnlyWithMedia').checked = d.dcOnlyWithMedia === true;
        document.getElementById('config-dcCustomName').value = d.dcCustomName || '';
        document.getElementById('config-dcCustomAvatar').value = d.dcCustomAvatar || '';
        document.getElementById('config-dcAutoPing').value = d.dcAutoPing || '';
        
        renderBots(); renderTokens();
        const wm = await fetch(`${API}/watermark`).then(r => r.json());
        document.getElementById('wm-enabled').checked = wm.enabled;
        document.getElementById('wm-size').value = wm.sizePercent;
        document.getElementById('wm-opacity').value = wm.opacity;
        document.getElementById('wm-status').style.display = wm.hasImage ? 'block' : 'none';
        
        if (wm.customPosition) wmPos = wm.customPosition;
        if (wm.blurBoxes) blurBoxes = wm.blurBoxes;
        renderVisualEditor();
    } catch { showToast('Failed to load config', 'error'); }
}

function renderBots() {
    const c = document.getElementById('telegram-bots-container');
    c.innerHTML = '';
    if (!tgState.length) tgState.push({ id: 1, token: '' });
    tgState.forEach((bot, i) => {
        const d = document.createElement('div');
        d.className = 'input-group';
        d.innerHTML = `<div class="id-badge">${bot.id}</div><input type="password" value="${bot.token}" placeholder="1234567890:AAH..." class="bot-token-input" data-idx="${i}">${bot.username ? `<span class="account-name-badge" title="${bot.username}">${bot.username}</span>` : ''}<button class="btn-danger btn-remove-bot" data-idx="${i}"><i class='bx bx-x'></i></button>`;
        c.appendChild(d);
    });
    c.querySelectorAll('.btn-remove-bot').forEach(b => b.addEventListener('click', () => { tgState.splice(+b.dataset.idx, 1); renderBots(); }));
    c.querySelectorAll('.bot-token-input').forEach(inp => inp.addEventListener('input', () => { tgState[+inp.dataset.idx].token = inp.value; }));
}

function renderTokens() {
    const c = document.getElementById('discord-tokens-container');
    c.innerHTML = '';
    if (!dcState.length) dcState.push({ token: '', tag: '', status: '', error: '' });
    dcState.forEach((item, i) => {
        const token = typeof item === 'string' ? item : (item.token || '');
        const tag = typeof item === 'object' ? (item.tag || '') : '';
        const status = typeof item === 'object' ? (item.status || '') : '';
        const error = typeof item === 'object' ? (item.error || '') : '';
        
        let badgeHtml = '';
        if (tag) {
            badgeHtml = `<span class="account-name-badge badge-online" title="Online: ${tag}"><i class='bx bx-check-circle'></i> ${tag}</span>`;
        } else if (status === 'connecting') {
            badgeHtml = `<span class="account-name-badge badge-warning" title="Sedang menghubungkan ke Discord..."><i class='bx bx-loader-alt bx-spin'></i> Menghubungkan...</span>`;
        } else if (status === 'error') {
            badgeHtml = `<span class="account-name-badge badge-danger" title="${error || 'Token tidak valid / gagal login'}"><i class='bx bx-error-circle'></i> ${error ? (error.length > 20 ? error.substring(0, 20) + '...' : error) : 'Gagal Login'}</span>`;
        }

        const d = document.createElement('div');
        d.className = 'input-group';
        d.innerHTML = `<div class="id-badge"><i class='bx bxl-discord'></i></div><input type="password" value="${token}" placeholder="Discord Token..." class="dc-token-input" data-idx="${i}">${badgeHtml}<button class="btn-danger btn-remove-token" data-idx="${i}"><i class='bx bx-x'></i></button>`;
        c.appendChild(d);
    });
    c.querySelectorAll('.btn-remove-token').forEach(b => b.addEventListener('click', () => { dcState.splice(+b.dataset.idx, 1); renderTokens(); }));
    c.querySelectorAll('.dc-token-input').forEach(inp => {
        inp.addEventListener('input', () => {
            const val = inp.value;
            if (typeof dcState[+inp.dataset.idx] === 'string') {
                dcState[+inp.dataset.idx] = val;
            } else {
                dcState[+inp.dataset.idx].token = val;
            }
        });
    });
}

document.getElementById('btn-add-bot').addEventListener('click', () => { tgState.push({ id: tgState.length ? Math.max(...tgState.map(b => b.id)) + 1 : 1, token: '' }); renderBots(); });
document.getElementById('btn-add-token').addEventListener('click', () => { dcState.push({ token: '', tag: '' }); renderTokens(); });

document.getElementById('btn-save-config').addEventListener('click', async () => {
    const payload = {
        telegramBots: tgState.filter(b => b.token.trim()), 
        discordTokens: dcState.map(t => typeof t === 'string' ? t.trim() : (t.token || '').trim()).filter(Boolean), 
        watermark: document.getElementById('config-watermark').value, 
        adminId: document.getElementById('config-admin').value,
        adminBotKey: document.getElementById('config-adminBotKey').value,
        healthPort: document.getElementById('config-healthPort').value,
        forwardBotMessages: document.getElementById('config-forwardBot').checked,
        forwardEdits: document.getElementById('config-forwardEdits').checked,
        forwardReactions: document.getElementById('config-forwardReactions').checked,
        showAuthorName: document.getElementById('config-showAuthor').checked,
        showChannelName: document.getElementById('config-showChannel').checked,
        showServerName: document.getElementById('config-showServer').checked,
        blockedUserIds: document.getElementById('config-blockedUsers').value,
        blacklistWords: document.getElementById('config-blacklistWords').value,
        whitelistWords: document.getElementById('config-whitelistWords').value,
        maxMessageLength: document.getElementById('config-maxLength').value,
        rateLimitDelay: document.getElementById('config-rateLimit').value,
        tgApiId: document.getElementById('config-tgApiId').value,
        tgApiHash: document.getElementById('config-tgApiHash').value,
        tgUserSession: document.getElementById('config-tgUserSession').value,
        dcReplyQuote: document.getElementById('config-dcReplyQuote').checked,
        dcStripInvites: document.getElementById('config-dcStripInvites').checked,
        dcOnlyWithMedia: document.getElementById('config-dcOnlyWithMedia').checked,
        dcCustomName: document.getElementById('config-dcCustomName').value,
        dcCustomAvatar: document.getElementById('config-dcCustomAvatar').value,
        dcAutoPing: document.getElementById('config-dcAutoPing').value
    };
    try {
        const r = await fetch(`${API}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (r.ok) showToast('Config saved! Restart bot to apply.');
        else showToast('Save failed', 'error');
    } catch { showToast('Connection error', 'error'); }
});

// ─── Visual Editor Logic ──────────────────────────────────────
let currentVisMode = 'watermark';
let wmPos = { x: 80, y: 80 };
let blurBoxes = [];

const visualContainer = document.getElementById('visual-editor-container');
const sampleImg = document.getElementById('sample-image-preview');
const wmDraggable = document.getElementById('watermark-draggable');
const blurLayer = document.getElementById('blur-layer');
const placeholderText = document.getElementById('visual-editor-placeholder');

document.getElementById('btn-mode-watermark').addEventListener('click', (e) => {
    currentVisMode = 'watermark';
    e.target.classList.add('active');
    document.getElementById('btn-mode-blur').classList.remove('active');
    wmDraggable.style.pointerEvents = 'auto';
    blurLayer.style.pointerEvents = 'none';
});

document.getElementById('btn-mode-blur').addEventListener('click', (e) => {
    currentVisMode = 'blur';
    e.target.classList.add('active');
    document.getElementById('btn-mode-watermark').classList.remove('active');
    wmDraggable.style.pointerEvents = 'none';
    blurLayer.style.pointerEvents = 'auto';
});

document.getElementById('btn-clear-blur').addEventListener('click', () => {
    blurBoxes = [];
    renderVisualEditor();
});

document.getElementById('sample-image-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        sampleImg.src = url;
        sampleImg.style.display = 'block';
        wmDraggable.style.display = 'block';
        blurLayer.style.display = 'block';
        placeholderText.style.display = 'none';
        
        // Load watermark preview if available
        if(document.getElementById('wm-status').style.display === 'block' && !document.getElementById('watermark-preview-img').src) {
            document.getElementById('watermark-preview-img').src = '/api/watermark/image?' + Date.now();
        }
        
        setTimeout(renderVisualEditor, 100);
    }
});

document.getElementById('wm-file').addEventListener('change', (e) => {
    if (e.target.files[0]) {
        document.getElementById('watermark-preview-img').src = URL.createObjectURL(e.target.files[0]);
    }
});

function renderVisualEditor() {
    if (sampleImg.style.display !== 'block') return;
    
    // Update watermark position and size
    const sizePct = document.getElementById('wm-size').value || 20;
    const opacity = document.getElementById('wm-opacity').value || 0.8;
    wmDraggable.style.width = sizePct + '%';
    wmDraggable.style.opacity = opacity;
    wmDraggable.style.left = wmPos.x + '%';
    wmDraggable.style.top = wmPos.y + '%';
    
    // Render blur boxes
    blurLayer.innerHTML = '';
    blurBoxes.forEach((box, i) => {
        const b = document.createElement('div');
        b.className = 'blur-box';
        b.style.left = box.x + '%';
        b.style.top = box.y + '%';
        b.style.width = box.w + '%';
        b.style.height = box.h + '%';
        
        const rem = document.createElement('div');
        rem.className = 'blur-box-remove';
        rem.innerHTML = '<i class="bx bx-x"></i>';
        rem.onclick = () => { blurBoxes.splice(i, 1); renderVisualEditor(); };
        b.appendChild(rem);
        blurLayer.appendChild(b);
    });
}

// Drag watermark
let isDraggingWm = false;
wmDraggable.addEventListener('mousedown', (e) => {
    if(currentVisMode !== 'watermark') return;
    isDraggingWm = true;
});
window.addEventListener('mousemove', (e) => {
    if(isDraggingWm) {
        const rect = visualContainer.getBoundingClientRect();
        let x = ((e.clientX - rect.left) / rect.width) * 100;
        let y = ((e.clientY - rect.top) / rect.height) * 100;
        x = Math.max(0, Math.min(x, 100 - parseFloat(wmDraggable.style.width)));
        y = Math.max(0, Math.min(y, 100 - (wmDraggable.offsetHeight/rect.height*100)));
        wmPos = { x, y };
        renderVisualEditor();
    }
});
window.addEventListener('mouseup', () => { isDraggingWm = false; });

// Draw blur box
let isDrawingBlur = false;
let startBlurX = 0, startBlurY = 0;
let currentBlurBox = null;

blurLayer.addEventListener('mousedown', (e) => {
    if(currentVisMode !== 'blur') return;
    if(e.target.closest('.blur-box-remove')) return;
    isDrawingBlur = true;
    const rect = blurLayer.getBoundingClientRect();
    startBlurX = ((e.clientX - rect.left) / rect.width) * 100;
    startBlurY = ((e.clientY - rect.top) / rect.height) * 100;
    
    currentBlurBox = document.createElement('div');
    currentBlurBox.className = 'blur-box';
    currentBlurBox.style.left = startBlurX + '%';
    currentBlurBox.style.top = startBlurY + '%';
    currentBlurBox.style.width = '0%';
    currentBlurBox.style.height = '0%';
    blurLayer.appendChild(currentBlurBox);
});

blurLayer.addEventListener('mousemove', (e) => {
    if(isDrawingBlur && currentBlurBox) {
        const rect = blurLayer.getBoundingClientRect();
        let currentX = ((e.clientX - rect.left) / rect.width) * 100;
        let currentY = ((e.clientY - rect.top) / rect.height) * 100;
        
        currentX = Math.max(0, Math.min(currentX, 100));
        currentY = Math.max(0, Math.min(currentY, 100));
        
        const w = Math.abs(currentX - startBlurX);
        const h = Math.abs(currentY - startBlurY);
        const x = Math.min(currentX, startBlurX);
        const y = Math.min(currentY, startBlurY);
        
        currentBlurBox.style.left = x + '%';
        currentBlurBox.style.top = y + '%';
        currentBlurBox.style.width = w + '%';
        currentBlurBox.style.height = h + '%';
    }
});

blurLayer.addEventListener('mouseup', (e) => {
    if(isDrawingBlur && currentBlurBox) {
        isDrawingBlur = false;
        const w = parseFloat(currentBlurBox.style.width);
        const h = parseFloat(currentBlurBox.style.height);
        const x = parseFloat(currentBlurBox.style.left);
        const y = parseFloat(currentBlurBox.style.top);
        
        if(w > 2 && h > 2) { // Only save if big enough
            blurBoxes.push({ x, y, w, h });
        }
        currentBlurBox.remove();
        currentBlurBox = null;
        renderVisualEditor();
    }
});

document.getElementById('wm-size').addEventListener('input', renderVisualEditor);
document.getElementById('wm-opacity').addEventListener('input', renderVisualEditor);

document.getElementById('btn-save-watermark').addEventListener('click', async () => {
    const fd = new FormData();
    fd.append('enabled', document.getElementById('wm-enabled').checked);
    fd.append('sizePercent', document.getElementById('wm-size').value);
    fd.append('opacity', document.getElementById('wm-opacity').value);
    fd.append('customPosition', JSON.stringify(wmPos));
    fd.append('blurBoxes', JSON.stringify(blurBoxes));
    const f = document.getElementById('wm-file');
    if (f.files.length) fd.append('watermarkImage', f.files[0]);
    try {
        const r = await fetch(`${API}/watermark`, { method: 'POST', body: fd });
        if (r.ok) { showToast('Watermark & Blur saved!'); document.getElementById('wm-status').style.display = 'block'; f.value = ''; }
        else showToast('Failed to save', 'error');
    } catch { showToast('Connection error', 'error'); }
});

// ─── Export / Import Config ───────────────────────────────────
document.getElementById('btn-export-config').addEventListener('click', async () => {
    try {
        const [cfg, channels, wm] = await Promise.all([
            fetch(`${API}/config`).then(r => r.json()),
            fetch(`${API}/channels`).then(r => r.json()),
            fetch(`${API}/watermark`).then(r => r.json())
        ]);
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), config: cfg, channels, watermark: wm }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `nexus-config-${Date.now()}.json`;
        a.click();
        showToast('Config exported!');
    } catch { showToast('Export failed', 'error'); }
});

document.getElementById('import-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.config && !data.channels) { showToast('Invalid config file', 'error'); return; }
        if (data.config) {
            await fetch(`${API}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data.config) });
        }
        if (data.channels && Array.isArray(data.channels)) {
            for (const ch of data.channels) {
                await fetch(`${API}/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ch) });
            }
        }
        showToast(`Config imported! ${data.channels?.length || 0} channels restored.`);
        loadConfig(); loadChannels();
    } catch { showToast('Failed to import config', 'error'); }
    e.target.value = '';
});

// ─── Live Activity Log (SSE) ──────────────────────────────────
const activityFeed = document.getElementById('activity-feed');
const miniFeed = document.getElementById('mini-activity-feed');
const badge = document.getElementById('activity-badge');
let logCount = 0;
let sseConnected = false;

const iconMap = { success: { cls: 'success', icon: 'bx-check-circle' }, error: { cls: 'error', icon: 'bx-error-circle' }, media: { cls: 'media', icon: 'bx-image' }, info: { cls: 'info', icon: 'bx-info-circle' }, warning: { cls: 'warning', icon: 'bx-error' } };

function addLogEntry(evt) {
    if (!evt || !evt.message) return;
    const type = evt.type || 'info';
    const ic = iconMap[type] || iconMap.info;
    const ts = evt.time || new Date().toLocaleTimeString('id-ID', { hour12: false });
    const html = `<div class="log-entry"><div class="log-icon ${ic.cls}"><i class='bx ${ic.icon}'></i></div><div class="log-body"><div class="log-msg">${evt.message}</div><div class="log-time">${ts}</div></div></div>`;

    // Main feed
    const empty = activityFeed.querySelector('.activity-empty');
    if (empty) empty.remove();
    activityFeed.insertAdjacentHTML('afterbegin', html);
    while (activityFeed.children.length > 200) activityFeed.removeChild(activityFeed.lastChild);

    // Mini feed
    const mEmpty = miniFeed.querySelector('.activity-empty');
    if (mEmpty) mEmpty.remove();
    miniFeed.insertAdjacentHTML('afterbegin', html.replace('log-entry', 'log-entry'));
    while (miniFeed.children.length > 5) miniFeed.removeChild(miniFeed.lastChild);

    // Badge
    if (!document.getElementById('section-activity').classList.contains('active')) {
        logCount++;
        badge.textContent = logCount > 99 ? '99+' : logCount;
        badge.style.display = 'inline-block';
    }
}

function connectSSE() {
    if (typeof EventSource === 'undefined') { connectPolling(); return; }
    const sseStatus = document.getElementById('sse-status');
    let es;
    function connect() {
        const token = localStorage.getItem('nexus-dashboard-token') || '';
        const url = token ? `${API}/events?key=${encodeURIComponent(token)}` : `${API}/events`;
        es = new EventSource(url);
        es.onopen = () => { sseConnected = true; sseStatus.className = 'sse-status'; };
        es.onmessage = e => { try { addLogEntry(JSON.parse(e.data)); } catch {} };
        es.onerror = () => { sseConnected = false; sseStatus.className = 'sse-status disconnected'; es.close(); setTimeout(connect, 5000); };
    }
    connect();
}

function connectPolling() {
    let lastTs = 0;
    setInterval(async () => {
        try {
            const d = await fetch(`${API}/events/poll?since=${lastTs}`).then(r => r.json());
            if (d.events) { d.events.forEach(ev => addLogEntry(ev)); if (d.events.length) lastTs = Date.now(); }
        } catch {}
    }, 3000);
}

document.getElementById('btn-clear-log').addEventListener('click', () => {
    activityFeed.innerHTML = '<div class="activity-empty">Log cleared.</div>';
    miniFeed.innerHTML = '<div class="activity-empty">Waiting for activity...</div>';
    logCount = 0; badge.style.display = 'none';
});

// ─── Crop Settings ────────────────────────────────────────────
let cropConfigs = {};        // { [channelId]: { enabled, x, y, w, h } }
let cropChannelNames = {};   // { [channelId]: name } dari channelStore
let cropEditingChannelId = null;

// State crop editor
let cropRect = { x: 0, y: 0, w: 100, h: 100 }; // dalam %
let cropDragging = false;
let cropResizing = null; // handle name: 'nw','ne','sw','se','n','s','w','e'
let cropStartMouse = { x: 0, y: 0 };
let cropStartRect = { x: 0, y: 0, w: 0, h: 0 };
let cropImgLoaded = false;

const cropSectionEl         = document.getElementById('section-crop');
const cropChannelListEl     = document.getElementById('crop-channel-list');
const cropEmptyMsgEl        = document.getElementById('crop-empty-msg');
const cropEditorCard        = document.getElementById('crop-editor-card');
const cropEditingLabel      = document.getElementById('crop-editing-channel-label');
const cropCanvasWrapper     = document.getElementById('crop-canvas-wrapper');
const cropPlaceholder       = document.getElementById('crop-editor-placeholder');
const cropPreviewImg        = document.getElementById('crop-preview-image');
const cropSelectionBox      = document.getElementById('crop-selection-box');
const cropEnabledToggle     = document.getElementById('crop-enabled-toggle');
const cropEnabledLabel      = document.getElementById('crop-enabled-label');

const cropOverlays = {
    top:    document.getElementById('crop-overlay-top'),
    bottom: document.getElementById('crop-overlay-bottom'),
    left:   document.getElementById('crop-overlay-left'),
    right:  document.getElementById('crop-overlay-right'),
};

function updateCropCoordsDisplay() {
    document.getElementById('crop-x-val').textContent = cropRect.x.toFixed(1) + '%';
    document.getElementById('crop-y-val').textContent = cropRect.y.toFixed(1) + '%';
    document.getElementById('crop-w-val').textContent = cropRect.w.toFixed(1) + '%';
    document.getElementById('crop-h-val').textContent = cropRect.h.toFixed(1) + '%';
}

function applySelectionBoxToDOM() {
    if (!cropImgLoaded) return;
    const wrapper = cropCanvasWrapper;
    const W = wrapper.offsetWidth;
    const H = cropPreviewImg.offsetHeight;

    const px = (cropRect.x / 100) * W;
    const py = (cropRect.y / 100) * H;
    const pw = (cropRect.w / 100) * W;
    const ph = (cropRect.h / 100) * H;

    cropSelectionBox.style.left   = px + 'px';
    cropSelectionBox.style.top    = py + 'px';
    cropSelectionBox.style.width  = pw + 'px';
    cropSelectionBox.style.height = ph + 'px';

    // Overlays gelap
    cropOverlays.top.style.cssText    = `top:0; left:0; right:0; height:${py}px;`;
    cropOverlays.bottom.style.cssText = `top:${py+ph}px; left:0; right:0; bottom:0;`;
    cropOverlays.left.style.cssText   = `top:${py}px; left:0; width:${px}px; height:${ph}px;`;
    cropOverlays.right.style.cssText  = `top:${py}px; left:${px+pw}px; right:0; height:${ph}px;`;

    updateCropCoordsDisplay();
}

function clampCropRect() {
    cropRect.x = Math.max(0, Math.min(cropRect.x, 99));
    cropRect.y = Math.max(0, Math.min(cropRect.y, 99));
    cropRect.w = Math.max(1, Math.min(cropRect.w, 100 - cropRect.x));
    cropRect.h = Math.max(1, Math.min(cropRect.h, 100 - cropRect.y));
}

function pxToPercent(px, py, wrapperEl) {
    const W = wrapperEl.offsetWidth;
    const H = cropPreviewImg.offsetHeight;
    return { x: (px / W) * 100, y: (py / H) * 100 };
}

// Mouse events di crop-canvas-wrapper untuk drag selection box (move)
cropSelectionBox.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('crop-handle')) return;
    cropDragging = true;
    cropStartMouse = { x: e.clientX, y: e.clientY };
    cropStartRect = { ...cropRect };
    e.preventDefault();
});

// Handle drag resize
document.querySelectorAll('.crop-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
        cropResizing = handle.className.split(' ')[1]; // 'nw','ne',etc
        cropStartMouse = { x: e.clientX, y: e.clientY };
        cropStartRect = { ...cropRect };
        e.preventDefault();
        e.stopPropagation();
    });
});

window.addEventListener('mousemove', (e) => {
    if (!cropImgLoaded) return;
    if (!cropDragging && !cropResizing) return;

    const wrapper = cropCanvasWrapper;
    const W = wrapper.offsetWidth;
    const H = cropPreviewImg.offsetHeight;
    const dx = ((e.clientX - cropStartMouse.x) / W) * 100;
    const dy = ((e.clientY - cropStartMouse.y) / H) * 100;

    if (cropDragging) {
        cropRect.x = cropStartRect.x + dx;
        cropRect.y = cropStartRect.y + dy;
        clampCropRect();
    } else if (cropResizing) {
        const r = cropResizing;
        let { x, y, w, h } = cropStartRect;

        if (r.includes('e')) { w = Math.max(1, w + dx); }
        if (r.includes('s')) { h = Math.max(1, h + dy); }
        if (r.includes('w')) { const newX = Math.min(x + w - 1, x + dx); w = w - (newX - x); x = newX; }
        if (r.includes('n')) { const newY = Math.min(y + h - 1, y + dy); h = h - (newY - y); y = newY; }

        cropRect = { x, y, w, h };
        clampCropRect();
    }

    applySelectionBoxToDOM();
});

window.addEventListener('mouseup', () => {
    cropDragging = false;
    cropResizing = null;
});

// Upload sample image untuk crop preview
document.getElementById('crop-sample-image').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    cropPreviewImg.onload = () => {
        cropImgLoaded = true;
        cropCanvasWrapper.style.display = 'block';
        cropPlaceholder.style.display = 'none';
        applySelectionBoxToDOM();
    };
    cropPreviewImg.src = url;
});

// Toggle enabled
cropEnabledToggle.addEventListener('change', () => {
    cropEnabledLabel.textContent = cropEnabledToggle.checked ? 'Aktif' : 'Nonaktif';
    cropEnabledLabel.style.color = cropEnabledToggle.checked ? 'var(--success-color)' : 'var(--text-secondary)';
});

// Reset crop selection
document.getElementById('btn-reset-crop').addEventListener('click', () => {
    cropRect = { x: 0, y: 0, w: 100, h: 100 };
    applySelectionBoxToDOM();
});

// Tutup editor
document.getElementById('btn-close-crop-editor').addEventListener('click', () => {
    cropEditorCard.style.display = 'none';
    cropEditingChannelId = null;
});

// Resize observer agar overlay tetap sinkron saat window resize
if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (cropImgLoaded) applySelectionBoxToDOM(); });
    ro.observe(cropCanvasWrapper);
}

// ─── Load & Render Crop Configs ───────────────────────────────
async function loadCropConfigs() {
    try {
        const [allCrop, channels] = await Promise.all([
            fetch(`${API}/crop`).then(r => r.json()),
            fetch(`${API}/channels`).then(r => r.json())
        ]);
        cropConfigs = allCrop || {};

        // Buat lookup nama channel dari channelStore
        cropChannelNames = {};
        (channels || []).forEach(ch => { cropChannelNames[ch.discordId] = ch.name; });

        renderCropChannelList();
    } catch {
        showToast('Gagal memuat crop configs', 'error');
    }
}

function renderCropChannelList() {
    // Hapus semua card lama (kecuali empty msg)
    const cards = cropChannelListEl.querySelectorAll('.crop-channel-card');
    cards.forEach(c => c.remove());

    const channelIds = Object.keys(cropConfigs);

    if (!channelIds.length) {
        cropEmptyMsgEl.style.display = 'block';
        return;
    }
    cropEmptyMsgEl.style.display = 'none';

    channelIds.forEach(id => {
        const cfg = cropConfigs[id];
        const name = cropChannelNames[id] || id;

        const card = document.createElement('div');
        card.className = 'crop-channel-card';
        card.dataset.id = id;

        // Mini rect preview
        const previewHTML = `
            <div class="crop-rect-preview">
                <div class="crop-rect-indicator" style="left:${cfg.x}%;top:${cfg.y}%;width:${cfg.w}%;height:${cfg.h}%;"></div>
            </div>`;

        card.innerHTML = `
            <div class="crop-card-header">
                <div class="crop-card-title">
                    <i class='bx bx-crop'></i>
                    ${name}
                </div>
                <span class="crop-status-badge ${cfg.enabled ? 'active' : 'inactive'}">
                    ${cfg.enabled ? '✅ Aktif' : '⏸ Nonaktif'}
                </span>
            </div>
            <div class="crop-channel-id">${id}</div>
            ${previewHTML}
            <div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:10px;">
                X: ${cfg.x.toFixed(1)}% &nbsp; Y: ${cfg.y.toFixed(1)}% &nbsp; W: ${cfg.w.toFixed(1)}% &nbsp; H: ${cfg.h.toFixed(1)}%
            </div>
            <div class="crop-card-actions">
                <button class="btn-edit-crop" data-id="${id}"><i class='bx bx-edit'></i> Edit</button>
                <button class="btn-delete-crop" data-id="${id}" data-name="${name}"><i class='bx bx-trash'></i> Hapus</button>
            </div>`;

        cropChannelListEl.insertBefore(card, cropEmptyMsgEl);

        card.querySelector('.btn-edit-crop').addEventListener('click', () => openCropEditor(id));
        card.querySelector('.btn-delete-crop').addEventListener('click', () => {
            confirmDelete(name + ' (Crop)', async () => {
                try {
                    await fetch(`${API}/crop/${id}`, { method: 'DELETE' });
                    delete cropConfigs[id];
                    renderCropChannelList();
                    if (cropEditingChannelId === id) {
                        cropEditorCard.style.display = 'none';
                        cropEditingChannelId = null;
                    }
                    showToast('Crop config dihapus');
                } catch { showToast('Gagal menghapus', 'error'); }
            });
        });
    });
}

function openCropEditor(channelId) {
    cropEditingChannelId = channelId;
    const cfg = cropConfigs[channelId] || { enabled: false, x: 0, y: 0, w: 100, h: 100 };
    const name = cropChannelNames[channelId] || channelId;

    cropEditingLabel.textContent = `Channel: ${name} (${channelId})`;
    cropEnabledToggle.checked = cfg.enabled;
    cropEnabledLabel.textContent = cfg.enabled ? 'Aktif' : 'Nonaktif';
    cropEnabledLabel.style.color = cfg.enabled ? 'var(--success-color)' : 'var(--text-secondary)';

    cropRect = { x: cfg.x, y: cfg.y, w: cfg.w, h: cfg.h };

    // Reset image preview
    cropImgLoaded = false;
    cropCanvasWrapper.style.display = 'none';
    cropPlaceholder.style.display = 'flex';
    cropPreviewImg.src = '';
    document.getElementById('crop-sample-image').value = '';

    updateCropCoordsDisplay();
    cropEditorCard.style.display = 'block';
    cropEditorCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Simpan crop
document.getElementById('btn-save-crop').addEventListener('click', async () => {
    if (!cropEditingChannelId) { showToast('Pilih channel dulu', 'warning'); return; }
    clampCropRect();
    try {
        const r = await fetch(`${API}/crop/${cropEditingChannelId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: cropEnabledToggle.checked, ...cropRect })
        });
        if (r.ok) {
            const d = await r.json();
            cropConfigs[cropEditingChannelId] = d.config;
            renderCropChannelList();
            showToast('Crop settings disimpan! ✂️');
        } else showToast('Gagal menyimpan', 'error');
    } catch { showToast('Connection error', 'error'); }
});

// Hapus dari editor
document.getElementById('btn-delete-crop-config').addEventListener('click', async () => {
    if (!cropEditingChannelId) return;
    const name = cropChannelNames[cropEditingChannelId] || cropEditingChannelId;
    confirmDelete(name + ' (Crop)', async () => {
        try {
            await fetch(`${API}/crop/${cropEditingChannelId}`, { method: 'DELETE' });
            delete cropConfigs[cropEditingChannelId];
            renderCropChannelList();
            cropEditorCard.style.display = 'none';
            cropEditingChannelId = null;
            showToast('Crop config dihapus');
        } catch { showToast('Gagal menghapus', 'error'); }
    });
});

// Tombol Add Crop Channel
document.getElementById('btn-add-crop-channel').addEventListener('click', () => {
    document.getElementById('crop-new-channel-id').value = '';
    document.getElementById('crop-new-channel-name').value = '';
    openModal('modal-add-crop');
});

document.getElementById('btn-confirm-add-crop').addEventListener('click', () => {
    const channelId = document.getElementById('crop-new-channel-id').value.trim();
    const channelName = document.getElementById('crop-new-channel-name').value.trim();
    if (!channelId || !/^\d+$/.test(channelId)) {
        showToast('Masukkan Discord Channel ID yang valid (angka)', 'warning');
        return;
    }
    closeModal('modal-add-crop');

    // Simpan nama custom jika ada
    if (channelName) cropChannelNames[channelId] = channelName;

    // Jika belum ada config, buat default
    if (!cropConfigs[channelId]) {
        cropConfigs[channelId] = { enabled: false, x: 0, y: 0, w: 100, h: 100 };
    }
    renderCropChannelList();
    openCropEditor(channelId);
});

// ─── Nav hook: load crop saat section crop dibuka ─────────────
// (tambahkan ke navLinks listener yang sudah ada)
document.querySelectorAll('.nav-links a').forEach(link => {
    if (link.getAttribute('data-target') === 'crop') {
        link.addEventListener('click', () => loadCropConfigs());
    }
});

// ─── Smart Blur Settings (Multi-Template Upgrade) ──────────────
let blurConfigs = {};
let blurEditingChannelId = null;
let currentTemplates = []; 
let editingTemplateIndex = -1; // -1 means none, 0+ means index in currentTemplates
let isDrawingBlurBox = false;
let blurStartPos = { x: 0, y: 0 };
let blurActiveBox = null;

const blurSectionEl         = document.getElementById('section-blur');
const blurChannelListEl     = document.getElementById('blur-channel-list');
const blurEmptyMsgEl        = document.getElementById('blur-empty-msg');
const blurEditorCard        = document.getElementById('blur-editor-card');
const blurEditingLabel      = document.getElementById('blur-editing-channel-label');
const blurTemplatesListEl   = document.getElementById('blur-templates-list');
const blurTemplateEditorArea = document.getElementById('blur-template-editor-area');
const blurCanvasWrapper     = document.getElementById('blur-canvas-wrapper');
const blurPlaceholder       = document.getElementById('blur-editor-placeholder');
const blurPreviewImg        = document.getElementById('blur-preview-image');
const blurDrawLayer         = document.getElementById('blur-draw-layer');
const blurEnabledToggle     = document.getElementById('blur-enabled-toggle');
const blurEnabledLabel      = document.getElementById('blur-enabled-label');
const blurBoxesConfigList   = document.getElementById('blur-boxes-config-list');
const blurTemplateNameInp   = document.getElementById('blur-template-name');
const blurRatioInfo         = document.getElementById('blur-template-ratio-info');

async function loadBlurConfigs() {
    try {
        const [allBlur, channels] = await Promise.all([
            fetch(`${API}/blur`).then(r => r.json()),
            fetch(`${API}/channels`).then(r => r.json())
        ]);
        blurConfigs = allBlur || {};
        const channelNames = {};
        (channels || []).forEach(ch => { channelNames[ch.discordId] = ch.name; });
        renderBlurChannelList(channelNames);
    } catch {
        showToast('Gagal memuat blur configs', 'error');
    }
}

function renderBlurChannelList(channelNames) {
    const cards = blurChannelListEl.querySelectorAll('.crop-channel-card');
    cards.forEach(c => c.remove());

    const ids = Object.keys(blurConfigs);
    if (!ids.length) {
        blurEmptyMsgEl.style.display = 'block';
        return;
    }
    blurEmptyMsgEl.style.display = 'none';

    ids.filter(id => id !== 'GLOBAL').forEach(id => {
        const cfg = blurConfigs[id];
        const name = channelNames[id] || id;

        const card = document.createElement('div');
        card.className = 'crop-channel-card';
        card.innerHTML = `
            <div class="crop-card-header">
                <div class="crop-card-title"><i class='bx bx-droplet'></i> ${name}</div>
                <span class="crop-status-badge ${cfg.enabled ? 'active' : 'inactive'}">
                    ${cfg.enabled ? '✅ Aktif' : '⏸ Nonaktif'}
                </span>
            </div>
            <div class="crop-channel-id">${id}</div>
            <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:10px;">
                ${cfg.templates ? cfg.templates.length : 0} smart blur templates defined.
            </div>
            <div class="crop-card-actions">
                <button class="btn-edit-blur" data-id="${id}"><i class='bx bx-edit'></i> Manage</button>
                <button class="btn-delete-blur" data-id="${id}" data-name="${name}"><i class='bx bx-trash'></i></button>
            </div>`;
        
        blurChannelListEl.insertBefore(card, blurEmptyMsgEl);
        card.querySelector('.btn-edit-blur').addEventListener('click', () => openBlurEditor(id, name));
        card.querySelector('.btn-delete-blur').addEventListener('click', () => deleteBlurConfig(id, name));
    });
}

function openBlurEditor(id, name) {
    blurEditingChannelId = id;
    const cfg = blurConfigs[id] || { enabled: false, templates: [] };
    currentTemplates = JSON.parse(JSON.stringify(cfg.templates || []));
    
    blurEditingLabel.textContent = `Channel: ${name} (${id})`;
    blurEnabledToggle.checked = cfg.enabled;
    blurEnabledLabel.textContent = cfg.enabled ? 'Aktif' : 'Nonaktif';
    
    editingTemplateIndex = -1;
    blurTemplateEditorArea.style.display = 'none';
    
    renderBlurTemplatesList();
    
    blurEditorCard.style.display = 'block';
    blurEditorCard.scrollIntoView({ behavior: 'smooth' });
}

function renderBlurTemplatesList() {
    blurTemplatesListEl.innerHTML = '';
    if (currentTemplates.length === 0) {
        blurTemplatesListEl.innerHTML = '<p style="font-size:0.85rem; color:var(--text-secondary); grid-column: 1/-1;">No templates yet. Click "New Template" to start.</p>';
    }
    
    currentTemplates.forEach((tpl, i) => {
        const card = document.createElement('div');
        card.className = 'glass-card blur-template-card';
        card.style.padding = '12px';
        card.style.background = editingTemplateIndex === i ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255,255,255,0.03)';
        card.style.border = editingTemplateIndex === i ? '1px solid var(--primary-color)' : '1px solid rgba(255,255,255,0.05)';
        card.style.cursor = 'pointer';
        
        card.innerHTML = `
            <div style="font-weight:bold; font-size:0.9rem; margin-bottom:5px;">${tpl.name || 'Untitled Template'}</div>
            <div style="font-size:0.75rem; color:var(--text-secondary);">Ratio: ${tpl.aspectRatio ? tpl.aspectRatio.toFixed(2) : '0.00'}</div>
            <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:10px;">Boxes: ${tpl.boxes.length}</div>
            <div style="display:flex; gap:8px;">
                <button class="btn-primary btn-sm btn-edit-tpl" style="flex:1;">Edit</button>
                <button class="btn-danger-soft btn-sm btn-del-tpl"><i class='bx bx-trash'></i></button>
            </div>
        `;
        
        blurTemplatesListEl.appendChild(card);
        
        card.querySelector('.btn-edit-tpl').addEventListener('click', (e) => {
            e.stopPropagation();
            editTemplate(i);
        });
        
        card.querySelector('.btn-del-tpl').addEventListener('click', (e) => {
            e.stopPropagation();
            currentTemplates.splice(i, 1);
            if (editingTemplateIndex === i) {
                editingTemplateIndex = -1;
                blurTemplateEditorArea.style.display = 'none';
            }
            renderBlurTemplatesList();
            saveAllBlurSettings();
        });
    });
}

function editTemplate(index) {
    editingTemplateIndex = index;
    const tpl = currentTemplates[index];
    
    blurTemplateNameInp.value = tpl.name || '';
    blurRatioInfo.textContent = `Ratio: ${tpl.aspectRatio ? tpl.aspectRatio.toFixed(2) : '0.00'}`;
    
    // Reset canvas
    blurCanvasWrapper.style.display = 'none';
    blurPlaceholder.style.display = 'flex';
    blurPreviewImg.src = '';
    document.getElementById('blur-sample-image').value = '';
    
    renderBlurBoxesPreview();
    renderBlurBoxesConfigList();
    
    blurTemplateEditorArea.style.display = 'block';
    renderBlurTemplatesList();
}

function renderBlurBoxesPreview() {
    const old = blurDrawLayer.querySelectorAll('.blur-box-preview');
    old.forEach(o => o.remove());
    
    if (editingTemplateIndex < 0) return;
    const boxes = currentTemplates[editingTemplateIndex].boxes || [];
    
    boxes.forEach((box, i) => {
        const div = document.createElement('div');
        div.className = 'blur-box-preview';
        
        if (box.mode === 'pixel' && blurPreviewImg.naturalWidth > 0) {
            const nw = blurPreviewImg.naturalWidth;
            const nh = blurPreviewImg.naturalHeight;
            let leftPct = 0;
            let topPct = 0;
            const widthPct = (box.w / nw) * 100;
            const heightPct = (box.h / nh) * 100;

            if (box.anchor === 'top-left') {
                leftPct = (box.x / nw) * 100;
                topPct = (box.y / nh) * 100;
            } else if (box.anchor === 'top-right') {
                leftPct = ((nw - box.w - box.x) / nw) * 100;
                topPct = (box.y / nh) * 100;
            } else if (box.anchor === 'bottom-left') {
                leftPct = (box.x / nw) * 100;
                topPct = ((nh - box.h - box.y) / nh) * 100;
            } else if (box.anchor === 'bottom-right') {
                leftPct = ((nw - box.w - box.x) / nw) * 100;
                topPct = ((nh - box.h - box.y) / nh) * 100;
            }

            div.style.left = leftPct + '%';
            div.style.top = topPct + '%';
            div.style.width = widthPct + '%';
            div.style.height = heightPct + '%';
            div.style.borderStyle = 'dashed';
            div.style.borderColor = '#00ff00'; // distinct color for pixel boxes
        } else {
            div.style.left = box.x + '%';
            div.style.top = box.y + '%';
            div.style.width = box.w + '%';
            div.style.height = box.h + '%';
        }
        
        div.innerHTML = `<span class="box-index">${i+1}</span>`;
        blurDrawLayer.appendChild(div);
    });
}

function renderBlurBoxesConfigList() {
    blurBoxesConfigList.innerHTML = '';
    if (editingTemplateIndex < 0) return;
    const boxes = currentTemplates[editingTemplateIndex].boxes || [];
    
    if (boxes.length === 0) {
        blurBoxesConfigList.innerHTML = '<p style="font-size:0.85rem; color:var(--text-secondary);">No blur areas for this template. Draw on the image.</p>';
        return;
    }
    
    boxes.forEach((box, i) => {
        const item = document.createElement('div');
        item.className = 'blur-config-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '10px';
        item.style.padding = '8px';
        item.style.background = 'rgba(255,255,255,0.02)';
        item.style.borderRadius = '8px';
        
        item.innerHTML = `
            <div style="font-weight:bold; min-width:20px;">#${i+1}</div>
            <div style="flex:1; display:flex; gap:8px; align-items:center;">
                <label style="font-size:0.7rem;">Anchor:</label>
                <select class="blur-anchor-select" style="font-size:0.75rem; background:var(--bg-secondary); color:var(--text-main); border:1px solid var(--border-color); border-radius:4px;">
                    <option value="top-left" ${box.anchor === 'top-left' ? 'selected' : ''}>TL</option>
                    <option value="top-right" ${box.anchor === 'top-right' ? 'selected' : ''}>TR</option>
                    <option value="bottom-left" ${box.anchor === 'bottom-left' ? 'selected' : ''}>BL</option>
                    <option value="bottom-right" ${box.anchor === 'bottom-right' ? 'selected' : ''}>BR</option>
                </select>
            </div>
            <button class="btn-danger-soft btn-sm remove-blur-box"><i class='bx bx-trash'></i></button>
        `;
        
        blurBoxesConfigList.appendChild(item);
        
        item.querySelector('.blur-anchor-select').addEventListener('change', (e) => {
            currentTemplates[editingTemplateIndex].boxes[i].anchor = e.target.value;
        });
        
        item.querySelector('.remove-blur-box').addEventListener('click', () => {
            currentTemplates[editingTemplateIndex].boxes.splice(i, 1);
            renderBlurBoxesPreview();
            renderBlurBoxesConfigList();
        });
    });
}

// Global drawing logic (shared)
blurDrawLayer.addEventListener('mousedown', (e) => {
    if (!blurPreviewImg.src || editingTemplateIndex < 0) return;
    isDrawingBlurBox = true;
    const rect = blurDrawLayer.getBoundingClientRect();
    blurStartPos = {
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100
    };
    
    blurActiveBox = document.createElement('div');
    blurActiveBox.className = 'blur-box-preview active-drawing';
    blurActiveBox.style.left = blurStartPos.x + '%';
    blurActiveBox.style.top = blurStartPos.y + '%';
    blurDrawLayer.appendChild(blurActiveBox);
});

window.addEventListener('mousemove', (e) => {
    if (!isDrawingBlurBox || !blurActiveBox) return;
    const rect = blurDrawLayer.getBoundingClientRect();
    let curX = ((e.clientX - rect.left) / rect.width) * 100;
    let curY = ((e.clientY - rect.top) / rect.height) * 100;
    
    curX = Math.max(0, Math.min(curX, 100));
    curY = Math.max(0, Math.min(curY, 100));
    
    const x = Math.min(blurStartPos.x, curX);
    const y = Math.min(blurStartPos.y, curY);
    const w = Math.abs(curX - blurStartPos.x);
    const h = Math.abs(curY - blurStartPos.y);
    
    blurActiveBox.style.left = x + '%';
    blurActiveBox.style.top = y + '%';
    blurActiveBox.style.width = w + '%';
    blurActiveBox.style.height = h + '%';
});

window.addEventListener('mouseup', () => {
    if (isDrawingBlurBox && blurActiveBox) {
        const x = parseFloat(blurActiveBox.style.left);
        const y = parseFloat(blurActiveBox.style.top);
        const w = parseFloat(blurActiveBox.style.width);
        const h = parseFloat(blurActiveBox.style.height);
        
        if (w > 1 && h > 1 && editingTemplateIndex >= 0) {
            if (!currentTemplates[editingTemplateIndex].boxes) currentTemplates[editingTemplateIndex].boxes = [];
            currentTemplates[editingTemplateIndex].boxes.push({ x, y, w, h, anchor: 'top-left', action: 'blur' });
        }
        blurActiveBox.remove();
        blurActiveBox = null;
        isDrawingBlurBox = false;
        renderBlurBoxesPreview();
        renderBlurBoxesConfigList();
    }
});

// Event Listeners
document.getElementById('btn-add-blur-template').addEventListener('click', () => {
    const name = prompt('Template Name (e.g. Landscape / Portrait):') || 'New Template';
    currentTemplates.push({ id: Date.now(), name, aspectRatio: 1, boxes: [] });
    editTemplate(currentTemplates.length - 1);
});

document.getElementById('blur-template-name').addEventListener('input', (e) => {
    if (editingTemplateIndex >= 0) {
        currentTemplates[editingTemplateIndex].name = e.target.value;
        renderBlurTemplatesList();
    }
});

document.getElementById('blur-sample-image').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file || editingTemplateIndex < 0) return;
    const url = URL.createObjectURL(file);
    blurPreviewImg.onload = () => {
        const ratio = blurPreviewImg.naturalWidth / blurPreviewImg.naturalHeight;
        currentTemplates[editingTemplateIndex].aspectRatio = ratio;
        blurRatioInfo.textContent = `Ratio: ${ratio.toFixed(2)}`;
        blurCanvasWrapper.style.display = 'block';
        blurPlaceholder.style.display = 'none';
        renderBlurBoxesPreview();
        renderBlurTemplatesList();
    };
    blurPreviewImg.src = url;
});

async function saveAllBlurSettings() {
    if (!blurEditingChannelId) return;
    try {
        await fetch(`${API}/blur/${blurEditingChannelId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                enabled: blurEnabledToggle.checked, 
                templates: currentTemplates 
            })
        });
        loadBlurConfigs();
    } catch (err) { console.error(err); }
}

document.getElementById('btn-save-blur').addEventListener('click', async () => {
    await saveAllBlurSettings();
    showToast('Template saved and synced!');
    blurTemplateEditorArea.style.display = 'none';
    editingTemplateIndex = -1;
    renderBlurTemplatesList();
});

blurEnabledToggle.addEventListener('change', () => {
    blurEnabledLabel.textContent = blurEnabledToggle.checked ? 'Aktif' : 'Nonaktif';
    saveAllBlurSettings();
});

document.getElementById('btn-blur-clear-all').addEventListener('click', () => {
    if (editingTemplateIndex >= 0) {
        currentTemplates[editingTemplateIndex].boxes = [];
        renderBlurBoxesPreview();
        renderBlurBoxesConfigList();
    }
});

document.getElementById('btn-close-blur-editor').addEventListener('click', () => {
    blurEditorCard.style.display = 'none';
    blurEditingChannelId = null;
});

document.getElementById('btn-add-blur-channel').addEventListener('click', () => {
    document.getElementById('blur-new-channel-id').value = '';
    document.getElementById('blur-new-channel-name').value = '';
    openModal('modal-add-blur');
});

document.getElementById('btn-confirm-add-blur').addEventListener('click', () => {
    const id = document.getElementById('blur-new-channel-id').value.trim();
    const name = document.getElementById('blur-new-channel-name').value.trim();
    if (!id || !/^\d+$/.test(id)) { showToast('Invalid ID', 'warning'); return; }
    closeModal('modal-add-blur');
    openBlurEditor(id, name);
});

async function deleteBlurConfig(id, name) {
    confirmDelete(name + ' (Blur)', async () => {
        try {
            await fetch(`${API}/blur/${id}`, { method: 'DELETE' });
            loadBlurConfigs();
            if (blurEditingChannelId === id) blurEditorCard.style.display = 'none';
            showToast('Blur config dihapus');
        } catch { showToast('Gagal menghapus', 'error'); }
    });
}

// Global blur manager button
document.getElementById('btn-manage-global-blur').addEventListener('click', () => {
    openBlurEditor('GLOBAL', 'GLOBAL (Semua Channel)');
});

// ─── Nav hook: load blur + powerblur settings when section opens ──
document.querySelectorAll('.nav-links a').forEach(link => {
    if (link.getAttribute('data-target') === 'blur') {
        link.addEventListener('click', () => {
            loadBlurConfigs();
            loadOcrSettings();
            loadMatchSettings();
        });
    }
});

// ======================================================================
//  POWERBLUR — Fixed Pixel Mode (mode switcher in template editor)
// ======================================================================
let currentBoxMode   = 'percent'; // 'percent' or 'pixel'
let selectedAnchor   = 'bottom-right';
// Mode switcher
document.getElementById('mode-btn-percent').addEventListener('click', () => setBoxMode('percent'));
document.getElementById('mode-btn-pixel').addEventListener('click',   () => setBoxMode('pixel'));

function setBoxMode(mode) {
    currentBoxMode = mode;
    document.getElementById('mode-btn-percent').classList.toggle('active', mode === 'percent');
    document.getElementById('mode-btn-pixel').classList.toggle('active',   mode === 'pixel');
    document.getElementById('pixel-mode-inputs').style.display = mode === 'pixel' ? 'block' : 'none';
    // Update draw-layer hint & cursor
    const drawLayer   = document.getElementById('blur-draw-layer');
    const hintEl      = document.getElementById('blur-toolbar-hint');
    const canvasWrapper = document.getElementById('blur-canvas-wrapper');
    if (mode === 'pixel') {
        drawLayer.style.pointerEvents = 'none';
        drawLayer.style.cursor = 'default';
        canvasWrapper.style.cursor = 'default';
        if (hintEl) hintEl.textContent = 'Pixel Mode aktif. Isi nilai di atas lalu klik "Add Fixed Pixel Blur Box".';
    } else {
        drawLayer.style.pointerEvents = 'auto';
        drawLayer.style.cursor = 'crosshair';
        canvasWrapper.style.cursor = 'crosshair';
        if (hintEl) hintEl.textContent = 'Klik dan seret pada gambar untuk menggambar area blur.';
    }
}

// Anchor buttons
document.querySelectorAll('.anchor-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.anchor-btn').forEach(b => b.classList.remove('active-anchor'));
        btn.classList.add('active-anchor');
        selectedAnchor = btn.dataset.anchor;
    });
});

// Add pixel box
document.getElementById('btn-add-pixel-box').addEventListener('click', () => {
    if (editingTemplateIndex < 0) { showToast('Pilih template dulu', 'warning'); return; }
    const w  = parseInt(document.getElementById('px-width').value)   || 200;
    const h  = parseInt(document.getElementById('px-height').value)  || 50;
    const ox = parseInt(document.getElementById('px-offset-x').value) || 10;
    const oy = parseInt(document.getElementById('px-offset-y').value) || 10;

    const box = { x: ox, y: oy, w, h, anchor: selectedAnchor, mode: 'pixel', action: 'blur' };
    if (!currentTemplates[editingTemplateIndex].boxes) currentTemplates[editingTemplateIndex].boxes = [];
    currentTemplates[editingTemplateIndex].boxes.push(box);

    renderBlurBoxesPreview();
    renderBlurBoxesConfigList();
    showToast(`✅ Pixel box ditambahkan: ${w}×${h}px @ ${selectedAnchor}`, 'success');
});

// Redefine renderBlurBoxesConfigList to support 'pixel' mode display:
function renderBlurBoxesConfigList() {
    blurBoxesConfigList.innerHTML = '';
    if (editingTemplateIndex < 0) return;
    const boxes = currentTemplates[editingTemplateIndex].boxes || [];

    if (boxes.length === 0) {
        blurBoxesConfigList.innerHTML = '<p style="font-size:0.85rem; color:var(--text-secondary);">No blur areas for this template. Draw on the image or use Pixel Mode above.</p>';
        return;
    }

    boxes.forEach((box, i) => {
        const isPixel = box.mode === 'pixel';
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px; background:rgba(255,255,255,0.02); border-radius:8px; border:1px solid rgba(255,255,255,0.05);';

        item.innerHTML = `
            <div style="font-weight:bold; min-width:22px; color:var(--primary-color);">#${i+1}</div>
            <div style="flex:1; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                ${isPixel
                    ? `<span class="pixel-box-badge">📸 PIXEL</span>
                       <span style="font-size:0.78rem; color:var(--text-secondary);">${box.w}×${box.h}px @ offset(${box.x},${box.y}) — <b>${box.anchor}</b></span>`
                    : `<label style="font-size:0.7rem;">Anchor:</label>
                       <select class="blur-anchor-select" style="font-size:0.75rem; background:var(--bg-secondary,#1e293b); color:var(--text-main,#f8fafc); border:1px solid var(--border-color); border-radius:4px; padding:2px 6px;">
                           <option value="top-left"     ${box.anchor==='top-left'    ?'selected':''}>TL</option>
                           <option value="top-right"    ${box.anchor==='top-right'   ?'selected':''}>TR</option>
                           <option value="bottom-left"  ${box.anchor==='bottom-left' ?'selected':''}>BL</option>
                           <option value="bottom-right" ${box.anchor==='bottom-right'?'selected':''}>BR</option>
                       </select>
                       <span style="font-size:0.72rem; color:var(--text-secondary);">${box.x.toFixed(1)}%,${box.y.toFixed(1)}% — ${box.w.toFixed(1)}×${box.h.toFixed(1)}%</span>`
                }
                <label style="font-size:0.7rem; margin-left:10px;">Action:</label>
                <select class="blur-action-select" style="font-size:0.75rem; background:var(--bg-secondary,#1e293b); color:var(--text-main,#f8fafc); border:1px solid var(--border-color); border-radius:4px; padding:2px 6px;">
                    <option value="blur"       ${!box.action || box.action==='blur'      ?'selected':''}>Blur Langsung</option>
                    <option value="ai-redraw"  ${box.action==='ai-redraw'                ?'selected':''}>AI Redraw</option>
                    <option value="scan-ocr"   ${box.action==='scan-ocr'                 ?'selected':''}>Scan Teks (OCR) Di Sini</option>
                    <option value="scan-match" ${box.action==='scan-match'               ?'selected':''}>Scan Logo Di Sini</option>
                </select>
            </div>
            <button class="remove-blur-box btn-danger-soft btn-sm"><i class='bx bx-trash'></i></button>
        `;

        blurBoxesConfigList.appendChild(item);

        item.querySelector('.blur-action-select').addEventListener('change', (e) => {
            currentTemplates[editingTemplateIndex].boxes[i].action = e.target.value;
        });

        if (!isPixel) {
            item.querySelector('.blur-anchor-select').addEventListener('change', (e) => {
                currentTemplates[editingTemplateIndex].boxes[i].anchor = e.target.value;
            });
        }
        item.querySelector('.remove-blur-box').addEventListener('click', () => {
            currentTemplates[editingTemplateIndex].boxes.splice(i, 1);
            renderBlurBoxesPreview();
            renderBlurBoxesConfigList();
        });
    });
}


// ======================================================================
//  POWERBLUR — OCR Text Detection Settings (1-Click Instant Toggle)
// ======================================================================
function updateAiQuickToggle(isEnabled) {
    const btn = document.getElementById('btn-topbar-ai-toggle');
    const icon = document.getElementById('topbar-ai-icon');
    const text = document.getElementById('topbar-ai-text');
    if (!btn) return;
    if (isEnabled) {
        btn.className = 'btn-ai-pill on';
        if (icon) icon.className = 'bx bx-bot';
        if (text) text.textContent = '🤖 AI Cleaner (ON)';
        btn.title = 'AI Aktif: Klik untuk beralih ke Mode Cepat (Forward instan tanpa AI)';
    } else {
        btn.className = 'btn-ai-pill off';
        if (icon) icon.className = 'bx bx-bolt-circle';
        if (text) text.textContent = '⚡ Mode Cepat (AI OFF)';
        btn.title = 'Mode Cepat Aktif: Klik untuk menyalakan AI Cleaner';
    }
}

async function toggleAiQuick(newState) {
    updateAiQuickToggle(newState);
    const toggleEl = document.getElementById('ocr-enabled-toggle');
    if (toggleEl) toggleEl.checked = newState;

    try {
        const r = await fetch(`${API}/blur/settings/ocr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: newState })
        });
        if (r.ok) {
            const d = await r.json();
            updateOcrStatusBadge(d.settings);
            updateAiQuickToggle(d.settings.enabled);
            if (d.settings.enabled) {
                showToast('🤖 AI Watermark Scanner DIAKTIFKAN! Teks watermark akan dibersihkan.', 'info');
            } else {
                showToast('⚡ Mode Cepat AKTIF! AI dimatikan. Forward media INSTAN & super cepat!', 'success');
            }
        } else {
            showToast('Gagal mengubah status AI', 'error');
            loadOcrSettings();
        }
    } catch {
        showToast('Connection error', 'error');
        loadOcrSettings();
    }
}

async function loadOcrSettings() {
    try {
        const d = await fetch(`${API}/blur/settings/ocr`).then(r => r.json());
        const isEnabled = !!d.enabled;
        const toggleEl = document.getElementById('ocr-enabled-toggle');
        if (toggleEl) toggleEl.checked = isEnabled;
        updateAiQuickToggle(isEnabled);
        const kwEl = document.getElementById('ocr-keywords');
        if (kwEl) kwEl.value = (d.keywords || []).join('\n');
        const padEl = document.getElementById('ocr-padding');
        if (padEl) padEl.value = d.blurPadding || 20;
        const padValEl = document.getElementById('ocr-padding-val');
        if (padValEl) padValEl.textContent = d.blurPadding || 20;
        const actEl = document.getElementById('ocr-action');
        if (actEl) actEl.value = d.action || 'blur';
        updateOcrStatusBadge(d);
    } catch (e) {
        const badgeEl = document.getElementById('ocr-status-badge');
        if (badgeEl) badgeEl.textContent = '⚠️ Gagal load OCR settings';
    }
}

function updateOcrStatusBadge(d) {
    const el  = document.getElementById('ocr-status-badge');
    if (!el) return;
    const kws = (d.keywords || []).length;
    if (d.enabled) {
        el.innerHTML = `<span style="color:#10b981;">● Aktif</span> — ${kws} keyword(s) terdaftar`;
    } else {
        el.innerHTML = `<span style="color:#94a3b8;">● Nonaktif (Mode Cepat)</span> — ${kws} keyword(s) terdaftar`;
    }
}

// 1-Click Instant Toggle pada Topbar
document.getElementById('btn-topbar-ai-toggle')?.addEventListener('click', () => {
    const toggleEl = document.getElementById('ocr-enabled-toggle');
    const currentState = toggleEl ? toggleEl.checked : false;
    toggleAiQuick(!currentState);
});

// 1-Click Instant Toggle pada Switch di halaman Smart Blur
document.getElementById('ocr-enabled-toggle')?.addEventListener('change', (e) => {
    toggleAiQuick(e.target.checked);
});

document.getElementById('ocr-padding')?.addEventListener('input', (e) => {
    document.getElementById('ocr-padding-val').textContent = e.target.value;
});

document.getElementById('btn-save-ocr')?.addEventListener('click', async () => {
    const enabled    = document.getElementById('ocr-enabled-toggle').checked;
    const rawKw      = document.getElementById('ocr-keywords').value;
    const keywords   = rawKw.split('\n').map(s => s.trim()).filter(Boolean);
    const blurPadding = parseInt(document.getElementById('ocr-padding').value) || 20;
    const action      = document.getElementById('ocr-action').value || 'blur';

    try {
        const r = await fetch(`${API}/blur/settings/ocr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, keywords, blurPadding, action })
        });
        if (r.ok) {
            const d = await r.json();
            updateOcrStatusBadge(d.settings);
            updateAiQuickToggle(d.settings.enabled);
            showToast(`✅ OCR Settings disimpan! ${keywords.length} keywords aktif.`, 'success');
        } else showToast('Gagal menyimpan OCR settings', 'error');
    } catch { showToast('Connection error', 'error'); }
});

document.getElementById('btn-ocr-preset-trading')?.addEventListener('click', () => {
    const textarea = document.getElementById('ocr-keywords');
    const existing = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
    const presets = [
        'tradingview',
        'created with',
        'mirror',
        'ori',
        '/08\\d{2,4}[-\\s]?\\d{3,5}[-\\s]?\\d{3,5}/',
        '/wa\\s*:\\s*[\\d\\s]+/i',
        '/@\\w{3,20}/i',
        'dsc.gg/actcrypto'
    ];
    const combined = Array.from(new Set([...existing, ...presets]));
    textarea.value = combined.join('\n');
    showToast('⚡ Preset TradingView & WA ditambahkan ke list!', 'info');
});


// ======================================================================
//  POWERBLUR — Logo Template Matching Settings
// ======================================================================
async function loadMatchSettings() {
    try {
        const [settings, files] = await Promise.all([
            fetch(`${API}/blur/settings/match`).then(r => r.json()),
            fetch(`${API}/blur/templates/source`).then(r => r.json()),
        ]);
        document.getElementById('match-enabled-toggle').checked = !!settings.enabled;
        const thresh = Math.round((settings.threshold || 0.80) * 100);
        document.getElementById('match-threshold').value     = thresh;
        document.getElementById('match-threshold-val').textContent = (thresh / 100).toFixed(2);
        document.getElementById('match-strength').value      = settings.blurStrength || 50;
        document.getElementById('match-strength-val').textContent  = settings.blurStrength || 50;
        if (settings.action) {
            document.getElementById('match-action').value = settings.action;
        } else {
            document.getElementById('match-action').value = 'blur';
        }
        renderSourceTemplates(files);
        updateMatchStatusBadge(settings, files.length);
    } catch (e) {
        document.getElementById('match-status-badge').textContent = '⚠️ Gagal load match settings';
    }
}

function updateMatchStatusBadge(s, fileCount) {
    const el = document.getElementById('match-status-badge');
    if (s.enabled) {
        el.innerHTML = `<span style="color:#10b981;">● Aktif</span> — ${fileCount} logo template(s), threshold: ${(s.threshold||0.80).toFixed(2)}`;
    } else {
        el.innerHTML = `<span style="color:#94a3b8;">● Nonaktif</span> — ${fileCount} logo template(s) ready`;
    }
}

function renderSourceTemplates(files) {
    const listEl = document.getElementById('match-templates-list');
    listEl.innerHTML = '';
    if (!files || files.length === 0) {
        listEl.innerHTML = '<p style="font-size:0.78rem; color:var(--text-secondary); text-align:center; padding:8px;">Belum ada logo template. Upload di atas.</p>';
        return;
    }
    files.forEach(filename => {
        const item = document.createElement('div');
        item.className = 'match-tpl-item';
        item.innerHTML = `
            <img src="${API}/blur/templates/source/${encodeURIComponent(filename)}" alt="${filename}" onerror="this.style.display='none'">
            <span title="${filename}">${filename}</span>
            <button class="btn-del-tpl-src" data-filename="${filename}"><i class='bx bx-trash'></i></button>
        `;
        listEl.appendChild(item);
        item.querySelector('.btn-del-tpl-src').addEventListener('click', async () => {
            if (!confirm(`Hapus template "${filename}"?`)) return;
            try {
                await fetch(`${API}/blur/templates/source/${encodeURIComponent(filename)}`, { method: 'DELETE' });
                await loadMatchSettings();
                showToast(`Template "${filename}" dihapus.`, 'success');
            } catch { showToast('Gagal menghapus', 'error'); }
        });
    });
}

// Sliders
document.getElementById('match-threshold').addEventListener('input', (e) => {
    document.getElementById('match-threshold-val').textContent = (parseInt(e.target.value) / 100).toFixed(2);
});
document.getElementById('match-strength').addEventListener('input', (e) => {
    document.getElementById('match-strength-val').textContent = e.target.value;
});

// Upload template file
document.getElementById('match-template-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fd = new FormData();
    fd.append('templateImage', file);

    try {
        const r = await fetch(`${API}/blur/templates/source`, { method: 'POST', body: fd });
        if (r.ok) {
            await loadMatchSettings();
            showToast(`✅ Logo template "${file.name}" diupload!`, 'success');
        } else {
            const err = await r.json();
            showToast('Upload gagal: ' + (err.error || 'Unknown error'), 'error');
        }
    } catch { showToast('Connection error', 'error'); }

    e.target.value = ''; // reset input
});

// Save match settings
document.getElementById('btn-save-match').addEventListener('click', async () => {
    const enabled     = document.getElementById('match-enabled-toggle').checked;
    const threshold   = parseInt(document.getElementById('match-threshold').value) / 100;
    const blurStrength = parseInt(document.getElementById('match-strength').value);
    const action       = document.getElementById('match-action').value || 'blur';

    try {
        const r = await fetch(`${API}/blur/settings/match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, threshold, blurStrength, action })
        });
        if (r.ok) {
            const d = await r.json();
            const files = await fetch(`${API}/blur/templates/source`).then(r => r.json());
            updateMatchStatusBadge(d.settings, files.length);
            showToast('✅ Template Matching settings disimpan!', 'success');
        } else showToast('Gagal menyimpan match settings', 'error');
    } catch { showToast('Connection error', 'error'); }
});


// ─── Word Filter ──────────────────────────────────────────────
let wfFilteredCount = 0; // session counter
let wfInitialized = false;

/** Inisialisasi semua event listener di halaman word filter */
function initWordFilter() {
    if (wfInitialized) return;
    wfInitialized = true;

    // Toggle aktif
    document.getElementById('wf-enabled').addEventListener('change', async function() {
        const enabled = this.checked;
        try {
            await fetch(`${API}/wordfilter/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
            updateWfStatusUI(enabled);
            showToast(enabled ? '✅ Filter diaktifkan!' : '⛔ Filter dinonaktifkan', enabled ? 'success' : 'warning');
        } catch { showToast('Gagal update status', 'error'); }
    });

    // Tambah kata (Enter atau klik tombol)
    document.getElementById('wf-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('wf-btn-add').click();
    });

    document.getElementById('wf-btn-add').addEventListener('click', async () => {
        const inp = document.getElementById('wf-input');
        const word = inp.value.trim();
        if (!word) { showToast('Kata tidak boleh kosong', 'warning'); return; }
        try {
            const r = await fetch(`${API}/wordfilter/words`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ word })
            });
            const d = await r.json();
            if (r.ok) { inp.value = ''; renderWfWords(d.settings.words); showToast(`✅ Kata "${word}" ditambahkan`, 'success'); }
            else showToast(d.error || 'Gagal tambah kata', 'error');
        } catch { showToast('Connection error', 'error'); }
    });

    // Import bulk
    document.getElementById('wf-btn-bulk').addEventListener('click', async () => {
        const raw = document.getElementById('wf-bulk-input').value.trim();
        if (!raw) { showToast('Input bulk kosong', 'warning'); return; }
        const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) { showToast('Tidak ada kata valid', 'warning'); return; }
        try {
            // Load existing first
            const cur = await fetch(`${API}/wordfilter`).then(r => r.json());
            const merged = [...new Set([...cur.words, ...lines])];
            const r = await fetch(`${API}/wordfilter/words`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ words: merged })
            });
            const d = await r.json();
            if (r.ok) {
                document.getElementById('wf-bulk-input').value = '';
                renderWfWords(d.settings.words);
                showToast(`✅ ${lines.length} kata diimport`, 'success');
            } else showToast(d.error || 'Gagal import', 'error');
        } catch { showToast('Connection error', 'error'); }
    });

    // Hapus semua
    document.getElementById('wf-btn-clear-all').addEventListener('click', async () => {
        if (!confirm('Hapus SEMUA kata terlarang?')) return;
        try {
            const r = await fetch(`${API}/wordfilter/words`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ words: [] })
            });
            const d = await r.json();
            if (r.ok) { renderWfWords([]); showToast('Semua kata dihapus', 'warning'); }
            else showToast('Gagal hapus', 'error');
        } catch { showToast('Connection error', 'error'); }
    });

    // Test simulator
    document.getElementById('wf-btn-test').addEventListener('click', async () => {
        const text = document.getElementById('wf-test-input').value.trim();
        if (!text) { showToast('Masukkan teks dulu', 'warning'); return; }
        try {
            const r = await fetch(`${API}/wordfilter/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const d = await r.json();
            const resultEl = document.getElementById('wf-test-result');
            resultEl.style.display = 'block';
            const hasRemoved = d.removedWords && d.removedWords.length > 0;
            const iconEl = document.getElementById('wf-test-icon');
            const summaryEl = document.getElementById('wf-test-summary');
            const removedEl = document.getElementById('wf-test-removed');
            const outputEl = document.getElementById('wf-test-output');

            if (hasRemoved) {
                iconEl.style.background = 'rgba(245,158,11,0.2)';
                iconEl.innerHTML = "<i class='bx bx-filter-alt' style='color:#f59e0b'></i>";
                summaryEl.innerHTML = `<span style='color:#f59e0b'>Filter aktif — ${d.removedWords.length} kata dihapus</span>`;
                removedEl.innerHTML = d.removedWords.map(w =>
                    `<span style='background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 8px;border-radius:12px;margin-right:4px;font-size:0.8rem;'>${w}</span>`
                ).join('');
                wfFilteredCount++;
                const statEl = document.getElementById('wf-stat-filtered');
                if (statEl) statEl.textContent = wfFilteredCount;
            } else {
                iconEl.style.background = 'rgba(16,185,129,0.2)';
                iconEl.innerHTML = "<i class='bx bx-check' style='color:#10b981'></i>";
                summaryEl.innerHTML = `<span style='color:#10b981'>Tidak ada kata terlarang ditemukan</span>`;
                removedEl.innerHTML = '<span style="color:var(--text-secondary);font-size:0.8rem;">—</span>';
            }
            outputEl.textContent = d.result || '(pesan kosong setelah filter)';
        } catch { showToast('Connection error', 'error'); }
    });

    // Simpan pengaturan (logFiltered)
    document.getElementById('wf-btn-save-settings').addEventListener('click', async () => {
        const logFiltered = document.getElementById('wf-log-filtered').checked;
        const enabled = document.getElementById('wf-enabled').checked;
        try {
            const r = await fetch(`${API}/wordfilter/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, logFiltered })
            });
            if (r.ok) showToast('✅ Pengaturan disimpan!', 'success');
            else showToast('Gagal simpan', 'error');
        } catch { showToast('Connection error', 'error'); }
    });
}

/** Render daftar kata ke DOM */
function renderWfWords(words) {
    const list = document.getElementById('wf-words-list');
    if (!list) return;
    const countEl = document.getElementById('wf-word-count');
    const statEl  = document.getElementById('wf-stat-total');
    if (countEl) countEl.textContent = `${words.length} kata`;
    if (statEl)  statEl.textContent  = words.length;
    if (!words.length) {
        list.innerHTML = '<div class="activity-empty">Belum ada kata terlarang. Tambahkan di atas.</div>';
        return;
    }
    list.innerHTML = words.map((w, i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:8px 12px;transition:background 0.2s;" class="wf-word-item">
            <span style="font-size:0.88rem;word-break:break-all;">
                <i class='bx bx-block' style="color:#ef4444;margin-right:6px;vertical-align:middle;"></i>${escHtml(w)}
            </span>
            <button class="btn-danger" data-idx="${i}" title="Hapus" style="padding:4px 10px;font-size:0.78rem;flex-shrink:0;margin-left:8px;">
                <i class='bx bx-x'></i>
            </button>
        </div>
    `).join('');
    list.querySelectorAll('[data-idx]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = btn.getAttribute('data-idx');
            try {
                const r = await fetch(`${API}/wordfilter/words/${idx}`, { method: 'DELETE' });
                const d = await r.json();
                if (r.ok) { renderWfWords(d.settings.words); showToast('Kata dihapus', 'warning'); }
                else showToast(d.error || 'Gagal hapus', 'error');
            } catch { showToast('Connection error', 'error'); }
        });
    });
}

/** Update label status aktif/nonaktif */
function updateWfStatusUI(enabled) {
    const label   = document.getElementById('wf-enabled-label');
    const statEl  = document.getElementById('wf-stat-status');
    if (label)  label.textContent  = enabled ? 'Aktif' : 'Nonaktif';
    if (statEl) {
        statEl.textContent = enabled ? 'ON' : 'OFF';
        statEl.style.color = enabled ? '#10b981' : '#ef4444';
    }
}

/** Load data filter dari API */
async function loadWordFilter() {
    // Pastikan section sudah ada di DOM
    if (!document.getElementById('section-wordfilter')) return;
    try {
        const d = await fetch(`${API}/wordfilter`).then(r => r.json());
        const enabledEl    = document.getElementById('wf-enabled');
        const logEl        = document.getElementById('wf-log-filtered');
        if (enabledEl) enabledEl.checked = !!d.enabled;
        if (logEl)     logEl.checked     = !!d.logFiltered;
        updateWfStatusUI(d.enabled);
        renderWfWords(d.words || []);
    } catch { showToast('Gagal load word filter', 'error'); }
}

/** Escape HTML helper */
function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Init ─────────────────────────────────────────────────────
// ─── TG→DC CHANNELS ───────────────────────────────────────────
let currentEditingTg2dcId = null;

async function loadTg2dcChannels() {
    try {
        const channels = await fetch(`${API}/tg2dc`).then(r => r.json());
        const tbody = document.getElementById('tg2dc-table-body');
        if (!tbody) return; // Prevent error if elements not ready
        tbody.innerHTML = '';
        if (!channels.length) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-secondary);padding:32px">No TG→DC mappings yet.</td></tr>`;
            return;
        }
        channels.forEach(ch => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${ch.name}</strong></td>
                <td style="font-family:monospace;font-size:.82rem">
                    ${ch.tgChatId} 
                    ${ch.tgThreadId ? `<span class="tag" style="margin-left:5px">Topic: ${ch.tgThreadId}</span>` : ''}
                </td>
                <td style="font-family:monospace;font-size:.8rem;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${ch.dcWebhookUrl}">
                    ${ch.dcWebhookUrl ? '✅ Configured' : '❌ Missing'}
                </td>
                <td>
                    <div class="action-btns">
                        <button class="btn-edit-tg2dc" data-id="${ch.id}" data-name="${ch.name}" data-tg="${ch.tgChatId}" data-thread="${ch.tgThreadId || ''}" data-dcwebhook="${ch.dcWebhookUrl || ''}" title="Edit Mapping" style="background: rgba(59,130,246,0.1); color: var(--primary-color); padding: 5px 12px; border: 1px solid rgba(59,130,246,0.2); border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 0.8rem;">
                            <i class='bx bx-edit'></i> Edit
                        </button>
                        <button class="btn-danger btn-delete-tg2dc" data-id="${ch.id}" data-name="${ch.name}" title="Delete">
                            <i class='bx bx-trash'></i>
                        </button>
                    </div>
                </td>`;
            tbody.appendChild(tr);
        });

        document.querySelectorAll('.btn-edit-tg2dc').forEach(btn => {
            btn.addEventListener('click', () => {
                currentEditingTg2dcId = btn.dataset.id;
                document.getElementById('modal-tg2dc-title').textContent = 'Edit TG→DC Mapping';
                document.getElementById('tg2dc-name').value = btn.dataset.name;
                document.getElementById('tg2dc-tgChatId').value = btn.dataset.tg;
                document.getElementById('tg2dc-tgThreadId').value = btn.dataset.thread;
                document.getElementById('tg2dc-dcWebhookUrl').value = btn.dataset.dcwebhook;
                openModal('modal-tg2dc');
            });
        });

        document.querySelectorAll('.btn-delete-tg2dc').forEach(btn => {
            btn.addEventListener('click', () => {
                confirmDelete(btn.dataset.name, async () => {
                    try {
                        const r = await fetch(`${API}/tg2dc/${btn.dataset.id}`, { method: 'DELETE' });
                        if (r.ok) { showToast('TG→DC Mapping deleted'); loadTg2dcChannels(); }
                        else showToast('Failed to delete', 'error');
                    } catch { showToast('Connection error', 'error'); }
                });
            });
        });
    } catch { showToast('Failed to load TG→DC channels', 'error'); }
}

document.getElementById('btn-add-tg2dc')?.addEventListener('click', () => { 
    currentEditingTg2dcId = null;
    document.getElementById('modal-tg2dc-title').textContent = 'Add TG→DC Mapping';
    document.getElementById('form-tg2dc').reset(); 
    openModal('modal-tg2dc'); 
});

document.getElementById('form-tg2dc')?.addEventListener('submit', async e => {
    e.preventDefault();
    const payload = { 
        name: document.getElementById('tg2dc-name').value, 
        tgChatId: document.getElementById('tg2dc-tgChatId').value, 
        tgThreadId: document.getElementById('tg2dc-tgThreadId').value || null, 
        dcWebhookUrl: document.getElementById('tg2dc-dcWebhookUrl').value 
    };
    try {
        let url = `${API}/tg2dc`;
        let method = 'POST';
        
        if (currentEditingTg2dcId) {
            url = `${API}/tg2dc/${currentEditingTg2dcId}`;
            method = 'PUT';
        }
        
        const r = await fetch(url, { 
            method, 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        const data = await r.json();
        if (r.ok) { 
            showToast(currentEditingTg2dcId ? 'TG→DC Mapping updated!' : 'TG→DC Mapping added!'); 
            closeModal('modal-tg2dc'); 
            loadTg2dcChannels(); 
        } else {
            showToast(data.error || 'Failed to save', 'error');
        }
    } catch { 
        showToast('Connection error', 'error'); 
    }
});

loadStats();
setTimeout(renderCharts, 300);
connectSSE();
loadOcrSettings();
});

// ============================================================
//   ANTI-SPAM GODMODE — Dashboard Module
// ============================================================
let _asBlacklist = [];

function initAntiSpam() {
    loadAntiSpam();

    // Rate limit live preview
    document.getElementById('as-rate-limit').addEventListener('input', e => {
        document.getElementById('as-rl-preview').textContent = e.target.value;
        document.getElementById('as-flow-limit').textContent = e.target.value;
        document.getElementById('as-rate-display').textContent = e.target.value;
    });
    document.getElementById('as-rate-window').addEventListener('input', e => {
        const sec = Math.round(parseInt(e.target.value) || 30);
        document.getElementById('as-rl-win-preview').textContent = sec;
        document.getElementById('as-flow-window').textContent = sec;
    });

    // Hash threshold slider
    document.getElementById('as-hash-threshold').addEventListener('input', e => {
        document.getElementById('as-threshold-val').textContent = e.target.value;
    });

    // Add blacklist word
    document.getElementById('as-bl-add').addEventListener('click', () => {
        const inp = document.getElementById('as-bl-input');
        const word = (inp.value || '').trim();
        if (!word) return;
        if (!_asBlacklist.includes(word)) {
            _asBlacklist.push(word);
            renderBlacklist();
            document.getElementById('as-bl-count').textContent = _asBlacklist.length;
        }
        inp.value = '';
        inp.focus();
    });
    document.getElementById('as-bl-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('as-bl-add').click();
    });

    // Test pattern
    document.getElementById('as-test-btn').addEventListener('click', async () => {
        const text = document.getElementById('as-test-input').value;
        if (!text.trim()) return;
        try {
            const r = await fetch('/api/antispam/test', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ text }),
            });
            const d = await r.json();
            const el = document.getElementById('as-test-result');
            el.style.display = 'block';
            if (d.detected) {
                el.style.background = 'rgba(239,68,68,.12)';
                el.style.border = '1px solid rgba(239,68,68,.3)';
                el.style.color = '#ef4444';
                el.innerHTML = `🚨 <b>SPAM TERDETEKSI!</b><br>Pola: <b>${d.label}</b><br>Match: <code>${d.match}</code>`;
            } else {
                el.style.background = 'rgba(16,185,129,.1)';
                el.style.border = '1px solid rgba(16,185,129,.3)';
                el.style.color = '#10b981';
                el.innerHTML = '✅ <b>Aman</b> — Tidak ada pola spam terdeteksi';
            }
        } catch { showToast('Gagal test pattern', 'error'); }
    });
    document.getElementById('as-test-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('as-test-btn').click();
    });

    // Reset hash DB
    document.getElementById('as-hash-reset').addEventListener('click', async () => {
        if (!confirm('Reset semua Image Hash Database? Gambar spam yang sudah dipelajari akan hilang.')) return;
        try {
            const r = await fetch('/api/antispam/hashes', { method: 'DELETE' });
            const d = await r.json();
            if (d.success) {
                document.getElementById('as-hash-count').textContent = '0';
                document.getElementById('as-hash-count2').textContent = '0';
                showToast('Image Hash DB berhasil di-reset', 'warning');
            }
        } catch { showToast('Gagal reset DB', 'error'); }
    });

    // Reload
    document.getElementById('as-btn-reload').addEventListener('click', loadAntiSpam);

    // Save
    document.getElementById('as-btn-save').addEventListener('click', saveAntiSpam);
}

async function loadAntiSpam() {
    try {
        const [settingsRes, patternsRes] = await Promise.all([
            fetch('/api/antispam/settings'),
            fetch('/api/antispam/patterns'),
        ]);
        const s = await settingsRes.json();
        const patterns = await patternsRes.json();

        _asBlacklist = s.blacklistWords || [];
        renderBlacklist();

        document.getElementById('as-bl-count').textContent = _asBlacklist.length;
        document.getElementById('as-hash-count').textContent  = s.hashStats?.count || 0;
        document.getElementById('as-hash-count2').textContent = s.hashStats?.count || 0;

        const rl = s.rateLimit || 10;
        const rw = Math.round((s.floodWindowMs || 30000) / 1000);
        const ht = s.hashThreshold || 10;

        document.getElementById('as-rate-limit').value  = rl;
        document.getElementById('as-rate-window').value = rw;
        document.getElementById('as-hash-threshold').value = ht;
        document.getElementById('as-threshold-val').textContent = ht;
        document.getElementById('as-rate-display').textContent  = rl;
        document.getElementById('as-rl-preview').textContent    = rl;
        document.getElementById('as-rl-win-preview').textContent = rw;
        document.getElementById('as-flow-limit').textContent    = rl;
        document.getElementById('as-flow-window').textContent   = rw;

        const blAutoEl = document.getElementById('as-bl-autodelete');
        if (blAutoEl) blAutoEl.checked = s.autoDeleteBlacklist !== false;
        
        const hashAutoEl = document.getElementById('as-hash-autodelete');
        if (hashAutoEl) hashAutoEl.checked = s.autoDeleteHash !== false;

        // Render pattern toggles
        renderPatterns(patterns, s);

    } catch(err) { showToast('Gagal load anti-spam settings', 'error'); }
}

function renderBlacklist() {
    const container = document.getElementById('as-bl-list');
    if (!container) return;
    container.innerHTML = '';
    _asBlacklist.forEach((word, i) => {
        const chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 12px;background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.3);border-radius:20px;font-size:13px;color:#8b5cf6;cursor:default;';
        chip.innerHTML = `${word} <button style="background:none;border:none;color:#8b5cf6;cursor:pointer;font-size:16px;line-height:1;padding:0;" data-idx="${i}" title="Hapus">&times;</button>`;
        chip.querySelector('button').addEventListener('click', () => {
            _asBlacklist.splice(i, 1);
            renderBlacklist();
            document.getElementById('as-bl-count').textContent = _asBlacklist.length;
        });
        container.appendChild(chip);
    });
    if (_asBlacklist.length === 0) {
        container.innerHTML = '<span style="color:var(--text-muted);font-size:13px;">Belum ada kata blacklist</span>';
    }
}

const PATTERN_LABELS = {
    SPAM_BLOCK_PHONE:          { label: '📱 Nomor HP/WA', desc: 'Deteksi nomor 08xx, +62xxx' },
    SPAM_BLOCK_DISCORD_INVITE: { label: '🎮 Link Discord', desc: 'Deteksi discord.gg/xxxx' },
    SPAM_BLOCK_TG_LINK:        { label: '✈️ Link Telegram', desc: 'Deteksi t.me/xxxx (hati-hati false positive)' },
    SPAM_BLOCK_PROMO:          { label: '📢 Kalimat Promo', desc: 'join sekarang, gabung gratis, dll' },
    SPAM_BLOCK_FAKE_MIRROR:    { label: '🪞 Mirror Palsu', desc: 'mirror bodong, asli hanya di, dll' },
    SPAM_BLOCK_WA_PATTERN:     { label: '📟 Pola WA Spasi', desc: 'Nomor WA berformat 0 8 9 7 7 7...' },
    SPAM_BLOCK_BODONG:         { label: '🚫 Kata Bodong', desc: 'Deteksi kata "bodong"' },
};

function renderPatterns(patterns, settings) {
    const grid = document.getElementById('as-patterns-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const settingMap = {
        blockPhone: 'SPAM_BLOCK_PHONE',
        blockDiscordInvite: 'SPAM_BLOCK_DISCORD_INVITE',
        blockTgLink: 'SPAM_BLOCK_TG_LINK',
        blockPromo: 'SPAM_BLOCK_PROMO',
        blockFakeMirror: 'SPAM_BLOCK_FAKE_MIRROR',
        blockWaPattern: 'SPAM_BLOCK_WA_PATTERN',
        blockBodong: 'SPAM_BLOCK_BODONG',
    };
    const settingValueMap = {
        SPAM_BLOCK_PHONE: settings.blockPhone,
        SPAM_BLOCK_DISCORD_INVITE: settings.blockDiscordInvite,
        SPAM_BLOCK_TG_LINK: settings.blockTgLink,
        SPAM_BLOCK_PROMO: settings.blockPromo,
        SPAM_BLOCK_FAKE_MIRROR: settings.blockFakeMirror,
        SPAM_BLOCK_WA_PATTERN: settings.blockWaPattern,
        SPAM_BLOCK_BODONG: settings.blockBodong,
    };
    
    const autoDeleteValueMap = {
        SPAM_BLOCK_PHONE: settings.autoDeletePhone,
        SPAM_BLOCK_DISCORD_INVITE: settings.autoDeleteDiscordInvite,
        SPAM_BLOCK_TG_LINK: settings.autoDeleteTgLink,
        SPAM_BLOCK_PROMO: settings.autoDeletePromo,
        SPAM_BLOCK_FAKE_MIRROR: settings.autoDeleteFakeMirror,
        SPAM_BLOCK_WA_PATTERN: settings.autoDeleteWaPattern,
        SPAM_BLOCK_BODONG: settings.autoDeleteBodong,
    };

    Object.entries(PATTERN_LABELS).forEach(([key, info]) => {
        const enabled = settingValueMap[key] === undefined ? true : (settingValueMap[key] === true || settingValueMap[key] === 'true');
            
        const autoDeleteEnabled = autoDeleteValueMap[key] === undefined ? true : (autoDeleteValueMap[key] === true || autoDeleteValueMap[key] === 'true');
            
        const card = document.createElement('div');
        card.style.cssText = 'padding:14px 16px;border-radius:10px;border:1px solid var(--border-color);background:var(--card-bg);display:flex;flex-direction:column;gap:12px;';
        card.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:4px;">
                <span style="font-size:14px;font-weight:600;">${info.label}</span>
                <span style="font-size:11px;color:var(--text-muted);">${info.desc}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border-color);padding-top:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                    <span style="font-size:12px;">Blokir Forward</span>
                    <label style="position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0;">
                        <input type="checkbox" id="asp-${key}" ${enabled ? 'checked' : ''} style="opacity:0;width:0;height:0;">
                        <span style="position:absolute;cursor:pointer;inset:0;background:${enabled ? '#10b981' : '#6b7280'};border-radius:24px;transition:.3s;"></span>
                        <span style="position:absolute;left:${enabled ? '18px' : '2px'};top:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.3s;"></span>
                    </label>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                    <span style="font-size:12px;">Hapus di Discord</span>
                    <label style="position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0;">
                        <input type="checkbox" id="asdel-${key}" ${autoDeleteEnabled ? 'checked' : ''} style="opacity:0;width:0;height:0;">
                        <span style="position:absolute;cursor:pointer;inset:0;background:${autoDeleteEnabled ? '#ef4444' : '#6b7280'};border-radius:24px;transition:.3s;"></span>
                        <span style="position:absolute;left:${autoDeleteEnabled ? '18px' : '2px'};top:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.3s;"></span>
                    </label>
                </div>
            </div>
        `;
        // Toggle visual blokir
        const cbBlock = card.querySelector(`#asp-${key}`);
        const spansBlock = cbBlock.parentElement.querySelectorAll('span');
        cbBlock.addEventListener('change', () => {
            spansBlock[0].style.background = cbBlock.checked ? '#10b981' : '#6b7280';
            spansBlock[1].style.left = cbBlock.checked ? '18px' : '2px';
        });
        
        // Toggle visual hapus
        const cbDel = card.querySelector(`#asdel-${key}`);
        const spansDel = cbDel.parentElement.querySelectorAll('span');
        cbDel.addEventListener('change', () => {
            spansDel[0].style.background = cbDel.checked ? '#ef4444' : '#6b7280';
            spansDel[1].style.left = cbDel.checked ? '18px' : '2px';
        });
        
        grid.appendChild(card);
    });
}

async function saveAntiSpam() {
    const rateLimit   = parseInt(document.getElementById('as-rate-limit').value) || 10;
    const rateWindow  = parseInt(document.getElementById('as-rate-window').value) || 30;
    const hashThr     = parseInt(document.getElementById('as-hash-threshold').value) || 10;

    const getToggle = id => { const el = document.getElementById(id); return el ? el.checked : true; };

    const payload = {
        blacklistWords:    _asBlacklist,
        rateLimit,
        floodWindowMs:     rateWindow * 1000,
        hashThreshold:     hashThr,
        blockPhone:        getToggle('asp-SPAM_BLOCK_PHONE'),
        blockDiscordInvite: getToggle('asp-SPAM_BLOCK_DISCORD_INVITE'),
        blockTgLink:       getToggle('asp-SPAM_BLOCK_TG_LINK'),
        blockPromo:        getToggle('asp-SPAM_BLOCK_PROMO'),
        blockFakeMirror:   getToggle('asp-SPAM_BLOCK_FAKE_MIRROR'),
        blockWaPattern:    getToggle('asp-SPAM_BLOCK_WA_PATTERN'),
        blockBodong:       getToggle('asp-SPAM_BLOCK_BODONG'),
        autoDeletePhone:         getToggle('asdel-SPAM_BLOCK_PHONE'),
        autoDeleteDiscordInvite: getToggle('asdel-SPAM_BLOCK_DISCORD_INVITE'),
        autoDeleteTgLink:        getToggle('asdel-SPAM_BLOCK_TG_LINK'),
        autoDeletePromo:         getToggle('asdel-SPAM_BLOCK_PROMO'),
        autoDeleteFakeMirror:    getToggle('asdel-SPAM_BLOCK_FAKE_MIRROR'),
        autoDeleteWaPattern:     getToggle('asdel-SPAM_BLOCK_WA_PATTERN'),
        autoDeleteBodong:        getToggle('asdel-SPAM_BLOCK_BODONG'),
        autoDeleteBlacklist:     getToggle('as-bl-autodelete'),
        autoDeleteHash:          getToggle('as-hash-autodelete'),
    };

    try {
        const r = await fetch('/api/antispam/settings', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (d.success) {
            showToast('✅ Anti-Spam GODMODE settings tersimpan! Restart bot untuk apply.', 'success');
        } else {
            showToast('Gagal simpan: ' + (d.error || 'unknown'), 'error');
        }
    } catch { showToast('Connection error', 'error'); }
}
