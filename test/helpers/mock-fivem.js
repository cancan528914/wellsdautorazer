/**
 * Test yardimcisi: YAPAY FiveM sunucusu.
 *
 * Gercek sunucuda her senaryoyu (403, "Nope.", anonim, timeout...) uretmek
 * mumkun degildir. Bu modul ayni endpoint'leri istenen davranisla SERVES eder.
 * Boylece hata siniflandirmasi, yetkilendirme ve zincir secimi test edilebilir.
 *
 * Modlar:
 *   real        → gercek oyuncu verisi
 *   anonymized  → id=0 / "Player" (bu sunucunun gercek davranisi)
 *   forbidden   → HTTP 403
 *   paranoia    → HTTP 200 + duz metin "Nope."
 *   empty       → bos oyuncu listesi []
 *   notfound    → HTTP 404
 *   ratelimited → HTTP 429
 *   servererror → HTTP 500
 *   slow        → belirtilen ms bekler (timeout testi)
 *   token       → X-Players-Token dogruysa real, yanlissa 403
 */
const http = require('node:http');

const REAL_PLAYERS = [
  { endpoint: '127.0.0.1', id: 12, identifiers: ['license:aaa', 'discord:111'], name: 'Test Oyuncu', ping: 31 },
  { endpoint: '127.0.0.1', id: 7, identifiers: ['license:bbb'], name: 'Wellsd', ping: 48 },
  { endpoint: '127.0.0.1', id: 27, identifiers: [], name: 'Kara Kartal', ping: 22 },
];

const ANON_PLAYERS = REAL_PLAYERS.map(() => ({
  endpoint: '127.0.0.1',
  id: 0,
  identifiers: [],
  name: 'Player',
  ping: 0,
}));

/**
 * @param {object} opts
 * @param {string} opts.mode varsayilan 'real'
 * @param {string} [opts.token] 'token' modunda dogru deger
 * @param {number} [opts.slowMs] 'slow' modunda beklenecek ms
 */
function createMockFivem(opts = {}) {
  const state = {
    mode: opts.mode || 'real',
    token: opts.token || 'dogru-token-123',
    slowMs: opts.slowMs || 30000,
    // Canli oyuncu listesi (b.connect/ayrilma testleri icin degistirilebilir)
    players: [...REAL_PLAYERS],
    // Istek sayaclari (spam/hiz limiti testleri icin)
    calls: { info: 0, dynamic: 0, players: 0 },
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const send = (code, body, type = 'application/json') => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    if (url === '/info.json') {
      state.calls.info++;
      return send(200, {
        server: 'FXServer-test',
        vars: { sv_projectName: 'TEST SUNUCU', sv_maxClients: 100, gamename: 'gta5' },
        resources: [{ name: 'a' }, { name: 'b' }],
      });
    }

    if (url === '/dynamic.json') {
      state.calls.dynamic++;
      return send(200, {
        clients: state.players.length,
        hostname: 'TEST SUNUCU',
        gametype: 'Freeroam',
        mapname: 'test-map',
        sv_maxclients: '100',
      });
    }

    if (url === '/players.json') {
      state.calls.players++;
      const mode = state.mode;

      if (mode === 'slow') {
        // Timeout testi: istegi geciktir, istemci zaman aşımına düşsün.
        return setTimeout(() => send(200, []), state.slowMs);
      }
      if (mode === 'forbidden') return send(403, 'Forbidden');
      if (mode === 'notfound') return send(404, 'Not Found');
      if (mode === 'ratelimited') return send(429, 'Too Many Requests');
      if (mode === 'servererror') return send(500, 'Server Error');
      if (mode === 'paranoia') return send(200, 'Nope.', 'text/plain');
      if (mode === 'badjson') return send(200, '{bozuk json', 'application/json');

      if (mode === 'token') {
        const given = req.headers['x-players-token'];
        if (!given || given !== state.token) return send(403, 'Forbidden');
        return send(200, state.players);
      }
      if (mode === 'anonymized') return send(200, ANON_PLAYERS);
      if (mode === 'empty') return send(200, []);
      return send(200, state.players);
    }

    return send(404, 'Not Found');
  });

  return {
    state,
    /** Sunucuyu 0.0.0.0 rastgele portta baslatir. */
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve({ host: '127.0.0.1', port: server.address().port });
        });
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
    /** Oyuncu ekle (b.connect testi) */
    addPlayer: (p) => state.players.push(p),
    /** Oyuncu cikar (b.ayrilma testi) */
    removePlayer: (id) => {
      state.players = state.players.filter((p) => p.id !== id);
    },
    resetCalls: () => {
      state.calls.info = 0;
      state.calls.dynamic = 0;
      state.calls.players = 0;
    },
  };
}

module.exports = { createMockFivem, REAL_PLAYERS, ANON_PLAYERS };