# Love Budget uygulamasını telefonuna kurma

Ortak harcama uygulamamız Love Budget’ı telefonuna kurman için iki adım var. Toplam 5 dakika sürer.
Telefon dili İngilizce olduğu için menü adlarını İngilizce yazdım.

Bunlar lazım olacak:

- **Adres:** https://harcama.burakilhanov.workers.dev
- **Anahtar:** sana ayrıca göndereceğim uzun yazı

---

## 1. Uygulamayı ana ekrana ekle

1. **Safari**'de yukarıdaki adresi aç.
2. Anahtarı yapıştırıp **Giriş yap**'a dokun.
3. Alttaki **Share** (paylaş) düğmesine dokun, sonra **Add to Home Screen → Add** de.
4. Bundan sonra uygulamayı ana ekrandaki **Love Budget** ikonundan aç. İlk açılışta anahtarı
   bir kez daha isteyebilir.

Para birimini sağ üstteki bayraklı düğmeden değiştirebilirsin. Bu seçim sadece senin
telefonunu etkiler.

## 2. Apple Pay ödemelerini otomatik kaydet

Bu adım, telefonunla her temassız ödeme yaptığında harcamayı kendiliğinden kaydeder.

1. **Shortcuts** uygulamasını aç, sağ üstteki **+** düğmesine dokun.
2. Açılan ekranda bir tarif kutusu varsa onu atla.
3. Alttaki arama kutusuna **Wallet** yaz ve **When Any Card is tapped** tetikleyicisini ekle.
4. Tetikleyicinin yanındaki oka dokun:
   - **Automation** açık olsun.
   - **Notify** kapalı olsun.
5. Arama kutusuna **Get Contents of URL** yaz ve ekle.
6. Mavi **URL** yazısına dokun ve şunu yaz:
   `https://harcama.burakilhanov.workers.dev/api/transactions`
7. Eylemin yanındaki oka dokunup şöyle doldur:
   - **Method:** `POST`
   - **Headers → Add new header:**
     - Key: `Authorization`
     - Text: `Bearer ` yaz (sonunda bir boşluk var), ardından anahtarı yapıştır.
   - **Request Body:** `JSON`
   - **Add new field → Text** ile üç alan ekle:

     | Key | Value |
     |---|---|
     | `merchant` | Değer kutusuna dokun, klavyenin üstünden **Shortcut Input**'u seç, ona tekrar dokunup **Merchant**'ı seç |
     | `amount` | Aynı yolla **Amount**'u seç |
     | `card` | Aynı yolla **Card or Pass**'i seç |

     Değerler renkli baloncuk olarak görünmeli. Elle yazarsan çalışmaz.
8. Kestirmeye "Harcama Kaydet" gibi bir ad ver ve **Done**'a dokun.

## 3. Dene

Telefonunla temassız küçük bir ödeme yap, sonra uygulamayı aç. Harcama listede görünmeli.
Ayarlar (⚙︎) ekranındaki **Son Apple Pay Kaydı** satırı da ödemenin saatini gösterir.

Bilmen gerekenler:

- Online Apple Pay ödemeleri (Safari ya da uygulama içi) otomatik gelmez. Onları uygulamadaki
  **Harcama Ekle** düğmesiyle ekle.
- Bazı bankalar tutarı göndermiyor. Öyle bir kayıt "Tutar gir" olarak görünür, dokunup girersin.
