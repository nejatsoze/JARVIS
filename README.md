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
