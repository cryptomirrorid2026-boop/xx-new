const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');

const envFile = fs.readFileSync('.env', 'utf8');
const tokenMatch = envFile.match(/DISCORD_TOKENS=([^,\n]+),([^,\n]+)/);
const token = tokenMatch[2];

const client = new Client({ checkUpdate: false });

client.on('messageCreate', msg => {
  if (msg.channel.name && msg.channel.name.includes('rwer')) {
    console.log(`\n--- MESSAGE CREATE ---`);
    console.log(`Content: ${msg.content}`);
    console.log(`Channel name: ${msg.channel.name}`);
    console.log(`Channel type: ${msg.channel.type}`);
    console.log(`isThread: ${typeof msg.channel.isThread === 'function' ? msg.channel.isThread() : 'N/A'}`);
    console.log(`Parent ID: ${msg.channel.parentId || msg.channel.parentID}`);
  }
});

client.once('ready', () => {
  console.log(`Listening to messages as ${client.user.tag}... Waiting 10 seconds to catch past events maybe?`);
  setTimeout(() => process.exit(0), 10000);
});

client.login(token);
