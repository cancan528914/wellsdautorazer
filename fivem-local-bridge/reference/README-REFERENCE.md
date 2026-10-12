# REFERENCE — Sunucu Sahibi Gerektiren Alternatif (ANA ÇÖZÜM DEĞİL)

> Bu klasördeki resource **yalnızca bilgi amaçlıdır**. Çalışması için sunucu
> sahibinin `server-resource/` içeriğini sunucuya kurup `ensure` etmesi gerekir.
> Kısıt "sunucu sahibi hiçbir şey yapmayacak" olduğu için bu yol **önerilen
> çözüm değildir**; sadece mimari bütünlük için belgelenmiştir.

## Neden bu tek tam-çalışan yoldur?

`GetActivePlayers` / `GetPlayerServerId` / `GetPlayerName` / `GetPlayerPing`
nativeleri **client-side** çalışır, ancak onları çağırabilecek kod
(`client_script`) yalnızca sunucunun başlattığı bir **resource** içinde yaşar
(`fxmanifest.lua` → `client_script`, sunucu `resources/` klasöründen yüklenir
ve `ensure` ile başlatılır). NUI bile (`ui_page` + `client_script` +
`RegisterNUICallback`) bir resource gerektirir — bkz.
`citizenfx/fivem` içinde `ResourceUIScripting.cpp`: `SEND_NUI_MESSAGE`
çağrısı "outside a scripting runtime" reddedilir.

## Kurulum (sahip yaparsa)

1. `server-resource/` klasörünü sunucunun `resources/` altına kopyalayın.
2. `client.lua` içindeki `BRIDGE_KEY` değerini oyuncunun bridge anahtarıyla değiştirin.
3. `server.cfg`: `ensure <klasor-adi>`.

Bundan sonra oyuncunun PC'sindeki bridge `POST /ingest` üzerinden gerçek
veriyi alır; Discord botu `FIVEM_LOCAL_BRIDGE_URL` ile okur.
