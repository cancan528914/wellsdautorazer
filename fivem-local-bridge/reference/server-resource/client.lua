-- REFERENCE ONLY — sunucu sahibinin kurması gerekir (ana çözüm DEĞİL).
-- Mantık: 2 saniyede bir aktif oyuncuları topla, localhost bridge'e POST et.
-- Gerekli natives: GetActivePlayers, GetPlayerServerId, GetPlayerName, GetPlayerPing.

local BRIDGE_URL = 'http://127.0.0.1:37911/ingest'
local BRIDGE_KEY = 'BURAYA_BRIDGE_ANAHTARI' -- data/.bridge-key içindeki değer
local TICK_MS = 2000

local function collect()
  local out = {}
  for _, pid in ipairs(GetActivePlayers()) do
    local sid = GetPlayerServerId(pid)
    if sid and sid > 0 then
      local okName, name = pcall(GetPlayerName, pid)
      local okPing, ping = pcall(GetPlayerPing, pid)
      out[#out + 1] = {
        id = sid,
        name = (okName and name) or 'Bilinmeyen',
        ping = (okPing and ping and ping >= 0) and math.floor(ping) or nil,
      }
    end
  end
  return out
end

CreateThread(function()
  while true do
    Wait(TICK_MS)
    local ok, err = pcall(function()
      local players = collect()
      PerformHttpRequest(BRIDGE_URL, function() end, 'POST', json.encode({ players = players }), {
        ['Content-Type'] = 'application/json',
        ['X-Bridge-Key'] = BRIDGE_KEY,
      })
    end)
    if not ok then print('[bridge-push] hata: ' .. tostring(err)) end
  end
end)
