--[[
  YONTEM C — Sunucu tarafi yapilandirma (config.lua)

  BU DOSYA SUNUCUDA KALIR. config.lua icerigi (ozellikle SECRET) herkese acik
  bir dosyaya KOYULMAZ ve git'e COMMITLENMEZ (.gitignore'a ekli).

  Kurulum:
    1. Bu dosyayi `config.example.lua` olarak kopyalayin:  config.lua
    2. Asagidaki degerleri kendi bilgilerinizle doldurun.
    3. Bot tarafindaki .env icine AYNI secret'i yazin:  FIVEM_BRIDGE_SECRET
    4. Botunuzun API adresi size soylenmelidir (örn: https://bot-ornek.com)

  Guvenli secret uretmek:
    PowerShell : [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
    Node.js   : require('crypto').randomBytes(32).toString('hex')
    Linux     : openssl rand -hex 32

  UYARI: Bu dosyayi ekran goruntusu / video ile paylasmayin.
--]]

Config = {}

-- Botun API adresi. ENGLISH: sonunda /api/fivem/players YAZILIR.
--   Ornek: Config.Endpoint = 'https://bot-ornek.com/api/fivem/players'
--   NOT: Bot "WEB_URL" ayarindaki adresi kullanir (https://... tercih edilir).
Config.Endpoint = 'https://BOT-ADRESINIZ-BURAYA/api/fivem/players'

-- Paylasilan gizli anahtar. Bot tarafindaki FIVEM_BRIDGE_SECRET ile AYNI olmali.
-- EN AZ 32 karakter rastgele olmalidir. Bos birakilirsa resource calisir ama
-- bot istekleri reddeder.
Config.Secret = 'BURAYA-32-KARAKTERLIK-RANDOM-SECRET-DEGERI'

-- Gonderim araligi (ms). Cok kisa secmeyin: bot tarafi rate-limit uygular.
-- Varsayilan 15 saniye. Minimum 5000.
Config.IntervalMs = 15000

-- Sunucu sadece bu guild'e ait oyuncularin listesini gonderir (bos = tumu).
-- Birden fazla guild icin virgulle ayirin: { 'discord:123', 'steam:456' }
Config.AllowedIdentifiers = {}

-- Sadece oyuncu sayisi degisince gonder (true) = tasarruf, false = her aralikte.
-- false daha guvenlidir; bot "guncel" sayar. Varsayilan: false
Config.OnlyOnChange = false

-- Istek zaman asimi (ms). PerformHttpRequest icin kullanilir.
Config.TimeoutMs = 10000

-- Hata ayiklama: true ise konsola ek bilgi yazar (oyuncu verisi YAZMAZ).
Config.Debug = false

-- Sunucu adi etiketi (istege bagli). Bos birakilirsa otomatik kullanilir.
Config.ServerTag = nil