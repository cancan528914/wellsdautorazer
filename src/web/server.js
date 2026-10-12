/**
 * Web Server - Transcript viewer için Express tabanlı HTTP sunucusu.
 * Bot ile aynı process'te çalışır ama mantıksal olarak ayrı modül.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../utils/logger');
const fivemBridge = require('../services/fivem/bridge');
const {
  getTranscriptById,
  getTranscriptMessages,
  getTranscriptUsers,
  getTranscriptAttachments,
  listTranscriptsByGuild,
} = require('../database/database');

const app = express();

// Trust proxy (Railway / reverse proxy arkasında)
app.set('trust proxy', config.web.trustProxy || 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      mediaSrc: ["'self'", 'https:', 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// --- FIVEM BRIDGE (Yontem C) rotlari ---
// Bu blok bilerek GLOBAL body parserlardan ONCE gelir: kendi ham govdesi
// (express.raw) ve kendi limitleriyle calisir. Boylece 413/400 dogru doner.
// ===================== FIVEM RESOURCE BRIDGE (Yöntem C) =====================

// Bu route kendi JSON parser'ını ve rate limiter'ını kullanır; global 1mb
// express.json middleware'i route'tan ÖNCE çalıştığı için ham gövde isteriz.
const bridgeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.fivem.bridge.rateMax || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// Yanıt süresi sınırı: kaynak takılırsa yavaş isteklere yer bırakma.
const BRIDGE_RESPONSE_TIMEOUT_MS = 15000;

/**
 * POST /api/fivem/players
 * Body: { "players": [{ "serverId": 1, "name": "Ada", "ping": 30 }, ...] }
 * Secret: header "X-Bridge-Secret"
 */
// Yanıt süresi sınırı — ROUTE'TAN ÖNCE kayıtlı olmalı (Express sırası belirleyici).
app.use('/api/fivem/players', (req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(503).json({ error: 'timeout' });
  }, BRIDGE_RESPONSE_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

app.post(
  '/api/fivem/players',
  bridgeLimiter,
  express.raw({ type: 'application/json', limit: config.fivem.bridge.bodyLimit }),
  (req, res) => {
    // 1) Ham gövde limiti aşıldıysa express.raw hata verdi; 413 dön.
    if (!Buffer.isBuffer(req.body)) {
      return res.status(415).json({ error: 'expect_json' });
    }
    // 2) Boyut sınırı (defansif: raw limit zaten uyguladı ama tekrar kontrol).
    if (req.body.length > config.fivem.bridge.bodyLimit) {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    // 3) Geçersiz JSON kontrolü — istisna sızdırma, 400 dön.
    let parsed;
    try {
      parsed = JSON.parse(req.body.toString('utf8'));
    } catch {
      logger.warn('Bridge isteği: geçersiz JSON gövdesi (reddedildi).');
      return res.status(400).json({ error: 'invalid_json' });
    }

    // 4) Yetkilendirme + şema doğrulama + saklama (bridge.js içinde).
    const provided = req.get('X-Bridge-Secret') || '';
    let result;
    try {
      result = fivemBridge.ingest(parsed, provided);
    } catch (err) {
      // Beklenmeyen hata: kullanıcıya 500, içeride detay loglanır (veri değil).
      logger.error('Bridge ingest beklenmedik hata.', err);
      return res.status(500).json({ error: 'internal' });
    }

    // 5) Cevap: yalnız durum + sayaç. Oyuncu verisi/secret ASLA dönülmez.
    if (!result.ok) {
      // 503 config yoksa kullanıcıya ne yapacağını söyle (gizli değil).
      return res.status(result.code).json({ error: result.error, ok: false });
    }
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, accepted: result.count, dropped: result.dropped || 0 });
  },
);

// ===================== FIVEM RESOURCE BRIDGE (Yöntem C) =====================

// express.raw gövde limitini aşarsa PayloadTooLargeError fırlatır ve istek GLOBAL
// hata işleyicisine düşer (500 + HTML). Bu route'a özel işleyici ile 413 JSON dönülür.
app.use('/api/fivem/players', (err, req, res, next) => {
  if (!err) return next();
  const tooLarge =
    err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413;
  if (tooLarge) {
    logger.warn('Bridge isteği reddedildi: gövde limiti aşıldı (413).');
    return res.status(413).json({ error: 'payload_too_large' });
  }
  logger.warn('Bridge isteği reddedildi: bozuk istek gövdesi.');
  return res.status(400).json({ error: 'invalid_request' });
});

// Yöntem C sağlığı (secret değeri ASLA dönülmez; sadece "var/yok" ve sayaç).
app.get('/api/fivem/status', bridgeLimiter, (req, res) => {
  const snap = fivemBridge.getSnapshot();
  res.json({
    configured: snap.configured,
    hasData: snap.hasData,
    count: snap.count,
    receivedAt: snap.receivedAt,
    ageMs: snap.ageMs,
    stale: snap.stale,
  });
});


app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Security headers extra
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Global rate limiting
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// Transcript specific limiter
const transcriptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Transcript endpoint rate limit exceeded.' },
});

// Static assets
const publicDir = path.join(__dirname, 'public');
const assetsDir = path.join(publicDir, 'assets');
const viewsDir = path.join(publicDir, 'views');

app.use('/assets', express.static(assetsDir, {
  maxAge: '1d',
  etag: true,
  fallthrough: true,
}));

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), uptime: process.uptime() });
});

function safeParse(str, fallback = []) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function renderErrorPage(res, status, title, message) {
  res.status(status).set('Content-Type','text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - ${escapeHtml(config.botName)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f12;color:#dcddde;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#1e1f22;border:1px solid #2b2d31;border-radius:16px;padding:48px;max-width:520px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.icon{font-size:56px;margin-bottom:12px}.code{font-size:64px;font-weight:800;color:#5865f2;line-height:1;margin-bottom:8px}
.title{font-size:22px;font-weight:700;color:#fff;margin-bottom:10px}.msg{font-size:15px;color:#949ba4;line-height:1.6;margin-bottom:24px}
.btn{display:inline-block;padding:12px 28px;background:#5865f2;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
.btn:hover{background:#4752c4}</style></head><body>
<div class="card"><div class="icon">${status===404?'🔍':status===403?'🔒':status===410?'🗑️':'⚠️'}</div><div class="code">${status}</div><div class="title">${escapeHtml(title)}</div><div class="msg">${escapeHtml(message)}</div><a href="javascript:history.back()" class="btn">Geri Dön</a></div></body></html>`);
}

// ===================== TRANSCRIPT VIEWER =====================
app.get('/transcript/:transcriptId', transcriptLimiter, async (req, res) => {
  try {
    const { transcriptId } = req.params;
    const token = String(req.query.token || '').trim();

    if (!transcriptId || !/^tr_[A-Za-z0-9_-]{16,}$/.test(transcriptId)) {
      return renderErrorPage(res, 404, 'Transcript Bulunamadı', 'Geçersiz transcript ID formatı.');
    }
    const transcript = getTranscriptById(transcriptId);
    if (!transcript) return renderErrorPage(res, 404, 'Transcript Bulunamadı', 'Bu transcript mevcut değil veya silinmiş olabilir.');
    if (!token || transcript.token !== token) return renderErrorPage(res, 403, 'Erişim Reddedildi', 'Bu transcripti görüntüleme yetkiniz yok. Geçerli bir token gereklidir.');
    if (transcript.status === 'deleted') return renderErrorPage(res, 410, 'Transcript Silinmiş', 'Bu transcript silinmiş ve artık erişilemez.');

    const messages = getTranscriptMessages(transcriptId, { limit: 10000 });
    const users = getTranscriptUsers(transcriptId);
    const attachments = getTranscriptAttachments(transcriptId);

    const payload = {
      transcript: {
        id: transcript.transcript_id,
        guildId: transcript.guild_id,
        channelId: transcript.channel_id,
        ticketId: transcript.ticket_id,
        ticketOwnerId: transcript.ticket_owner_id,
        claimedById: transcript.claimed_by_id,
        closedById: transcript.closed_by_id,
        status: transcript.status,
        messageCount: transcript.message_count,
        userCount: transcript.user_count,
        attachmentCount: transcript.attachment_count,
        imageCount: transcript.image_count,
        videoCount: transcript.video_count,
        fileCount: transcript.file_count,
        createdAt: transcript.created_at,
        closedAt: transcript.closed_at,
        webUrl: transcript.web_url,
      },
      messages: messages.map(m => ({
        messageId: m.message_id,
        userId: m.user_id,
        username: m.username,
        displayName: m.display_name,
        discriminator: m.discriminator,
        avatarUrl: m.avatar_url,
        bot: !!m.bot,
        content: m.content,
        cleanedContent: m.cleaned_content,
        editedAt: m.edited_at,
        createdAt: m.created_at,
        type: m.type,
        replyToId: m.reply_to_id,
        replyPreview: safeParse(m.reply_preview, null),
        attachments: safeParse(m.attachments, []),
        embeds: safeParse(m.embeds, []),
        reactions: safeParse(m.reactions, {}),
        stickerItems: safeParse(m.sticker_items, []),
        roleColor: m.role_color,
        roleName: m.role_name,
      })),
      users: users.map(u => ({
        userId: u.user_id,
        username: u.username,
        displayName: u.display_name,
        discriminator: u.discriminator,
        avatarUrl: u.avatar_url,
        bot: !!u.bot,
        roles: safeParse(u.roles, []),
        messageCount: u.message_count,
        firstMessageAt: u.first_message_at,
        lastMessageAt: u.last_message_at,
      })),
      attachments: attachments.map(a => ({
        attachmentId: a.attachment_id,
        messageId: a.message_id,
        filename: a.filename,
        contentType: a.content_type,
        size: a.size,
        url: a.url,
        proxyUrl: a.proxy_url,
        width: a.width,
        height: a.height,
      })),
      config: { botName: config.botName, guildId: config.guildId },
    };

    // Read template and inject JSON safely
    const templatePath = path.join(viewsDir, 'transcript.html');
    let html;
    try { html = fs.readFileSync(templatePath, 'utf8'); }
    catch { return renderErrorPage(res, 500, 'Sunucu Hatası', 'Transcript template bulunamadı.'); }

    // Escape </script> in JSON to prevent breaking out
    const jsonStr = JSON.stringify(payload).replace(/</g, '\\u003c');
    html = html.replace('__TRANSCRIPT_JSON__', jsonStr);
    res.set('Content-Type','text/html; charset=utf-8');
    res.set('Cache-Control','private, max-age=60');
    res.set('X-Frame-Options','DENY');
    return res.send(html);
  } catch (err) {
    logger.error('Transcript render hatası:', err);
    return renderErrorPage(res, 500, 'Sunucu Hatası', 'Transcript yüklenirken bir hata oluştu.');
  }
});

// API JSON
app.get('/api/transcript/:transcriptId', transcriptLimiter, async (req, res) => {
  try {
    const { transcriptId } = req.params;
    const token = String(req.query.token || '').trim();
    if (!/^tr_[A-Za-z0-9_-]{16,}$/.test(transcriptId)) return res.status(400).json({ error: 'Invalid transcript ID' });
    const transcript = getTranscriptById(transcriptId);
    if (!transcript || transcript.token !== token) return res.status(403).json({ error: 'Access denied' });
    if (transcript.status === 'deleted') return res.status(410).json({ error: 'Transcript deleted' });
    const messages = getTranscriptMessages(transcriptId, { limit: 10000 });
    const users = getTranscriptUsers(transcriptId);
    return res.json({
      transcript: { ...transcript, token: undefined },
      messages: messages.map(m => ({ ...m, attachments: safeParse(m.attachments), embeds: safeParse(m.embeds), reactions: safeParse(m.reactions), stickerItems: safeParse(m.sticker_items), replyPreview: safeParse(m.reply_preview, null) })),
      users: users.map(u => ({ ...u, roles: safeParse(u.roles) })),
    });
  } catch (err) {
    logger.error('Transcript API hatası:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/transcripts', transcriptLimiter, async (req, res) => {
  try {
    const guildId = String(req.query.guildId || '').trim();
    if (!/^\d{17,20}$/.test(guildId)) return res.status(400).json({ error: 'guildId required' });
    const list = listTranscriptsByGuild(guildId, { limit: 100 });
    return res.json({ transcripts: list.map(t => ({ ...t, token: undefined })) });
  } catch (err) {
    logger.error('Transcript list API hatası:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 404
app.use((req, res) => renderErrorPage(res, 404, 'Sayfa Bulunamadı', 'Aradığınız sayfa mevcut değil.'));
// error
app.use((err, req, res, _next) => {
  logger.error('Web server error:', err);
  renderErrorPage(res, 500, 'Sunucu Hatası', 'Beklenmeyen bir hata oluştu.');
});

function getBaseUrl() {
  if (config.web.baseUrl) return config.web.baseUrl.replace(/\/$/, '');
  const port = config.web.port || 3000;
  return `http://localhost:${port}`;
}

function startWebServer() {
  if (!config.web.enabled) {
    logger.info('Web server devre dışı (WEB_ENABLED=false).');
    return Promise.resolve(null);
  }
  const port = config.web.port || 3000;
  const host = config.web.host || '0.0.0.0';
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      logger.success(`Web server başlatıldı: http://${host}:${port} (base: ${getBaseUrl()})`);
      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') logger.error(`Port ${port} kullanımda. WEB_PORT değiştirin.`);
      else logger.error('Web server başlatılamadı.', err);
      reject(err);
    });
  });
}

module.exports = { app, startWebServer, getBaseUrl };