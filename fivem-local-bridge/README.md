# fivem-local-bridge

Kendi PC'nizde çalışan **localhost oyuncu-listesi köprüsü**. Provider
snapshot'larını `http://127.0.0.1:37911` HTTP API olarak sunar; Discord botu
(`FIVEM_LOCAL_BRIDGE_URL` ile) buradan okur.

> **Dürüstlük notu (önce bunu okuyun):** Bu köprü yazılımı tek başına
> **gerçek FiveM verisi üretmez**. Gerçek oyuncu listesini köprüye sokmanın
> kısıtlar dahilinde güvenilir bir yolu **yoktur** — detay aşağıda
> "GERÇEKLİK KONTROLÜ" bölümündedir. Kutu içinden çıkan `simulator`
> provider ile tüm akış (köprü → API → Discord botu) uçtan uca test edilir;
> gerçek veri için ya sunucu-sahipli referans resource (`reference/`) ya da
> size ait legittim bir push-istemcisi `POST /ingest` kullanır.

## Hızlı başlangıç

```bat
install.bat     :: bağımlılıklar (bir kez)
start.bat       :: köprü (http://127.0.0.1:37911)
```

veya:

```sh
npm install
npm start     # provider=simulator
npm test      # 19 test, FiveM gerekmez
```

İlk çalışta API anahtarı üretilir ve konsola **bir kez** yazdırılır
(`data/.bridge-key` dosyasına da kaydedilir, git'e girmez). Botun
`FIVEM_LOCAL_BRIDGE_KEY` değerine yazın.

Ortam değişkenleri: `BRIDGE_PORT` (varsayılan 37911), `BRIDGE_API_KEY`
(hazır anahtar kullanmak için), `BRIDGE_PROVIDER=simulator`,
`BRIDGE_POLL_MS=2000`, `BRIDGE_RATE_MAX=300`.

## API

Tümü `X-Bridge-Key: <anahtar>` ister (`/health` hariç). Yanıtlar JSON'dur.

| Metot | Yol | Açıklama |
|---|---|---|
| GET | `/health` | Süreç kontrolü (anahtarsız): `{ok, service, uptimeSec}` |
| GET | `/status` | `{success, online, count, selfId, stale, source, updatedAt}` |
| GET | `/players` | `{success, count, players:[{id,name,ping}], stale, updatedAt, source}` |
| GET | `/player/:id` | Tek oyuncu (`404` yoksa, `400` geçersiz id) |
| POST | `/ingest` | Push-model kaynak snapshot yazar: `{players, selfId?}` → `{success, count, dropped}` |

Örnek:

```jsonc
GET /players
{
  "success": true,
  "count": 3,
  "players": [
    { "id": 12, "name": "Javrex", "ping": 38 },
    { "id": 27, "name": "PlayerTest", "ping": 51 },
    { "id": 43, "name": "ABC", "ping": 29 }
  ],
  "stale": false,
  "updatedAt": 1726650000000,
  "source": "simulator"
}
```

Güvenlik: 127.0.0.1 bind + loopback-kaynak kontrolü (dış IP → 403),
anahtar zorunlu (401), rate limit (429), localhost-dışı CORS yok,
güvenlik başlıkları, provider hatasında `stale:true` ile son veri korunur.

## Provider yazmak

`src/providers/base.js` sözleşmesi: `async getSnapshot()` →
`{players:[{id,name,ping}], selfId}`. Kayıt: `src/index.js` içinde provider
seçimine ekleyin. Bozuk kayıtlar otomatik elenir (id>0, ad zorunlu).

## GERÇEKLİK KONTROLÜ — neden gerçek FiveM verisi kısıtlarla alınamaz?

Doğrulanmış bulgular (kaynaklarıyla):

1. **Nativeler gerçek ama runtime ister.** `GetActivePlayers` ("Returns all
   player indices for 'active' physical players known to the client"),
   `GetPlayerServerId`, `GetPlayerName`, `GetPlayerPing` —
   [docs.fivem.net Natives](https://docs.fivem.net/natives) (API Set: client)
   ve [native-decls](https://github.com/citizenfx/fivem/blob/master/ext/native-decls/GetActivePlayers.md).
   Ancak bunları çağıracak Lua/JS/C# kodu **script runtime** ister.
2. **Script runtime = resource = sunucu.** `client_script` yalnızca
   sunucunun `resources/` klasöründeki `fxmanifest.lua` ile yüklenir ve
   sunucu konsolundan `ensure` ile başlatılır
   ([Creating Scripts](https://docs.fivem.net/docs/getting-started/create-first-script),
   [Resource Manifest](https://docs.fivem.net/docs/scripting-reference/resource-manifest)).
   İstemci kendi başına local script yükleyemez.
3. **NUI bile resource ister.** `ui_page` + `client_script` +
   `RegisterNUIMessage/Callback` hep bir resource içindedir; üstelik
   [ResourceUIScripting.cpp](https://github.com/citizenfx/fivem/blob/master/code/components/nui-resources/src/ResourceUIScripting.cpp)
   runtime-dışı `SEND_NUI_MESSAGE` çağrısını reddeder
   ("called from outside a scripting runtime").
4. **F8 konsolundan keyfi Lua çalışmaz** (sadece kayıtlı komut/convar;
   `luaconsole`/`runcode` tarzı araçların kendileri sunucu-kurulumu resource'tur).
5. **"Lua executor" denen araçlar runtime'ı memory'de hook'lar** — yani
   istenmeyen kategorinin ta kendisidir (enjeksiyon/bypass) ve ayrıca
   hile-menüleriyle aynı aileden araçlardır. Yasak listesi gereği elendi.
6. **ScriptHookV/ASI multiplayer'da çalışmaz** (oyunu kapatır) ve FiveM
   bütünlüğü (adhesive) modül taraması yapar; kullanıcı kısıtı zaten
   DLL-enjeksiyonunu yasaklıyor.
7. **PerformHttpRequest** (localhost'a POST edebilecek ilkel) bir script
   runtime'ı gerektirir — tavuk-yumurta yine resource'a çıkar.
8. Log dosyası oyuncu listesi+ping vermez; OCR'da ping/ID güvenilmez ve menü
   otomasyonu sunucu kurallarını ihlal edebilir; Overwolf/Discord presence
   kadro vermez.

**Hüküm:** kısıtlar altında (sunucuya dokunma yok + enjeksiyon/memory/driver/
bypass yok) gerçek veri akışı teknik olarak mümkün değildir. Çalışan tek
tam-yol, sunucunun başlattığı minik bir resource'tur (`reference/`).

## BU SİSTEM NEDEN ÇALIŞIYOR?

Köprünün kendisi FiveM'e hiç dokunmaz: saf bir Node.js sürecidir; bir
providerdan snapshot alır, doğrular, `127.0.0.1` HTTP API olarak sunar.
Başlaması, cevap vermesi, churn'ü yansıtması, hatada `stale` moda geçmesi ve
kapanması tamamen kendi içindedir — bunların tamamı testlerle kanıtlıdır
(`npm test`). Veri kaynağı soyutlandığı için kaynak değişince köprü ve bot
kodu değişmez.

## BU SİSTEMİN FIVE M SUNUCUSU TARAFINDA NEDEN HİÇBİR DEĞİŞİKLİĞE İHTİYACI YOK?

Köprü + Discord botu + simulator üçlüsü sunucuyla **hiç konuşmaz**: ne oyun
trafiği, ne RCON, ne HTTP, ne resource. Dışa giden tek şey yoktur; dinlenen
adres `127.0.0.1`'dir. (Gerçek oyuncu verisi istenirse o ayrı katmandır ve
yukarıdaki GERÇEKLİK KONTROLÜ geçerlidir.)
