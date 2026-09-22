# Chrome Web Store submission pack

Everything the dashboard asks for, ready to paste. Upload
`dist/extension-v2.0.0.zip`.

---

## 1. Before you can submit

- [ ] **Developer account** — one-time **$5** registration fee at
      <https://chrome.google.com/webstore/devconsole>. Pay it before you start;
      you cannot submit without it.
- [ ] **Host the privacy policy at a public URL.** `PRIVACY.md` in a GitHub repo
      works (use the rendered file URL). A policy URL is **required** because the
      extension requests host permissions. Without it the submission is rejected.
- [ ] **Replace every `Furkankus123`** in `PRIVACY.md` and
      `src/userscript-header.txt` with your GitHub username.
- [ ] **Screenshots** — at least one, `1280x800` or `640x400` PNG/JPEG.
      Take them on a real results page after the badges appear. Blur or crop
      seller phone numbers if any are visible.
- [ ] Optional but recommended: small promo tile `440x280`.

---

## 2. Listing fields

**Name** (45 char limit)

```
Sahibinden Tutarsızlık Dedektörü
```

**Short description** (132 char limit — this is 128)

```
Başlığında "hatasız/boyasız" yazıp açıklamasında boya, değişen veya hasar kaydı geçen ilanları otomatik olarak işaretler.
```

**Category:** Shopping
**Language:** Turkish

**Detailed description**

```
Sahibinden.com'da araç ararken sık karşılaşılan bir durum var: ilan başlığında
"hatasız", "boyasız", "değişensiz" veya "tramersiz" yazıyor; ancak ilana
girdiğinizde açıklamada "2 parça boyalı" ya da "tramer kaydı bulunmaktadır"
gibi ifadeler görüyorsunuz.

Bu eklenti, arama sonuçları sayfasındaki bu tür ilanları siz tıklamadan önce
tespit eder.

NASIL ÇALIŞIR
• Arama sonuçlarındaki ilan başlıklarını okur.
• Yalnızca "hatasız/boyasız/değişensiz/tramersiz" iddiası taşıyan ilanların
  detay sayfasını arka planda açar.
• Açıklamada boya, değişen parça veya hasar kaydı geçiyor mu diye bakar.
• Çelişki bulursa ilanı kırmızıyla işaretler, başlığın üzerini çizer ve
  "⚠️ TUTARSIZ" rozeti ekler. Rozetin üzerine gelince açıklamada ne bulunduğunu
  görürsünüz.

OLUMSUZLAMALARI AYIRT EDER
Basit bir kelime aramasından farklı olarak Türkçe olumsuzlamaları anlar:
• "tramersiz", "değişensiz"            → temiz sayılır
• "tramer kaydı yoktur"                → temiz sayılır
• "boyalı ve değişen yoktur"           → temiz sayılır
• "2 parça boyalı, tramer kaydı yok"   → TUTARSIZ olarak işaretlenir
• "tramer kaydı bulunmaktadır"         → TUTARSIZ olarak işaretlenir

SİTEYE SAYGILI
İstekler tek tek, aralarında 1,5–4 saniye rastgele bekleme ile yapılır. Site
yoğunluk sinyali verirse eklenti kendiliğinden duraklar ve süreyi kademeli
olarak artırır. Birden fazla sekme açsanız bile tek bir istek sırası kullanılır.
Sonuçlar 24 saat önbelleğe alınır, aynı ilan tekrar istenmez.

GİZLİLİK
Varsayılan olarak hiçbir veri gönderilmez; tüm işlem tarayıcınızda gerçekleşir
ve yalnızca sahibinden.com'a erişim istenir.

İsterseniz "Anonim katkı" seçeneğini açarak Türkçe eşleştirme kurallarının
gelişmesine katkıda bulunabilirsiniz. Açık olduğunda yalnızca kararı üreten
cümle, verilen karar ve sizin "doğru/yanlış" işaretiniz gönderilir. İlan
adresi, ilan başlığı ve kimlik bilgisi gönderilmez; telefon, plaka ve e-posta
metinden otomatik temizlenir. Gönderilecek veriyi göndermeden önce eklentinin
penceresinden görebilirsiniz. Seçenek kapalıyken hiçbir istek yapılmaz.

UYARI
Sonuçlar anahtar kelime eşleşmesine dayanır ve bir ipucudur, kanıt değildir.
Yanlış işaretleme de, kaçırma da mümkündür. Kararınızı vermeden önce ilanı
mutlaka kendiniz okuyun. Bu eklenti hiçbir satıcı hakkında suçlama içermez.
```

---

## 3. Privacy tab — the part that gets submissions rejected

**Single purpose** (one sentence, must match what the code does)

```
Flags sahibinden.com car listings whose title claims the vehicle is undamaged
while the listing's own description mentions paint, replaced parts, or a damage
record.
```

**Permission justifications**

| Field | Paste this |
|---|---|
| `storage` | Stores a 24-hour cache of per-listing verdicts so the same listing is not requested twice, two user preferences (on/off, badge visibility), and any corrections the user chooses to record. No browsing data. |
| Host permission `sahibinden.com` | The extension reads the search results page the user is on and requests listing detail pages from that same site in order to compare the title against the description. It accesses no other site. |
| Optional host permission `*.workers.dev` | Requested only if the user switches on "Anonim katkı". It is used solely to POST anonymised sentences and corrections to the project's own endpoint so the Turkish matching rules can be improved. Declining it leaves the extension fully functional. |
| Remote code | **No**, the extension does not use remote code. All logic ships in the package. |

**Data usage disclosures.** The extension DOES collect data once the optional
sharing switch is turned on, so this section cannot be left blank. Tick:

- [x] **User activity** — only when the user enables "Anonim katkı". Limited to
      sentences from public listing descriptions and whether the user marked a
      verdict correct or wrong. No URLs, no titles, no identifiers.

Leave every other category unticked — no personally identifiable information,
no health, financial, authentication, personal communications, location or web
history is collected. Then certify all three statements:

- [x] I do not sell or transfer user data to third parties, outside of approved use cases
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** the public URL where you hosted `PRIVACY.md`. It must
describe the optional sharing, because the listing now declares collection.

> Do not describe the extension as collecting nothing. It is off by default and
> requires two separate consents, but "off by default" is not "never", and a
> listing that says otherwise is a false declaration.

---

## 4. Realistic expectations about review

Be aware of what you are submitting before you spend the $5:

- **Host permissions trigger closer review.** Expect longer than the typical
  few days, and possibly a request for more justification.
- **This extension automates requests to a commercial site it does not own.**
  Chrome Web Store policy does not ban that outright, but sahibinden.com's own
  terms of use may prohibit automated access, and they can complain to Google
  about an extension that does it at scale. Read their terms and decide whether
  you want this published under your own name. Publishing the userscript on
  Greasy Fork carries the same question with far less ceremony.
- **Do not lower the request delays to look faster.** A reviewer testing the
  extension is also generating traffic to sahibinden. The current 1.5–4 s
  spacing with exponential back-off is the defensible setting.
- **The "not proof, just a hint" disclaimer is in the listing text for a
  reason.** Keep it. An extension that publicly labels named sellers' listings
  as deceptive is a different and riskier product than one that flags a
  contradiction for the reader to check.

---

## 5. Publishing updates

1. Bump `version` in `extension/manifest.json` (and `src/userscript-header.txt`
   if you also ship the userscript).
2. `powershell -ExecutionPolicy Bypass -File .\build.ps1`
3. Upload the new `dist/extension-v<version>.zip` as a new package.

Version numbers must increase; the Web Store rejects a re-upload of the same
version.
