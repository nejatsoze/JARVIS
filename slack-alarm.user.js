// ==UserScript==
// @name         Slack Alarm - 3 Kademeli Toggle
// @namespace    palentis-slack-alarm
// @version      2.1
// @description  Sidebar'da hedef kanal/kişi okunmamış kaldığı sürece tekrarlayan alarm çalar. Kapsam 0 / I / II kademeli kol ile seçilir.
// @match        https://app.slack.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
    'use strict';

    // ============ KADEMELER ============
    const SEVIYE_I = ['admin', 'Anderson', 'Joseph', 'Minerva', 'çekim-talepleri'];

    const SEVIYE_II_EK = [
        'finansal-sorunlar',
        'canlıdestek-ortak',
        'bonus-kontrol',
        'çevrim-kontrol',
        'sifre-yenileme-2fa',
        'cekim-iptal',
        'casino-sorunları',
        'kupon-sorunları',
    ];

    const SEVIYELER = [
        { kisa: '0', ad: 'Kapalı', aciklama: 'Hiçbir kanal için alarm yok', renk: '#94a3b8', liste: [] },
        { kisa: 'I', ad: 'Öncelikli', aciklama: 'Yalnızca kritik kanallar', renk: '#f0a132', liste: SEVIYE_I },
        { kisa: 'II', ad: 'Tam kapsam', aciklama: 'Kritik + operasyon kanalları', renk: '#e4574c', liste: [...SEVIYE_I, ...SEVIYE_II_EK] },
    ];

    // Hedeflerden biri okunmamış kaldığı sürece alarmın kaç saniyede bir tekrar çalacağı.
    const TEKRAR_ARALIGI_SN = 15;

    // Bir hedef sidebar'da bu kadar ardışık taramada bulunamazsa, eski
    // "unread" durumu güvenilmez sayılır ve arayüzde "belirsiz" olarak işaretlenir
    // (Slack DOM'u değişmiş ya da bölüm daraltılmış olabilir).
    const KAYIP_ESIK = 5;

    const KAYIT_SEVIYE = 'palentis_slack_alarm_seviye';
    const KAYIT_KONUM = 'palentis_slack_alarm_konum';

    // Sidebar seçicileri (Slack DOM'u zamanla değişebilir). Birden fazla aday
    // eklenmiştir; Slack bir sürümde class isimlerini değiştirirse diğerleri
    // devreye girsin diye.
    const AD_SELECTOR = [
        '.p-channel_sidebar__name span',
        '.p-channel_sidebar__name',
        '[data-qa="channel_sidebar_name"]',
        '.p-channel_sidebar__link .p-channel_sidebar__name',
    ].join(', ');
    const SATIR_SELECTOR = [
        '.p-channel_sidebar__channel',
        '[role="treeitem"]',
        '[data-qa="virtual-list-item"]',
    ].join(', ');
    const SIDEBAR_SELECTOR = [
        '.p-channel_sidebar__static_list',
        '[data-qa="slack_kit_list"]',
        '.p-channel_sidebar',
    ].join(', ');

    // Sidebar hiç bulunamazsa bu kadar deneme sonra döngü durdurulur ve
    // arayüzde hata durumu gösterilir (sonsuz sessiz döngü yerine).
    const MAX_BASLATMA_DENEMESI = 60; // ~60 sn

    // ============ DURUM ============
    let aktifSeviye = seviyeOku();
    const durum = new Map(); // hedef isim -> { unread: bool, kayipSayisi: number }
    let tekrarTimer = null;
    let sesCtx = null;
    let sesKilitli = true; // gerçek kullanıcı etkileşimi olana kadar true
    let ui = null; // { kapsul, tutamak, durumMetin, kademeler }
    let sidebarBulunduMu = false;

    function seviyeOku() {
        const kayit = parseInt(localStorage.getItem(KAYIT_SEVIYE), 10);
        return Number.isInteger(kayit) && kayit >= 0 && kayit <= 2 ? kayit : 1;
    }

    // Karşılaştırma için normalize: baştaki #, fazla boşluk ve büyük/küçük harf farkı silinir.
    function normalize(metin) {
        return (metin || '').replace(/^#/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function aktifHedefler() {
        return SEVIYELER[aktifSeviye].liste;
    }

    // ============ ALARM SESİ ============
    // Tek bir AudioContext tekrar kullanılıyor: her çalışta yeni context açmak
    // tarayıcı limitine takılıyordu.
    function sesContext() {
        if (!sesCtx) {
            sesCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (sesCtx.state === 'suspended') {
            sesCtx.resume();
        }
        return sesCtx;
    }

    // Tarayıcıların autoplay politikası: AudioContext yalnızca gerçek bir
    // kullanıcı jesti (click/keydown/pointerdown) sırasında resume() edilirse
    // açılır. Otomatik tetiklenen alarmlar (timer/MutationObserver) bu şartı
    // sağlamaz, bu yüzden sayfadaki ilk gerçek etkileşimde sesi önceden açıyoruz.
    function sesKilidiniAcmayaCalis() {
        if (!sesKilitli) return;
        const ctx = sesContext();
        if (ctx.state === 'running') {
            sesKilitli = false;
            uiDurumGuncelle(unreadSayisi());
        }
    }
    ['pointerdown', 'keydown', 'click'].forEach((olay) => {
        window.addEventListener(olay, sesKilidiniAcmayaCalis, { capture: true, passive: true });
    });

    function alarmSesiCal() {
        try {
            const ctx = sesContext();
            const simdi = ctx.currentTime;

            function bip(baslangic, frekans, sure, ses) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'square'; // sine'dan daha keskin, dikkat çekici
                osc.frequency.setValueAtTime(frekans, simdi + baslangic);
                gain.gain.setValueAtTime(0, simdi + baslangic);
                gain.gain.linearRampToValueAtTime(ses, simdi + baslangic + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.001, simdi + baslangic + sure);
                osc.start(simdi + baslangic);
                osc.stop(simdi + baslangic + sure + 0.05);
            }

            // Üç hızlı çift-tonlu bip: normal Slack bildirim sesinden net ayrışsın diye.
            [0, 0.3, 0.6].forEach((t) => {
                bip(t, 1500, 0.18, 0.3);
                bip(t + 0.18, 1100, 0.18, 0.3);
            });
        } catch (e) {
            console.log('Alarm sesi çalma hatası:', e);
        }
    }

    // ============ YARDIMCI: bir isim elementi unread mi? ============
    function unreadMi(isimEl) {
        const stil = window.getComputedStyle(isimEl);
        if (stil.fontWeight === '700' || stil.fontWeight === 'bold' || stil.fontWeight === '800') {
            return true;
        }
        const satir = isimEl.closest(SATIR_SELECTOR);
        if (satir) {
            const classListesi = satir.className || '';
            const ariaLabel = (satir.getAttribute('aria-label') || '').toLowerCase();
            if (
                classListesi.includes('unread') ||
                ariaLabel.includes('unread') ||
                ariaLabel.includes('okunmamış') ||
                /\b[1-9]\d*\s*(unread|okunmamış)/.test(ariaLabel)
            ) {
                return true;
            }
            // Slack farklı sürümlerde badge'i ayrı bir alt eleman olarak render eder.
            if (satir.querySelector('[data-qa*="unread"], .p-channel_sidebar__badge')) {
                return true;
            }
        }
        return false;
    }

    // ============ TEKRARLAYAN ALARM TIMER'I ============
    function unreadSayisi() {
        return [...durum.values()].filter((d) => d.unread).length;
    }

    function belirsizSayisi() {
        return [...durum.values()].filter((d) => d.kayipSayisi >= KAYIP_ESIK).length;
    }

    function tekrarTimeriGuncelle() {
        const sayi = unreadSayisi();

        if (sayi > 0 && !tekrarTimer) {
            alarmSesiCal(); // ilk tetiklemede hemen çal
            tekrarTimer = setInterval(() => {
                if (unreadSayisi() > 0) {
                    alarmSesiCal();
                } else {
                    timeriDurdur();
                }
            }, TEKRAR_ARALIGI_SN * 1000);
        } else if (sayi === 0 && tekrarTimer) {
            timeriDurdur();
        }

        uiDurumGuncelle(sayi);
    }

    function timeriDurdur() {
        if (tekrarTimer) {
            clearInterval(tekrarTimer);
            tekrarTimer = null;
        }
    }

    // ============ SIDEBAR TARAMA ============
    function taramaYap() {
        const hedefler = aktifHedefler();

        if (hedefler.length === 0) {
            durum.clear();
            timeriDurdur();
            uiDurumGuncelle(0);
            return;
        }

        const bulunanlar = new Set();

        for (const el of document.querySelectorAll(AD_SELECTOR)) {
            const metin = normalize(el.textContent);
            const eslesen = hedefler.find((h) => normalize(h) === metin);
            if (!eslesen) continue;

            bulunanlar.add(eslesen);
            durum.set(eslesen, { unread: unreadMi(el), kayipSayisi: 0 });
        }

        // Bu turda sidebar'da görünmeyen hedefler: hiç kaydı yoksa "read"
        // varsayımıyla başlat; kaydı varsa ardışık kayıp sayacını artır ve
        // eski unread durumunu koru (geçici DOM kaybı ihtimaline karşı) —
        // ancak eşik aşılırsa arayüzde "belirsiz" olarak işaretle ki alarm
        // sessizce ve kalıcı biçimde takılı kalmasın.
        for (const hedef of hedefler) {
            if (bulunanlar.has(hedef)) continue;
            const mevcut = durum.get(hedef);
            if (!mevcut) {
                durum.set(hedef, { unread: false, kayipSayisi: 0 });
            } else {
                mevcut.kayipSayisi += 1;
            }
        }

        // Kademe düşürüldüğünde eski hedefler durumda kalmasın.
        for (const anahtar of [...durum.keys()]) {
            if (!hedefler.includes(anahtar)) durum.delete(anahtar);
        }

        tekrarTimeriGuncelle();
    }

    // ============ KADEME DEĞİŞTİRME ============
    function seviyeAyarla(yeni, sesTesti) {
        aktifSeviye = yeni;
        localStorage.setItem(KAYIT_SEVIYE, String(yeni));
        durum.clear();
        timeriDurdur();
        uiKademeGuncelle();
        taramaYap();
        // Kullanıcı etkileşimi varken AudioContext'i uyandır (otomatik oynatma politikası).
        if (sesTesti && yeni > 0) sesKilidiniAcmayaCalis();
    }

    // ============ ARAYÜZ ============
    // Kademeli bir saha ekipmanı kolu: kol yukarı çıktıkça kapsam genişler,
    // renk sakinden acile döner. Alarm çalarken kol halkası nabız gibi atar.
    function uiKur() {
        const host = document.createElement('div');
        host.id = 'palentis-alarm-kolu';
        host.style.cssText = 'position:fixed;z-index:2147483000;bottom:88px;right:18px;';

        const konum = localStorage.getItem(KAYIT_KONUM);
        if (konum) {
            try {
                const { x, y } = JSON.parse(konum);
                const genislik = 78; // kapsül + kenar payı tahmini
                const yukseklik = 130;
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    // Kaydedilen konum farklı bir ekran/pencere boyutundan kalmış
                    // olabilir; görünür alanın dışına taşıyorsa yok say — aksi
                    // halde widget ekran dışında "kayboluyor".
                    const gecerliX = Math.min(Math.max(x, 0), window.innerWidth - genislik);
                    const gecerliY = Math.min(Math.max(y, 0), window.innerHeight - yukseklik);
                    host.style.cssText = `position:fixed;z-index:2147483000;left:${gecerliX}px;top:${gecerliY}px;`;
                } else {
                    localStorage.removeItem(KAYIT_KONUM);
                }
            } catch (e) {
                localStorage.removeItem(KAYIT_KONUM); // bozuk kayıt: temizle, varsayılan konumda kal
            }
        }

        const kok = host.attachShadow({ mode: 'open' });
        kok.innerHTML = `
            <style>
                :host, * { box-sizing: border-box; }
                .kapsul {
                    width: 62px;
                    padding: 8px 8px 10px;
                    border-radius: 16px;
                    background: rgba(18, 21, 28, 0.92);
                    border: 1px solid rgba(255, 255, 255, 0.09);
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
                    font-family: "Lato", "Segoe UI", system-ui, sans-serif;
                    color: #cbd5e1;
                    user-select: none;
                    backdrop-filter: blur(6px);
                }
                .tut {
                    height: 10px;
                    margin: 0 auto 8px;
                    width: 22px;
                    border-radius: 6px;
                    background: repeating-linear-gradient(
                        to bottom,
                        rgba(255,255,255,0.22) 0 1px,
                        transparent 1px 3px
                    );
                    cursor: grab;
                }
                .tut:active { cursor: grabbing; }

                .ray {
                    position: relative;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    padding: 4px;
                    border-radius: 12px;
                    background: #0b0e14;
                    border: 1px solid rgba(255,255,255,0.06);
                    box-shadow: inset 0 2px 6px rgba(0,0,0,0.6);
                }
                .kademe {
                    position: relative;
                    z-index: 2;
                    height: 34px;
                    border: 0;
                    background: transparent;
                    color: #5b6678;
                    font: 600 13px/1 "Lato", system-ui, sans-serif;
                    letter-spacing: 0.04em;
                    cursor: pointer;
                    border-radius: 9px;
                    transition: color 160ms ease;
                }
                .kademe:hover { color: #93a2b8; }
                .kademe:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
                .kademe[aria-checked="true"] { color: #0b0e14; }

                .kol {
                    position: absolute;
                    z-index: 1;
                    left: 4px;
                    right: 4px;
                    height: 34px;
                    border-radius: 9px;
                    background: var(--renk);
                    box-shadow: 0 2px 10px color-mix(in srgb, var(--renk) 55%, transparent);
                    transition: transform 320ms cubic-bezier(.34,1.56,.64,1), background 220ms ease;
                }
                .kapsul[data-seviye="2"] .kol { transform: translateY(0); }
                .kapsul[data-seviye="1"] .kol { transform: translateY(36px); }
                .kapsul[data-seviye="0"] .kol { transform: translateY(72px); }

                .durum {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    margin-top: 9px;
                    font-size: 9.5px;
                    line-height: 1.25;
                    color: #7d8a9e;
                }
                .nokta {
                    flex: 0 0 auto;
                    width: 6px; height: 6px;
                    border-radius: 50%;
                    background: var(--renk);
                }
                .metin { overflow-wrap: anywhere; }

                .kapsul.calar .kol {
                    animation: nabiz 1.1s ease-in-out infinite;
                }
                .kapsul.calar .nokta {
                    animation: nabiz 1.1s ease-in-out infinite;
                }
                .kapsul.uyari .nokta { background: #f59e0b; }
                @keyframes nabiz {
                    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--renk) 70%, transparent); }
                    50%      { box-shadow: 0 0 0 7px color-mix(in srgb, var(--renk) 0%, transparent); }
                }
                @media (prefers-reduced-motion: reduce) {
                    .kol { transition: none; }
                    .kapsul.calar .kol, .kapsul.calar .nokta { animation: none; }
                }
            </style>
            <div class="kapsul" data-seviye="1" style="--renk:#f0a132">
                <div class="tut" title="Sürükleyerek taşı"></div>
                <div class="ray" role="radiogroup" aria-label="Alarm kapsamı">
                    <div class="kol"></div>
                    <button class="kademe" role="radio" data-i="2">II</button>
                    <button class="kademe" role="radio" data-i="1">I</button>
                    <button class="kademe" role="radio" data-i="0">0</button>
                </div>
                <div class="durum">
                    <span class="nokta"></span>
                    <span class="metin">Sidebar aranıyor…</span>
                </div>
            </div>
        `;

        document.body.appendChild(host);

        ui = {
            host,
            kapsul: kok.querySelector('.kapsul'),
            metin: kok.querySelector('.metin'),
            kademeler: [...kok.querySelectorAll('.kademe')],
        };

        ui.kademeler.forEach((btn) => {
            btn.addEventListener('click', () => seviyeAyarla(parseInt(btn.dataset.i, 10), true));
        });

        surukleBagla(host, kok.querySelector('.tut'));

        // Alt+Shift+A ile kademeler arasında dolaş.
        window.addEventListener('keydown', (e) => {
            if (e.altKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
                e.preventDefault();
                seviyeAyarla((aktifSeviye + 1) % 3, true);
            }
        });

        uiKademeGuncelle();
    }

    function surukleBagla(host, tutamak) {
        let baslangic = null;
        tutamak.addEventListener('pointerdown', (e) => {
            const kutu = host.getBoundingClientRect();
            baslangic = { fareX: e.clientX, fareY: e.clientY, x: kutu.left, y: kutu.top };
            tutamak.setPointerCapture(e.pointerId);
        });
        tutamak.addEventListener('pointermove', (e) => {
            if (!baslangic) return;
            const kutu = host.getBoundingClientRect();
            const x = Math.min(Math.max(4, baslangic.x + (e.clientX - baslangic.fareX)), window.innerWidth - kutu.width - 4);
            const y = Math.min(Math.max(4, baslangic.y + (e.clientY - baslangic.fareY)), window.innerHeight - kutu.height - 4);
            host.style.left = x + 'px';
            host.style.top = y + 'px';
            host.style.right = 'auto';
            host.style.bottom = 'auto';
        });
        tutamak.addEventListener('pointerup', () => {
            if (!baslangic) return;
            baslangic = null;
            const kutu = host.getBoundingClientRect();
            localStorage.setItem(KAYIT_KONUM, JSON.stringify({ x: kutu.left, y: kutu.top }));
        });
    }

    function uiKademeGuncelle() {
        if (!ui) return;
        const seviye = SEVIYELER[aktifSeviye];
        ui.kapsul.dataset.seviye = String(aktifSeviye);
        ui.kapsul.style.setProperty('--renk', seviye.renk);
        ui.kademeler.forEach((btn) => {
            btn.setAttribute('aria-checked', btn.dataset.i === String(aktifSeviye) ? 'true' : 'false');
        });
        ui.host.title = `${seviye.kisa} · ${seviye.ad} — ${seviye.aciklama}`;
    }

    function uiDurumGuncelle(sayi) {
        if (!ui) return;

        if (!sidebarBulunduMu) {
            ui.kapsul.classList.remove('calar');
            ui.kapsul.classList.add('uyari');
            ui.metin.textContent = 'Sidebar bulunamadı — Slack DOM değişmiş olabilir';
            return;
        }

        const seviye = SEVIYELER[aktifSeviye];
        ui.kapsul.classList.toggle('calar', sayi > 0);

        const belirsiz = belirsizSayisi();
        ui.kapsul.classList.toggle('uyari', belirsiz > 0 && sayi === 0);

        if (sesKilitli) {
            ui.metin.textContent = '🔇 Ses kilitli — sayfaya tıklayın';
        } else if (aktifSeviye === 0) {
            ui.metin.textContent = 'Alarm kapalı';
        } else if (sayi > 0) {
            ui.metin.textContent = `${sayi} kanal bekliyor` + (belirsiz > 0 ? ` (${belirsiz} belirsiz)` : '');
        } else if (belirsiz > 0) {
            ui.metin.textContent = `${belirsiz} kanal bulunamıyor (kontrol edin)`;
        } else {
            ui.metin.textContent = `${seviye.liste.length} kanal tetikte`;
        }
    }

    // ============ MUTATIONOBSERVER ============
    let debounceHandle = null;
    function debounceliTarama() {
        if (debounceHandle) return;
        debounceHandle = setTimeout(() => {
            debounceHandle = null;
            taramaYap();
        }, 300);
    }

    function gozlemciyiBaslat() {
        const hedefKonteyner = document.querySelector(SIDEBAR_SELECTOR) || document.body;
        const observer = new MutationObserver(debounceliTarama);
        observer.observe(hedefKonteyner, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'aria-label', 'style'],
        });
        taramaYap(); // ilk yükleme taraması
    }

    // Slack SPA'sı geç yükleniyor; sidebar hazır olana kadar kısa aralıklarla dene.
    // Widget baştan gösterilir ki selectors Slack güncellemesiyle bozulduğunda
    // script "hiç çalışmıyormuş" gibi sessizce durmasın, hata durumu görünür olsun.
    if (!document.getElementById('palentis-alarm-kolu')) uiKur();

    let deneme = 0;
    const baslatmaDenemesi = setInterval(() => {
        deneme += 1;
        if (document.querySelector(AD_SELECTOR)) {
            clearInterval(baslatmaDenemesi);
            sidebarBulunduMu = true;
            gozlemciyiBaslat();
        } else if (deneme >= MAX_BASLATMA_DENEMESI) {
            clearInterval(baslatmaDenemesi);
            console.warn(
                '[Slack Alarm] Sidebar seçicileri eşleşmedi (AD_SELECTOR):',
                AD_SELECTOR,
                '— Slack arayüzü güncellenmiş olabilir, script içindeki seçicileri güncel DOM ile karşılaştırın.'
            );
            uiDurumGuncelle(0);
        }
    }, 1000);
})();
