/**
 * Javrex Bot System - Merkezi konfigürasyon
 * Tüm değiştirilebilir değerler buradan yönetilir. Hassas veriler .env'den okunur.
 * Hard-code ID KULLANMAYIN - her şeyi .env üzerinden değiştirin.
 */

require('dotenv').config();
const path = require('path');

function required(name) {
  const v = (process.env[name] || '').trim();
  if (!v) {
    console.warn(`[WARN] .env içinde ${name} tanımlı değil.`);
  }
  return v;
}

function int(name, fallback) {
  const raw = process.env[name];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Birden fazla isimden ilk DOLU değeri okur (yeni env adı + eski ad).
 * Böylece proje yeni CFX_* adlarıyla da, eski FIVEM_* adlarıyla da çalışır.
 */
function firstEnv(...names) {
  for (const n of names) {
    const v = (process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
}

/** Birden fazla isimden ilk geçerli tam sayıyı döner. */
function intAny(names, fallback) {
  for (const n of names) {
    const raw = process.env[n];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const v = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

/** Virgülle ayrılmış Discord rol ID listesi (geçersiz girdiler atlanır, tekrarlar silinir). */
function idList(name) {
  const out = [];
  for (const part of String(process.env[name] || '').split(',')) {
    const v = part.trim();
    if (!v) continue;
    if (/^\d{17,20}$/.test(v)) {
      if (!out.includes(v)) out.push(v);
    } else {
      console.warn(`[WARN] .env içinde ${name} alanında geçersiz ID atlandı.`);
    }
  }
  return out;
}

// Sabit staff ticket rolü — tüm ticket kanallarında FULL erişim (View/Read/Send/ManageMessages)
const STAFF_TICKET_ROLE_ID = '1522773972393922730';

// Guard komutlarını kullanabilen rol — TEK ROLE kilitlidir.
// .env'deki GUARD_MANAGER_ROLE_IDS BİLEREK GÖZ ARDI EDİLİR (eski roller geçersizdir).
// Rol koruması (guard/events.js → isSensitiveTarget) aynı listeyi kullanır.
const GUARD_MANAGER_ROLE_ID = '1549823609000820766';

// Guard komutlarını kullanabilecek KULLANICI ID'leri (rol verilemeyen durumlar için).
// DİKKAT: Bu bir istisnadır — normalde rol atanması önerilir.
// .env (GUARD_MANAGER_USER_IDS) virgüllü liste ile ezebilir (virgüllü liste verilirse
// bu sabit tamamen değiştirilir). Administrator/ManageGuild bypass YOKTUR.
const GUARD_MANAGER_USER_IDS_DEFAULT = ['1056585742731726918'];

// Başvuru kabulünde verilen roller — .env (TICKET_ACCEPT_ROLE_IDS) ile değiştirilebilir.
const ACCEPT_ROLE_IDS = ['1522773983588646982', '1522773986721660928'];

const config = {
  botName: 'Javrex Bot System',
  STAFF_TICKET_ROLE_ID,
  GUARD_MANAGER_ROLE_ID,
  // Rol verilemeyen kişiler için istisna listesi (env virgüllü listesi verirse onu kullanır).
  GUARD_MANAGER_USER_IDS: (() => {
    const env = idList('GUARD_MANAGER_USER_IDS');
    return env.length ? env : [...GUARD_MANAGER_USER_IDS_DEFAULT];
  })(),
  ACCEPT_ROLE_IDS,

  // --- Hassas bilgiler (.env) ---
  token: (() => {
    const v = firstEnv('DISCORD_BOT_TOKEN', 'DISCORD_TOKEN');
    if (!v) console.warn('[WARN] .env içinde DISCORD_BOT_TOKEN (veya eski adı DISCORD_TOKEN) tanımlı değil.');
    return v;
  })(),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),

  // Yönetici rolü. Boş bırakılabilir (o zaman Administrator / ManageGuild yetkisi aranır).
  adminRoleId: (process.env.ADMIN_ROLE_ID || '').trim(),

  // --- Yetki rol listeleri (virgüllü rol ID'leri; admin her kapıdan geçer) ---
  roleManagerRoleIds: idList('ROLE_MANAGER_ROLE_IDS'), // /rolver + /rolal
  // Guard komut yetkisi TEK ROLE kilitlidir; GUARD_MANAGER_ROLE_IDS env değeri
  // bilerek göz ardı edilir (eski roller geçersiz). Rol koruması (isSensitiveTarget) aynı listeyi kullanır.
  guardManagerRoleIds: [GUARD_MANAGER_ROLE_ID], // guard komutları (/guardekle, /guardçıkar, /guardliste, /guardsetup)
  banManagerRoleIds: idList('BAN_MANAGER_ROLE_IDS'), // /ban + /unban
  staffRoleIds: (() => {
    const base = idList('STAFF_ROLE_IDS');
    const legacy = (process.env.TICKET_STAFF_ROLE_ID || '').trim(); // geriye uyumluluk
    if (/^\d{17,20}$/.test(legacy) && !base.includes(legacy)) base.push(legacy);
    // Sabit staff ticket rolü HER ZAMAN yetkili — .env'de unutulsa bile
    if (!base.includes(STAFF_TICKET_ROLE_ID)) base.push(STAFF_TICKET_ROLE_ID);
    return base;
  })(), // ekip komutları (ticket/mazeret/ses/setup/komutlarpng)
  // Global komut erişimi: doluysa SADECE bu roller + adminler komut kullanabilir.
  // Boş bırakılırsa kısıtlama yok (geriye uyumluluk).
  globalAllowedRoleIds: idList('BOT_ALLOWED_ROLE_IDS'),

  // --- Yetki mimarisi ---
  // /ingame ve /aktiflik herkes kullanabilsin istiyorsanız null bırakın.
  // Belirli bir rol isterseniz .env'e INGAME_ROLE_ID / AKTIFLIK_ROLE_ID ekleyin.
  permissions: {
    // dmmesaj + clear her zaman yetkilidir (aşağıdaki kontrol + Discord permission).
    // ingame / aktiflik için opsiyonel rol kilidi:
    ingameRoleId: (process.env.INGAME_ROLE_ID || '').trim() || null,
    aktiflikRoleId: (process.env.AKTIFLIK_ROLE_ID || '').trim() || null,
  },

  // --- /clear limitleri ---
  clear: {
    min: int('CLEAR_MIN', 1),
    max: int('CLEAR_MAX', 100), // Discord bulkDelete limiti zaten 100'dür, üstüne çıkarmayın
  },

  // --- /dmmesaj rate-limit ayarı ---
  dm: {
    delayMs: int('DM_DELAY_MS', 200), // paralel grup arası bekleme (ms). 100'ün altına indirmeyin (kod tabanı zorlar).
    concurrency: int('DM_CONCURRENCY', 5), // aynı anda gönderim yapan işçi sayısı (1-10 arası zorlanır)
    // Sadece bu role sahip üyelere DM atılır. Boşsa herkese atılır.
    targetRoleId: (process.env.DM_TARGET_ROLE_ID || '').trim() || null,
    // Büyük sunucularda tek seferde çekilecek üye sayısı için bir üst sınır isterseniz:
    // 0 = sınırsız (tüm üyeler)
    maxTargets: int('DM_MAX_TARGETS', 0),
  },

  // --- Embed renkleri ---
  colors: {
    ingame: 0x2ecc71, // yeşil
    aktiflik: 0x3498db, // mavi
    dm: 0x9b59b6, // mor
    clear: 0xe67e22, // turuncu
    mazeret: 0x1abc9c, // turkuaz
    error: 0xe74c3c, // kırmızı
    success: 0x2ecc71,
    // --- Guard log renkleri (merkezi tema) ---
    guardBan: 0xe74c3c, // kritik/ban
    guardWarn: 0xe67e22, // uyarı
    guardAllowed: 0x2ecc71, // izinli
    guardConfig: 0x3498db, // config
    guardPanel: 0x9b59b6, // panel erişim
  },

  // --- Liste / embed limitleri ---
  // Bir field max 1024 karakter olabilir. Bu sayıdan sonra "+X kişi daha" gösterilir.
  maxMentionsPerField: int('MAX_MENTIONS_PER_FIELD', 40),

  // --- Ticket sistemi ---
  ticket: {
    // Sabit staff rol — env boşsa bile 1522773972393922730 kullanılır (hard-code yasak değil, merkezi constant)
    staffRoleId: (() => {
      const v = (process.env.TICKET_STAFF_ROLE_ID || '').trim();
      if (/^\d{17,20}$/.test(v)) return v;
      return STAFF_TICKET_ROLE_ID;
    })(),
    categoryId: (process.env.TICKET_CATEGORY_ID || '').trim() || null,
    logChannelId: (process.env.TICKET_LOG_CHANNEL_ID || '').trim() || null,
    panelChannelId: (process.env.TICKET_PANEL_CHANNEL_ID || '').trim() || null,
    logEnabled: (process.env.TICKET_LOG_ENABLED || 'true').toLowerCase() !== 'false',
    // Varsayılan panel görseli. /ticketpng ile değiştirilir (DB'deki değer önceliklidir).
    panelImage: (process.env.TICKET_PANEL_IMAGE || '').trim() || null,
    maxOpenPerUser: int('TICKET_MAX_OPEN_PER_USER', 1),
    callCooldownMs: int('TICKET_CALL_COOLDOWN_MS', 300000), // Yetkili Çağır bekleme süresi (5 dk)
    // Yeni ticket açıldığında etiketlenecek rol (boşsa ping atılmaz).
    pingRoleId: (process.env.TICKET_PING_ROLE_ID || '').trim() || null,
    // Açık ticketları salt-okunur görebilecek rol (boşsa ek izin verilmez).
    viewerRoleId: (process.env.TICKET_VIEWER_ROLE_ID || '').trim() || null,
    // Başvuru kabulünde ticket sahibine verilen roller.
    // .env'de TICKET_ACCEPT_ROLE_IDS virgüllü liste olarak ezilebilir.
    acceptRoleIds: (() => {
      const env = idList('TICKET_ACCEPT_ROLE_IDS');
      return env.length ? env : [...ACCEPT_ROLE_IDS];
    })(),
    color: 0x5865f2, // premium blurple
    panelAbout:
      process.env.TICKET_PANEL_ABOUT ||
      'Aşağıdaki seçeneklerden uygun olanı seçerek hemen bir ticket oluşturabilirsiniz.',
    panelInfo:
      process.env.TICKET_PANEL_INFO || 'Sunucumuzun kurallarını okumayı unutmayın.',
    // Kategoriler: key benzersiz olmalı (label ≤100, description ≤100 karakter).
    // Yeni kategori eklemek için listeye satır eklemeniz yeterli.
    // formQuestions doluysa ticket açılışında forma soruları ayrı mesaj olarak gönderilir.
    categories: [
      {
        key: 'basvuru',
        label: 'Başvuru',
        description: 'Başvuru yapmak için seçiniz.',
        emoji: '📄',
        formTitle: '📝 Başvuru Formu',
        formIntro: 'Lütfen aşağıdaki soruları eksiksiz yanıtlayın. Başvurunuz yetkili ekip tarafından incelenecektir.',
        formQuestions: [
          'Yaş:',
          'FiveM Saatiniz:',
          'Legal Rol Yaptınız mı?:',
          'Hangi Ekiplerde Oynadınız?:',
          'Kurallara ve hiyerarşik düzene uyacağınızı onaylıyor musunuz?:',
          'Neden başvurmak istiyorsunuz?:',
          "Saat 21.00'den sonra zorunlu 2 saat aktifliği onaylıyor musunuz? (Discord ses kanalında bulunmak dahil):",
          '5 Kill POV:',
        ],
      },
      { key: 'sikayet', label: 'Sorun & Şikayet', description: 'Sorun veya şikayetinizi bildirmek için seçiniz.', emoji: '⚠️' },
      { key: 'diger', label: 'Diğer Kategoriler', description: 'Sebebiniz listede yoksa bu kategoriyi seçiniz.', emoji: '🐯' },
    ],
  },

  // --- Panel görselleri (opsiyonel banner; boşsa görsel gösterilmez) ---
  // Doğrudan görsel URL'si yazın (https://...png/jpg). Embed'i geniş ve premium gösterir.
  ingamePanelImage: (process.env.INGAME_PANEL_IMAGE || '').trim() || null,
  aktiflikPanelImage: (process.env.AKTIFLIK_PANEL_IMAGE || '').trim() || null,

  // --- IC isim onay kanalı ---
  // Bu kanala yazılan her mesaj için onay paneli açılır (Onayla/Reddet).
  icApprovalChannelId: (process.env.IC_APPROVAL_CHANNEL_ID || '').trim() || null,

  // --- Mazeret sistemi ---
  mazeretCooldownMs: int('MAZERET_COOLDOWN_MS', 300000), // kullanıcı başına bildirim bekleme süresi (5 dk)
  // Mazeret bildirimlerinin düştüğü kanal (boşsa panelin kanalı kullanılır).
  mazeretChannelId: (process.env.MAZERET_CHANNEL_ID || '').trim() || null,
  // Mazeret panel banner görseli (/mazeretpng ile değişir; DB'deki değer önceliklidir).
  mazeretPanelImage: (process.env.MAZERET_PANEL_IMAGE || '').trim() || null,

  // --- Quit (sunucudan ayrılma) logu ---
  quitLogChannelId: (process.env.QUIT_LOG_CHANNEL_ID || '').trim() || null,

  // --- Join (sunucuya katılma) logu — spec: 1533266772633850027 ---
  joinLogChannelId: (() => {
    const v = (process.env.JOIN_LOG_CHANNEL_ID || '').trim();
    if (/^\d{17,20}$/.test(v)) return v;
    return '1533266772633850027';
  })(),

  // --- Yardım menüsü görseli (/komutlarpng ile değişir; DB'deki değer önceliklidir) ---
  komutlarImage: (process.env.KOMUTLAR_IMAGE || '').trim() || null,

  // --- Moderasyon log kanalı (ban/unban kayıtları; boşsa sadece console) ---
  modLogChannelId: (process.env.MOD_LOG_CHANNEL_ID || '').trim() || null,

  // --- Veritabanı ---
  // Çözümleme sırası:
  //   1) DB_PATH (elle, en güçlü)
  //   2) Railway volume mount yolu (RAILWAY_VOLUME_MOUNT_PATH veya /data) — kalıcı disk
  //   3) Lokal varsayılan
  // PaaS (Railway) dosya sistemi GEÇİCİDİR: volume mount edilmezse her
  // deploy'da DB sıfırlanır (ticket/guard/whitelist kayıtları gider).
  dbPath: (() => {
    const explicit = (process.env.DB_PATH || '').trim();
    if (explicit) return explicit;

    // Railway volume: RAILWAY_VOLUME_MOUNT_PATH her mount'ta otomatik gelir.
    const mount = (process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
    if (mount) return path.join(mount, 'wellsd.db');

    // RAILWAY_ENVIRONMENT varsa ama mount yoksa uyarı ver (veri kaybı riski).
    if ((process.env.RAILWAY_ENVIRONMENT || '').trim()) {
      console.warn('[WARN] Railway tespit edildi ama DB_PATH tanımlı değil ve volume mount yolu yok.');
      console.warn('[WARN] Veriler her deploy\'da silinecek. Railway → Volume ekleyip mount path = /data yapın.');
    }
    return './data/wellsd.db';
  })(),

  // --- FiveM canlı oyuncu sorgu ---
  // Oyuncu verisi sunucu sahibinin izin verdiği kanaldan okunur. Öncelik sırası
  // service.js içinde tanımlıdır: local bridge → HTTP (X-Players-Token) → RCON → anonim.
  // CFX ID sadece metadata'dır (footer/link); oyuncu verisi için kullanılmaz, HTML scraping yoktur.
  fivem: {
    cfxId: (process.env.FIVEM_CFX_ID || '8emv3b3').trim() || '8emv3b3',
    // Ana oyun sunucusu host/port. Kodun hiçbir yerinde IP:port hard-code YOKTUR —
    // tek kaynak burasıdır.
    host: firstEnv('CFX_HOST', 'FIVEM_SERVER_HOST') || '5.231.120.202',
    port: (() => {
      const n = intAny(['CFX_PORT', 'FIVEM_SERVER_PORT'], 30120);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 30120;
    })(),
    // Tam adres override (en yüksek öncelik). Örn: FIVEM_SERVER_ENDPOINT=http://85.104.10.20:30120
    endpoint: (process.env.FIVEM_SERVER_ENDPOINT || '').trim() || null,
    // Connect endpoint primary'den farklıysa fallback adayı (örn. proxy arkası kurulumlar).
    // Boşsa kullanılmaz; rastgele fallback YOKTUR.
    connectEndpoint: (process.env.FIVEM_CONNECT_ENDPOINT || '').trim() || null,
    // sv_playersToken kullanılıyorsa istekler X-Players-Token header ile imzalanır.
    // Token ASLA loga/URL'e/embed'e yazılmaz.
    playersToken: firstEnv('CFX_PLAYERS_TOKEN', 'FIVEM_PLAYERS_TOKEN') || null,
    // Tek HTTP isteği zaman aşımı (ms, 2000-30000). Önerilen: 5000-8000.
    apiTimeoutMs: (() => {
      const n = int('FIVEM_API_TIMEOUT_MS', 7000);
      return Math.min(30000, Math.max(2000, n));
    })(),
    // Genel kaynak önbellek ömrü (ms). Komutlar "canlı"dır; uzun tutmayın.
    cacheTtlMs: (() => {
      const n = int('FIVEM_CACHE_TTL_MS', 4000);
      return Math.min(30000, Math.max(1000, n));
    })(),
    // Oyuncu listesi önbellek ömrü (ms) — daha kısa tutulur.
    playersCacheTtlMs: (() => {
      const n = int('FIVEM_PLAYERS_CACHE_TTL_MS', 3000);
      return Math.min(30000, Math.max(1000, n));
    })(),
    // --- Local bridge (fivem-local-bridge paketi, AYNI makinede) ---
    // URL doluysa en yüksek öncelikli kaynaktır. Boşsa kapalıdır.
    localBridge: {
      url: (process.env.FIVEM_LOCAL_BRIDGE_URL || '').trim() || null,
      key: (process.env.FIVEM_LOCAL_BRIDGE_KEY || '').trim() || null,
      timeoutMs: (() => {
        const n = int('FIVEM_LOCAL_BRIDGE_TIMEOUT_MS', 3000);
        return Math.min(15000, Math.max(1000, n));
      })(),
    },
    // --- FiveM RCON (UDP) ---
    // Parola ASLA koda yazılmaz; sadece FIVEM_RCON_PASSWORD env'den okunur.
    // Host/port boş bırakılırsa ana oyun sunucusuna (FIVEM_SERVER_HOST/PORT) düşer.
    rcon: {
      host: firstEnv('FIVEM_RCON_HOST', 'CFX_HOST', 'FIVEM_SERVER_HOST') || '5.231.120.202',
      port: (() => {
        const n = intAny(['FIVEM_RCON_PORT', 'CFX_PORT', 'FIVEM_SERVER_PORT'], 0) || 30120;
        return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 30120;
      })(),
      // Boşsa RCON kapalı sayılır (FiveM: rcon_password yoksa RCon devre dışı).
      password: (process.env.FIVEM_RCON_PASSWORD || '').trim() || null,
      // Tek istek zaman aşımı (ms, 2000-15000). UDP'dir; kayıp pakette retry olur.
      timeoutMs: (() => {
        const n = int('FIVEM_RCON_TIMEOUT_MS', 5000);
        return Math.min(15000, Math.max(2000, n));
      })(),
      // status yanıtı önbelleği (ms, 1000-10000). Kısa tutulur (canlı veri).
      cacheTtlMs: (() => {
        const n = int('FIVEM_RCON_CACHE_TTL_MS', 2500);
        return Math.min(10000, Math.max(1000, n));
      })(),
    },
    // Ardışık oyun-sunucusu istekleri arası bekleme (ms). Burst korumalı
    // sunucularda art arda istekler IP bloklatabildiği için konur (0 kapatır).
    requestGapMs: (() => {
      const n = int('FIVEM_REQUEST_GAP_MS', 500);
      return Math.min(5000, Math.max(0, n));
    })(),
    // Başarısız sorgu negatif önbelleği (ms). OFFLINE/ERROR sonucu bu süre boyunca
    // SUNUCUYA TEKRAR SORULMADAN aynı mesajla döner — komut spam'i blok süresini
    // uzatamaz. Kullanıcıya gösterilen mesaj değişmez (dürüst hata).
    negCacheMs: (() => {
      const n = int('FIVEM_NEG_CACHE_MS', 15000);
      return Math.min(60000, Math.max(5000, n));
    })(),
    // --- Arka plan yoklama aralığı (ms) ---
    // Kaç ms'de bir sunucu durumu/oyuncu verisi yenilenecek. Panel varsa panel
    // bu aralıkla güncellenir (yeni mesaj atılmaz). Varsayılan 30 sn.
    pollIntervalMs: (() => {
      const n = intAny(['CFX_POLL_INTERVAL_MS', 'CFX_POLL_INTERVAL', 'FIVEM_POLL_INTERVAL_MS'], 30000);
      return Math.min(600000, Math.max(5000, n));
    })(),
    // Otomatik panel güncelleme: spam YAPMAZ, mevcut mesajı düzenler.
    panel: {
      enabled: (firstEnv('FIVEM_PANEL_ENABLED') || 'true').toLowerCase() !== 'false',
      // Panel mesajının tutulduğu kanal. Boşsa otomatik güncelleme yapılmaz.
      channelId: firstEnv('FIVEM_PANEL_CHANNEL_ID', 'CFX_PANEL_CHANNEL_ID') || null,
      // Mevcut panel mesajının ID'si (bot yeniden başlasa da aynı mesaj güncellenir).
      messageId: firstEnv('FIVEM_PANEL_MESSAGE_ID', 'CFX_PANEL_MESSAGE_ID') || null,
    },

    // --- YÖNTEM C: Sunucu resource bridge (push) ---
    // Sunucudaki Lua resource oyuncu listesini buraya POST eder. Secret YALNIZCA
    // sunucu tarafında tutulur; loglara/Discord'a yazılmaz.
    bridge: {
      secret: firstEnv('FIVEM_BRIDGE_SECRET', 'CFX_BRIDGE_SECRET') || null,
      // Bu süreden eski snapshot "bayat" sayılır ve güncelmiş gibi gösterilmez.
      maxAgeMs: (() => {
        const n = intAny(['FIVEM_BRIDGE_MAX_AGE_MS'], 120000);
        return Math.min(3600000, Math.max(15000, n));
      })(),
      // Güvenlik sınırları
      maxPlayers: (() => {
        const n = intAny(['FIVEM_BRIDGE_MAX_PLAYERS'], 1024);
        return Math.min(4096, Math.max(1, n));
      })(),
      // İstek gövdesi üst sınırı (bayt) — 1024 oyuncu için yeterli.
      bodyLimit: (() => {
        const n = intAny(['FIVEM_BRIDGE_BODY_LIMIT'], 512 * 1024);
        return Math.min(4 * 1024 * 1024, Math.max(4096, n));
      })(),
      // Dakika başına kabul edilecek istek sayısı (aşılırsa 429).
      rateMax: (() => {
        const n = intAny(['FIVEM_BRIDGE_RATE_MAX'], 30);
        return Math.min(600, Math.max(1, n));
      })(),
    },

    pageSize: 10, // pagination: sayfa başına oyuncu
    sessionTtlMs: 10 * 60 * 1000, // pagination buton oturumu ömrü
  },

  // --- Web Transcript Server ---
  web: {
    enabled: (process.env.WEB_ENABLED || 'true').toLowerCase() !== 'false',
    // Railway PORT env'ini de destekle (PaaS otomatik port)
    port: (() => {
      const p = int('WEB_PORT', 0);
      if (p) return p;
      const railway = int('PORT', 0);
      return railway || 3000;
    })(),
    host: (process.env.WEB_HOST || '0.0.0.0').trim() || '0.0.0.0',
    baseUrl: (() => {
      const explicit = (process.env.WEB_URL || '').trim();
      if (explicit) return explicit;
      const railwayDomain = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
      if (railwayDomain) return `https://${railwayDomain}`;
      const railwayStatic = (process.env.RAILWAY_STATIC_URL || '').trim();
      if (railwayStatic) return railwayStatic;
      return null;
    })(),
    trustProxy: int('WEB_TRUST_PROXY', 1),
  },
};

module.exports = config;
