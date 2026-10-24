# Love Budget — Apple Pay harcama takibi

iPhone'da Apple Pay ile her ödemede **işyeri, tutar ve kartı** otomatik kaydeden,
aylık bütçe ve grafiklerle gösteren kişisel bir PWA.

```
Apple Pay ödemesi ─► Kestirmeler "İşlem" otomasyonu ─► POST /api/transactions
                                                         │
                         Cloudflare Worker + D1 (SQLite) ◄┘
                                                         │
                 iPhone ana ekranındaki PWA (bütçe, grafik, liste) ◄┘
```

- **Sunucu:** tek bir Cloudflare Worker (`src/index.js`), veritabanı Cloudflare D1.
  Ücretsiz planın sınırları kişisel kullanım için fazlasıyla yeterli.
- **Arayüz:** `public/` altındaki derleme gerektirmeyen PWA. Çevrimdışıyken son veriyi gösterir.
- **Kimlik doğrulama:** tek bir gizli anahtar (`API_TOKEN`). Kestirme ve PWA aynı anahtarı kullanır.

## Özellikler

- Her Apple Pay ödemesi otomatik kaydedilir. Aynı ödeme iki kez gelirse tek kayıt tutulur.
- İşyerine göre otomatik kategori (Migros → Market, Shell → Akaryakıt…). Bir kaydın
  kategorisini değiştirdiğinizde o işyeri hatırlanır, sonraki ödemeler de o kategoriye düşer.
- Aylık bütçe: kalan tutar, günlük harcama limiti, ay sonu tahmini, ideal tempo çizgisi.
- Grafikler: ay içi kümülatif harcama, kategori dağılımı, son 6 ayın karşılaştırması.
- Ödeme yöntemi: Apple Pay kayıtlarında Wallet'taki kart adı otomatik gelir; elle eklerken son
  kullanılan yöntemlerden ya da "Nakit"ten seçilir. Ana ekranda ödeme yöntemine göre dağılım.
- Elle harcama ekleme (online alışverişler veya nakit için), düzenleme, silme.
- Banka tutar göndermezse kayıt "Tutar gir" olarak işaretlenir, dokunup girebilirsiniz.
- Ortak kullanım: aynı adres ve anahtarla birden çok telefon aynı veriyi görür
  ([ORTAK-KURULUM.md](ORTAK-KURULUM.md)). Gösterim para birimi her telefonun kendi tercihidir.
- Para birimi seçici (TRY, USD, EUR, IDR, THB, JPY, SGD): her harcama kendi para biriminde
  saklanır, tüm toplamlar ve grafikler seçilen birime güncel kurla çevrilir. Kurlar
  open.er-api.com'dan (yedek: Frankfurter/ECB) saatlik önbellekle alınır; servis çökerse son
  bilinen kurlar kullanılır. Yurt dışı ödemelerde `฿`, `S$`, `¥`, `Rp` gibi semboller tanınır.

---

## Kurulum (MacBook'ta, bir kez)

### 1. Araçlar

[Node.js](https://nodejs.org) (LTS) kurulu olmalı. Terminal'de:

```bash
git clone https://github.com/nejatsoze/JARVIS.git
cd JARVIS
git checkout claude/blissful-cori-4xfjwn   # ana dala birleştirilene kadar gerekli
cd harcama
npm install
npx wrangler login          # tarayıcıda Cloudflare hesabınızla izin verin
```

### 2. Veritabanı

```bash
npx wrangler d1 create harcama
```

Çıktıdaki `database_id` değerini `wrangler.jsonc` içindeki
`00000000-0000-0000-0000-000000000000` yerine yapıştırın.

### 3. Gizli anahtar

Rastgele bir anahtar üretip Cloudflare'e kaydedin:

```bash
openssl rand -hex 24        # çıktıyı bir yere not edin (Kestirme ve giriş için lazım)
npx wrangler secret put API_TOKEN   # sorunca az önceki anahtarı yapıştırın
```

### 4. Yayına alma

```bash
npm run deploy
```

Bu komut veritabanı tablolarını oluşturur ve uygulamayı yayına alır.
Sonunda `https://harcama.<hesabınız>.workers.dev` gibi bir adres verir.

### 5. Kendi alan adınız (isteğe bağlı ama önerilir)

Cloudflare panelinde **Workers & Pages → harcama → Settings → Domains & Routes →
Add → Custom domain** yolunu izleyip örneğin `harcama.alanadiniz.com` girin.
Alan adınız Cloudflare'de olduğu için DNS ve SSL otomatik ayarlanır.

### 6. iPhone'a ekleme

1. Safari'de adresi açın, anahtarınızla giriş yapın.
2. **Paylaş → Ana Ekrana Ekle**. Artık uygulama gibi tam ekran açılır.
3. Ayarlar (⚙︎) ekranından **aylık bütçenizi** girin.

---

## Kestirme otomasyonu (iPhone'da, bir kez)

1. **Kestirmeler** uygulaması → alttan **Otomasyon** → sağ üstte **+**.
2. **İşlem** (Transaction) tetikleyicisini seçin.
   - **Kart:** takip etmek istediğiniz kartların hepsini işaretleyin.
   - **Hemen Çalıştır**'ı seçin (her ödemede onay sormasın), **Çalıştırıldığında Bildir** kapalı kalabilir.
   - **İleri → Yeni Boş Otomasyon**.
3. **URL'nin İçeriğini Al** (Get Contents of URL) eylemini ekleyin:
   - **URL:** `https://harcama.alanadiniz.com/api/transactions`
     (doğru adres uygulamanın Ayarlar ekranında da yazıyor)
   - **Yöntem:** `POST`
   - **Başlıklar:** anahtar `Authorization`, değer `Bearer ANAHTARINIZ`
   - **İstek Gövdesi:** `JSON`, şu alanları ekleyin (değerler için **Kestirme Girdisi**
     değişkenine dokunup ilgili özelliği seçin):

     | Anahtar    | Tür  | Değer                           |
     |------------|------|---------------------------------|
     | `merchant` | Metin | Kestirme Girdisi → **İşyeri**  |
     | `amount`   | Metin | Kestirme Girdisi → **Tutar**   |
     | `card`     | Metin | Kestirme Girdisi → **Kart** (ya da **Ad**) |

4. **Bitti**. İlk ödemenizden sonra kayıt uygulamada görünür.

> Tarih göndermenize gerek yok, sunucu ödemenin geldiği anı kullanır. Tutar
> `₺1.234,56`, `1.234,56 TL`, `1,234.56` gibi biçimlerin hepsinde doğru okunur.

### Bilinen sınırlar

- Tetikleyici, telefon ya da saat **POS cihazına okutulduğunda** çalışır. Safari veya uygulama
  içindeki online Apple Pay ödemelerinde genelde çalışmaz. Bunları **+** düğmesiyle ekleyin.
- Bazı bankalar tutarı göndermiyor. O kayıtlar "Tutar gir" olarak görünür.

### Test

Kurulumdan sonra Mac'ten deneme kaydı atabilirsiniz:

```bash
curl -X POST https://harcama.alanadiniz.com/api/transactions \
  -H "Authorization: Bearer ANAHTARINIZ" \
  -H "Content-Type: application/json" \
  -d '{"merchant":"TEST MARKET","amount":"₺12,50","card":"Deneme"}'
```

---

## Geliştirme

```bash
echo 'API_TOKEN=test-token' > .dev.vars
npm run db:migrate:local
npm run dev                 # http://localhost:8787 (anahtar: test-token)
npm test                    # tutar/kategori/tarih birim testleri
```

## API

Tüm uçlar (`/api/health` hariç) `Authorization: Bearer <API_TOKEN>` ister.

| Yöntem | Yol | Açıklama |
|---|---|---|
| `POST` | `/api/transactions` | `{merchant, amount?, card?, note?, category?, date?, currency?}`. 90 sn içinde aynı işyeri+tutar gelirse mevcut kaydı döner (`duplicate: true`). |
| `GET` | `/api/transactions?month=YYYY-AA[&currency=USD]` | Ayın kayıtları, her biri `converted_minor` ile gösterim birimine çevrilmiş. |
| `PATCH` | `/api/transactions/:id` | Alanları günceller. Kategori değişirse işyeri öğrenilir (`learn: false` ile kapatılır). |
| `DELETE` | `/api/transactions/:id` | Kaydı siler. |
| `GET` | `/api/summary?month=YYYY-AA[&currency=USD]` | Gösterim biriminde toplam, kategori ve gün kırılımı, bütçe, son 6 ay, kurlar. |
| `GET` / `PUT` | `/api/settings` | `{monthly_budget, budget_currency, display_currency}`. Boş bütçe kaldırır. |
| `GET` | `/api/health` | Sağlık kontrolü (veritabanına da dokunur). |

Tutarlar veritabanında kuruş cinsinden tamsayı olarak saklanır (`amount_minor`).
`CURRENCY` (`wrangler.jsonc`), para birimi belirtilmemiş ödemelerin varsayılanıdır; saat dilimi `TIMEZONE` ile değişir.
