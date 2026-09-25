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
