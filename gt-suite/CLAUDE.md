# GT Suite — GamingTec Tampermonkey paketi

core-secundus.gmntc.com (Angular SPA) üzerinde çalışan, tek paylaşılan
çekirdek + sayfa başına uydu script mimarisi. Palentis (operasyon/destek,
çekim işleme + oyuncu hesap yönetimi) için yazılıyor.

## Mimari

- **gt-core.user.js** — UI üretmez, `document-start`'ta yüklenir.
  `window.GT` (unsafeWindow üzerinden) yayınlar: rAF-batch'li tek
  MutationObserver veriyolu (`GT.bus`), router (pushState/replaceState
  yaması), `sessionKey`'i her istekte taze okuyan API katmanı (`GT.api`),
  tasarım token'ları + UI kiti (`GT.ui`, `GT.css`), kısayol defteri
  (`GT.hotkeys`), modül yaşam döngüsü (`GT.define`).
- **Uydular** (gt-shell, gt-player, gt-withdrawals, gt-transactions) kendilerini şöyle
  kaydeder — çekirdek onlardan önce ya da sonra yüklense fark etmez:
  ```js
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  (W.__GT__ = W.__GT__ || []).push((GT) => {
      GT.define({ id: '...', match: GT.at.playerDetail, setup(ctx) { ... } });
  });
  ```
- Her modül `ctx.tick()` (her karede veya `{lazy:true}` ile boşta),
  `ctx.mount()` (çapa bulunca bir kere monte et, kaybolursa geri koy),
  `ctx.hotkey()`, `ctx.own()` (temizlenecek DOM/worker) araçlarını kullanır.
  `key: () => api.partyId()` verilirse konu (örn. oyuncu) değişince modül
  baştan kurulur.

## Neden bu mimari

Eskiden tek dev "All-in-One" script'ti (23 modül, ~3000 satır). Sorunlar:
tek observer yoktu, her modül kendi interval/observer'ını kuruyordu;
Firefox'ta `@grant` olan script'in fetch/XHR'ı sayfanın gerçek ağından
izole (main-world enjeksiyonu gerekiyor); sessionKey her istekte TAZE
okunmalı yoksa sessiz 401. Çekirdek bunları tek yerde çözüyor.

## AKTİF SORUN — adoptContacts hipotezi (ÇÖZÜLMEDİ, buradan devam et)

`gt-player.user.js`'in bir sürümünde (1.0.4) eklenen `adoptContacts()`
fonksiyonu, oyuncu detay sayfasındaki maskeli e-posta/telefon
hücrelerinin GERÇEK DOM düğümlerini (klon değil) bizim kimlik kartımıza
TAŞIYORDU (`slot.append(...valueTd.childNodes)`), ve bunu `{lazy:true}`
ile SONSUZA KADAR her boşta turunda tekrarlıyordu (o sürümde "bir kez
çalış" kilidi yoktu).

Bunu yükledikten hemen sonra kullanıcı sayfanın "döngüye girdiğini"
(muhtemelen gerçek navigasyon, sadece görsel titreme değil) bildirdi.

**Hipotez:** Angular'ın kendi oluşturup yönettiği bir DOM düğümünü
haberi olmadan yerinden söküp taşımak, Angular'ın bir sonraki değişiklik
algılama turunda o düğüme referans vermeye çalışıp iç hata fırlatmasına
ve uygulamanın kendi hata-kurtarma mekanizmasının (varsa) sayfayı
yenilemesine yol açmış olabilir. Bu KANITLANMADI, sadece mekanistik
olarak en güçlü açıklama.

**Şu an test edilen:** `gt-player.user.js` şu an **1.0.4-safe** sürümünde
— Accounting sadeleşmesi (periyotlar Dün→Bugün→WTD→MTD→Geçen ay→YTD→LTD,
tek tablo, sekmesiz) ve giriş kayıtları görsel düzeni (sabit kolon
genişliği, kırpılabilir rozetler) VAR, ama `adoptContacts` YOK — email/
telefon eski yerinde (sayfada) kalıyor, kimlik kartına taşınmıyor.

**SONUÇ (2026-09-24):** 1.0.4-safe ile sorun GERİ GELDİ → `adoptContacts`
suçlu DEĞİL, hipotez elendi. Kullanıcıya göre bilinen son sorunsuz ikili:
**gt-player 1.0.3 + gt-withdrawals 1.0.4** (birlikte çalışırken her şey
yolundaydı; bir sonraki güncellemede çöktü). Bu iki dosyanın kaynağı henüz
repo'da yok — gelince mevcut sürümlerle diff alınmalı. Yeni şüpheli:
`sweepOldPanels()` içinde Angular'a ait `td` hücrelerini her boşta turunda
`cell.remove()` ile SİLEN döngü (gizlemek yerine siliyor, aynı sınıf risk).

**player 1.0.3 ↔ 1.0.4-safe diff'i (gt-player-1.0.3.user.js repo'da):**
fark küçük ve neredeyse tamamen görsel — giriş kayıtları CSS'i, Accounting
sekmelerinin kaldırılıp tek tablo yapılması, periyot sırası, kimlik kartı
markup'ı, `USERID`'nin HIDE_LABELS'a eklenmesi (sadece class ile gizleme).
1.0.3 ayrıca tamamen gizlenen SATIRLARI da gizliyordu; 1.0.4 bunu kaldırdı
(daha az müdahale). `cell.remove()` döngüsü ve panel yerleşimi (infoBlock/
place) İKİSİNDE DE AYNI. Navigasyon/yenileme tetikleyebilecek yeni bir kod
yok → **asıl şüpheli player değil, gt-withdrawals 1.0.4→1.0.5 (ya da core)**.
gt-withdrawals 1.0.4 kaynağı kayıp.

**Teşhis araçları (core 1.1.3):** `GT.flight()` sayfa yenilemeleri arasında
kalıcı kara kutuyu (yükleme türü, rota, modül kurulumu, hata, çıkış)
tablo olarak basar; `GT.off('id' | 'kaynak' | 'önek*')` dosya düzenlemeden
modül kapatır (localStorage `gt.off`), `GT.on()` hepsini açar. Suçluyu
bulmak için önce kaynak bazında (player / withdrawals / shell), sonra
modül bazında daraltılır.

Eski plan (tarihsel):
- **Düzeldiyse** → adoptContacts kesin suçlu. Özelliği GERİ getirirken
  düğümü TAŞIMAK yerine KLONLAMAK (`cloneNode(true)`) ve orijinali sadece
  CSS ile (`display:none`) gizlemek gerekir — Angular'ın kendi düğümüne
  hiç dokunulmamış olur, klon bizim tarafımızda serbestçe yaşar.
- **Düzelmediyse** → adoptContacts suçlu değil. O zaman GT Withdrawals'ı
  da devre dışı bırakıp sadece Core+Shell+Player ile test etmek gerekir
  (GT Withdrawals'ın `wd-session-guard` modülü daha önce tüm sayfalarda
  `visibilitychange`/`blur` olaylarını boğuyordu, artık `VISIBILITY_
  GUARD_SCOPE` anahtarıyla sadece Çekimler sayfasında — bu da olası bir
  ikinci şüpheliydi, elendi mi test edilmedi).

## Sürüm geçmişi disiplini (ÖNEMLİ)

Tampermonkey dosya geçmişi TUTMUYOR. Bu yüzden geçmişte büyük bir hata
yapıldı: gt-player art arda "akıllı" düzeltmeler (kendi kendini ölçen/
düzelten yerleşim mantığı, isUsable, forceFloat) ile 1.0.11'e kadar
şişirildi, her düzeltme yeni bir sorun yarattı, sonunda 1.0.3'e (bilinen
son çalışan sürüm) elle geri dönüldü. **Artık bu repo'da git var — bu
sorun bir daha yaşanmamalı.** Her anlamlı değişiklikten sonra commit at.
Şüpheli/test edilen bir değişiklik varsa ayrı bir branch'te dene, ana
branch'i bozma.

## Bilinen kısıtlar / tuhaflıklar

- `@match` geniş tutulmalı (`https://core-secundus.gmntc.com/*`) — dar
  match SSO login yönlendirme zincirinin ortasında script'i hiç
  enjekte etmeyebiliyor.
- Klasik withdrawal listesi ve bazı popup'lar (`/j/PendingWithdrawals.
  action`, `player-withdrawals` popup → `#iframe-player-withdrawals`)
  **iframe** içinde render oluyor. Popup modülleri (`wd-quick-reject`,
  `wd-popup-list`) üst pencere adresine (`topHref()` içinde
  `popup:player-withdrawals`) bakar, iframe'in İÇİNDE çalışır.
  `@noframes` bu modülleri kırar — gt-withdrawals'ın ilgili 5 modülü
  `scope: 'both'` ile hem üst pencerede hem iframe'de çalışıyor.
- iframe'in ilk `about:blank` belgesinden gerçek sayfaya geçişte tarayıcı
  aynı `window`'u yeniden kullanır. Tampermonkey bazen o boş belgeye
  enjekte ediyor: JS yaşar, `<style>`'lar boş belgeyle gider → stilsiz
  butonlar (Withdrawals popup'ındaki IP/PT/KYC, düz metin ONAY). Bu yüzden
  `css()` stilleri bir kayıtta tutar ve her zaman `W.document`'a (aktif
  belge) yazar; `ctx.mount` ve DOM'u başka belgeye ekleyen modüller
  `GT.ensureStyles(node.ownerDocument)` çağırır. Stil sorunu görürsen önce
  "stil etiketi bu belgede var mı" diye bak, `!important` ile boğuşma.
- Oturum: `wd-session-guard` her sayfada Worker saatiyle (gizli sekmede rAF
  hiç, setInterval dakikada bir çalışır — Worker kısılmaz) saniyede bir
  "Continue Session" diyaloğuna bakar ve 50–70 sn'de bir sahte `mousemove`
  ile sitenin hareketsizlik sayacını sıfırlar. Logout olursa `GT.flight()`
  "oturum" satırlarına bak: tıklandı mı, diyalog butonsuz muydu.
- `sessionKey` rotasyonlu: her `ics/*` isteğinde TAZE okunmalı, asla
  cache'lenmemeli — bayat anahtar sessiz 401 döner. `GT.api.ics()` bunu
  otomatik yapar.
- KYCAID portre akışı (CSRF token → `/api/session` → `/api/verifications`)
  Bearer token akışından tamamen ayrı, karıştırılmamalı.
- `player-transactions` verisi `gameTranId` ile gruplanmalı (bir turda
  birden fazla BET/WIN satırı olabilir), `platformName` ile filtrelenmeli
  (`gameName` ile değil).
- Firefox + `@grant` kombinasyonunda script'in kendi fetch/XHR'ı
  sayfanın gerçek ağından izole — main-world `<script>` enjeksiyonu +
  `CustomEvent` ile geri okuma gerekiyor (`GT.capture` bunu sağlıyor,
  henüz hiçbir uydu kullanmıyor — AI ÖZET / GT Transactions taşınırken
  gerekecek).

## Tasarım kuralları (panel)

- Panel sayfanın kendi `<table>`'ı içine yerleşiyor; sitenin Bootstrap
  `table/td/.row/.badge/small` kuralları bizim öğelere sızar. Bu yüzden
  kartların içinde `<table>` KULLANILMAZ (grid div), sınıflar öneklenir
  (`gtc-` kart iskeleti, `gta-` Accounting, `gtl-` giriş kayıtları,
  `gtb-` bakiye), `#gt-dash *` font/harf aralığı sıfırlaması korunur.
  Sitede `.content` gri arka plan veriyor, `.card` / `.row` / `.badge`
  Bootstrap'ta var — öneksiz genel sınıf adı KULLANMA.
- Butonlar: her zaman `GT.ui.button` / `.gt-btn`, kendi buton CSS'i yazma.
  Renk ROLÜ anlatır: varsayılan nötr (araç: filtre, sorgu, gezinme),
  `success` onay, `warn` parayı değiştirir (bakiye, CHK), `danger` geri
  alınamaz (red, oturum sonlandır), `.is-active` seçili durum. Hücrede tek
  birincil aksiyon dolu olur (ONAY), alternatifler tonlu. Aksiyon = 8px
  köşeli dikdörtgen, durum rozeti (`.gt-chip`) = hap — karıştırma.
  Kısayolu olan butona `key: 'alt+x'` ver, içinde tuş kapağı çıkar. Butonu
  title ile arama (title'a kısayol eklenir) — id ver (`#gt-cre-btn`).
  Renkli metinler AA kontrastlı koyu tonlar (#1e7b34, #c93400, #d70015),
  çerçeveler 1px (.5px Windows 1x ekranda kayboluyor).
- Sayfadaki Angular hücrelerine dokunulmaz: kopyala + CSS ile gizle.
  Kopyadaki tıklamalar `twin` eşlemesiyle ("hücre + sıra") aslına iletilir.

## Eksik / yapılmamış

- **GT Transactions** (`gt-transactions.user.js`, 1.0.0) yazıldı:
  1./2. Aşama + CRE (Alt+X / Alt+D / Alt+C), `<<` bir gün geri, kaydırma
  butonu — eski All-in-One'daki mantık birebir, çekirdek modüllerine
  oturtuldu. AI ÖZET (v6.7.0) hâlâ ayrı, bağımsız; eski main-world ağ
  yakalama desenini kendi başına yapıyor, çekirdeğe taşınmadı.
- Pingwi Checker (v2.6.0) bilinçli olarak bağımsız kaldı — ikinci bir
  domain'de (safepaymentprocessingservice.com) GM_setValue köprüsüyle
  çalışıyor, GT Core'a bağlı değil.
- Eski "GamingTec Merkezi Saat Grubu" script'i GT Shell'in `shell-clocks`
  modülüne taşındı, ayrı script artık kapatılmalı.

## Test döngüsü (Claude Code bunu otomatikleştiremez, unutma)

Bu kod tarayıcı içinde, gerçek bir üretim sitesinde çalışıyor. Claude
Code syntax kontrolü (`node --check`) yapabilir ama gerçek DOM'a erişimi
yok. Her değişiklikten sonra: kullanıcı dosyayı Tampermonkey'e yapıştırır
→ test eder → sonucu buraya bildirir. Kör tahmin yürütmek yerine, emin
olunmayan her değişiklik için mümkünse tek dosyada açılıp kapanabilen
bir test anahtarı bırak (bkz. gt-withdrawals'taki `VISIBILITY_GUARD_
SCOPE` deseni) — kullanıcının dosya geçmişi olmadığı unutulmamalı,
git bunu commit seviyesinde çözer ama script İÇİ hipotez testlerinde
hâlâ en pratik yöntem budur.
