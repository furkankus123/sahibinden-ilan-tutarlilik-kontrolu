# Sahibinden İlan Tutarlılık Kontrolü

Başlığında **"hatasız / boyasız / değişensiz / tramersiz"** yazan, ancak ilan
açıklamasında boya, değişen parça veya hasar kaydı geçen araç ilanlarını
**siz tıklamadan önce** arama sonuçları sayfasında işaretler.

İki ayrı seviye kullanır, çünkü boyanmış bir parça ile kayıtlı bir hasar aynı
şey değildir:

| Seviye | Tetikleyen | Satır rengi | Rozet |
|---|---|---|---|
| **Boyalı** | `boya`, `boyalı`, `lokal boya` | turuncu | `🎨 BOYALI · boya` |
| **Tutarsız** | `değişen`, `tramer`, `hasar kaydı`, `çarpma`, `sürtme` | kırmızı | `⚠️ TUTARSIZ · tramer` |

Ağır olan kazanır: "2 parça boyalı, motor kaputu değişen" → kırmızı.
Her rozet, o kararı üreten kelimeleri yanında yazar; nedeni görmek için
üzerine gelmeniz gerekmez.

İki biçimde dağıtılır, ikisi de aynı kaynaktan derlenir:

| Biçim | İstek kuyruğu | Kurulum |
|---|---|---|
| Chrome eklentisi (MV3) | service worker'da, **tüm sekmeler için tek** | `extension/` |
| Userscript (Tampermonkey) | sayfa içinde, sekme başına bir tane | `dist/…user.js` |

Eklenti daha güvenlidir: beş sonuç sekmesi açsanız bile siteye tek bir nazik
istek akışı gider, beş değil.

---

## Kurulum

### Chrome eklentisi

1. `chrome://extensions` adresini açın.
2. Sağ üstten **Geliştirici modu**'nu açın.
3. **Paketlenmemiş öğe yükle** → `extension/` klasörünü seçin.
4. sahibinden.com'da bir arama sonuçları sayfası açın.

Araç çubuğundaki simgeye tıklayarak açma/kapama anahtarına, "tutarlı" rozetleri
tercihine ve önbellek sayacına ulaşabilirsiniz.

> Eklentiyi güncelledikten sonra `chrome://extensions` üzerindeki **↻** simgesine
> basmayı ve açık sahibinden sekmesini yenilemeyi unutmayın. İçerik betikleri
> yalnızca sayfa yüklenirken enjekte edilir.

### Userscript

1. Tampermonkey panelini açın.
2. `dist/sahibinden-tutarsizlik-dedektoru.user.js` dosyasını tarayıcı
   penceresine sürükleyin veya **Yardımcı Programlar → Dosyadan içe aktar**
   seçeneğini kullanın.

Dosya adı `.user.js` ile bitmeli ve ilk satırı `// ==UserScript==` olmalıdır;
aksi halde Tampermonkey onu düz metin olarak gösterir.

---

## Nasıl çalışır

1. Arama sonuçlarındaki ilan başlıklarını okur.
2. **Yalnızca** "hatasız / boyasız / değişensiz / tramersiz" iddiası taşıyan
   ilanların detay sayfasını arka planda ister. Diğerlerine hiç dokunmaz —
   istek sayısını düşük tutan şey budur.
3. Açıklama metninde boya, değişen parça veya hasar kaydı arar.
4. Çelişki bulursa satırı boyar, başlığın üzerini çizer ve nedeniyle birlikte
   bir rozet ekler.

### Türkçe olumsuzlamaları ayırt eder

Düz bir kelime aramasından farkı burada:

| İfade | Sonuç | Neden |
|---|---|---|
| `tramersiz`, `değişensiz` | temiz | `-siz` eki |
| `tramer kaydı yoktur` | temiz | ardından gelen olumsuzlama |
| `boyalı ve değişen yoktur` | temiz | olumsuzlama listeye dağılır |
| `boya raporu mevcuttur` | temiz | belge, hasar değil |
| `tüm parçalar orjinal boyalı` | temiz | fabrika boyası |
| `2 parça boya var` | **BOYALI** | miktar belirtilmiş bildirim |
| `2 parça boyalı, tramer kaydı yok` | **BOYALI** | boya bildirilmiş, tramer reddedilmiş |
| `tramer kaydı bulunmaktadır` | **TUTARSIZ** | olumlu ifade |

Son iki satır önemli: basit bir arama bunları "temiz" sayar, çünkü cümlede
"yok" geçiyor.

### Siteye saygılı

- İstekler tek tek, aralarında **1,5–4 saniye** rastgele bekleme ile yapılır.
- 403/429/503 veya bot doğrulama sayfasında kuyruk kendiliğinden duraklar ve
  bekleme süresini katlayarak artırır (1 dk → 10 dk tavan).
- Sonuçlar 24 saat önbelleğe alınır; aynı ilan tekrar istenmez.
- Eklentide kuyruk service worker'dadır, yani sekme sayısından bağımsız olarak
  tek akış vardır.

**Bekleme sürelerini düşürmeyin.** Rozetlerin daha hızlı gelmesi için yapılacak
tek şey IP'nizin engellenmesidir.

---

## Testler

Node veya npm gerekmez. Yerel bir sunucu yeterlidir:

```powershell
py -m http.server 8777 --directory .
```

| Adres | Ne yapar | Beklenen |
|---|---|---|
| `/tests/detector-tests.html` | 61 mantık testi, ağ yok | `✓ All 61 tests passed.` |
| `/tests/e2e.html` | sahte sonuç sayfası, yerel fixture'lar | `✓ All 6 rows rendered as expected.` |
| `/tests/userscript-smoke.html` | **derlenmiş** userscript, GM API'leri taklit | `✓ All 18 checks passed.` |

Hiçbiri sahibinden.com'a tek bir istek göndermez.

Smoke testi ayrıca sayfanın kendi CSS'inin satır rengini ezmeye çalıştığı
düşmanca bir kural içerir; renk yine de doğru çıkmalıdır.

**Yanlış sonuç veren bir ilana rastlarsanız** açıklama metnini
`tests/detector-tests.html` içine beklediğiniz kararla birlikte ekleyin.
O dosya, dedektörün gerçekte neyi doğru yaptığının kaydıdır.

---

## Derleme

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

Tek dosyalık userscript'i `dist/` içine üretir, paylaşılan modülleri
`extension/src/` içine kopyalar ve Web Store için
`dist/extension-v<sürüm>.zip` paketini hazırlar.

Derleme, sessizce bozuk bir çıktı vermektense hata verir: BOM kontrolü,
stil dosyasının JS string olarak gömüldüğü kontrolü, manifest'in referans
verdiği her dosyanın varlığı ve zip yollarının eğik çizgi kullandığı kontrolü
yapılır.

İkonları değiştirmek isterseniz:

```powershell
py tools\make-icons.py
```

---

## Proje yapısı

```
src/                      düzenlediğiniz tek yer
  detector.js             Türkçe kelime + olumsuzlama mantığı (saf fonksiyonlar)
  site-adapters.js        siteye özgü seçiciler ve HTML çıkarımı
  queue.js                geri çekilmeli, hız sınırlı kuyruk
  content-core.js         sonuç sayfası DOM'u: tarama, rozet, renklendirme
  styles.css              rozet ve panel stilleri
  userscript-glue.js      Tampermonkey bağlantısı (GM_xmlhttpRequest + GM depolama)
  userscript-header.txt   ==UserScript== meta bloğu

extension/
  manifest.json
  icons/                  tools/make-icons.py üretir
  src/background.js       MV3 service worker: genel zamanlayıcı + ortak önbellek
  src/content-glue.js     eklenti bağlantısı (worker'a port, fetch + parse)
  src/popup.html/.js      araç çubuğu penceresi
  src/*.js, styles.css    build.ps1 tarafından src/'den kopyalanır — düzenlemeyin

tests/                    üç test sayfası + sahte ilan fixture'ları
tools/make-icons.py       ikon üreteci (yalnızca standart kütüphane)
dist/                     derlenmiş userscript + eklenti zip'i
build.ps1                 derleme (Node yok, npm yok)

PRIVACY.md                gizlilik politikası
STORE-LISTING.md          Chrome Web Store başvuru paketi
```

`extension/src/detector.js` ve kardeşleri **üretilmiş kopyalardır**.
`src/` içinde düzenleyip yeniden derleyin.

Bir kelimeyi seviyeler arasında taşımak için `src/detector.js` içindeki tek
`DAMAGE` tablosunu düzenleyin; rozetler, renkler ve sayaçlar otomatik uyar.

---

## Bilmeniz gerekenler

**Sonuçlar bir ipucudur, kanıt değildir.** Anahtar kelime eşleşmesine dayanır.
Hem yanlış işaretleme hem de kaçırma mümkündür. Bir rozet "bu ilanı dikkatle
oku" demektir; "bu satıcı yalan söylüyor" demez. Aracı almadan önce ilanı ve
ekspertiz raporunu kendiniz okuyun.

**Seçiciler siteye bağımlıdır.** `tr.searchResultsItem`, `a.classifiedTitle` ve
`#classifiedDescription` sahibinden'in uzun süredir kullandığı yapıya
dayanır. Site kodunu değiştirirse rozetler görünmez olur; bu durumda
düzenlenmesi gereken tek dosya `src/site-adapters.js`'dir.

**sahibinden.com otomatik tarayıcıları engeller.** Yoğun kullanımda
`/cs/tloading` adresindeki "Tarayıcınızı kontrol ediyoruz…" ekranıyla
karşılaşabilirsiniz. Eklenti bunu tanır ve yanlış sonuç üretmek yerine
duraklar.

**Otomatik istekler sahibinden.com kullanım şartlarıyla çelişebilir.** Araç
yalnızca sizin zaten açabileceğiniz sayfaları ister, ama bunu otomatik yapar.
Kendi adınıza yayımlamadan önce şartları okuyup kararı siz verin.

---

## English summary

A Chrome extension and Tampermonkey userscript that flags sahibinden.com car
listings whose **title** claims the car is undamaged (`hatasız`, `boyasız`,
`değişensiz`, `tramersiz`) while the **description** on the detail page
mentions paint, replaced parts, or a registered damage record.

Findings come in two tiers — orange for paint only, red for replaced parts or
a damage record — and each badge names the keywords behind the verdict.

The matcher understands Turkish negation, so `tramersiz`, `tramer kaydı
yoktur`, `boyalı ve değişen yoktur`, `boya raporu` and `orjinal boyalı` are all
correctly treated as clean, while `2 parça boya` and `tramer kaydı
bulunmaktadır` are flagged.

Requests are sequential with a randomized 1.5–4 s gap and exponential back-off
on rate limiting. No data is collected or transmitted; see `PRIVACY.md`.

Build with `build.ps1` (PowerShell, no Node required). Tests run in the browser
from a static server — see the Testler section above.

---

## Lisans

MIT — bkz. [LICENSE](LICENSE).
