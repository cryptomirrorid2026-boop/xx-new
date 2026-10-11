const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ override: true });

// ─── Deteksi Port Otomatis (Anti-Tabrakan Port) ────────────────────────────────
function getTargetPort() {
  const dataPath = path.join(__dirname, 'data', 'web-port.json');
  try {
    if (fs.existsSync(dataPath)) {
      const portInfo = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      if (portInfo && portInfo.port) {
        return String(portInfo.port);
      }
    }
  } catch (_) {}
  return String(process.env.HEALTH_PORT || process.env.PORT || '5005');
}

const targetPort = getTargetPort();
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// ─── Konfigurasi Provider ──────────────────────────────────────────────────────
const providerConfig = (process.env.TUNNEL_PROVIDER || 'both').toLowerCase();
const ngrokToken = process.env.NGROK_AUTHTOKEN || process.env.NGROK_TOKEN;
const ngrokDomain = process.env.NGROK_DOMAIN;
const cfToken = process.env.TUNNEL_TOKEN || process.env.CLOUDFLARE_TUNNEL_TOKEN;

// Mode default: 'both' menjalankan Cloudflare & Ngrok berdampingan
const shouldRunCloudflare = (providerConfig === 'both' || providerConfig === 'all' || providerConfig === 'cloudflare') && process.env.ENABLE_CLOUDFLARE_TUNNEL !== 'false';
const shouldRunNgrok = (providerConfig === 'both' || providerConfig === 'all' || providerConfig === 'ngrok') && Boolean(ngrokToken || process.env.ENABLE_NGROK_TUNNEL === 'true');

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
  // Cloudflare diutamakan sebagai URL utama karena 100% bebas bentrok
  const primaryUrl = tunnelState.cloudflare || tunnelState.ngrok || tunnelState.local;
  tunnelState.url = primaryUrl;
  tunnelState.updatedAt = new Date().toISOString();

  const dataPath = path.join(__dirname, 'data');
  if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });

  fs.writeFileSync(
    path.join(dataPath, 'tunnel.json'),
    JSON.stringify(tunnelState, null, 2)
  );

  if (lastSavedUrl !== `${tunnelState.cloudflare}|${tunnelState.ngrok}|${tunnelState.ngrokStatus}`) {
    lastSavedUrl = `${tunnelState.cloudflare}|${tunnelState.ngrok}|${tunnelState.ngrokStatus}`;
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

// ─── 1. Cloudflare Tunnel Process (Anti-Tabrakan & Bebas Kuota) ────────────────
let cfProcess = null;
let cfRestartTimeout = null;

function startCloudflareTunnel() {
  if (!shouldRunCloudflare) return;

  const cfArgs = cfToken
    ? ['-y', 'cloudflared', 'tunnel', '--no-autoupdate', 'run', '--token', cfToken]
    : ['-y', 'cloudflared', 'tunnel', '--url', `http://localhost:${targetPort}`];

  console.log(`☁️ Memulai Cloudflare Tunnel (Target: http://localhost:${targetPort})...`);
  cfProcess = spawn(npxCmd, cfArgs, { shell: true });

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
  if (!shouldRunNgrok) return;

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

    // Deteksi bentrok dengan project lain (misal domain dipakai Store)
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

  ngrokProcess.on('close', (code) => {
    if (isShuttingDown) return;
    // Jika bentrok, tunggu 45 detik sebelum mencoba lagi agar tidak membebani sistem
    const delay = tunnelState.ngrokStatus === 'conflict' ? 45000 : 8000;
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
let isShuttingDown = false;
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
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
