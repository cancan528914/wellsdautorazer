/**
 * Ses yaşam döngüsü kontrolü.
 * - Her zaman güvenli: önkoşul denetimi (sürümler, şifreleme, intent).
 * - Canlı test (opsiyonel): VOICE_TEST_GUILD_ID + VOICE_TEST_CHANNEL_ID verilirse
 *   GERÇEK joinVoice hattını çalıştırır, aşamaları loglar, sonunda temiz çıkar.
 *   DİKKAT: test sırasında botun başka örneği çalışmamalı (token çakışır).
 *
 * Çalıştırma: npm run doctor:voice
 */
require('dotenv').config();
const path = require('path');

const PROJ = __dirname;
const pkg = require(path.join(PROJ, 'package.json'));

async function prereqs() {
  console.log('--- ses önkoşulları ---');
  const need = { 'discord.js': null, '@discordjs/voice': null, 'libsodium-wrappers': null };
  for (const name of Object.keys(need)) {
    try {
      need[name] = require(path.join(PROJ, 'node_modules', name, 'package.json')).version;
    } catch {
      need[name] = 'YOK';
    }
  }
  console.log(`node=${process.version} discord.js=${need['discord.js']} voice=${need['@discordjs/voice']} sodium=${need['libsodium-wrappers']}`);
  let enc = '?';
  try {
    const { generateDependencyReport } = require(path.join(PROJ, 'node_modules/@discordjs/voice'));
    const rep = generateDependencyReport();
    enc = /libsodium-wrappers: [0-9]/.test(rep) ? 'sodium OK' : 'sodium YOK';
  } catch (e) {
    enc = `rapor alınamadı: ${e.message}`;
  }
  console.log(`sifreleme: ${enc}`);
  const indexSrc = require('fs').readFileSync(path.join(PROJ, 'index.js'), 'utf8');
  console.log(`GuildVoiceStates intenti: ${indexSrc.includes('GuildVoiceStates') ? 'VAR' : 'YOK (KRITIK!)'}`);
  try {
    const vh = require(path.join(PROJ, 'src/handlers/voiceHandler.js'));
    console.log(`voiceHandler: classify=${typeof vh.classifyJoinError} probe=${typeof vh.probeUdpEgress} rejoinMax=${vh.MAX_REJOIN_ATTEMPTS}`);
  } catch (e) {
    console.log(`voiceHandler yuklenemedi: ${e.message}`);
    return false;
  }
  return need['discord.js'] !== 'YOK' && need['@discordjs/voice'] !== 'YOK' && enc === 'sodium OK';
}

async function live() {
  const gid = (process.env.VOICE_TEST_GUILD_ID || '').trim();
  const cid = (process.env.VOICE_TEST_CHANNEL_ID || '').trim();
  if (!gid || !cid) {
    console.log('--- canlı test atlandı (VOICE_TEST_GUILD_ID + VOICE_TEST_CHANNEL_ID yok) ---');
    console.log('Canlı denemek için: $env:VOICE_TEST_GUILD_ID="<guild>"; $env:VOICE_TEST_CHANNEL_ID="<ses>" ; npm run doctor:voice');
    return null;
  }
  console.log('--- CANLI yasam dongusu testi (60-90sn surer) ---');
  const { Client, GatewayIntentBits } = require(path.join(PROJ, 'node_modules/discord.js'));
  const vh = require(path.join(PROJ, 'src/handlers/voiceHandler.js'));
  const { getSetting, setSetting, deleteSetting } = require(path.join(PROJ, 'src/database/database.js'));
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const origSaved = getSetting(vh.voiceKey(gid));
  try {
    await client.login(process.env.DISCORD_TOKEN);
    await new Promise((r) => client.once('clientReady', r));
    const guild = await client.guilds.fetch(gid);
    await guild.channels.fetch(cid).catch(() => null);
    console.log('asama: joinVoice cagriliyor...');
    const t0 = Date.now();
    const res = await vh.joinVoice(guild, cid);
    console.log(`asama: READY OK (${Date.now() - t0}ms) kanal=${res.channelId} taskinma=${res.moved}`);
    // 60sn canlı izleme
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      let st = '?';
      try {
        const { getVoiceConnection } = require(path.join(PROJ, 'node_modules/@discordjs/voice'));
        st = getVoiceConnection(gid)?.state?.status || 'yok';
      } catch {}
      console.log(`canli [+${Math.round((Date.now() - t0) / 1000)}sn]: ${st}`);
      if (st !== 'ready') {
        console.log('SONUC: BASARISIZ (baglanti ready kalamadi)');
        return false;
      }
    }
    console.log('SONUC: BASARILI (60sn kesintisiz ready)');
    return true;
  } catch (err) {
    console.log(`SONUC: BASARISIZ: [${err.code || '?'}] ${err.message}`);
    return false;
  } finally {
    try {
      await vh.leaveVoice(gid);
    } catch {}
    try {
      if (origSaved) setSetting(vh.voiceKey(gid), origSaved);
      else deleteSetting(vh.voiceKey(gid));
    } catch {}
    try {
      client.destroy();
    } catch {}
  }
}

(async () => {
  const ok = await prereqs();
  if (!ok) {
    console.log('ONKOSUL EKSIK — once bunlari duzeltin.');
    process.exit(1);
  }
  const res = await live();
  if (res === null) process.exit(0);
  process.exit(res ? 0 : 1);
})().catch((e) => {
  console.error('doctor-voice hatasi:', e.message || e);
  process.exit(1);
});
