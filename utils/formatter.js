// ============================================================
//   UTILS / FORMATTER.JS
//   Memformat pesan Discord menjadi teks Telegram (MarkdownV2)
//   + Konversi mention Discord ke teks yang readable
// ============================================================

'use strict';

/**
 * Escape karakter khusus Telegram MarkdownV2
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

/**
 * Konversi Discord mentions/emoji ke teks readable
 * Dipanggil SEBELUM escapeMarkdown
 * @param {string} text
 * @param {Guild|null} guild - Discord guild object
 */
function convertMentions(text, guild) {
  if (!text) return text;

  // User/Member mentions: <@userId> atau <@!userId>
  text = text.replace(/<@!?(\d+)>/g, (match, userId) => {
    if (guild) {
      const member = guild.members.cache.get(userId);
      if (member) return `@${member.displayName || member.user.username}`;
      const user = guild.client?.users.cache.get(userId);
      if (user) return `@${user.username}`;
    }
    return `@${userId}`;
  });

  // Role mentions: <@&roleId>
  text = text.replace(/<@&(\d+)>/g, (match, roleId) => {
    if (guild) {
      const role = guild.roles?.cache.get(roleId);
      if (role) return `@${role.name}`;
    }
    return '@role';
  });

  // Channel mentions: <#channelId>
  text = text.replace(/<#(\d+)>/g, (match, channelId) => {
    if (guild) {
      const ch = guild.channels?.cache.get(channelId);
      if (ch) return `#${ch.name}`;
    }
    return '#channel';
  });

  // Custom emoji (animasi): <a:name:id> → :name:
  // Custom emoji (biasa):   <:name:id>  → :name:
  text = text.replace(/<a?:([^:]+):\d+>/g, ':$1:');

  return text;
}

/**
 * Konversi format markdown Discord ke Telegram MarkdownV2
 */
function convertDiscordMarkdown(text) {
  if (!text) return '';
  let result = text;

  // Simpan code blocks agar tidak diproses ulang
  const codeBlocks = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // Escape semua karakter khusus Telegram
  result = escapeMarkdown(result);

  // Kembalikan code blocks (sudah di-escape sebelum disimpan — tidak perlu)
  codeBlocks.forEach((block, i) => {
    result = result.replace(`\x00CODE${i}\x00`, block);
  });
  inlineCodes.forEach((code, i) => {
    result = result.replace(`\x00INLINE${i}\x00`, code);
  });

  return result;
}

/**
 * Buat baris header pesan (watermark + meta info)
 * @param {Message} message - Discord message
 * @param {object} config
 * @returns {string} Teks MarkdownV2
 */
function buildHeader(message, config) {
  const parts = [];

  if (config.watermark) {
    parts.push(`*${escapeMarkdown(config.watermark)}*`);
  }

  const meta = [];
  if (config.showServerName && message.guild) {
    meta.push(`🏠 *${escapeMarkdown(message.guild.name)}*`);
  }
  if (config.showChannelName && message.channel) {
    meta.push(`📌 \\#${escapeMarkdown(message.channel.name)}`);
  }
  if (config.showAuthorName && message.author) {
    const name = message.member?.displayName || message.author.username;
    meta.push(`👤 ${escapeMarkdown(name)}`);
  }

  if (meta.length > 0) parts.push(meta.join('  '));
  parts.push(escapeMarkdown('─'.repeat(28)));

  return parts.join('\n');
}

/**
 * Format pesan Discord lengkap untuk Telegram MarkdownV2
 * @param {Message} message
 * @param {object} config
 * @returns {string}
 */
function formatMessage(message, config) {
  const header = buildHeader(message, config);
  let body = '';

  if (message.content) {
    // 1. Konversi mention dulu (sebelum escape)
    const converted = convertMentions(message.content, message.guild);
    // 2. Escape untuk MarkdownV2
    body = convertDiscordMarkdown(converted);
  }

  // Embed Discord
  if (message.embeds?.length > 0) {
    const embedTexts = message.embeds.map(embed => {
      const lines = [];
      if (embed.title)       lines.push(`📋 *${escapeMarkdown(embed.title)}*`);
      if (embed.description) lines.push(escapeMarkdown(embed.description));
      if (embed.fields?.length > 0) {
        embed.fields.forEach(f => {
          lines.push(`\n*${escapeMarkdown(f.name)}*\n${escapeMarkdown(f.value)}`);
        });
      }
      if (embed.footer?.text) lines.push(`_${escapeMarkdown(embed.footer.text)}_`);
      return lines.join('\n');
    });
    const embedBody = embedTexts.join('\n\n');
    body = body ? `${body}\n\n${embedBody}` : embedBody;
  }

  // Sticker
  if (message.stickers?.size > 0) {
    const names = [...message.stickers.values()].map(s => s.name).join(', ');
    const stickerText = `\\[Sticker: ${escapeMarkdown(names)}\\]`;
    body = body ? `${body}\n${stickerText}` : stickerText;
  }

  const full = `${header}\n${body || '\\[pesan tanpa teks\\]'}`;

  const maxLen = config.maxMessageLength || 4000;
  if (full.length > maxLen) {
    return full.substring(0, maxLen - 20) + '\n\\.\\.\\.\\[dipotong\\]';
  }

  return full;
}

/**
 * Format notif pesan yang diedit
 */
function formatEditedMessage(message, config) {
  const header = buildHeader(message, config);
  const editTag = '✏️ *\\[DIEDIT\\]*';
  let body = '';

  if (message.content) {
    const converted = convertMentions(message.content, message.guild);
    body = convertDiscordMarkdown(converted);
  }

  // Embed Discord
  if (message.embeds?.length > 0) {
    const embedTexts = message.embeds.map(embed => {
      const lines = [];
      if (embed.title)       lines.push(`📋 *${escapeMarkdown(embed.title)}*`);
      if (embed.description) lines.push(escapeMarkdown(embed.description));
      if (embed.fields?.length > 0) {
        embed.fields.forEach(f => {
          lines.push(`\n*${escapeMarkdown(f.name)}*\n${escapeMarkdown(f.value)}`);
        });
      }
      if (embed.footer?.text) lines.push(`_${escapeMarkdown(embed.footer.text)}_`);
      return lines.join('\n');
    });
    const embedBody = embedTexts.join('\n\n');
    body = body ? `${body}\n\n${embedBody}` : embedBody;
  }

  if (!body) {
    body = '\\[konten tidak tersedia\\]';
  }

  return `${header}\n${editTag}\n${body}`;
}

/**
 * Format notif pesan yang dihapus
 */
function formatDeletedMessage(message, config) {
  const header = buildHeader(message, config);
  const deleteTag = '🗑️ *\\[PESAN DIHAPUS\\]*';
  let preview = '';

  if (message.content) {
    const short = message.content.substring(0, 100);
    preview = `\n_${escapeMarkdown(short + (message.content.length > 100 ? '...' : ''))}_`;
  }

  return `${header}\n${deleteTag}${preview}`;
}

module.exports = {
  escapeMarkdown,
  convertMentions,
  convertDiscordMarkdown,
  buildHeader,
  formatMessage,
  formatEditedMessage,
  formatDeletedMessage,
};
