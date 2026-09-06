const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Starting Cloudflare Tunnel...');
const tunnel = spawn('npx.cmd', ['cloudflared', 'tunnel', '--url', 'http://localhost:3000'], {
    shell: true
});

tunnel.stdout.on('data', (data) => {
    console.log(`[CF OUT] ${data.toString()}`);
});

tunnel.stderr.on('data', (data) => {
    const text = data.toString();
    console.log(`[CF ERR] ${text}`);
    
    // Parse URL
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
        const url = match[0];
        console.log(`Found URL: ${url}`);
        fs.writeFileSync(path.join(__dirname, 'data', 'tunnel.json'), JSON.stringify({ url, updatedAt: new Date().toISOString() }));
    }
});

tunnel.on('close', (code) => {
    console.log(`Cloudflared exited with code ${code}`);
    process.exit(code);
});
