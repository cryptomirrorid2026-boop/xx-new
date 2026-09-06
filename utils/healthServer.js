// ============================================================
//   UTILS / HEALTHSERVER.JS
//   HTTP server sederhana untuk health-check
//   GET /health → JSON status bot
//   GET /        → redirect ke /health
//   Dipakai oleh UptimeRobot / BetterStack / monitoring tools
// ============================================================

'use strict';

const http  = require('http');
const stats = require('./stats');
const messageStore      = require('./messageStore');
const blockedUsersStore = require('./blockedUsersStore');
const mutedChannels     = require('./mutedChannels');
const logger            = require('./logger');
const os                = require('os');

/**
 * Mulai HTTP health-check server
 * @param {object} tgManager   - TelegramManager instance
 * @param {Map}    channelMap  - Channel mapping
 * @param {number} port        - Port yang digunakan (default: 3000)
 */
function startHealthServer(tgManager, channelMap, port = 3000) {
  const server = http.createServer((req, res) => {
    const url = req.url?.split('?')[0];

    // ─── GET /health ──────────────────────────────────────────────────────────
    if (url === '/health' || url === '/') {
      const s    = stats.getSummary();
      const mem  = process.memoryUsage();
      const toMB = (b) => parseFloat((b / 1024 / 1024).toFixed(2));

      const body = JSON.stringify({
        status:    'ok',
        uptime:    s.uptime,
        timestamp: new Date().toISOString(),
        stats: {
          forwarded: s.totalForwarded,
          edits:     s.totalEdits,
          media:     s.totalMedia,
          failed:    s.totalFailed,
          lastForwardedAt: s.lastForwardedAt,
        },
        system: {
          nodeVersion:   process.version,
          heapUsedMB:    toMB(mem.heapUsed),
          heapTotalMB:   toMB(mem.heapTotal),
          rssMemMB:      toMB(mem.rss),
          freeRamMB:     Math.round(os.freemem()  / 1024 / 1024),
          totalRamMB:    Math.round(os.totalmem() / 1024 / 1024),
          cpuLoad1m:     os.loadavg()[0].toFixed(2),
          platform:      os.platform(),
          uptimeSeconds: Math.round(process.uptime()),
        },
        bot: {
          telegramBots:    tgManager.size,
          activeChannels:  channelMap.size,
          mutedChannels:   mutedChannels.size,
          blockedUsers:    blockedUsersStore.size,
          storedMessages:  messageStore.size,
        },
      }, null, 2);

      res.writeHead(200, {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-cache',
        'X-Bot-Status':  'running',
      });
      res.end(body);

    // ─── GET /ping ────────────────────────────────────────────────────────────
    } else if (url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');

    // ─── 404 ──────────────────────────────────────────────────────────────────
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found', endpoints: ['/health', '/ping'] }));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Health server: Port ${port} sudah dipakai, coba port ${port + 1}`);
      server.listen(port + 1);
    } else {
      logger.error('Health server error', err.message);
    }
  });

  server.listen(port, () => {
    logger.success(`🌐 Health server aktif`, `http://localhost:${port}/health`);
  });

  return server;
}

module.exports = { startHealthServer };
