const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ override: true });

let isShuttingDown = false;

// ─── Single-Instance Guard (Mencegah Instance Tunnel Ganda) ───────────────────
const dataPath = path.join(__dirname, 'data');
if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });
const pidPath = path.join(dataPath, 'tunnel.pid');

try {
  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf8').trim());
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // Jika tidak throw error, proses masih hidup
        console.log(`[Tunnel] Instance tunnel lain sudah aktif (PID ${existingPid}). Instance ini selesai.`);
        process.exit(0);
      } catch (_) {
        // PID sebelumnya sudah mati, boleh lanjut
      }
    }
  }
} catch (_) {}

try {
  fs.writeFileSync(pidPath, String(process.pid));
} catch (_) {}

// ─── Deteksi Port Otomatis (Anti-Tabrakan Port) ────────────────────────────────
function getTargetPort() {
  const portFile = path.join(dataPath, 'web-port.json');
  try {
    if (fs.existsSync(portFile)) {
      const portInfo = JSON.parse(fs.readFileSync(portFile, 'utf8'));
      if (portInfo && portInfo.port && portInfo.port !== 5005 && portInfo.port !== 3000) {
        return String(portInfo.port);
      }
    }
  } catch (_) {}
  const rawPort = String(process.env.HEALTH_PORT || process.env.PORT || '5080');
  if (rawPort === '5005' || rawPort === '3000') {
    return '5080';
  }
  return rawPort;
}

const targetPort = getTargetPort();
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// ─── Konfigurasi Provider ──────────────────────────────────────────────────────
const providerConfig = (process.env.TUNNEL_PROVIDER || 'both').toLowerCase();
const ngrokToken = process.env.NGROK_AUTHTOKEN || process.env.NGROK_TOKEN;
const ngrokDomain = process.env.NGROK_DOMAIN;
const cfToken = process.env.TUNNEL_TOKEN || process.env.CLOUDFLARE_TUNNEL_TOKEN;

// Cloudflare diaktifkan secara default (ANTI-BENTROK)
const shouldRunCloudflare = process.env.ENABLE_CLOUDFLARE !== 'false' && process.env.ENABLE_CLOUDFLARE_TUNNEL !== 'false' && providerConfig !== 'ngrok';
// Ngrok aktif jika token tersedia, provider mengizinkan, dan tidak dimatikan secara eksplisit
const shouldRunNgrok = Boolean(ngrokToken) && process.env.ENABLE_NGROK !== 'false' && process.env.ENABLE_NGROK_TUNNEL !== 'false' && providerConfig !== 'cloudflare';

// ─── Status Tunnel ─────────────────────────────────────────────────────────────
const tunnelState = {
  url: '',
  cloudflare: null,
  cfStatus: shouldRunCloudflare ? 'starting' : 'disabled',
  ngrok: null,
  ngrokStatus: shouldRunNgrok ? 'starting' : 'disabled',
  local: `http://localhost:${targetPort}`,
  port: parseInt(targetPort),
  updatedAt: new Date().toISOString()
};

let lastSavedUrl = '';
function saveTunnelState() {
  const primaryUrl = tunnelState.cloudflare || tunnelState.ngrok || tunnelState.local;
  tunnelState.url = primaryUrl;
  tunnelState.updatedAt = new Date().toISOString();

  fs.writeFileSync(
    path.join(dataPath, 'tunnel.json'),
    JSON.stringify(tunnelState, null, 2)
  );

  const currentSummary = `${tunnelState.cloudflare}|${tunnelState.ngrok}|${tunnelState.ngrokStatus}|${tunnelState.cfStatus}`;
  if (lastSavedUrl !== currentSummary) {
    lastSavedUrl = currentSummary;
    printBanner();
  }
}

function printBanner() {
  console.log('\n============================================================');
  console.log(`🌐 NEXUS MIRROR DASHBOARD TUNNELS ONLINE (Port ${targetPort})`);
  console.log('------------------------------------------------------------');
  if (tunnelState.cloudflare) {
    console.log(`✅ [CLOUDFLARE] : ${tunnelState.cloudflare} (Utama - Bebas Bentrok)`);
  } else if (shouldRunCloudflare) {
    console.log(`⏳ [CLOUDFLARE] : Sedang menghubungkan...`);
  }

  if (tunnelState.ngrok) {
    console.log(`✅ [NGROK]      : ${tunnelState.ngrok}`);
  } else if (tunnelState.ngrokStatus === 'conflict') {
    console.log(`⚠️ [NGROK]      : Bentrok dengan project Store (Domain dipakai). Cloudflare tetap aktif!`);
  } else if (shouldRunNgrok) {
    console.log(`⏳ [NGROK]      : Sedang menghubungkan...`);
  }

  console.log(`🏠 [LOCAL]      : http://localhost:${targetPort}`);
  console.log('============================================================\n');
}

// ─── 1. Cloudflare Tunnel Process (Anti-Tabrakan & Cepat) ─────────────────────
let cfProcess = null;
let cfRestartTimeout = null;

function getCloudflareExecutable() {
  // 1. Coba gunakan binary langsung dari node_modules (Super cepat, aman untuk path berspasi)
  try {
    const cfPackage = require('cloudflared');
    if (cfPackage && cfPackage.bin && fs.existsSync(cfPackage.bin)) {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(cfPackage.bin, 0o755); } catch (_) {}
      }
      return { cmd: cfPackage.bin, argsPrefix: [], useShell: false };
    }
  } catch (_) {}

  // 2. Fallback ke npx jika binary lokal tidak ditemukan
  return { cmd: npxCmd, argsPrefix: ['-y', 'cloudflared'], useShell: true };
}

function startCloudflareTunnel() {
  if (!shouldRunCloudflare || isShuttingDown) return;

  const { cmd, argsPrefix, useShell } = getCloudflareExecutable();
  const cfArgs = [...argsPrefix, 'tunnel'];

  if (cfToken) {
    cfArgs.push('--no-autoupdate', 'run', '--token', cfToken);
  } else {
    cfArgs.push('--url', `http://localhost:${targetPort}`);
  }

  console.log(`☁️ Memulai Cloudflare Tunnel (Target: http://localhost:${targetPort})...`);
  cfProcess = spawn(cmd, cfArgs, { shell: useShell });

  const handleCfOutput = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !match[0].includes('api.trycloudflare.com') && !match[0].includes('update.trycloudflare.com')) {
      const url = match[0];
      if (tunnelState.cloudflare !== url) {
        tunnelState.cloudflare = url;
        tunnelState.cfStatus = 'online';
        saveTunnelState();
      }
    }
  };

  cfProcess.stdout.on('data', handleCfOutput);
  cfProcess.stderr.on('data', handleCfOutput);

  cfProcess.on('error', (err) => {
    console.warn(`⚠️ [Cloudflare Error]: ${err.message}`);
  });

  cfProcess.on('close', (code) => {
    if (isShuttingDown) return;
    console.log(`[Cloudflare] Process exit with code ${code}. Merestart dalam 5 detik...`);
    tunnelState.cfStatus = 'reconnecting';
    saveTunnelState();
    cfRestartTimeout = setTimeout(startCloudflareTunnel, 5000);
  });
}

// ─── 2. Ngrok Tunnel Process (Dukungan Paralel) ────────────────────────────────
let ngrokProcess = null;
let ngrokRestartTimeout = null;

function startNgrokTunnel() {
  if (!shouldRunNgrok || isShuttingDown) return;

  const ngrokArgs = ['-y', 'ngrok', 'http', targetPort];
  if (ngrokToken) {
    ngrokArgs.push(`--authtoken=${ngrokToken}`);
  }
  if (ngrokDomain) {
    const cleanDomain = ngrokDomain.replace(/^https?:\/\//, '');
    ngrokArgs.push(`--url=${cleanDomain}`);
  }

  console.log(`🚇 Memulai Ngrok Tunnel (Target: http://localhost:${targetPort})...`);
  ngrokProcess = spawn(npxCmd, ngrokArgs, { shell: true });

  const handleNgrokOutput = (data) => {
    const text = data.toString();

    // Deteksi jika domain/session sedang dipakai oleh project Store
    if (text.includes('ERR_NGROK_334') || text.includes('already online') || text.includes('ERR_NGROK_324')) {
      if (tunnelState.ngrokStatus !== 'conflict') {
        tunnelState.ngrokStatus = 'conflict';
        tunnelState.ngrok = null;
        console.log(`\n⚠️ [NGROK CONFLICT] Endpoint Ngrok sedang aktif dipakai project lain (seperti Store).`);
        console.log(`💡 Dashboard Mirror Bot tetap aman & online via Cloudflare Tunnel di atas.\n`);
        saveTunnelState();
      }
      return;
    }

    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok[-a-z0-9]*\.(io|app|dev)/);
    if (match) {
      const url = match[0];
      if (tunnelState.ngrok !== url) {
        tunnelState.ngrok = url;
        tunnelState.ngrokStatus = 'online';
        saveTunnelState();
      }
    }
  };

  ngrokProcess.stdout.on('data', handleNgrokOutput);
  ngrokProcess.stderr.on('data', handleNgrokOutput);

  ngrokProcess.on('error', (err) => {
    console.warn(`⚠️ [Ngrok Error]: ${err.message}`);
  });

  ngrokProcess.on('close', (code) => {
    if (isShuttingDown) return;
    const delay = tunnelState.ngrokStatus === 'conflict' ? 60000 : 10000;
    console.log(`[Ngrok] Process exit with code ${code}. Coba lagi dalam ${Math.round(delay / 1000)} detik...`);
    tunnelState.ngrok = null;
    saveTunnelState();
    ngrokRestartTimeout = setTimeout(startNgrokTunnel, delay);
  });
}

// ─── Inisialisasi Awal ─────────────────────────────────────────────────────────
saveTunnelState();
if (shouldRunCloudflare) startCloudflareTunnel();
if (shouldRunNgrok) startNgrokTunnel();

// ─── Pembersihan Saat Aplikasi Berhenti ────────────────────────────────────────
function cleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n🛑 Menghentikan semua tunnel process...');
  if (cfRestartTimeout) clearTimeout(cfRestartTimeout);
  if (ngrokRestartTimeout) clearTimeout(ngrokRestartTimeout);
  if (cfProcess) {
    try { cfProcess.kill(); } catch (_) {}
  }
  if (ngrokProcess) {
    try { ngrokProcess.kill(); } catch (_) {}
  }
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
