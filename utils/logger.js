// ============================================================
//   UTILS / LOGGER.JS
//   Logger berwarna untuk console + file (winston)
//   Log disimpan di folder /logs dengan rotasi harian
// ============================================================

'use strict';

const chalk   = require('chalk');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path    = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

// ─── Winston File Logger ──────────────────────────────────────────────────────
const fileLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] [${level.toUpperCase().padEnd(7)}] ${message}`;
    })
  ),
  transports: [
    // Log semua level ke combined.log (rotasi harian, simpan 14 hari)
    new DailyRotateFile({
      dirname:      LOG_DIR,
      filename:     'bot-%DATE%.log',
      datePattern:  'YYYY-MM-DD',
      maxFiles:     '14d',
      maxSize:      '20m',
      zippedArchive: true,
    }),
    // Log hanya error ke error.log terpisah
    new DailyRotateFile({
      dirname:      LOG_DIR,
      filename:     'error-%DATE%.log',
      datePattern:  'YYYY-MM-DD',
      level:        'error',
      maxFiles:     '30d',
      maxSize:      '10m',
      zippedArchive: true,
    }),
  ],
});

// ─── Console Color Levels ─────────────────────────────────────────────────────
const LEVELS = {
  INFO:    { label: ' INFO ', color: chalk.bgCyan.black.bold,    icon: '📋' },
  SUCCESS: { label: ' OK   ', color: chalk.bgGreen.black.bold,   icon: '✅' },
  WARN:    { label: ' WARN ', color: chalk.bgYellow.black.bold,  icon: '⚠️ ' },
  ERROR:   { label: ' ERR  ', color: chalk.bgRed.white.bold,     icon: '❌' },
  FORWARD: { label: ' FWD  ', color: chalk.bgMagenta.white.bold, icon: '🔄' },
  BOT:     { label: ' BOT  ', color: chalk.bgBlue.white.bold,    icon: '🤖' },
};

function timestamp() {
  const now = new Date();
  return chalk.gray(`[${now.toLocaleString('id-ID', { hour12: false })}]`);
}

function log(level, message, extra = '') {
  const lvl = LEVELS[level] || LEVELS.INFO;
  const tag  = lvl.color(`${lvl.label}`);
  const extraStr = extra ? chalk.gray(` | ${extra}`) : '';

  // Console output (berwarna)
  console.log(`${timestamp()} ${tag} ${lvl.icon} ${message}${extraStr}`);

  // File output (plain text via winston)
  const plainMsg = extra ? `${message} | ${extra}` : message;
  switch (level) {
    case 'ERROR': fileLogger.error(plainMsg); break;
    case 'WARN':  fileLogger.warn(plainMsg);  break;
    default:      fileLogger.info(`[${level}] ${plainMsg}`); break;
  }
}

module.exports = {
  info:    (msg, extra) => log('INFO',    msg, extra),
  success: (msg, extra) => log('SUCCESS', msg, extra),
  warn:    (msg, extra) => log('WARN',    msg, extra),
  error:   (msg, extra) => log('ERROR',   msg, extra),
  forward: (msg, extra) => log('FORWARD', msg, extra),
  bot:     (msg, extra) => log('BOT',     msg, extra),

  // Akses langsung ke winston jika diperlukan
  fileLogger,
  LOG_DIR,

  // Banner startup
  banner() {
    console.log('\n');
    console.log(chalk.magenta.bold('  ╔══════════════════════════════════════════════╗'));
    console.log(chalk.magenta.bold('  ║   ') + chalk.white.bold('  DISCORD → TELEGRAM MIRROR BOT         ') + chalk.magenta.bold('  ║'));
    console.log(chalk.magenta.bold('  ║   ') + chalk.cyan('  Real-time Message Forwarding           ') + chalk.magenta.bold('  ║'));
    console.log(chalk.magenta.bold('  ╚══════════════════════════════════════════════╝'));
    console.log('\n');
    fileLogger.info('══════════════════════════════════════════════');
    fileLogger.info('  DISCORD → TELEGRAM MIRROR BOT — Session Start');
    fileLogger.info('══════════════════════════════════════════════');
  },
};
