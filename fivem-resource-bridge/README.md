# JAVREX FIVE-M BRIDGE (Yöntem C)

Bu, **FiveM sunucusuna kurulan** bir resource'tir. Aktif oyuncu listesini
sunucu tarafında okur ve Discord botunun HTTPS API'sine gönderir.

> **Bu, gizlilik kontrollerini aşan bir yöntem DEĞİLDİR.** Yalnızca sunucu
> sahibi bu resource'i kendi sunucusuna kurarak izin vermiş olur.

## Neden gerekli?

Bu sunucuda `/players.json` yanıtı **anonimleştirilmiş** (her kayıt `id=0`,
ad `Player`). Bu resource, veriyi sunucu içinden okuyup ayrı bir yetkili
kanaldan aktarır.

## Ne gönderilir / ne gönderilmez

| | Alan | Neden |
|---|---|---|
| ✅ | `serverId` | FiveM server ID (oturuma özgüdür, **kalıcı kimlik değildir**) |
| ✅ | `name` | Oyuncu adı |
| ✅ | `ping` | Gecikme |
| ❌ | IP adresi / endpoint | `GetPlayerEndpoint()` hiç çağrılmaz |
| ❌ | license / steam / rockstar identifier | `GetPlayerIdentifiers()` sadece guild filtresi için kullanılır, **gönderilmez** |
| ❌ | Discord hesabı | hiç okunmaz |

## Kurulum (sunucu sahibi)

### 1. Dosyaları kopyalayın

Bu klasörün tamamını sunucunuzun `resources/` klasörüne kopyalayın:

```
resources/
  [Javrex]/           <-- fxmanifest.lua'nin olduğu yer
    fxmanifest.lua
    config.lua
    server/sv_bridge.lua
```

### 2. `config.lua` oluşturun

`config.example.lua` dosyasını `config.lua` olarak kopyalayın ve düzenleyin:

```lua
Config.Endpoint = 'https://BOT-ADRESINIZ/api/fivem/players'
Config.Secret   = '32+ KARAKTERLIK RASTGELE GIZLI DEGER'
Config.IntervalMs = 15000
```

Güvenli secret üretin:
```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

### 3. Bot tarafına aynı secret'i verin

Botun `.env` dosyasına:
```
FIVEM_BRIDGE_SECRET=<config.lua ile AYNI değer>
```

> `FIVEM_BRIDGE_SECRET` **boşsa** bot tarafındaki endpoint 503 döner ve resource
> "bot yapılandırılmamış" hatası gösterir. Bu bilinçlidir.

### 4. Botun internete açık olduğundan emin olun

Bot, dışarıdan erişilebilir bir **HTTPS** adresinden sunulmalıdır (reverse
proxy önerilir). Botun `.env` içinde `WEB_URL` ayarlıysa o adresi kullanın.

### 5. Resource'i başlatın

`server.cfg`:
```
ensure [Javrex]
```
veya konsoldan:
```
start [Javrex]
```

## Çalışma kontrolü

Konsolda şunu görmelisiniz:
```
[Javrex-fivem-bridge] JAVREX FIVE-M BRIDGE baslatildi
[Javrex-fivem-bridge] Endpoint : https://.../api/fivem/players
[Javrex-fivem-bridge] Secret   : TANIMLI (uzunluk 64)
[Javrex-fivem-bridge] Aralik   : 15000 ms
```

Sonra Discord'da `/sunucudurum` çalıştırın. Veri kaynağı
`Resource bridge` olarak görünmelidir.

## Sorun giderme

| Belirti | Sebep | Çözüm |
|---|---|---|
| `HTTP 401/403` | Secret'lar eşleşmiyor | İki taraftaki secret'ı karşılaştırın (uzunluk + karakter) |
| `HTTP 503` | Bot tarafında `FIVEM_BRIDGE_SECRET` boş | Bot `.env`'i doldurun ve botu yeniden başlatın |
| `HTTP 413` | Gövde limiti aşıldı | Oyuncu sayısı çok yüksek; nadiren olur |
| `HTTP 429` | Çok sık gönderim | `Config.IntervalMs` değerini **artırın** |
| Veri geliyor ama `/oyuncular` boş | Snapshot bayat | `FIVEM_BRIDGE_MAX_AGE_MS` değerini artırın |
| Hiç gönderim yok | Endpoint yazılmamış | `Config.Endpoint` içinde `BOT-ADRESINIZ` kalıntısı olmamalı |

## Sıfırlama

Bot tarafındaki hafıza bot yeniden başlatılınca sıfırlanır. Bu **kasıtlıdır**:
eski veri "güncel" gibi gösterilmez. Resource çalışmaya devam ediyorsa yeni
veri 15 saniye içinde tekrar gelir.