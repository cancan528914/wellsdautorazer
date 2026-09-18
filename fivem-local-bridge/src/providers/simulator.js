/**
 * SimulatorProvider — gerçek FiveM bağlantısı olmadan köprüyü uçtan uca
 * test etmek için canlı-taklit eden sahte kaynak.
 *
 * Davranış: ping jitter + ara sıra katılma/ayrılma/isim değişimi.
 * Üretimde gerçek veri kaynağı (örn. push-ingest) ile değiştirilir.
 */
const { validateSnapshot } = require('./base');

const FIRST = [
  { id: 12, name: 'Javrex', ping: 38 },
  { id: 27, name: 'PlayerTest', ping: 51 },
  { id: 43, name: 'ABC', ping: 29 },
  { id: 7, name: 'Kara Kartal', ping: 44 },
  { id: 61, name: 'John Doe', ping: 63 },
];

const POOL = ['Nova', 'Rüzgar_01', '[AZ] Kaplan', 'mavi', 'Efe-07', 'Zeynep Kaya', 'PewPew'];

class SimulatorProvider {
  constructor() {
    this.players = FIRST.map((p) => ({ ...p }));
    this.nextId = 100;
    this.tick = 0;
    this.selfId = 12;
  }

  async getSnapshot() {
    this.tick++;
    // Ping jitter (±5ms, min 5)
    for (const p of this.players) {
      p.ping = Math.max(5, p.ping + Math.floor(Math.random() * 11) - 5);
    }
    // Her ~4 tick'te bir churn: katılma / ayrılma / isim değişimi
    if (this.tick % 4 === 0 && this.players.length) {
      const roll = Math.random();
      if (roll < 0.4 && this.players.length < 12) {
        const name = POOL[Math.floor(Math.random() * POOL.length)];
        this.players.push({ id: this.nextId++, name, ping: 20 + Math.floor(Math.random() * 60) });
      } else if (roll < 0.7 && this.players.length > 2) {
        const idx = Math.floor(Math.random() * this.players.length);
        if (this.players[idx].id !== this.selfId) this.players.splice(idx, 1);
      } else {
        const cand = this.players[Math.floor(Math.random() * this.players.length)];
        if (cand) cand.name = `${cand.name.replace(/ v\d+$/, '')} v${2 + Math.floor(Math.random() * 3)}`;
      }
    }
    const clean = validateSnapshot({ players: this.players, selfId: this.selfId });
    return { players: clean.players, selfId: clean.selfId };
  }
}

module.exports = { SimulatorProvider };
