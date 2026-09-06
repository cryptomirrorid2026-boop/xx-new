const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const port = process.env.HEALTH_PORT || process.env.PORT || '5000';
const provider = (process.env.TUNNEL_PROVIDER || '').toLowerCase(); // 'ngrok' | 'localtunnel' | 'cloudflare'
const ngrokToken = process.env.NGROK_AUTHTOKEN || process.env.NGROK_TOKEN;
const ngrokDomain = process.env.NGROK_DOMAIN; // e.g. mybot.ngrok-free.app
const cfToken = process.env.TUNNEL_TOKEN || process.env.CLOUDFLARE_TUNNEL_TOKEN;
const ltSubdomain = process.env.LOCALTUNNEL_SUBDOMAIN || process.env.SUBDOMAIN;

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

let urlSaved = false;
function saveTunnelUrl(url) {
  if (urlSaved && process.env.TUNNEL_SAVED_URL === url) return;
  urlSaved = true;
  process.env.TUNNEL_SAVED_URL = url;

  const dataPath = path.join(__dirname, 'data');
  if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });
  fs.writeFileSync(
    path.join(dataPath, 'tunnel.json'),
    JSON.stringify({ url, updatedAt: new Date().toISOString() })
  );
  console.log(`\n========================================`);
  console.log(`✅ DASHBOARD ONLINE: ${url}`);
  console.log(`========================================\n`);
}

// Deteksi provider otomatis jika tidak dispesifikasikan
let selectedProvider = provider;
if (!selectedProvider) {
  if (ngrokToken || process.env.USE_NGROK === 'true') {
    selectedProvider = 'ngrok';
  } else if (ltSubdomain || process.env.USE_LOCALTUNNEL === 'true') {
    selectedProvider = 'localtunnel';
  } else {
    selectedProvider = 'cloudflare';
  }
}

console.log(`🚀 Memulai Tunnel Provider: [${selectedProvider.toUpperCase()}] (Target Port: ${port})...`);

if (selectedProvider === 'ngrok') {
  // Matikan proses ngrok zombie lama jika ada (mencegah ERR_NGROK_334)
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM ngrok.exe', { stdio: 'ignore' });
    } else {
      execSync('pkill -f ngrok', { stdio: 'ignore' });
    }
  } catch (_) {}

  // Config ngrok authtoken jika ada
  if (ngrokToken) {
    try {
      execSync(`${npxCmd} ngrok config add-authtoken ${ngrokToken}`, { stdio: 'ignore' });
      console.log('🔑 Ngrok Authtoken terkonfigurasi');
    } catch (e) {
      console.warn('⚠️ Gagal memasang ngrok authtoken:', e.message);
    }
  }

  const ngrokArgs = ['-y', 'ngrok', 'http', port];
  if (ngrokDomain) {
    const cleanDomain = ngrokDomain.replace(/^https?:\/\//, '');
    ngrokArgs.push(`--url=${cleanDomain}`);
    saveTunnelUrl(`https://${cleanDomain}`);
  }

  console.log(`📌 Menggunakan Ngrok (Command: npx ${ngrokArgs.join(' ')})`);
  const tunnel = spawn(npxCmd, ngrokArgs, { shell: true });

  tunnel.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(`[NGROK OUT] ${text}`);
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok[-a-z0-9]*\.(io|app|dev)/);
    if (match) saveTunnelUrl(match[0]);
  });

  tunnel.stderr.on('data', (data) => {
    const text = data.toString();
    console.log(`[NGROK ERR] ${text}`);
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok[-a-z0-9]*\.(io|app|dev)/);
    if (match) saveTunnelUrl(match[0]);
  });

  tunnel.on('close', (code) => {
    console.log(`Ngrok exited with code ${code}`);
    process.exit(code);
  });

} else if (selectedProvider === 'localtunnel') {
  const ltArgs = ['-y', 'localtunnel', '--port', port];
  if (ltSubdomain) {
    ltArgs.push('--subdomain', ltSubdomain);
  }

  console.log(`📌 Menggunakan LocalTunnel (Subdomain: ${ltSubdomain || 'Random'})`);
  const tunnel = spawn(npxCmd, ltArgs, { shell: true });

  tunnel.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(`[LT OUT] ${text}`);
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.loca\.lt/);
    if (match) saveTunnelUrl(match[0]);
  });

  tunnel.stderr.on('data', (data) => {
    const text = data.toString();
    console.log(`[LT ERR] ${text}`);
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.loca\.lt/);
    if (match) saveTunnelUrl(match[0]);
  });

  tunnel.on('close', (code) => {
    console.log(`LocalTunnel exited with code ${code}`);
    process.exit(code);
  });

} else {
  // Cloudflare Tunnel (Default)
  const cfArgs = cfToken
    ? ['-y', 'cloudflared', 'tunnel', '--no-autoupdate', 'run', '--token', cfToken]
    : ['-y', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`];

  console.log(cfToken ? '📌 Menggunakan Cloudflare Tunnel Token' : `📌 Menggunakan Cloudflare Quick Tunnel (Port: ${port})`);
  const tunnel = spawn(npxCmd, cfArgs, { shell: true });

  tunnel.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(`[CF OUT] ${text}`);
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !match[0].includes('api.trycloudflare.com') && !match[0].includes('update.trycloudflare.com')) {
      saveTunnelUrl(match[0]);
    }
  });

  tunnel.stderr.on('data', (data) => {
    const text = data.toString();
    console.log(`[CF ERR] ${text}`);
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !match[0].includes('api.trycloudflare.com') && !match[0].includes('update.trycloudflare.com')) {
      saveTunnelUrl(match[0]);
    }
  });

  tunnel.on('close', (code) => {
    console.log(`Cloudflared exited with code ${code}`);
    process.exit(code);
  });
}


