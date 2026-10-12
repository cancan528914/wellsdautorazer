--[[
  YONTEM C — Sunucu tarafi kopru (server-side bridge)

  Gorev: aktif oyuncu listesini OKUYUP botun HTTPS API'sine GONDERMEK.
  Bu kod YALNIZCA sunucuda calisir (client_script yoktur).

  GONDERILEN ALANLAR (yalnizca bunlar):
    serverId : FiveM server ID (oturuma ozgudur, kalici kimlik DEGILDIR)
    name     : oyuncu adi
    ping     : gecikme (ms)

  GONDERILMEYENLER (bilincli olarak disarida birakilir):
    - IP adresi / endpoint  : GetPlayerEndpoint() HICIR CAGRILMAZ
    - license / steam / rockstar identifier : GetPlayerIdentifiers() HICIR CAGRILMAZ
    - Discord hesabi       : hicbir sekilde okunmaz

  Bu bir gizlilik kararidir: hassas identifier'lar sunucu disina tasinmaz.
--]]

local RESOURCE = GetCurrentResourceName()

-- ============================ YARDIMCILAR ============================

--- JSON string kacisi (FiveM tarafinda hazir kutuphane yok).
local function jsonEscape(s)
  if type(s) ~= 'string' then s = tostring(s or '') end
  s = s:gsub('\\', '\\\\')
  s = s:gsub('"', '\\"')
  s = s:gsub('\n', '\\n')
  s = s:gsub('\r', '\\r')
  s = s:gsub('\t', '\\t')
  -- Kontrol karakterlerini ve BOM/zero-width gibi tuzakleri at.
  s = s:gsub('[%z\1-\31]', '')
  return s
end

--- Girilen degerleri guvenli sekilde JSON dizisine cevirir.
local function buildPayload()
  local players = GetPlayers() -- "serverId\x20name" listesi
  local allowed = Config.AllowedIdentifiers
  local out = {}

  for i = 1, #players do
    local raw = players[i]
    -- "12\x20Ali Veli" -> serverId=12, name="Ali Veli"
    local sid, name = string.match(raw, '^([^ ]+)%s(.+)$')
    if not sid then
      sid = string.match(raw, '^([^ ]+)$')
      name = sid
    end

    local serverId = tonumber(sid)
    if serverId and name and name ~= '' then
      -- Guild filtresi tanimliysa kontrol et (veri disari cikmadan once).
      local include = true
      if allowed and #allowed > 0 then
        include = false
        local ids = GetPlayerIdentifiers(serverId) or {}
        for _, id in ipairs(ids) do
          for _, allow in ipairs(allowed) do
            if id == allow then include = true break end
          end
          if include then break end
        end
      end

      if include then
        local ping = GetPlayerPing(serverId)
        if not ping or ping < 0 then ping = 0 end
        out[#out + 1] = string.format(
          '{"serverId":%d,"name":"%s","ping":%d}',
          serverId, jsonEscape(name), tonumber(ping) or 0
        )
      end
    end
  end

  return '{"players":[' .. table.concat(out, ',') .. ']}'
end

--- Baglanti acilisindaki geri cekilme (backoff) hesabi.
--  Hata arttikca bekleme 2s,4s,8s ... 60sn tavanda kalir.
local FAIL_STREAK = 0
local function nextDelay()
  local base = Config.IntervalMs or 15000
  if FAIL_STREAK <= 0 then return base end
  local d = base * (2 ^ math.min(FAIL_STREAK, 4)) -- 1x,2x,4x,8x,16x
  return math.min(d, 60000)
end

local function log(fmt, ...)
  local msg = string.format(fmt, ...)
  print(('[%s] ' .. msg):format(RESOURCE))
end

local function logErr(fmt, ...)
  local msg = string.format(fmt, ...)
  print(('^1[%s] ' .. msg .. '^7'):format(RESOURCE))
end

local LAST_SENT_PAYLOAD = nil

-- ============================ GONDERIM ============================

local function send()
  -- Yapilandirma kontrolu: yarim kalan kurulum sessizce calismasin.
  if not Config.Endpoint or Config.Endpoint == '' or string.find(Config.Endpoint, 'BOT%-ADRESINIZ') then
    logErr('Config.Endpoint ayarlanmamis. resource devre disi.')
    return
  end
  if not Config.Secret or #Config.Secret < 32 then
    logErr('Config.Secret eksik veya cok kisa (en az 32 karakter). resource devre disi.')
    return
  end

  local payload = buildPayload()

  -- Sadece degisince gonder modu
  if Config.OnlyOnChange and payload == LAST_SENT_PAYLOAD then
    if Config.Debug then log('degisiklik yok, atlandi.') end
    return
  end

  local headers = {
    ['Content-Type'] = 'application/json',
    ['X-Bridge-Secret'] = Config.Secret,
    ['User-Agent'] = 'Javrex-FiveM-Bridge/1.0',
  }

  PerformHttpRequest(
    Config.Endpoint,
    'POST',
    payload,
    headers,
    function(status, responseText, responseHeaders)
      -- CEVAP GOVDESI LOGLANMAZ: sunucu sadece saya dondurur, veri icermez.
      local code = tonumber(status) or 0

      if code >= 200 and code < 300 then
        FAIL_STREAK = 0
        LAST_SENT_PAYLOAD = payload
        if Config.Debug then log('veri gonderildi (HTTP %d).', code) end
        return
      end

      FAIL_STREAK = FAIL_STREAK + 1

      if code == 401 or code == 403 then
        logErr('Yetkilendirme basarisiz (HTTP %d). Config.Secret ile bot tarafindaki FIVEM_BRIDGE_SECRET ayni mi?', code)
      elseif code == 413 then
        logErr('Govde cok buyuk (HTTP 413). Sunucu capacity azaltin veya oyuncu sayisi yuksek.')
      elseif code == 429 then
        logErr('Hiz limiti (HTTP 429). Config.IntervalMs degerini ARTIRIN.')
      elseif code == 503 then
        logErr('Bot tarafi bridge yapilandirilmamis (HTTP 503). Bot .env icinde FIVEM_BRIDGE_SECRET tanimlamali.')
      else
        logErr('Gonderim basarisiz (HTTP %d).', code)
      end

      if Config.Debug then
        logErr('bot yaniti: %s', tostring(responseText or '(bos)'):sub(1, 200))
      end
    end
  )
end

-- ============================ YASAM DONGUSU ============================

AddEventHandler('onResourceStart', function(resource)
  if resource ~= RESOURCE then return end
  print(('=' * 60))
  print(('[%s] JAVREX FIVE-M BRIDGE baslatildi'):format(RESOURCE))
  print(('[%s] Endpoint : %s'):format(RESOURCE, tostring(Config.Endpoint)))
  print(('[%s] Secret   : %s (uzunluk %d)'):format(RESOURCE,
    (Config.Secret and #Config.Secret >= 32) and 'TANIMLI' or 'TANIMLI DEGIL',
    #tostring(Config.Secret or '')))
  print(('[%s] Aralik   : %d ms'):format(RESOURCE, Config.IntervalMs or 15000))
  print(('[%s] Gonderilen alanlar: serverId, name, ping'):format(RESOURCE))
  print(('[%s] Gonderilmeyenler  : IP, license, steam, rockstar'):format(RESOURCE))
  print(('=' * 60))

  if not Config.Secret or #Config.Secret < 32 then
    logErr('Secret tanimli degil veya cok kisa. Bot veri ALAMAZ. config.lua kontrol et.')
    return
  end

  -- Sunucu bossa veya FiveM cok yavas aciliyorsa ilk gonderimi ertele.
  SetTimeout(3000, function()
    send()
    while true do
      Wait(nextDelay())
      send()
    end
  end)
end)

-- Sunucu kapanirken son bir gonderi denemesi (best-effort).
AddEventHandler('onResourceStop', function(resource)
  if resource ~= RESOURCE then return end
  log('durduruldu.')
end)