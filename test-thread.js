const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');

const envFile = fs.readFileSync('.env', 'utf8');
const tokenMatch = envFile.match(/DISCORD_TOKENS=([^,\n]+),([^,\n]+)/);
if (!tokenMatch) {
  console.log('Token not found');
  process.exit(1);
}
const token = tokenMatch[2];

const client = new Client({ checkUpdate: false });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  let found = false;
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.name === 'ting' || channel.name === 'events' || channel.name === '-events') {
        console.log(`\nFound matching channel: ${channel.name}`);
        console.log(`ID: ${channel.id}, Type: ${channel.type}, Raw Type: ${channel.rawType || 'N/A'}`);
        console.log(`Guild: ${guild.name}`);
        
        found = true;
      }
      if (channel.name === 'rwer' || channel.name === 'fdgff' || channel.name === "'") {
        console.log(`\nFound matching thread: ${channel.name}`);
        console.log(`ID: ${channel.id}, Type: ${channel.type}, Raw Type: ${channel.rawType || 'N/A'}`);
        console.log(`Guild: ${guild.name}`);
        console.log(`ParentID: ${channel.parentId || channel.parentID}`);
        console.log(`isThread: ${typeof channel.isThread === 'function' ? channel.isThread() : 'N/A'}`);
      }
    }
  }
  
  if (!found) console.log('Did not find ting or events.');
  
  process.exit(0);
});

client.login(token).catch(err => {
  console.log('Login failed:', err);
  process.exit(1);
});
