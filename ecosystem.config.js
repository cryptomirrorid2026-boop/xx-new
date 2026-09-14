// ============================================================
//   ECOSYSTEM.CONFIG.JS - PM2 PROCESS MANAGER (DYNAMIC)
//   Mendukung multi-instance bot di VPS tanpa bentrok port / nama
// ============================================================

// Muat variabel lingkungan dari file .env secara aman
try {
  require('dotenv').config();
} catch (e) {
  // Fallback jika package dotenv belum terinstall di environment tertentu
}

// Konfigurasi Dinamis dari .env (Anti-Tabrakan Port & Nama Proses)
const APP_NAME = process.env.PM2_APP_NAME || "discord-to-telegram-mirror";
const PORT = process.env.PORT || process.env.HEALTH_PORT || "5000";
const TUNNEL_APP_NAME = process.env.PM2_TUNNEL_NAME || `${APP_NAME}-tunnel`;
const MAX_RAM = process.env.MAX_RAM_MB ? `${process.env.MAX_RAM_MB}M` : "550M";

module.exports = {
  apps: [
    {
      name: APP_NAME,
      script: "index.js",
      exec_mode: "fork",
      watch: false,

      max_memory_restart: MAX_RAM,
      node_args: "--max-old-space-size=512 --expose-gc",
      autorestart: true,
      exp_backoff_restart_delay: 100,
      restart_delay: 2000,
      kill_timeout: 3000,
      cron_restart: "0 */12 * * *",
      env: {
        NODE_ENV: "production",
        PORT: PORT,
        HEALTH_PORT: PORT
      }
    },
    {
      name: TUNNEL_APP_NAME,
      script: "tunnel.js",
      watch: false,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        PORT: PORT,
        HEALTH_PORT: PORT
      }
    }
  ]
};
