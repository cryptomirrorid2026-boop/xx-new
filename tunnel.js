const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config({ override: true });

let isShuttingDown = false;

// ─── Single-Instance Guard (Mencegah Instance Tunnel Ganda & Bunuh Zombie) ────
const dataPath = path.join(__dirname, 'data');
if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });
const pidPath = path.join(dataPath, 'tunnel.pid');

try {
  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf8').trim());
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // Cek apakah masih hidup
        console.log(`[Tunnel] Menghentikan instance tunnel lama (PID ${existingPid}) agar tidak bentrok...`);
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          try { execSync(`taskkill /F /T /PID ${existingPid}`, { stdio: 'ignore' }); } catch (_) {}
        } else {
          try { process.kill(existingPid, 'SIGKILL'); } catch (_) {}
        }
      } catch (_) {
        // PID sebelumnya sudah mati
      }
    }
  }
} catch (_) {}

// Matikan juga proses cloudflared liar yang mungkin tertinggal dari sesi sebelumnya
if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    execSync('taskkill /F /IM cloudflared.exe', { stdio: 'ignore' });
  } catch (_) {}
}

try {
  fs.writeFileSync(pidPath, String(process.pid));
} catch (_) {}

// ─── Blacklist Port Milik Web Sebelah / Store / ReviewLink ─────────────────────
// 5005 & 3000: Store Payment
// 3333, 5000, 5080, 8080: ReviewLink & Web Sebelah
const FORBIDDEN_PORTS = ['5005', '3000', '5000', '3333', '5080', '8080'];

/**
 * Verifikasi secara HTTP apakah port benar-benar menjalankan Nexus Mirror Bot Dashboard
 */
function checkMirrorHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: Number(port),
      path: '/api/health',
      timeout: 1200
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json && json.service === 'Nexus Mirror Bot Dashboard' && json.status === 'ok') {
            return resolve(true);
          }
        } catch (_) {}
        resolve(false);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Resolusi port yang 100% tervalidasi Nexus Mirror Bot
 */
async function resolveVerifiedMirrorPort() {
  const candidatePorts = [];
  
  // 1. Port dari web-port.json jika ada
  const portFile = path.join(dataPath, 'web-port.json');
  try {
    if (fs.existsSync(portFile)) {
      const portInfo = JSON.parse(fs.readFileSync(portFile, 'utf8'));
      if (portInfo && portInfo.port && !FORBIDDEN_PORTS.includes(String(portInfo.port))) {
        candidatePorts.push(String(portInfo.port));
      }
    }
  } catch (_) {}

  // 2. Port dari .env (prioritas 7080)
  const envPort = String(process.env.HEALTH_PORT || process.env.PORT || '7080');
  if (!FORBIDDEN_PORTS.includes(envPort)) candidatePorts.push(envPort);
  candidatePorts.push('7080', '7081', '7082', '7085');

  const uniquePorts = Array.from(new Set(candidatePorts));

  // Tunggu hingga web server Mirror Bot online & terverifikasi (hingga 12 detik)
  for (let attempt = 0; attempt < 24; attempt++) {
    for (const p of uniquePorts) {
      const isAlive = await checkMirrorHealth(p);
      if (isAlive) {
        console.log(`✅ [Tunnel] Web Server Mirror Bot terverifikasi pada port ${p}!`);
        return p;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Fallback aman jika web server butuh waktu startup lebih lama
  const fallback = uniquePorts.find(p => !FORBIDDEN_PORTS.includes(p)) || '7080';
  console.log(`⚠️ [Tunnel] Web Server belum merespon /api/health dalam 12s, menggunakan port target aman: ${fallback}`);
  return fallback;
}

let targetPort = '7080';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// ─── Konfigurasi Provider ──────────────────────────────────────────────────────
const providerConfig = (process.env.TUNNEL_PROVIDER || 'both').toLowerCase();
const ngrokToken = process.env.NGROK_AUTHTOKEN || process.env.NGROK_TOKEN;
const ngrokDomain = process.env.NGROK_DOMAIN;
const cfToken = process.env.TUNNEL_TOKEN || process.env.CLOUDFLARE_TUNNEL_TOKEN;

const shouldRunCloudflare = process.env.ENABLE_CLOUDFLARE !== 'false' && process.env.ENABLE_CLOUDFLARE_TUNNEL !== 'false' && providerConfig !== 'ngrok';
const shouldRunNgrok = Boolean(ngrokToken) && process.env.ENABLE_NGROK !== 'false' && process.env.ENABLE_NGROK_TUNNEL !== 'false' && providerConfig !== 'cloudflare';

// ─── Status Tunnel ─────────────────────────────────────────────────────────────
const tunnelState = {
  url: '',
  cloudflare: null,
  cfStatus: shouldRunCloudflare ? 'starting' : 'disabled',
  ngrok: null,
  ngrokStatus: shouldRunNgrok ? 'starting' : 'disabled',
  local: `http://localhost:${targetPort}`,
  port: parseInt(targetPort) || 7080,
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
  try {
    const cfPackage = require('cloudflared');
    if (cfPackage && cfPackage.bin && fs.existsSync(cfPackage.bin)) {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(cfPackage.bin, 0o755); } catch (_) {}
      }
      return { cmd: cfPackage.bin, argsPrefix: [], useShell: false };
    }
  } catch (_) {}

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

  console.log(`☁️ Memulai Cloudflare Tunnel (Target Port: http://localhost:${targetPort})...`);
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
  if (!shouldRunNgrok || !ngrokToken || isShuttingDown) return;

  const ngrokArgs = ['ngrok', 'http', String(targetPort), '--authtoken', ngrokToken, '--log=stdout'];
  if (ngrokDomain) {
    ngrokArgs.push('--domain', ngrokDomain);
  }

  console.log(`🚇 Memulai Ngrok Tunnel (Target Port: http://localhost:${targetPort})...`);
  ngrokProcess = spawn(npxCmd, ngrokArgs, { shell: true });

  const handleNgrokOutput = (data) => {
    const text = data.toString();

    // Deteksi bentrok domain ngrok (ERR_NGROK_334)
    if (text.includes('ERR_NGROK_334') || text.includes('already bound') || text.includes('failed to start tunnel')) {
      if (tunnelState.ngrokStatus !== 'conflict') {
        tunnelState.ngrokStatus = 'conflict';
        tunnelState.ngrok = null;
        console.warn(`\n⚠️ [NGROK CONFLICT] Domain Ngrok sedang aktif di project lain.`);
        console.log(`💡 Dashboard Mirror Bot tetap aman & online via Cloudflare Tunnel di atas.\n`);
        saveTunnelState();
      }
      return;
    }

    const match = text.match(/url=(https:\/\/[a-zA-Z0-9.-]+\.ngrok(?:-free)?\.(?:app|dev))/);
    if (match) {
      const url = match[1];
      if (tunnelState.ngrok !== url) {
        tunnelState.ngrok = url;
        tunnelState.ngrokStatus = 'online';
        saveTunnelState();
      }
      return;
    }

    const matchAlt = text.match(/https:\/\/[a-zA-Z0-9.-]+\.ngrok(?:-free)?\.(?:app|dev)/);
    if (matchAlt) {
      const url = matchAlt[0];
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

// ─── Inisialisasi Asinkron & Terverifikasi ────────────────────────────────────
async function startTunnelManager() {
  targetPort = await resolveVerifiedMirrorPort();
  tunnelState.local = `http://localhost:${targetPort}`;
  tunnelState.port = parseInt(targetPort) || 7080;
  saveTunnelState();

  if (shouldRunCloudflare) startCloudflareTunnel();
  if (shouldRunNgrok) startNgrokTunnel();
}

startTunnelManager().catch(err => {
  console.error('[Tunnel Startup Error]:', err.message);
});

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
