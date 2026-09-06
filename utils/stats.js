// ============================================================
//   UTILS / STATS.JS
//   Tracking statistik pesan yang diteruskan
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, '..', 'data', 'stats.json');

const defaultStats = {
  startTime: null,
  totalForwarded: 0,
  totalFailed: 0,
  totalEdits: 0,
  totalMedia: 0,
  byChannel: {},
  lastForwardedAt: null,
};

class Stats {
  constructor() {
    this.data = { ...defaultStats };
    this.data.startTime = new Date().toISOString();
    this._load();
  }

  _load() {
    try {
      const dir = path.dirname(STATS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf-8');
        const saved = JSON.parse(raw);
        this.data = { ...this.data, ...saved };
      }
    } catch (_) {
      // Tidak masalah jika file tidak ada
    }
  }

  save() {
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.data, null, 2));
    } catch (_) {}
  }

  recordForward(channelId) {
    this.data.totalForwarded++;
    this.data.lastForwardedAt = new Date().toISOString();
    if (!this.data.byChannel[channelId]) {
      this.data.byChannel[channelId] = 0;
    }
    this.data.byChannel[channelId]++;
    this.save();
  }

  recordFailed() {
    this.data.totalFailed++;
    this.save();
  }

  recordEdit() {
    this.data.totalEdits++;
    this.save();
  }

  recordMedia() {
    this.data.totalMedia++;
    this.save();
  }

  getSummary() {
    const uptime = this.data.startTime
      ? this._formatUptime(Date.now() - new Date(this.data.startTime).getTime())
      : 'N/A';

    return {
      uptime,
      totalForwarded: this.data.totalForwarded,
      totalFailed: this.data.totalFailed,
      totalEdits: this.data.totalEdits,
      totalMedia: this.data.totalMedia,
      lastForwardedAt: this.data.lastForwardedAt,
    };
  }

  _formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }
}

module.exports = new Stats();
