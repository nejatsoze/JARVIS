# JARVIS — Userscript'ler

| Dosya | Ne yapar |
|---|---|
| `gamingtec-ai-ozet.user.js` | Oyuncu işlemlerinde yüksek `Win/Bet` oranlı turları yakalar |
| `slack-kanal-aynala.user.js` | Bir Slack kanalındaki her mesajı/cevabı başka kanala aynalar |

```bash
node test/analysis.test.js       # AI ÖZET testleri
node test/slack-mirror.test.js   # Slack aynalama testleri
```

---

## GamingTec — AI ÖZET (Yüksek Oranlı Kazanç Dedektörü)

Oyuncu işlem (transactions) ekranındaki ağ trafiğini dinleyip, aynı **Game Tran ID**'ye
ait tüm hareketleri tek bir "tur" altında toplayan ve `Win / Bet` oranı eşiği aşan
turları canlı filtrelenebilir bir panelde gösteren userscript.

**Kurulum:** Tampermonkey / Violentmonkey'e `gamingtec-ai-ozet.user.js` dosyasını ekleyin.
Sayfa açıldığında sağ altta **🤖 AI ÖZET** düğmesi belirir (`Alt+A` ile de açılır/kapanır).

---

### Ne yapar?

- `/ics/player-transactions/page` cevaplarını `fetch` + `XMLHttpRequest` kancasıyla yakalar.
- Aynı `gameTranId` altındaki **birden çok** `GAME_BET` / `GAME_WIN` satırını toplar.
- İptal/geri alma hareketlerini (`*_CANCEL`, `ROLLBACK`, `REFUND`) düşer — tamamen
  iptal edilmiş bir tur artık yanlışlıkla "şüpheli" olarak işaretlenmez.
- `Win / Bet` oranı eşiği geçen turları listeler; tek tıkla tablodaki satıra atlar,
  satırı veya tüm özeti panoya kopyalar, CSV olarak dışa aktarır.

### v5 → v6 farkları

#### Doğruluk / mantık
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

#### Performans
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

#### Arayüz
- Sürüklenebilir **ve** yeniden boyutlandırılabilir panel; konum/boyut kalıcı.
- Otomatik / açık / koyu tema.
- Üstte özet kartları: şüpheli tur, toplam kazanç, toplam bet, net, en yüksek oran, en sık oyun.
- Oyun · sağlayıcı · Tran ID üzerinde arama; zaman ↑↓ / oran / kazanç sıralaması.
- Gelişmiş filtreler: min. bet, min. kazanç, bet'siz kazançlar, biriktirme, hariç tutulan sağlayıcılar.
- CSV dışa aktarma (Excel-TR uyumlu, `;` ayraç + BOM), toast bildirimleri, `alert()` yok.
- Klavye: `Alt+A` aç/kapat, `Esc` kapat, `/` aramaya odaklan, listede `Enter` ile satıra git.

### Konsol API'si

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

### Testler

Tarayıcı gerektirmeden, asgari bir DOM taklidi üzerinde analiz çekirdeğini doğrular:

```bash
node test/analysis.test.js
```


---

## Slack Kanal Aynalama

`C08TKRJQ96G` kanalına düşen **her mesajı ve her thread cevabını** `C0BMBT1A6KX`
kanalına olduğu gibi aktarır. Düzenlemeler hedefte güncellenir, silmeler hedefte de
silinir.

**Kurulum:** Tampermonkey / Violentmonkey'e `slack-kanal-aynala.user.js` dosyasını ekleyin,
Slack'i tarayıcıda (`app.slack.com`) açın. Sağ altta `🔁 ayna 0` rozeti belirir;
tıklayınca duraklar/devam eder.

**Ön koşul:** Slack hesabınız **iki kanalın da üyesi** olmalı. Mesajlar sizin
hesabınızdan gönderilir; script masaüstü uygulamasında değil, tarayıcıda çalışır.

### Nasıl çalışır?

- **Anlık:** Slack'in kendi WebSocket'i `document-start`'ta `Proxy` ile kancalanır;
  kaynak kanala ait `message` olayları anında yakalanır.
- **Kayıpsız:** Sekme uyuduysa ya da soket yeniden bağlandıysa diye her 20 saniyede
  `conversations.history` + `conversations.replies` ile fark taranır. İki yol da aynı
  tekilleştirme havuzuna düşer, aynı mesaj iki kez gönderilmez.
- **Thread yapısı korunur:** Cevap, hedefteki karşılık gelen mesajın thread'ine düşer.
  Üst mesaj henüz aynalanmadıysa önce o aktarılır.
- **Hız sınırı:** Gönderimler tek kuyruktan, aralarında ≥1,2 sn ile çıkar; `429`
  cevabında `Retry-After` kadar beklenip yeniden denenir.
- **Kimlik:** Token, Slack'in kendi `localStorage` yapılandırmasından okunur ve kaynak
  kanalı gerçekten gören oturum seçilir. İstekler tarayıcının kendi oturumuyla, sayfanın
  kendi kaynağına atılır — hiçbir veri dışarı çıkmaz.

### Aktarılan mesajın biçimi

```
*Ada Yılmaz* ↗
orijinal metin (biçimlendirme, emoji, bağlantılar olduğu gibi)
📎 rapor.pdf
```

`↗` orijinal mesajın kalıcı bağlantısıdır. `@channel` / `@here` / `@grup` çağrıları düz
metne indirgenir ve `<@U123>` bahsetmeleri `@ad` olarak yazılır — ayna kanalı her
aktarımda kimseyi uyandırmasın diye. Metni olmayan bot mesajlarında `blocks` /
`attachments` olduğu gibi taşınır.

### Ayarlar

Dosyanın başındaki `CONFIG` bloğu:

| Anahtar | Varsayılan | Açıklama |
|---|---|---|
| `SRC` / `DST` | `C08TKRJQ96G` / `C0BMBT1A6KX` | kaynak ve hedef kanal |
| `INCLUDE_AUTHOR` | `true` | yazar satırı eklensin mi |
| `INCLUDE_PERMALINK` | `true` | yazar satırına orijinal bağlantı |
| `MIRROR_THREADS` | `true` | cevaplar hedefte de thread olsun |
| `MIRROR_EDITS` / `MIRROR_DELETES` | `true` | düzenleme / silme aynalansın mı |
| `KEEP_USER_MENTIONS` | `false` | `true` yaparsanız bahsetmeler gerçek ping olur |
| `BACKFILL_MINUTES` | `0` | ilk açılışta kaç dakikalık geçmiş aktarılsın |
| `POLL_SECONDS` | `20` | yedek yoklama aralığı |
| `POST_INTERVAL_MS` | `1200` | iki gönderim arası asgari bekleme |
| `DEBUG` | `false` | ayrıntılı konsol günlüğü |

İlk çalıştırmada geçmiş **aktarılmaz**; yalnız o andan sonraki mesajlar gider.

### Konsol API'si

```js
SlackMirror.status()      // durum, kuyruk, aktarılan sayısı
SlackMirror.pause()       // duraklat
SlackMirror.resume()      // devam et
SlackMirror.poll()        // hemen bir tarama yap
SlackMirror.resync(60)    // son 60 dakikayı yeniden tara (tekrar göndermez)
SlackMirror.reset()       // hatırlanan mesaj/eşleşme kayıtlarını sil
```

Durum `localStorage` altında `slackMirror.state.<SRC>.<DST>.v1` anahtarında saklanır.

### Testler

WebSocket, `fetch` ve Slack API taklidi üzerinde uçtan uca doğrulama (token elemesi,
tekilleştirme, thread eşleme, düzenleme/silme, yoklama yedeği, duraklatma):

```bash
node test/slack-mirror.test.js
```
