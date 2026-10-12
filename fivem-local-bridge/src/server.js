/**
 * Localhost HTTP API:
 *   GET  /health      (anahtarsız — süreç izleme için minimal)
 *   GET  /status      oyuncu sayısı + tazelik + kaynak
 *   GET  /players     tam liste [{id,name,ping}]
 *   GET  /player/:id  tek oyuncu (404 yoksa, 400 geçersiz id)
 *   POST /ingest      push-model kaynaklar için snapshot yazar (anahtarlı)
 *
 * Güvenlik: 127.0.0.1 bind + loopback kaynak kontrolü + API anahtarı
 * (X-Bridge-Key) + rate limit + localhost-dışı CORS yok.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { validateSnapshot } = require('./providers/base');

function isLoopback(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function createServer({ store, apiKey, rateWindowMs, rateMax }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Güvenlik başlıkları (minimal, bağımlılıksız).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // CORS: sadece localhost origin'ler (bot sunucu-sunucu okur; tarayıcı gerekmez).
    const origin = String(req.headers.origin || '');
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  const limiter = rateLimit({
    windowMs: rateWindowMs,
    max: rateMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'RATE_LIMITED' },
  });
  app.use(limiter);

  // Loopback bekçisi (bind 127.0.0.1'e ek savunma).
  app.use((req, res, next) => {
    if (!isLoopback(req)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    next();
  });

  const needKey = (req, res, next) => {
    const got = String(req.headers['x-bridge-key'] || '');
    if (!got || got !== apiKey) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    next();
  };

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'fivem-local-bridge', uptimeSec: Math.floor(process.uptime()) });
  });

  app.get('/status', needKey, (req, res) => {
    const s = store.get();
    res.json({
      success: true,
      online: s.players.length > 0 || !s.stale,
      count: s.players.length,
      selfId: s.selfId,
      stale: s.stale,
      source: s.source,
      updatedAt: s.updatedAt,
    });
  });

  app.get('/players', needKey, (req, res) => {
    const s = store.get();
    res.json({ success: true, count: s.players.length, players: s.players, stale: s.stale, updatedAt: s.updatedAt, source: s.source });
  });

  app.get('/player/:id', needKey, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 100000) {
      return res.status(400).json({ success: false, error: 'INVALID_ID' });
    }
    const s = store.get();
    const player = s.players.find((p) => p.id === id) || null;
    if (!player) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    res.json({ success: true, player, stale: s.stale, updatedAt: s.updatedAt });
  });

  // Push-model kaynaklar (örn. oyun-içi istemci) snapshot'ı buraya yazar.
  app.post('/ingest', needKey, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    if (!body) return res.status(400).json({ success: false, error: 'INVALID_BODY' });
    const clean = validateSnapshot({ players: body.players, selfId: body.selfId });
    store.set({ players: clean.players, selfId: clean.selfId, source: 'push', stale: false, error: null });
    res.json({ success: true, count: clean.players.length, dropped: clean.dropped });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.status === 400) {
      return res.status(400).json({ success: false, error: 'INVALID_JSON' });
    }
    res.status(500).json({ success: false, error: 'INTERNAL' });
  });
  app.use((req, res) => res.status(404).json({ success: false, error: 'NOT_FOUND_ROUTE' }));

  return app;
}

module.exports = { createServer, isLoopback };
