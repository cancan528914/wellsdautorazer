# Javrex Bot System

## 🎉 Çekiliş Sistemi (`/çekiliş`)

Ödüllü çekiliş başlatır (sadece yetkililer: admin veya staff rolü).
Katılım paneldeki 🎉 tepkisiyle olur; süre bitince kazananlar otomatik seçilir.
Bot yeniden başlasa bile aktif çekilişler veritabanından devam eder.

### Kullanım

`/çekiliş ödül:<metin> süre:<süre> kazanan:<sayı> limit:<sayı> rol:<@rol>`

| Alan | Zorunlu | Açıklama |
|---|---|---|
| `ödül` | Evet | Ödül metni (örn. `BTC ARAÇ`) |
| `süre` | Evet | Aşağıdaki formatlardan biri |
| `kazanan` | Hayır (1) | Kazanan sayısı (1-20) |
| `limit` | Hayır (0) | Kişi sınırı (`0` = sınırsız) |
| `rol` | Hayır | Katılabilecek rol (boş = herkes) |

### Desteklenen süre formatları

`30s` (saniye) • `5m` (dakika) • `2h` (saat) • `3d` (gün)

Türkçe karşılıklar da geçerlidir: `sn`, `saniye`, `dk`, `dakika`, `saat`, `gün`.
Boşluk bırakılabilir (`3 gün`). En az 30 saniye, en fazla 30 gün.

### Davranış

- Katılım ve ayrılma 🎉 tepkisiyle olur; paneldeki sayaç otomatik güncellenir.
- Rol şartı ve kişi sınırı hem girişte hem çekiliş anında denetlenir.
- Süre dolunca kazananlar rastgele seçilir, sonuç mesajı mention ile duyurulur.
- Sonuç mesajındaki 🔄 Reroll butonu (sadece yetkililer) eski kazananlar hariç yeniden çeker.

---

## 🎮 FiveM ID Botu

Discord üzerinden FiveM sunucusunun **aktif oyuncularını ve FiveM Server ID**
bilgilerini gösterir.

> **FiveM Server ID kalıcı bir kimlik DEĞİLDİR.** Oyuncu her bağlanışta yeni
> bir ID alır. Kalıcı kimlik (license/steam/rockstar) **okunmaz ve saklanmaz**;
> oyuncu IP adresleri de hiçbir aşamada toplanmaz.

### Komutlar

| Komut | Açıklama |
|---|---|
| `/oyuncular` | Aktif oyuncuları ID, ad ve ping ile listeler (sayfalı). |
| `/idbul isim:<metin>` | Aktif oyuncular arasında ada göre arama (Türkçe İ/ı duyarlı). |
| `/sunucudurum` | Sunucu erişimi, oyuncu sayısı, veri kaynağı (herkese açık). |
| `/id id:<sayı>` | Verilen Server ID aktif mi diye sorgular. |
| `/fivemstatus` | Derin teşhis: A/B/C durumu, katmanlar, token, bridge (sadece yetkililer, ephemeral). |
| `/aktifoyuncular`, `/tag` | Eski adlar — aynı komutlara devreder. |

Uzun listeler sayfalanır; sayfa değiştirmek **yeni istek yapmaz**. Butonlara
yalnızca komutu kullanan kişi basabilir.

### Erişim yöntemleri ve otomatik seçim

Bot aşağıdaki sırayla dener ve **yalnızca gerçekten doğruladığı** veriyi kullanır:

| # | Yöntem | Gereken ayar | Durum |
|---|---|---|---|
| 1 | **Yöntem B** — yetkili HTTP (`X-Players-Token`) | `CFX_PLAYERS_TOKEN` | ⏳ Bekliyor |
| 2 | **Yöntem C** — sunucu resource bridge | `FIVEM_BRIDGE_SECRET` | ⏳ Bekliyor |
| — | RCON (UDP) — sunucu sahibi izni | `FIVEM_RCON_PASSWORD` | ⏳ Bekliyor |
| 3 | **Yöntem A** — public HTTP | — | ✅ **Çalışıyor** (isimler gizli) |

Hiçbir yetkili yöntem tanımlı değilse bot **sahte oyuncu üretmez**; durumu
`🔒 Oyuncu listesi anonimleştirilmiş` olarak bildirir ve sunucu sahibinden ne
gerektiğini kullanıcıya gösterir.

### Yöntem A — public HTTP (her zaman açık)

`/info.json` ve `/dynamic.json` herkese açıktır: **oyuncu sayısı, sunucu adı ve
kapasite** doğrulanabilir. `/players.json` ise bu sunucuda anonimleştirilmiş
gelir (her kayıt `id=0`, ad `Player`).

Bot yanıtları şu şekilde **birbirinden ayırır** — hepsi "timeout" sayılmaz:

| Durum | HTTP | Anlamı |
|---|---|---|
| `ok` | 200 + geçerli veri | Gerçek veri |
| `forbidden` | 403 **veya** 200 + `Nope.` | `sv_requestParanoia` — istek reddedildi |
| `not_found` | 404 | Yanlış port / endpoint kapalı |
| `rate_limited` | 429 | Hız limiti |
| `server_error` | 5xx | Sunucu hatası |
| `invalid_json` | 200 + bozuk gövde | Beklenmeyen format |
| `empty_body` | 200 + boş gövde | Endpoint erişilebilir, içerik yok |
| `timeout` / `connection_refused` / `dns_error` / `unreachable` / `connection_reset` | — | **OFFLINE** |

Anonimleştirme ayrıca tespit edilir: kayıtların tamamı `id=0` + `Player` ise
sonuç `ANONYMIZED` olur — **karışık yanıtta bile** `id=0` kayıtları gerçek
oyuncu gibi listelenmez.

### Yöntem B — `sv_playersToken` ile yetkili erişim

**Sunucu sahibi** `server.cfg` dosyasına:
```
set sv_playersToken <gizli-bir-deger>
```
**Bot tarafında** `.env` dosyasına **aynı değeri** yazın:
```
CFX_PLAYERS_TOKEN=<gizli-bir-deger>
```
Token yalnızca `X-Players-Token` **header**’ında gönderilir; URL’ye konmaz,
loglanmaz, Discord mesajlarında gösterilmez. Yanlış token veya sunucu tarafında
tanımlı değilse bot bunu açıkça raporlar — gizlilik kontrolü aşılmaya çalışılmaz.

### Yöntem C — FiveM sunucu resource bridge

Sunucu sahibi `fivem-resource-bridge/` klasörünü sunucusunun `resources/` klasörüne
kopyalar. Resource **yalnız sunucu tarafında** çalışır (client script yoktur) ve
her oyuncu için yalnızca `serverId`, `name`, `ping` gönderir.

**Gönderilmeyenler:** IP adresi (`GetPlayerEndpoint` hiç çağrılmaz), license /
steam / rockstar identifier, Discord hesabı.

Bot tarafı endpoint: `POST /api/fivem/players`

| Güvenlik önlemi | Uygulama |
|---|---|
| Paylaşımlı secret | `FIVEM_BRIDGE_SECRET`, yalnız sunucu tarafında |
| Token doğrulama | `crypto.timingSafeEqual` (zamanlama-güvenli) |
| İstek boyutu sınırı | `express.raw` limiti + `maxPlayers` kırpma |
| Timeout | 15 sn yanıt süresi sınırı |
| Rate-limit | dakikada istek sınırı, aşılırsa 429 |
| Geçersiz JSON | ayrı parse + 400 |
| Yetkisiz istek | 401, sır sızdırmadan |
| Hassas veri loglanmaz | yalnız HTTP durumu + sayaç |

Resource veriyi gönderemezse bot **son başarılı veriyi güncelmiş gibi göstermez**:
`FIVEM_BRIDGE_MAX_AGE_MS` (varsayılan 2 dk) aşılınca snapshot **bayat** işaretlenir
ve bot diğer kaynaklara düşer.

Ayrıntılı kurulum: [`fivem-resource-bridge/README.md`](fivem-resource-bridge/README.md)

### Canlı panel (spam yok)

`FIVEM_PANEL_CHANNEL_ID` verilirse bot, veriyi `CFX_POLL_INTERVAL_MS` aralığıyla
**tek bir mesajı güncellerek** gösterir — her turda yeni mesaj göndermez.
Mesajın ID’si kalıcı dosyada tutulur, bot yeniden başlasa da aynı mesaj güncellenir.
Panel; veri kaynağını, son güncelleme zamanını ve bayatlık durumunu gösterir.

### Hata yönetimi

- Ağ hataları `OFFLINE`, diğerleri `ERROR` olarak **ayrı raporlanır** (detay eşlemesi yukarıda).
- Başarısız sonuçlar **negatif önbelleğe** alınır (varsayılan 15 sn): komut spam’ı sunucuyu zorlamaz.
- Eşzamanlı istekler **birleştirilir**: 10 kullanıcı aynı anda sorarsa sunucuya tek istek gider.
- Timeout’ta en fazla 2 deneme yapılır, sonra geri çekilir — **sonsuz döngü yok**.
- Sunucu yanıt vermezse bot **çökmez**; komutlar dürüst bir hata mesajı döner.

### Ayarlar (.env)

| Değişken | Açıklama | Varsayılan |
|---|---|---|
| `CFX_HOST` / `CFX_PORT` | Sunucu adresi | `5.231.120.202` / `30120` |
| `CFX_PLAYERS_TOKEN` | Yöntem B token’ı | boş |
| `CFX_POLL_INTERVAL_MS` | Arka plan yoklama aralığı | `30000` |
| `DISCORD_BOT_TOKEN` | Bot token’ı (eski adı `DISCORD_TOKEN` da çalışır) | — |
| `GUILD_ID` | Komutların kaydedileceği sunucu | — |
| `FIVEM_BRIDGE_SECRET` | Yöntem C secret’ı | boş |
| `FIVEM_BRIDGE_MAX_AGE_MS` | Bayatlık eşiği | `120000` |
| `FIVEM_PANEL_CHANNEL_ID` | Panel kanalı | boş (panel kapalı) |
| `FIVEM_RCON_PASSWORD` | RCON parolası | boş |

> `FIVEM_SERVER_HOST` / `FIVEM_SERVER_PORT` / `FIVEM_PLAYERS_TOKEN` eski adları
> geriye uyumluluk için hâlâ tanınır.

### Testler

```bash
npm test        # birim + HTTP + bridge API (yapay sunucu, ağa çıkmaz)
npm run test:live   # GERÇEK sunucuya bağlanır (erişilemezse atlanır)
npm run test:all   # hepsi
```

`test/helpers/mock-fivem.js` gerçek bir FiveM sunucusu gibi davranır; 403,
`Nope.`, anonim, boş liste, 429, 5xx, timeout, yanlış/doğru token senaryoları
burada üretilir.

### Yapı

```
src/services/fivem/
  client.js     HTTP istemcisi (cache, coalescing, hata sınıflandırma, teşhis)
  parser.js     Ham JSON → {id, name, ping} + isim güvenlik temizliği
  service.js    Kaynak zinciri (B → C → RCON → A) + sağlık
  bridge.js     Yöntem C: gönderilen veriyi doğrular, zaman damgalar, bayatlar
  rcon.js       FiveM RCON istemcisi (UDP)
  rconParser.js RCON status çıktısı ayrıştırıcı
  localBridge.js Yerel köprü istemcisi (yalnız 127.0.0.1)
  pagination.js Bellek içi, TTL’li sayfalama oturumları
  panel.js      Canlı panel (tek mesaj güncelleme)
src/commands/  id.js, oyuncular.js, aktifoyuncular.js, idbul.js, tag.js,
               sunucudurum.js, fivemstatus.js
fivem-resource-bridge/   Sunucuya kurulacak Lua resource (Yöntem C)
test/                   Test paketi + yapay FiveM sunucusu
```

### Hızlı test

```bash
node -e "const {service}=require('./src/services/fivem');service.queryServer().then(q=>console.log(q.status,q.onlineCount,q.baseSource))"
```

Bot çalışırken derin teşhis için Discord'da: `/fivemstatus` (yetkililer).
