# GamingTec — AI ÖZET (Yüksek Oranlı Kazanç Dedektörü)

Oyuncu işlem (transactions) ekranındaki ağ trafiğini dinleyip, aynı **Game Tran ID**'ye
ait tüm hareketleri tek bir "tur" altında toplayan ve `Win / Bet` oranı eşiği aşan
turları canlı filtrelenebilir bir panelde gösteren userscript.

**Kurulum:** Tampermonkey / Violentmonkey'e `gamingtec-ai-ozet.user.js` dosyasını ekleyin.
Sayfa açıldığında sağ altta **🤖 AI ÖZET** düğmesi belirir (`Alt+A` ile de açılır/kapanır).

---

## Ne yapar?

- `/ics/player-transactions/page` cevaplarını `fetch` + `XMLHttpRequest` kancasıyla yakalar.
- Aynı `gameTranId` altındaki **birden çok** `GAME_BET` / `GAME_WIN` satırını toplar.
- İptal/geri alma hareketlerini (`*_CANCEL`, `ROLLBACK`, `REFUND`) düşer — tamamen
  iptal edilmiş bir tur artık yanlışlıkla "şüpheli" olarak işaretlenmez.
- `Win / Bet` oranı eşiği geçen turları listeler; tek tıkla tablodaki satıra atlar,
  satırı veya tüm özeti panoya kopyalar, CSV olarak dışa aktarır.

## v5 → v6 farkları

### Doğruluk / mantık
| Konu | Önce | Şimdi |
|---|---|---|
| İptal & geri alma | Yok sayılıyordu → iptal edilmiş tur şüpheli görünüyordu | `VOID` olarak düşülüyor, tur `iptal` etiketiyle işaretleniyor |
| Bet'siz kazanç (freespin/jackpot) | Sessizce eleniyordu | `∞` oranıyla ayrı gösteriliyor (kapatılabilir) |
| Sayfalar arası veri | Her cevap öncekini eziyordu | Satır bazında tekilleştirilip biriktiriliyor (kapatılabilir, 20.000 satır tavanı) |
| XHR yakalama | `readyState 3`'te de okunuyordu (yarım gövde riski) | Yalnızca tamamlanmış, 2xx cevaplar |
| Tarih | Yalnızca `dd-MM-yyyy` metni | epoch (sn/ms), `dd-MM-yyyy`, `dd.MM.yyyy`, ISO |
| Sayı ayrıştırma | Basit virgül/nokta değişimi | TR/EN binlik-ondalık ayırımı, negatif ve `(1.234,50)` biçimi |
| Tür eşleme | Sadece `GAME_BET` / `GAME_WIN` | Jackpot/casino/spor türevleri + bilinmeyen türler için güvenli geri düşüş |
| Para birimi | Sabit `TRY` | Veriden okunur |

### Performans
- **İki aşamalı analiz:** ham satır → tur grupları (ağır, yalnız veri değişince) ve
  tur → filtre sonucu (hafif). Eşiği kaydırmak artık tüm veriyi yeniden taramıyor;
  10.000 turda ölçülen yeniden hesap ~5 ms.
- **Sanal liste:** 60'lık parçalar hâlinde `IntersectionObserver` ile basılır,
  `content-visibility: auto` ile ekran dışı satırlar düzenlenmez.
- **Tek stylesheet + olay devri:** satır içi stil ve satır başına dinleyici yok.
- Arama/eşik/filtre girdileri debounce'lu, sürükle-boyutlandır `requestAnimationFrame` ile.
- Tablo satırı arama artık indeksli; indeks yalnızca DOM değişince geçersizleşir
  (önceden her tıklamada tüm hücreler taranıyordu).
- Panel yeni veri geldiğinde sıfırdan kurulmuyor; arama metni, odak ve kaydırma korunuyor.

### Arayüz
- Sürüklenebilir **ve** yeniden boyutlandırılabilir panel; konum/boyut kalıcı.
- Otomatik / açık / koyu tema.
- Üstte özet kartları: şüpheli tur, toplam kazanç, toplam bet, net, en yüksek oran, en sık oyun.
- Oyun · sağlayıcı · Tran ID üzerinde arama; zaman ↑↓ / oran / kazanç sıralaması.
- Gelişmiş filtreler: min. bet, min. kazanç, bet'siz kazançlar, biriktirme, hariç tutulan sağlayıcılar.
- CSV dışa aktarma (Excel-TR uyumlu, `;` ayraç + BOM), toast bildirimleri, `alert()` yok.
- Klavye: `Alt+A` aç/kapat, `Esc` kapat, `/` aramaya odaklan, listede `Enter` ile satıra git.

## Konsol API'si

```js
GTAiOzet.result()          // son analiz sonucu
GTAiOzet.groups()          // tüm turlar (şüpheli olmayanlar dâhil)
GTAiOzet.rows()            // yakalanan ham işlemler
GTAiOzet.setThreshold(5)   // eşiği değiştir
GTAiOzet.ingest(json)      // elle veri besle (test/doğrulama için)
GTAiOzet.summary()         // panoya kopyalanan özet metni
GTAiOzet.csv()             // CSV indir
GTAiOzet.clear()           // yakalanan veriyi temizle
GTAiOzet.toggle()          // paneli aç/kapat
```

Ayarlar `localStorage` altında `gtAiOzet.settings.v2` anahtarında saklanır; v1 ayarları
(`gtAiOzetSettings_v1`) ilk açılışta otomatik taşınır.

## Testler

Tarayıcı gerektirmeden, asgari bir DOM taklidi üzerinde analiz çekirdeğini doğrular:

```bash
node test/analysis.test.js
```

---

# Betby — Çift Taraf (Hedge) Dedektörü

`betby-hedge-dedektor.user.js` — Betby backoffice'te (`backoffice.sptenv.com`) arka planda
bahis geçmişini tarar ve **aynı maçın aynı marketinde farklı hesaplardan zıt taraf** oynanan
bahisleri (ör. bir hesaptan *Total over 2.5*, diğerinden *under 2.5*) puanlayarak listeler.

**Kurulum:** Tampermonkey / Violentmonkey'e ekleyin, backoffice'e giriş yapın. Sağ altta
**🛡️ Çift Taraf** düğmesi belirir (`Alt+H`). Tarama otomatik başlar; sekmeyi açık bırakmak yeterlidir.

## Nasıl çalışır?

- Oturum token'ı `localStorage['spt-state'] → persistable.users[…].token`'dan okunur
  (sayfanın kendi isteklerindeki `Authorization` başlığı yedek kaynaktır).
- Panelde seçilen **zaman penceresi** (varsayılan *Ay başından*; 12 sa / 24 sa / 3–7–14–30 gün /
  geçen ay başından) hem taranır hem bellekte tutulur. İlk açılışta (ve **⇊ Tümünü tara** ile) pencerenin **tüm sayfaları**
  çekilir; cevaptaki `total`'e ulaşılana ya da boş sayfa gelene kadar devam eder (sunucunun sayfa başı
  sınırı ne olursa olsun). Sonraki taramalar artımlıdır: son taramada görülen en yeni bahis − 5 dk'dan
  itibaren, yeni bahis kalmayınca durur. Sayfanın kendi yüklediği bahisler bu işareti etkilemez. GraphQL ucu, sayfa Apply'a basıldığında kendiliğinden öğrenilir;
  olmazsa `/api/v1/BetSlipsAdmin/betslips/clickhouse` REST ucuna düşer.
- Birden fazla sekme açıksa yalnızca biri tarar (localStorage kilidi).
- Sayfanın kendi bahis geçmişi cevapları da pasif olarak analize eklenir.

## Eşleştirme ve skor

Anahtar: `eventId | marketId | market adı` (+ alt/üst için `total`, handikap için mutlak çizgi).
Farklı oyunculardan farklı taraf → eşleşme. Doğru skor, golcü, aralık vb. çok sonuçlu marketler hariç.

| Sinyal | Puan |
|---|---|
| Alt/üst aynı çizgi / ters handikap | 40 |
| Alt/üst "orta" (over 2.5 ↔ under 3.5) | 25 |
| Alt/üst boşluklu (over 3.5 ↔ under 2.5) | 12 |
| Diğer 2–3 yollu marketlerde farklı sonuç | 20 |
| Aynı IP / aynı /24 ağ | +45 / +15 |
| Bahisler arası ≤1 dk / ≤5 dk / ≤30 dk | +25 / +15 / +6 |
| Olası ödemeler dengeli (≥%85 / ≥%65) | +15 / +7 |
| Aynı hesap çifti N maçta karşılaştı | +15 × (N−1) |
| Kombine ayağı | × 0,6 |

Her oyuncunun yanındaki **GT ↗** düğmesi, oyuncunun GT core profilini
(`core-secundus.gmntc.com/core/app/core/players/{extPlayerId}/detail`) açar. İlk tıklama `gtcore`
adlı yeni bir sekme açar, sonraki tıklamalar aynı sekmeyi kullanır. Ctrl/orta tık yeni sekmede açar.

Varsayılan liste eşiği 50, alarm eşiği 75 (ses + başlık yanıp söner + isteğe bağlı masaüstü bildirimi).

## Konsol API'si

```js
BBHedge.groups()        // eşik üstü maç/market eşleşmeleri
BBHedge.pairs()         // hesap çiftleri (maç sayısı, aynı IP, toplam stake)
BBHedge.scan()          // hemen tara (artımlı)
BBHedge.fullScan()      // geriye dönük tüm pencereyi baştan tara
BBHedge.start() / stop()
BBHedge.set('minScore', 40)
BBHedge.ingest(json)    // getBetHistoryList cevabını elle besle
BBHedge.csv()           // CSV indir
BBHedge.debug()         // öğrenilen uç, token süresi, son hata
BBHedge.openGt('13667023') // GT core profilini aç
```

Testler: `node test/hedge.test.js`
