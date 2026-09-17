/**
 * WELLSD AUTORAZER - Merkezi konfigürasyon
 * Tüm değiştirilebilir değerler buradan yönetilir. Hassas veriler .env'den okunur.
 * Hard-code ID KULLANMAYIN - her şeyi .env üzerinden değiştirin.
 */

require('dotenv').config();

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

const config = {
  botName: 'WELLSD AUTORAZER',
  STAFF_TICKET_ROLE_ID,

  // --- Hassas bilgiler (.env) ---
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),

  // Yönetici rolü. Boş bırakılabilir (o zaman Administrator / ManageGuild yetkisi aranır).
  adminRoleId: (process.env.ADMIN_ROLE_ID || '').trim(),

  // --- Yetki rol listeleri (virgüllü rol ID'leri; admin her kapıdan geçer) ---
  roleManagerRoleIds: idList('ROLE_MANAGER_ROLE_IDS'), // /rolver + /rolal
  guardManagerRoleIds: idList('GUARD_MANAGER_ROLE_IDS'), // guard komutları
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
  dbPath: process.env.DB_PATH || './data/wellsd.db',

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
