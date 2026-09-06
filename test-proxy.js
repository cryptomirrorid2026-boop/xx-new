const { applyWordFilter } = require('./handlers/messageHandler');
// We need to just test the proxy logic or duplicateGuard/shouldFilter.
const config = {
  forwardBotMessages: true,
  blacklistWords: [],
  whitelistWords: []
};

const wordFilter = require('./utils/wordFilterManager');

const message = {
  id: '123',
  content: 'ADMIN [` VaultXII `](<https://dsc.gg/vaultxii>) halooo',
  channelId: '456',
  author: { id: '789', bot: false },
  attachments: { size: 0 },
  embeds: [],
  stickers: { size: 0 },
  guild: null,
  channel: { name: 'test' }
};

// Test shouldFilter
const messageHandler = require('./handlers/messageHandler');
const { shouldFilter } = require('./handlers/messageHandler');
// Oops shouldFilter is not exported. But we can require it if we mock it? No, shouldFilter is internal.
// Let's just test applyWordFilter using proxy.
const applyWordFilterMock = (msg) => {
  if (!msg.content) return msg; // Tidak ada teks, lewat

  const originalContent = msg.content;
  const { filtered, result, removedWords } = wordFilter.filterContent(originalContent);
  if (!filtered) return msg;

  return new Proxy(msg, {
    get(target, prop) {
      if (prop === 'content') return result; // '' jika semua dihapus, string jika ada sisa
      return target[prop];
    }
  });
};

const proxyMsg = applyWordFilterMock(message);
console.log('Original content:', message.content);
console.log('Proxy content:', proxyMsg.content);

// Let's check formatMessage
const { formatMessage } = require('./utils/formatter');
const formatted = formatMessage(proxyMsg, config);
console.log('Formatted:\n', formatted);

