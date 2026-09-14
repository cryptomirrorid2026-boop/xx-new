'use strict';

// ============================================================
//   UTILS / MEMORYGUARD.JS — RAM Monitor & Self-Healing Guard
//   Memantau penggunaan RAM secara real-time:
//   1. Paksa V8 Garbage Collection (GC) jika --expose-gc aktif
//   2. Auto-restart bersih via PM2 sebelum kena Linux OOM Killer
// ============================================================

const logger = require('./logger');
const sharp  = require('sharp');

// Matikan internal memory cache milik LibVIPS (Sharp) agar tidak menahan image Buffer di C++ heap
try {
  sharp.cache(false);
  sharp.concurrency(1);
} catch (_) {}

class MemoryGuard {
  constructor() {
    // Threshold RAM dalam MB (Default: 550MB, bisa diset di .env MAX_RAM_MB)
    this.maxRamMB = parseInt(process.env.MAX_RAM_MB || '550', 10);
    this.checkIntervalMs = 30 * 1000; // Cek setiap 30 detik
    this.intervalId = null;
  }

  start() {
    if (this.intervalId) return;

    logger.info(`🛡️ Memory Guard aktif (Batas RAM: ${this.maxRamMB} MB | GC: ${global.gc ? 'Aktif' : 'Pasif'})`);

    this.intervalId = setInterval(() => {
      this.checkMemory();
    }, this.checkIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  checkMemory() {
    const mem = process.memoryUsage();
    const rssMB  = Math.round(mem.rss / 1024 / 1024);
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);

    // Jika --expose-gc diaktifkan dan RAM di atas 300MB, jalankan GC
    if (global.gc && rssMB > 300) {
      try {
        global.gc();
      } catch (_) {}
    }

    // Jika RAM fisik (RSS) melebihi batas aman
    if (rssMB >= this.maxRamMB) {
      logger.warn(`🚨 Memory Guard: RAM saat ini (${rssMB} MB, Heap ${heapMB} MB) melebihi limit aman (${this.maxRamMB} MB)!`);
      logger.warn('🔄 Melakukan restart mandiri secara bersih via PM2 untuk mengosongkan memory...');

      // Jalankan GC sekali lagi sebelum exit
      if (global.gc) {
        try { global.gc(); } catch (_) {}
      }

      // Exit gracefully — PM2 akan otomatis menyalakan ulang bot dalam 1 detik
      // Di Cloud (Railway/Render), exit code 1 diperlukan untuk memicu auto-restart container
      const exitCode = (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER) ? 1 : 0;
      setTimeout(() => {
        process.exit(exitCode);
      }, 1000);
    }
  }

  getStats() {
    const mem = process.memoryUsage();
    return {
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
      maxLimitMB: this.maxRamMB
    };
  }
}

module.exports = new MemoryGuard();
