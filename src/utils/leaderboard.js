/**
 * Ticket leaderboard PNG üretici (@napi-rs/canvas + repoya gömülü Inter fontu).
 * NEDEN: sunucu imajlarında sistem fontu olmayabiliyor (SVG metni tofu olur).
 * Gömülü TTF her ortamda birebir aynı render verir — sistem fontuna bağımlılık YOK.
 * - Her çağrıda güncel DB verisiyle dinamik render.
 * - Emoji glifi YOK (rozetler şekil+numara).
 * - Avatar yoksa/yüklenemezse baş harf rozeti; buffer üzerinden gönderim (temp dosya yok).
 * - Avatar cache: URL anahtarlı, 10dk TTL, max 50.
 */
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const logger = require('./logger');

const W = 900;
const FAMILY = 'Inter, Arial, sans-serif';
const C = {
  bg: '#232428',
  card: '#2b2d31',
  rowAlt: '#26272b',
  gold: '#FFD700',
  goldDark: '#3a2f00',
  silver: '#C0C0C0',
  bronze: '#CD7F32',
  rankBg: '#4e5058',
  white: '#ffffff',
  muted: '#b5bac1',
};
const MEDALS = [
  { bg: C.gold, fg: C.goldDark },
  { bg: C.silver, fg: '#333333' },
  { bg: C.bronze, fg: '#2f1a00' },
];
const AVATAR_TTL_MS = 10 * 60 * 1000;
const AVATAR_CACHE_MAX = 50;
const AVATAR_TIMEOUT_MS = 3500;
const AVATAR_MAX_BYTES = 3 * 1024 * 1024;

const avatarCache = new Map(); // url -> { ts, buf }
let fontsRegistered = false;

function registerFonts() {
  if (fontsRegistered) return true;
  try {
    const dir = path.join(__dirname, '..', '..', 'assets', 'fonts');
    GlobalFonts.registerFromPath(path.join(dir, 'Inter-Regular.ttf'), 'Inter');
    GlobalFonts.registerFromPath(path.join(dir, 'Inter-Bold.ttf'), 'Inter');
    GlobalFonts.registerFromPath(path.join(dir, 'Inter-ExtraBold.ttf'), 'Inter');
    fontsRegistered = true;
    return true;
  } catch (err) {
    logger.warn(`Gömülü font kaydı başarısız (sistem fontuna düşülür): ${err.message}`);
    return false;
  }
}

function cleanName(name, max = 18) {
  const t = String(name || 'Deleted User').replace(/\s+/g, ' ').trim() || 'Deleted User';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function initialOf(name) {
  const t = cleanName(name, 24);
  return (t.charAt(0) || '?').toUpperCase();
}

function countText(n) {
  const c = Math.max(0, Number(n) || 0);
  return c === 1 ? '1 TICKET' : `${c} TICKETS`;
}

function rowCountText(n) {
  const c = Math.max(0, Number(n) || 0);
  return c === 1 ? '1 Ticket' : `${c} Tickets`;
}

function paletteFor(userId) {
  const PALETTE = ['#5865F2', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63', '#0099ff', '#ff6b6b', '#2ecc71', '#f1c40f', '#00bcd4'];
  let h = 0;
  for (const ch of String(userId)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
}

function pruneAvatarCache() {
  try {
    const now = Date.now();
    for (const [k, v] of avatarCache) {
      if (!v || v.ts + AVATAR_TTL_MS <= now) avatarCache.delete(k);
    }
    if (avatarCache.size > AVATAR_CACHE_MAX) {
      const sorted = [...avatarCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [k] of sorted.slice(0, avatarCache.size - AVATAR_CACHE_MAX)) avatarCache.delete(k);
    }
  } catch {
    /* ignore */
  }
}

/** URL'den görsel indirir (başarısızlıkta null — çağıran fallback kullanır). */
async function fetchAvatar(url) {
  if (!url) return null;
  try {
    const hit = avatarCache.get(url);
    if (hit && Date.now() - hit.ts < AVATAR_TTL_MS) return hit.buf;
  } catch {
    /* ignore */
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) });
    const ct = res.headers?.get?.('content-type') || '';
    if (!res.ok || !ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > AVATAR_MAX_BYTES) return null;
    try {
      avatarCache.set(url, { ts: Date.now(), buf });
      if (avatarCache.size % 10 === 0) pruneAvatarCache();
    } catch {
      /* ignore */
    }
    return buf;
  } catch {
    return null;
  }
}

function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function circle(ctx, cx, cy, r, fill) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function centerText(ctx, text, x, y, font, fill) {
  ctx.font = font;
  ctx.fillStyle = fill;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

/** Buffer görseli dairesel kırpıp çizer (avatar/icon). Hata verirse false döner. */
async function drawAvatar(ctx, buf, cx, cy, d) {
  try {
    const img = await loadImage(buf);
    const side = Math.min(img.width, img.height) || 1;
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, sx, sy, side, side, cx - d / 2, cy - d / 2, d, d);
    ctx.restore();
    return true;
  } catch {
    return false;
  }
}

/**
 * rows: [{ userId, name, avatarBuffer|null, count }] (sıralı, max 10)
 * @returns {Promise<Buffer>} PNG
 */
async function renderTopImage({ guildName = '', iconBuffer = null, rows = [] }) {
  registerFonts();
  const list = (rows || []).filter((r) => r).slice(0, 10);
  const top3 = list.slice(0, 3);
  const rest = list.slice(3);
  const pad = 28;
  const headerH = 118;
  const topH = top3.length ? 258 : 0;
  const rowH = 64;
  const footerH = 46;
  const H = Math.round(pad + headerH + (top3.length ? 16 + topH + 14 : 8) + rest.length * (rowH + 8) + footerH + pad);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // zemin + üst altın şerit
  rr(ctx, 0, 0, W, H, 24);
  ctx.fillStyle = C.bg;
  ctx.fill();
  ctx.fillStyle = C.gold;
  ctx.fillRect(0, 0, W, 6);

  // header
  let hx = pad + 8;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let iconDrawn = false;
  if (iconBuffer) {
    iconDrawn = await drawAvatar(ctx, iconBuffer, hx + 32, pad + 14 + 32, 64);
  }
  if (iconDrawn) hx += 80;
  ctx.fillStyle = C.white;
  ctx.font = `800 38px ${FAMILY}`;
  ctx.fillText('TICKET TOP 10', hx, pad + 46);
  ctx.fillStyle = C.muted;
  ctx.font = `400 17px ${FAMILY}`;
  ctx.fillText(`En çok ticket sahiplenen yetkililer${guildName ? ` • ${guildName}` : ''}`.slice(0, 90), hx, pad + 74);
  let y = pad + headerH;

  // ilk 3: büyük kartlar
  if (top3.length) {
    y += 16;
    const gap = 16;
    const cw = Math.floor((W - pad * 2 - gap * (top3.length - 1)) / top3.length);
    for (let i = 0; i < top3.length; i++) {
      const r = top3[i];
      const x = pad + i * (cw + gap);
      const medal = MEDALS[i] || MEDALS[2];
      rr(ctx, x, y, cw, 242, 16);
      ctx.fillStyle = C.card;
      ctx.fill();
      circle(ctx, x + 34, y + 34, 20, medal.bg);
      centerText(ctx, String(i + 1), x + 34, y + 35, `800 20px ${FAMILY}`, medal.fg);
      const ax = x + cw / 2;
      const ay = y + 118;
      const drew = r.avatarBuffer ? await drawAvatar(ctx, r.avatarBuffer, ax, ay, 84) : false;
      if (!drew) {
        circle(ctx, ax, ay, 42, paletteFor(r.userId));
        centerText(ctx, initialOf(r.name), ax, ay + 2, `800 38px ${FAMILY}`, C.white);
      }
      centerText(ctx, cleanName(r.name, 16), ax, ay + 76, `700 21px ${FAMILY}`, C.white);
      const label = countText(r.count);
      ctx.font = `800 16px ${FAMILY}`;
      const pw = 34 + ctx.measureText(label).width;
      const px = Math.round(ax - pw / 2);
      const py = ay + 88;
      rr(ctx, px, py, pw, 32, 16);
      ctx.fillStyle = medal.bg;
      ctx.fill();
      centerText(ctx, label, ax, py + 17, `800 16px ${FAMILY}`, medal.fg);
    }
    y += 242 + 14;
  } else {
    y += 8;
  }

  // 4-10: kompakt satırlar
  for (let k = 0; k < rest.length; k++) {
    const r = rest[k];
    const i = k + 3;
    rr(ctx, pad, y, W - pad * 2, rowH, 12);
    ctx.fillStyle = i % 2 ? C.card : C.rowAlt;
    ctx.fill();
    const cy = y + rowH / 2;
    circle(ctx, pad + 34, cy, 16, C.rankBg);
    centerText(ctx, String(i + 1), pad + 34, cy + 1, `700 14px ${FAMILY}`, '#dbdee1');
    const drew = r.avatarBuffer ? await drawAvatar(ctx, r.avatarBuffer, pad + 80, cy, 40) : false;
    if (!drew) {
      circle(ctx, pad + 80, cy, 20, paletteFor(r.userId));
      centerText(ctx, initialOf(r.name), pad + 80, cy + 1, `800 19px ${FAMILY}`, C.white);
    }
    ctx.fillStyle = C.white;
    ctx.font = `600 19px ${FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(cleanName(r.name, 20), pad + 114, cy + 1);
    ctx.fillStyle = C.gold;
    ctx.font = `800 19px ${FAMILY}`;
    ctx.textAlign = 'right';
    ctx.fillText(rowCountText(r.count), W - pad - 12, cy + 1);
    ctx.textAlign = 'center';
    y += rowH + 8;
  }

  // footer
  centerText(ctx, 'Ticket statistics • Güncel', W / 2, H - pad - 8, `400 14px ${FAMILY}`, C.muted);

  return canvas.toBuffer('image/png');
}

/**
 * Kullanıcı/roller verisini topla (avatarlar paralel, hepsi best-effort).
 * dbRows: [{ user_id, claimed_count }] (sıralı).
 */
async function fetchTopData(guild, dbRows) {
  const list = (dbRows || []).filter((r) => r && r.user_id).slice(0, 10);
  const jobs = list.map(async (r) => {
    const userId = String(r.user_id);
    const count = Math.max(0, Number(r.claimed_count) || 0);
    let name = 'Deleted User';
    let avatarUrl = null;
    try {
      const m = await guild.members.fetch(userId).catch(() => null);
      if (m) {
        name = m.displayName || m.user?.username || name;
        try {
          avatarUrl = m.user?.displayAvatarURL?.({ extension: 'png', size: 128, forceStatic: true }) || null;
        } catch {
          avatarUrl = null;
        }
      } else {
        const u = await guild.client.users.fetch(userId).catch(() => null);
        if (u) {
          name = u.username || name;
          try {
            avatarUrl = u.displayAvatarURL?.({ extension: 'png', size: 128, forceStatic: true }) || null;
          } catch {
            avatarUrl = null;
          }
        }
      }
    } catch {
      /* fallback değerler */
    }
    const avatarBuffer = avatarUrl ? await fetchAvatar(avatarUrl) : null;
    return { userId, name: cleanName(name, 24), avatarBuffer, count };
  });
  return Promise.all(jobs);
}

module.exports = {
  renderTopImage,
  fetchTopData,
  fetchAvatar,
  drawAvatar,
  cleanName,
  initialOf,
  countText,
  rowCountText,
  paletteFor,
  registerFonts,
  _avatarCache: avatarCache,
};
