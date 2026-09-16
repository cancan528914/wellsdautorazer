/**
 * Ticket leaderboard PNG üretici (sharp + SVG, derlemesiz).
 * - Her çağrıda güncel DB verisiyle dinamik render.
 * - Emoji glifi YOK (Linux sunucularda tofu olur) → rozetler şekil+numara ile çizilir.
 * - Avatar/geçici dosya yok: buffer üzerinden composite, veriAvatar yoksa baş harf rozeti.
 * - Avatar cache: URL anahtarlı (avatar değişince URL değişir), 10dk TTL, max 50.
 */
const sharp = require('sharp');
const logger = require('./logger');

const W = 900;
const FONT = 'Segoe UI, Arial, Helvetica, sans-serif';
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
  dark: '#1a1b1e',
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

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

/** Kare buffer'ı dairesel maskeyle kırpar (avatar/icon için). */
async function circleImage(buf, size) {
  const resized = await sharp(buf).resize(size, size, { fit: 'cover' }).png().toBuffer();
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`,
  );
  return sharp(resized).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

const PALETTE = ['#5865F2', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63', '#0099ff', '#ff6b6b', '#2ecc71', '#f1c40f', '#00bcd4'];

function paletteFor(userId) {
  let h = 0;
  for (const ch of String(userId)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
}

/**
 * rows: [{ userId, name, avatarBuffer|null, count }] (sıralı, max 10)
 * SVG'yi string olarak kurar (test edilebilir), renderTopImage PNG'ye çevirir.
 */
function buildTopSvg({ guildName = '', iconUri = null, rows = [] }) {
  const list = (rows || []).filter((r) => r).slice(0, 10);
  const top3 = list.slice(0, 3);
  const rest = list.slice(3);
  const pad = 28;
  const headerH = iconUri ? 118 : 104;
  const topH = top3.length ? 258 : 0;
  const rowH = 64;
  const footerH = 46;
  const H = pad + headerH + (top3.length ? 16 + topH + 14 : 8) + rest.length * (rowH + 8) + footerH + pad;

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="24" fill="${C.bg}"/>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="6" fill="${C.gold}"/>`);

  // header
  let hx = pad + 8;
  if (iconUri) {
    parts.push(`<image href="${iconUri}" x="${hx}" y="${pad + 14}" width="64" height="64"/>`);
    hx += 80;
  }
  parts.push(
    `<text x="${hx}" y="${pad + 52}" font-family="${FONT}" font-size="38" font-weight="800" fill="${C.white}">TICKET TOP 10</text>`,
    `<text x="${hx}" y="${pad + 80}" font-family="${FONT}" font-size="17" fill="${C.muted}">En çok ticket sahiplenen yetkililer${guildName ? ` • ${escapeXml(guildName)}` : ''}</text>`,
  );
  let y = pad + headerH;

  // ilk 3: büyük kartlar
  if (top3.length) {
    y += 16;
    const gap = 16;
    const cw = Math.floor((W - pad * 2 - gap * (top3.length - 1)) / top3.length);
    top3.forEach((r, i) => {
      const x = pad + i * (cw + gap);
      const medal = MEDALS[i] || MEDALS[2];
      parts.push(`<rect x="${x}" y="${y}" width="${cw}" height="242" rx="16" fill="${C.card}"/>`);
      // rozet
      parts.push(`<circle cx="${x + 34}" cy="${y + 34}" r="20" fill="${medal.bg}"/>`);
      parts.push(
        `<text x="${x + 34}" y="${y + 41}" font-family="${FONT}" font-size="20" font-weight="800" fill="${medal.fg}" text-anchor="middle">${i + 1}</text>`,
      );
      // avatar veya baş harf
      const ax = x + cw / 2;
      const ay = y + 118;
      if (r.avatarUri) {
        parts.push(`<image href="${r.avatarUri}" x="${Math.round(ax - 42)}" y="${Math.round(ay - 42)}" width="84" height="84"/>`);
      } else {
        parts.push(`<circle cx="${ax}" cy="${ay}" r="42" fill="${paletteFor(r.userId)}"/>`);
        parts.push(
          `<text x="${ax}" y="${ay + 15}" font-family="${FONT}" font-size="38" font-weight="800" fill="${C.white}" text-anchor="middle">${escapeXml(initialOf(r.name))}</text>`,
        );
      }
      // isim + sayı rozeti
      parts.push(
        `<text x="${ax}" y="${ay + 76}" font-family="${FONT}" font-size="21" font-weight="700" fill="${C.white}" text-anchor="middle">${escapeXml(cleanName(r.name, 16))}</text>`,
      );
      const label = countText(r.count);
      const pw = 34 + label.length * 11;
      parts.push(`<rect x="${Math.round(ax - pw / 2)}" y="${ay + 88}" width="${pw}" height="32" rx="16" fill="${medal.bg}"/>`);
      parts.push(
        `<text x="${ax}" y="${ay + 110}" font-family="${FONT}" font-size="16" font-weight="800" fill="${medal.fg}" text-anchor="middle">${label}</text>`,
      );
    });
    y += 242 + 14;
  } else {
    y += 8;
  }

  // 4-10: kompakt satırlar
  rest.forEach((r, k) => {
    const i = k + 3;
    parts.push(`<rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${rowH}" rx="12" fill="${i % 2 ? C.card : C.rowAlt}"/>`);
    parts.push(`<circle cx="${pad + 34}" cy="${y + rowH / 2}" r="16" fill="${C.rankBg}"/>`);
    parts.push(
      `<text x="${pad + 34}" y="${y + rowH / 2 + 5}" font-family="${FONT}" font-size="14" font-weight="700" fill="#dbdee1" text-anchor="middle">${i + 1}</text>`,
    );
    if (r.avatarUri) {
      parts.push(`<image href="${r.avatarUri}" x="${pad + 60}" y="${Math.round(y + (rowH - 40) / 2)}" width="40" height="40"/>`);
    } else {
      parts.push(`<circle cx="${pad + 80}" cy="${y + rowH / 2}" r="20" fill="${paletteFor(r.userId)}"/>`);
      parts.push(
          `<text x="${pad + 80}" y="${y + rowH / 2 + 7}" font-family="${FONT}" font-size="19" font-weight="800" fill="${C.white}" text-anchor="middle">${escapeXml(initialOf(r.name))}</text>`,
      );
    }
    parts.push(
      `<text x="${pad + 114}" y="${y + rowH / 2 + 7}" font-family="${FONT}" font-size="19" font-weight="600" fill="${C.white}">${escapeXml(cleanName(r.name, 20))}</text>`,
    );
    const label = rowCountText(r.count);
    parts.push(
      `<text x="${W - pad - 12}" y="${y + rowH / 2 + 7}" font-family="${FONT}" font-size="19" font-weight="800" fill="${C.gold}" text-anchor="end">${label}</text>`,
    );
    y += rowH + 8;
  });

  // footer
  parts.push(
    `<text x="${W / 2}" y="${H - pad - 8}" font-family="${FONT}" font-size="14" fill="${C.muted}" text-anchor="middle">Ticket statistics • Güncel</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
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

async function toDataUri(buf, size) {
  try {
    const circ = await circleImage(buf, size);
    return `data:image/png;base64,${circ.toString('base64')}`;
  } catch (err) {
    logger.warn(`Avatar maskeleme başarısız: ${err.message}`);
    return null;
  }
}

/**
 * PNG üretir. Avatarlar dairesel maskelenip gömülür; yoksa baş harf rozeti.
 * @returns {Promise<Buffer>}
 */
async function renderTopImage({ guildName = '', iconBuffer = null, rows = [] }) {
  const list = (rows || []).filter((r) => r).slice(0, 10);
  let iconUri = null;
  if (iconBuffer) {
    try {
      const circ = await circleImage(iconBuffer, 64);
      iconUri = `data:image/png;base64,${circ.toString('base64')}`;
    } catch (err) {
      logger.warn(`Sunucu ikonu işlenemedi: ${err.message}`);
    }
  }
  const sized = await Promise.all(
    list.map(async (r, i) => {
      const size = i < 3 ? 84 : 40;
      return { ...r, avatarUri: r.avatarBuffer ? await toDataUri(r.avatarBuffer, size) : null };
    }),
  );
  const svg = buildTopSvg({ guildName, iconUri, rows: sized });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = {
  buildTopSvg,
  renderTopImage,
  fetchTopData,
  fetchAvatar,
  circleImage,
  cleanName,
  initialOf,
  countText,
  escapeXml,
  _avatarCache: avatarCache,
};
