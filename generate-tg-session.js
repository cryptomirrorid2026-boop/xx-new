// ============================================================
//   GENERATE-TG-SESSION.JS
//   Script satu kali untuk membuat Telegram Session String
//   dari akun user biasa (bukan bot).
//
//   Cara pakai:
//     1. node generate-tg-session.js
//     2. Masukkan nomor HP, kode OTP, dan password 2FA (jika ada)
//     3. Copy session string yang muncul ke .env:
//        TG_USER_SESSIONS=namaSession
//
//   ⚠️  JANGAN bagikan session string ke siapapun!
//       Session string = akses penuh ke akun Telegram Anda.
// ============================================================

'use strict';

require('dotenv').config();

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const input = require('input'); // kita pakai readline langsung

const readline = require('readline');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  console.log('\n========================================');
  console.log('  Telegram Session String Generator');
  console.log('  Untuk fitur TG → Discord Mirror');
  console.log('========================================\n');

  // Ambil API credentials
  const envApiId   = process.env.TG_API_ID;
  const envApiHash = process.env.TG_API_HASH;

  let apiId, apiHash;

  if (envApiId && envApiHash && envApiId !== '0') {
    console.log(`✅ Menggunakan TG_API_ID dari .env: ${envApiId}`);
    apiId   = parseInt(envApiId);
    apiHash = envApiHash;
  } else {
    console.log('📋 Dapatkan API ID & Hash di: https://my.telegram.org');
    console.log('   Login → App configuration → Buat/lihat app\n');
    apiId   = parseInt(await ask('Masukkan TG_API_ID (angka): '));
    apiHash = await ask('Masukkan TG_API_HASH (string): ');
  }

  if (!apiId || !apiHash) {
    console.error('\n❌ API ID atau API Hash tidak valid!');
    process.exit(1);
  }

  const session = new StringSession(''); // Kosong = login baru
  const client  = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log('\n🔐 Memulai proses login Telegram...\n');

  await client.start({
    phoneNumber: async () => {
      console.log('📱 Masukkan nomor HP Telegram Anda (format internasional):');
      return await ask('   Contoh: +6281234567890 → ');
    },
    phoneCode: async () => {
      console.log('\n📨 Kode OTP dikirim ke Telegram Anda (atau SMS).');
      return await ask('   Masukkan kode OTP: ');
    },
    password: async () => {
      console.log('\n🔒 Akun Anda mengaktifkan 2FA (Two-Step Verification).');
      return await ask('   Masukkan password 2FA: ');
    },
    onError: (err) => {
      console.error('\n❌ Error saat login:', err.message);
    },
  });

  console.log('\n✅ Login berhasil!');

  const me   = await client.getMe();
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || String(me.id);
  console.log(`\n👤 Akun: ${name} (@${me.username || me.id})`);

  const sessionString = client.session.save();
  console.log('\n========================================');
  console.log('  SESSION STRING (copy ke .env):');
  console.log('========================================');
  console.log(sessionString);
  console.log('========================================\n');
  console.log('📋 Tambahkan ke file .env:');
  console.log(`   TG_USER_SESSIONS=${sessionString}\n`);
  console.log('💡 Jika punya lebih dari 1 akun, pisahkan dengan koma:');
  console.log('   TG_USER_SESSIONS=session1String,session2String\n');
  console.log('⚠️  JANGAN bagikan session string ini ke siapapun!\n');

  await client.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
