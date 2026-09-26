// ==UserScript==
// @name         GT Withdrawals — çekim masası
// @namespace    palentis.gt
// @version      1.0.10
// @description  Çekim sayfalarının tek sahibi: keep-alive, satır tıklama, zaman aşımı otomatik reddi (OTORED), tek tıkla şablonlu red, ONAY butonu, red şablonu kısayolları; oyuncu çekim popup'ında sade liste + işlem detayı ipucu, yatırım geçmişi popup'ında sütun/metin temizliği ve sağlayıcı adları. GT Core üzerine kurulur. Dört ayrı scriptin (Keep-Alive, Full Row Click, OTORED, Auto Process) birleşiğidir — o dördünü kapat.
// @match        https://core-secundus.gmntc.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
'use strict';

const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

(W.__GT__ = W.__GT__ || []).push((GT) => {

const { h, $, $$, txt, css, log, warn, oops, at, parseTrDate } = GT;

/* ════════════════════════════════════════════════════════════
   PAYLAŞILAN ÇEKİM KATMANI
   Eskiden OTORED ve Auto Process bu mantığı birbirinden bağımsız
   iki kopya halinde taşıyordu. Tek kopya artık:
   · status karşılaştırması büyük/küçük harf duyarsız ("PENDING"
     vs "Pending" farkı iki scripti farklı sonuçlara götürüyordu),
   · inFlight kilidi ORTAK — otomatik red ile elle red aynı
     ödemeye aynı anda POST atamaz.
   ════════════════════════════════════════════════════════════ */

const REASONS = {
    IP:   'Çoklu hesap veya IP çakismasi tespit edilmesi sebebiyle, kurallar geregince promosyon iptal edilmis ve elde edilen kazanç geçersiz sayilmistir.',
    PT:   'Daha önce etkinlik kapsamında çekim yapıldıysa veya etkinlikten 5 kez faydalanılıp yatırım yapılmadıysa, yeni bir yatırım yaparak etkinliklerden tekrar faydalanabilirsiniz.',
    KYC:  'Profilinizdeki "Doğrulama" bölümünden, kimliğinizin veya ehliyetinizin fotoğrafını yükleyerek hesabınızı doğrulayabilirsiniz. Fotoğrafta TC kimlik no, ad, soyad ve doğum tarihi net görünmelidir. Bulanık, eksik veya karanlık fotoğraflar reddedilecektir.',
    HVL1: 'Lütfen Havale 1 yöntemiyle yeniden talep iletiniz.',
    FORM: 'Çekim talep formunuz hatalıdır. Chrome tarayıcısı ile giriş yaptığınızdan ve IBAN numarasını yazarken boşluk bırakmadığınızdan emin olunuz.',
};

/** Kısayol → şablon. Auto Process'teki Alt+1/2/3/H/G ile birebir aynı. */
const SHORTCUTS = { '1': 'IP', '2': 'PT', '3': 'KYC', h: 'HVL1', g: 'FORM' };

const inFlight = new Set();

/**
 * Listedeki bekleyen çekim satırları. Kolon sırası değişse de link'ten okur.
 * limit: sadece ilk N tanesi lazımsa erken çık — sayfa boyutu 1000'e
 * ayarlıyken tüm tabloyu her turda gezmek pahalı.
 */
function pendingRows(limit = Infinity) {
    const out = [];
    for (const row of $$('tbody.tbody > tr')) {
        if (out.length >= limit) break;
        const cells = row.cells;
        if (cells.length < 5) continue;
        if (txt(cells[4]).toUpperCase() !== 'PENDING') continue;

        const link = row.querySelector('a[href*="ProcessWithdrawal.action"]');
        if (!link) continue;

        let params;
        try { params = new URL(link.getAttribute('href'), location.origin).searchParams; }
        catch { continue; }

        const paymentid = params.get('paymentid');
        const partyId = params.get('partyId');
        if (!paymentid || !partyId) continue;

        out.push({ row, link, paymentid, partyId, requestedAt: parseTrDate(txt(cells[0])) });
    }
    return out;
}

/**
 * Onay penceresi açmadan reddet: sayfayı GET ile çekip tek kullanımlık
 * _sourcePage / __fp token'larını al, sonra reject POST'unu gönder.
 */
async function reject(paymentid, partyId, reasonText) {
    if (inFlight.has(paymentid)) throw new Error('bu ödeme zaten işleniyor');
    inFlight.add(paymentid);
    try {
        const base = `${GT.api.HOST}/j/ProcessWithdrawal.action?embeddedInNewDashboard=true`
            + `&paymentid=${encodeURIComponent(paymentid)}&partyId=${encodeURIComponent(partyId)}`;

        const page = await fetch(base, { credentials: 'same-origin' });
        if (!page.ok) throw new Error('GET başarısız (HTTP ' + page.status + ')');
        const doc = new DOMParser().parseFromString(await page.text(), 'text/html');

        const sourcePage = doc.querySelector('input[name="_sourcePage"]')?.value;
        const fp = doc.querySelector('input[name="__fp"]')?.value;
        if (!sourcePage || !fp) throw new Error('_sourcePage / __fp yok (sayfa yapısı değişmiş olabilir)');

        const body = new URLSearchParams({
            partyId, paymentid, embeddedInNewDashboard: 'true',
            reject_reason: reasonText, reject: 'Reject Unprocessed',
            _sourcePage: sourcePage, __fp: fp,
        });

        const res = await fetch(`${GT.api.HOST}/j/ProcessWithdrawal.action`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        if (!res.ok) throw new Error('POST başarısız (HTTP ' + res.status + ')');
        return true;
    } finally {
        inFlight.delete(paymentid);
    }
}

css('gt-wd-style', `
#gt-otored{margin-left:8px}
#gt-otored .gt-dot{background:currentColor}

.gt-quick-reject{display:flex; flex-direction:column; align-items:stretch; gap:4px; margin-top:6px}
.gt-quick-reject[data-busy="1"]{pointer-events:none; opacity:.6}

/* ONAY hücredeki birincil aksiyon: tek dolu buton; red şablonları tonlu alternatifler. */
a.gt-onay{
  display:flex !important; align-items:center; justify-content:center; box-sizing:border-box;
  min-height:24px; margin-bottom:4px; padding:0 12px; font-family:var(--gt-font); font-size:11.5px;
  font-weight:700; line-height:1; background:#1e7b34; color:#fff !important; border:1px solid #1e7b34;
  border-radius:7px; text-decoration:none !important; white-space:nowrap; cursor:pointer;
  transition:background-color .12s}
a.gt-onay:hover{background:#186a2c; border-color:#186a2c}
a.gt-onay:focus-visible{outline:2px solid #0071e3; outline-offset:2px}

#gt-keepalive{position:fixed; bottom:20px; right:20px; z-index:999999; display:flex; align-items:center;
  gap:8px; padding:10px 16px; background:#fff; border:.5px solid var(--gt-line); border-radius:var(--gt-r);
  box-shadow:0 2px 12px rgba(0,0,0,.08); font-family:var(--gt-font); font-size:13px; color:var(--gt-ink)}
#gt-keepalive .gt-dot{background:var(--gt-accent); transition:background .2s}
`);

/* ════════════════════════════════════════════════════════════
   1 · SATIRIN TAMAMI TIKLANABİLİR
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'wd-row-click',
    scope: 'both',   // klasik liste iframe içinde render ediliyor
    match: at.pending,
    source: 'withdrawals',
    setup(ctx) {
        ctx.each('tr[id^="pending_withdrawals_row"]', (row) => {
            const link = row.querySelector('a.core-tab-player-detail');
            if (!link) return;
            row.style.cursor = 'pointer';
            ctx.on(row, 'click', (e) => {
                // Kendi butonlarımıza basıldığında oyuncu detayına atlama.
                if (e.target.closest('.gt-quick-reject, .gt-onay, #gt-otored, .pw-badge, .gt-badge')) return;
                link.click();
            });
            ctx.on(row, 'mouseenter', () => { row.style.backgroundColor = 'rgba(0,123,255,.06)'; });
            ctx.on(row, 'mouseleave', () => { row.style.backgroundColor = ''; });
        }, { lazy: true });
    },
});

/* ════════════════════════════════════════════════════════════
   2 · OTORED — zaman aşımına uğrayan talepleri sessizce reddet
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'wd-auto-reject',
    scope: 'both',   // klasik liste iframe içinde render ediliyor
    match: at.pending,
    source: 'withdrawals',
    setup(ctx) {
        const TIMEOUT_MIN = 20;
        const SCAN_MS = 15000;
        const KEY = 'gt_otored_enabled';

        const enabled = () => localStorage.getItem(KEY) !== 'false'; // varsayılan açık

        function paint(btn) {
            const on = enabled();
            btn.dataset.on = on ? '1' : '0';
            btn.className = on ? 'gt-btn gt-btn--sm gt-btn--success is-active' : 'gt-btn gt-btn--sm';
            btn.innerHTML = '';
            btn.append(h('span', { class: 'gt-dot' }), on ? 'OTORED açık' : 'OTORED kapalı');
            btn.title = on
                ? `${TIMEOUT_MIN} dakikayı geçen bekleyen talepler FORM şablonuyla otomatik reddediliyor`
                : 'Otomatik red kapalı';
        }

        ctx.mount('input[name="reset"]', 'gt-otored', () => {
            const btn = h('button', { type: 'button' });
            paint(btn);
            btn.addEventListener('click', () => {
                localStorage.setItem(KEY, enabled() ? 'false' : 'true');
                paint(btn);
                log(`OTORED ${enabled() ? 'açıldı' : 'kapatıldı'}.`);
            });
            return btn;
        }, 'after');

        async function sweep() {
            if (!enabled()) return;
            const limit = TIMEOUT_MIN * 60000;
            const now = Date.now();

            for (const item of pendingRows()) {
                if (!item.requestedAt) continue;
                if (inFlight.has(item.paymentid)) continue;
                const waited = now - item.requestedAt.getTime();
                if (waited < limit) continue;

                try {
                    await reject(item.paymentid, item.partyId, REASONS.FORM);
                    log(`OTORED · ${item.paymentid} reddedildi (${Math.round(waited / 60000)} dk bekledi).`);
                    item.row.remove();
                } catch (e) {
                    oops('OTORED ·', item.paymentid, e.message);
                }
            }
        }

        ctx.interval(sweep, SCAN_MS);
        sweep();
    },
});

/* ════════════════════════════════════════════════════════════
   3 · HIZLI RED — oyuncu detayındaki çekim popup'ında
   (…/detail/(popup:player-withdrawals)) en üstteki bekleyen talebe
   şablon butonları. Ana Pending Withdrawals listesinde ÇIKMAZ.
   ════════════════════════════════════════════════════════════ */
/** Üst pencerenin adresi — popup içeriği iframe'de olsa da popup rotası okunur. */
function topHref() {
    try { return window.top.location.href; } catch { return location.href; }
}
const inWithdrawalPopup = () => topHref().includes('popup:player-withdrawals');

GT.define({
    id: 'wd-quick-reject',
    scope: 'both',   // popup içeriği iframe içinde render olabiliyor
    match: inWithdrawalPopup,
    source: 'withdrawals',
    setup(ctx) {
        const LABELS = ['IP', 'PT', 'KYC', 'HVL1', 'FORM'];

        async function run(item, label, box) {
            if (!confirm(`Talep "${label}" şablonuyla reddedilecek.\n\nOnaylıyor musun?`)) return;

            const restore = box.innerHTML;
            box.dataset.busy = '1';
            box.innerHTML = '<span style="font-size:12px;color:var(--gt-muted)">İşleniyor…</span>';
            try {
                await reject(item.paymentid, item.partyId, REASONS[label]);
                item.row.remove(); // sonraki bekleyen satır butonları kendiliğinden alır
            } catch (e) {
                oops('[Hızlı red]', e);
                alert('İşlem tamamlanamadı: ' + e.message);
                box.innerHTML = restore;
                delete box.dataset.busy;
            }
        }

        function build(item) {
            const box = h('div', { class: 'gt-quick-reject', dataset: { paymentid: item.paymentid } });
            for (const label of LABELS) {
                box.append(GT.ui.button({
                    label, variant: 'danger', small: true,
                    title: `${label} şablonuyla reddet`,
                    onClick: () => run(item, label, box),
                }));
            }
            return box;
        }

        /** Process linkini yeşil ONAY butonuna çevirir; href aynı kaldığı için
         *  sayfanın kendi popup davranışı bozulmaz. */
        function styleOnay(item) {
            for (const old of $$('a.gt-onay')) {
                if (old.closest('tr') === item.row) continue;
                old.classList.remove('gt-onay');
                old.innerHTML = '<img src="/j/static/images/folder.gif" title="Process" alt="Process">';
            }
            const link = item.row.querySelector('a[href*="ProcessWithdrawal.action"]:not(.gt-onay)');
            if (!link) return;
            link.classList.add('gt-onay');
            link.textContent = 'ONAY';
            link.title = 'Onayla';
        }

        ctx.tick(() => {
            const [top] = pendingRows(1);
            const existing = $('.gt-quick-reject');

            if (!top) { existing?.remove(); return; }
            GT.ensureStyles?.(top.row.ownerDocument);
            if (existing?.dataset.paymentid === top.paymentid && existing.isConnected) {
                styleOnay(top);
                return;
            }
            existing?.remove();

            const cell = top.row.querySelector('td:last-child');
            if (!cell) return;
            cell.append(ctx.own(build(top)));
            styleOnay(top);
        }, { lazy: true });

        ctx.onDestroy(() => {
            for (const link of $$('a.gt-onay')) {
                link.classList.remove('gt-onay');
                link.innerHTML = '<img src="/j/static/images/folder.gif" title="Process" alt="Process">';
            }
        });
    },
});

/* ════════════════════════════════════════════════════════════
   4 · RED ŞABLONU KISAYOLLARI (Alt+1/2/3/H/G)
   Yalnızca imleç bir metin alanındayken çalışır — bu yüzden core'un
   genel kısayol defterine değil, kendi dinleyicisine bağlı. Böylece
   Alt+1 sayfanın başka yerinde hiçbir şeyi tetiklemez.
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'wd-reason-snippets',
    scope: 'both',   // klasik liste iframe içinde render ediliyor
    source: 'withdrawals',
    setup(ctx) {
        const editable = (el) =>
            el && (el.tagName === 'TEXTAREA'
                || (el.tagName === 'INPUT' && /^(text|email|search|tel|url)$/i.test(el.type))
                || el.isContentEditable);

        ctx.on(document, 'keydown', (e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey) return;
            const el = document.activeElement;
            if (!editable(el)) return;

            const key = (e.key || '').toLowerCase();
            const label = SHORTCUTS[key];
            if (!label) return;

            e.preventDefault();
            const text = REASONS[label];

            if (el.isContentEditable) {
                document.execCommand('insertText', false, text);
                return;
            }
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? el.value.length;
            el.value = el.value.slice(0, start) + text + el.value.slice(end);
            el.selectionStart = el.selectionEnd = start + text.length;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { capture: true });
    },
});

/* ════════════════════════════════════════════════════════════
   5 · İŞLEM POPUP'I — Deposit History panelini gizle
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'wd-popup-cleanup',
    scope: 'both',   // klasik liste iframe içinde render ediliyor
    source: 'withdrawals',
    setup(ctx) {
        ctx.tick(() => {
            const textarea = $('#reject_reason') || $('textarea[name="reject_reason"]');
            if (!textarea) return;
            const scope = textarea.closest('mat-dialog-container, [role="dialog"], .modal-content, .modal, .cdk-overlay-pane') || document;
            for (const panel of $$('.panel', scope)) {
                if (txt(panel.querySelector('.header')) !== 'Deposit History') continue;
                panel.style.display = 'none';
            }
        }, { lazy: true });
    },
});

/* ════════════════════════════════════════════════════════════
   6 · OTURUM KORUMASI — "Continue Session" diyaloğu
   Her sayfada geçerli: oturum her yerde düşebilir.
   ════════════════════════════════════════════════════════════ */
const session = (() => {
    const docs = () => {
        const list = [document];
        for (const frame of document.querySelectorAll('iframe')) {
            try { if (frame.contentDocument) list.push(frame.contentDocument); } catch { /* cross-origin */ }
        }
        return list;
    };

    function button(root) {
        const dialog = root.querySelector('session-termination');
        if (!dialog) return null;
        const actions = dialog.querySelector('.session-termination__content__actions');
        if (actions) {
            const primary = actions.querySelector('button[color="primary"].mat-flat-button');
            if (primary) return primary;
            const all = actions.querySelectorAll('button');
            if (all.length >= 2) return all[all.length - 1];
        }
        return Array.from(dialog.querySelectorAll('button')).find(b => b.textContent.includes('Continue Session')) || null;
    }

    let warnedNoButton = false;

    return {
        keepAlive(tag) {
            for (const doc of docs()) {
                if (!doc.querySelector('session-termination')) continue;
                const btn = button(doc);
                if (!btn) {
                    if (!warnedNoButton) { warnedNoButton = true; GT.flight.log?.('oturum', 'diyalog var, Continue butonu bulunamadı'); }
                    continue;
                }
                btn.click();
                warnedNoButton = false;
                log(`Continue Session tıklandı (${tag}).`);
                GT.flight.log?.('oturum', `Continue Session tıklandı (${tag})`);
                return true;
            }
            return false;
        },

        /** Sitenin hareketsizlik sayacı fare/klavye olaylarını dinliyor: sahte bir
         *  mousemove sayacı sıfırlar, diyalog hiç açılmaz. keydown kullanılmıyor —
         *  sayfanın/çekirdeğin kısayollarını tetikleyebilir. */
        nudge() {
            for (const doc of docs()) {
                const target = doc.body || doc.documentElement;
                const View = doc.defaultView;
                if (!target || !View) continue;
                target.dispatchEvent(new View.MouseEvent('mousemove', {
                    bubbles: true, clientX: 2 + Math.floor(Math.random() * 6), clientY: 2 + Math.floor(Math.random() * 6),
                }));
            }
        },
    };
})();

/** Gizli sekmede rAF hiç çalışmaz, setInterval dakikada bire kısılır; Worker
 *  zamanlayıcısı kısılmaz. Worker açılamazsa (CSP) normal aralığa düşer. */
function workerClock(ctx, fn) {
    try {
        const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000);'], { type: 'application/javascript' }));
        const worker = new Worker(url);
        URL.revokeObjectURL(url);
        ctx.own(worker); // ctx.destroy → worker.terminate()
        worker.onmessage = fn;
    } catch (e) {
        warn('Worker açılamadı, setInterval kullanılıyor:', e);
        ctx.interval(fn, 1000);
    }
}

GT.define({
    id: 'wd-session-guard',
    source: 'withdrawals',
    setup(ctx) {
        // Her sayfada: sekme arka plandayken de saniyede bir diyaloğa bak,
        // 50–70 sn'de bir hareketsizlik sayacını sıfırla.
        const nextNudge = () => 50 + Math.floor(Math.random() * 21);
        let sinceNudge = 0, nudgeAt = nextNudge();
        workerClock(ctx, () => {
            session.keepAlive('saat');
            if (++sinceNudge < nudgeAt) return;
            session.nudge();
            sinceNudge = 0; nudgeAt = nextNudge();
        });
    },
});

/**
 * TEŞHİS ANAHTARI — Tampermonkey dosya geçmişi tutmadığı için "eski hâline
 * dön" diye ayrı bir kopya taşımak yerine, iki davranış da burada, tek
 * satırla değişiyor:
 *   'pending' → sadece Çekimler sayfasında bastırır (şu anki, dar kapsam)
 *   'global'  → her sayfada bastırır (önceki, geniş kapsam — şüpheli olan)
 * Test için: bu satırı 'global' yap, kaydet, sayfayı yenile, oyuncu
 * detayında döngü geri geliyor mu bak. Sonra 'pending'e döndür.
 */
const VISIBILITY_GUARD_SCOPE = 'pending'; // 'pending' | 'global'

/**
 * Sekme arka planda sayılmasın — Keep-Alive sayacı için gerekli. Önceden bu
 * bastırma HER SAYFADA çalışıyordu (modülün match'i yoktu). Sitenin kendi
 * SSO/oturum yenileme akışı visibilitychange sinyaline dayanıyorsa, bunu
 * global boğmak o akışı bozup beklenmedik bir yenileme döngüsüne yol
 * açabilir — VISIBILITY_GUARD_SCOPE='global' ile bunu yeniden test edebilirsin.
 */
GT.define({
    id: 'wd-visibility-guard',
    match: VISIBILITY_GUARD_SCOPE === 'global' ? undefined : at.pending,
    source: 'withdrawals',
    setup(ctx) {
        ctx.on(window, 'visibilitychange', (e) => e.stopImmediatePropagation(), { capture: true });
        ctx.on(window, 'blur', (e) => e.stopImmediatePropagation(), { capture: true });
    },
});

/* ════════════════════════════════════════════════════════════
   7 · KEEP-ALIVE — listeyi düzenli aralıklarla tazele
   Sayaç bir Web Worker'da döner; sekme arka plandayken tarayıcı
   setInterval'i kısar, Worker'ı kısmaz.
   ════════════════════════════════════════════════════════════ */
let visibilitySpoofed = false;

GT.define({
    id: 'wd-keepalive',
    match: at.pending,
    source: 'withdrawals',
    setup(ctx) {
        if (!visibilitySpoofed) {
            visibilitySpoofed = true;
            try {
                Object.defineProperty(document, 'hidden', { value: false, writable: false, configurable: true });
                Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false, configurable: true });
            } catch (e) { warn('görünürlük sabitlenemedi:', e); }
        }

        const indicator = ctx.own(h('div', { id: 'gt-keepalive' },
            h('span', { class: 'gt-dot' }),
            h('span', { html: 'Keep-Alive: <b>--</b>' })));
        document.body.append(indicator);

        const pulse = (color = 'var(--gt-success)') => {
            const dot = indicator.querySelector('.gt-dot');
            dot.style.background = color;
            setTimeout(() => { dot.style.background = 'var(--gt-accent)'; }, 300);
        };

        function targetDoc() {
            if ($('input[name="execute"][value="Go"]')) return document;
            try { return $('iframe[src*="PendingWithdrawals.action"]')?.contentDocument || null; }
            catch { return null; }
        }

        function clickGo(attempt = 0) {
            // Bir red işlemi sürerken listeyi tazeleme: POST'un altından satır çekilmesin.
            if (inFlight.size) { setTimeout(() => clickGo(attempt), 1000); return; }
            const btn = targetDoc()?.querySelector('input[name="execute"][value="Go"]');
            if (btn && !btn.disabled) { btn.click(); pulse(); log('Liste tazelendi.'); return; }
            if (attempt < 8) setTimeout(() => clickGo(attempt + 1), 300);
            else warn('Go butonu 9 denemede yakalanamadı.');
        }

        const nextGap = () => 240 + Math.floor(Math.random() * 181); // 240–420 sn
        let elapsed = 0, target = nextGap();

        const paint = () => {
            const left = Math.max(target - elapsed, 0);
            indicator.querySelector('b').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        };
        paint();

        workerClock(ctx, () => {
            elapsed++;
            paint();
            if (elapsed < target) return;
            clickGo();
            elapsed = 0; target = nextGap(); paint();
        });

        log('Keep-Alive başladı.');
    },
});

/* ════════════════════════════════════════════════════════════
   8 · ÖDEME POPUP'LARI — ortak yardımcılar
   Sütun gizleme satır satır değil CSS ile: tabloya data-gt-hide="c3 c7"
   yazılır, belgeye bir kez eklenen kurallar o sütunları (sonradan gelen
   satırlar dahil) gizler. Kendi belgesi olan iframe'e de uygulanabilsin
   diye stil GT.css ile değil, hedef belgeye doğrudan eklenir.
   ════════════════════════════════════════════════════════════ */
const POPUP_STYLE_ID = 'gt-pay-popup-style';
const MAX_COLS = 40;

function ensurePopupStyle(doc) {
    if (doc.getElementById(POPUP_STYLE_ID)) return;
    const cols = Array.from({ length: MAX_COLS }, (_, i) =>
        `table[data-gt-hide~="c${i + 1}"] > :is(thead, tbody, tfoot) > tr > :nth-child(${i + 1})`).join(',\n');
    const style = doc.createElement('style');
    style.id = POPUP_STYLE_ID;
    style.textContent = `${cols}{display:none !important}
.gt-strong{font-weight:700}
#gt-wd-tip{position:fixed; z-index:999999; display:none; max-width:320px; padding:10px 12px; pointer-events:none;
  background:rgba(255,255,255,.98); border:.5px solid rgba(0,0,0,.12); border-radius:10px;
  box-shadow:0 6px 22px rgba(0,0,0,.14); color:#1d1d1f; font-size:12px; line-height:1.5;
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif}
#gt-wd-tip .m{font-weight:600}
#gt-wd-tip .k{color:#86868b}
#gt-wd-tip .r{margin-top:4px}`;
    (doc.head || doc.documentElement).append(style);
}

/** Verilen başlık hücrelerinin sütunlarını tabloda gizler. */
function hideColumns(table, headerCells) {
    if (!table) return;
    const want = new Set((table.dataset.gtHide || '').split(' ').filter(Boolean));
    for (const cell of headerCells) if (cell) want.add('c' + (cell.cellIndex + 1));
    const next = [...want].join(' ');
    if (table.dataset.gtHide !== next) table.dataset.gtHide = next;
}

/** Kökteki metin düğümlerini dönüştürür; sadece gerçekten değişenlere yazar. */
function rewriteText(root, test, fn) {
    if (!root) return;
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT,
        { acceptNode: (n) => test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const hits = [];
    while (walker.nextNode()) hits.push(walker.currentNode);
    for (const node of hits) {
        const next = fn(node.nodeValue);
        if (next !== node.nodeValue) node.nodeValue = next;
    }
}

/* ════════════════════════════════════════════════════════════
   9 · ÇEKİM POPUP'I (popup:player-withdrawals) — sade liste
   · requestMethod, subMethod, updatedManuallyText, misc, info,
     referenceNumber sütunları gizlenir
   · " UTC" ve "TRY " metinleri atılır
   · "iSettle V2 Havale 16 (MGP)" kalın yazılır
   · Process bağlantısının üzerine gelince işlem detayı (durum mesajı,
     tutar, tran ID) ipucu olarak gösterilir; her bağlantı bir kez çekilir
   Liste #iframe-player-withdrawals içinde: modül normalde iframe'in
   İÇİNDE çalışır. Tampermonkey iframe'e girmediyse üst pencere iframe
   belgesini dışarıdan işler (yedek).
   ════════════════════════════════════════════════════════════ */
const WD_HIDE_COLS = ['requestMethod', 'subMethod', 'updatedManuallyText', 'misc', 'info', 'referenceNumber'];
const WD_BOLD = 'iSettle V2 Havale 16 (MGP)';
const detailCache = new Map();

function statusColor(status) {
    const s = String(status || '').toUpperCase();
    if (/ERROR|FAIL|REJECT/.test(s)) return '#FF3B30';
    if (/SUCCESS|OK|APPROVED|COMPLETE/.test(s)) return '#34C759';
    if (/PENDING|PROCESS/.test(s)) return '#FF9500';
    return '#1d1d1f';
}

/** "KOD: insan mesajı | ... | status=X&amount=Y&transactionId=Z" */
function parseDetail(raw) {
    const parts = raw.split('|').map(p => p.trim()).filter(Boolean);
    const first = parts[0] || '';
    const last = parts[parts.length - 1] || '';
    const data = {};
    if (/status=/i.test(last)) {
        for (const pair of last.split('&')) {
            const i = pair.indexOf('=');
            if (i > 0) data[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
        }
    }
    return { message: first.replace(/^\S+:\s*/, '').trim() || first, data, raw };
}

function detailHtml(entry) {
    if (entry.state === 'loading') return 'Yükleniyor…';
    if (entry.state !== 'ready') return GT.esc(entry.raw || 'Detay alınamadı');
    const { message, data, raw } = entry.parsed;
    if (!message && !Object.keys(data).length) return GT.esc(raw);
    return [
        message && `<div class="m" style="color:${statusColor(data.status)}">${GT.esc(message)}</div>`,
        data.amount && `<div class="r"><span class="k">Tutar:</span> ${GT.esc(data.amount)}</div>`,
        data.transactionId && `<div><span class="k">Tran ID:</span> ${GT.esc(data.transactionId)}</div>`,
    ].filter(Boolean).join('');
}

function fetchDetail(url) {
    if (detailCache.has(url)) return detailCache.get(url).promise;
    const entry = { state: 'loading' };
    entry.promise = (async () => {
        try {
            const res = await fetch(url, { credentials: 'same-origin' });
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const has = (t) => /status=\w+/i.test(t) && /message=/i.test(t);
            let raw = [...doc.querySelectorAll('td')].map(td => td.textContent.trim()).find(has)
                || [...doc.querySelectorAll('body *')].filter(el => !el.children.length).map(el => el.textContent.trim()).find(has);
            if (!raw) raw = html.match(/[^<]*status=[^<]*message=[^<\n]*/i)?.[0].replace(/&amp;/g, '&').trim();
            if (raw) Object.assign(entry, { state: 'ready', parsed: parseDetail(raw) });
            else Object.assign(entry, { state: 'error', raw: `Red sebebi mevcut değil (Code: ${res.status})` });
        } catch (e) {
            Object.assign(entry, { state: 'error', raw: 'Yüklenemedi: ' + e.message });
        }
        return entry;
    })();
    detailCache.set(url, entry);
    return entry.promise;
}

GT.define({
    id: 'wd-popup-list',
    scope: 'both',
    match: inWithdrawalPopup,
    source: 'withdrawals',
    setup(ctx) {
        const hovered = new WeakSet();

        function bindHover(doc) {
            if (hovered.has(doc)) return;
            hovered.add(doc);
            const view = doc.defaultView || window;
            let active = null;
            const tip = () => {
                let el = doc.getElementById('gt-wd-tip');
                if (!el) { el = doc.createElement('div'); el.id = 'gt-wd-tip'; doc.body.append(el); ctx.own(el); }
                return el;
            };
            const linkOf = (e) => e.target.closest?.('a[href*="ProcessWithdrawal.action"]');

            ctx.on(doc, 'mouseover', (e) => {
                const link = linkOf(e);
                if (!link) return;
                const url = new URL(link.getAttribute('href'), view.location.href).href;
                active = url;
                const el = tip();
                el.innerHTML = detailHtml(detailCache.get(url) || { state: 'loading' });
                el.style.display = 'block';
                fetchDetail(url).then((entry) => {
                    if (active === url && el.style.display !== 'none') el.innerHTML = detailHtml(entry);
                });
            }, { capture: true });

            ctx.on(doc, 'mousemove', (e) => {
                const el = doc.getElementById('gt-wd-tip');
                if (!el || el.style.display === 'none') return;
                const w = el.offsetWidth || 320, hgt = el.offsetHeight || 120;
                let x = e.clientX + 16, y = e.clientY + 16;
                if (x + w > view.innerWidth) x = e.clientX - w - 16;
                if (y + hgt > view.innerHeight) y = e.clientY - hgt - 16;
                el.style.left = Math.max(4, x) + 'px';
                el.style.top = Math.max(4, y) + 'px';
            }, { capture: true, passive: true });

            ctx.on(doc, 'mouseout', (e) => {
                const link = linkOf(e);
                if (!link || link.contains(e.relatedTarget)) return;
                active = null;
                const el = doc.getElementById('gt-wd-tip');
                if (el) el.style.display = 'none';
            }, { capture: true });
        }

        function tidy(doc) {
            if (!doc?.body) return;
            GT.ensureStyles?.(doc);
            ensurePopupStyle(doc);

            for (const part of WD_HIDE_COLS) {
                const head = doc.querySelector(`div[id*="${part}"]`)?.closest('td, th');
                if (head) hideColumns(head.closest('table'), [head]);
            }

            for (const table of doc.querySelectorAll('table')) {
                if (!table.querySelector('a[href*="ProcessWithdrawal.action"]')) continue;
                rewriteText(table, (t) => t.includes(' UTC') || t.includes('TRY '),
                    (t) => t.replace(/ UTC/g, '').replace(/TRY /g, ''));
                boldMethod(table);
            }
            bindHover(doc);
        }

        function boldMethod(root) {
            const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: (n) => n.nodeValue.includes(WD_BOLD) && !n.parentNode?.classList?.contains('gt-strong')
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
            });
            const hits = [];
            while (walker.nextNode()) hits.push(walker.currentNode);
            for (const node of hits) {
                const doc = node.ownerDocument;
                const frag = doc.createDocumentFragment();
                node.nodeValue.split(WD_BOLD).forEach((part, i, all) => {
                    frag.append(part);
                    if (i < all.length - 1) {
                        const b = doc.createElement('span');
                        b.className = 'gt-strong';
                        b.textContent = WD_BOLD;
                        frag.append(b);
                    }
                });
                node.replaceWith(frag);
            }
        }

        if (GT.IN_FRAME) {
            // Normal yol: iframe'in içindeyiz, kendi belgemizi çekirdeğin veriyoluyla izleriz.
            ctx.tick(() => tidy(document), { lazy: true });
            tidy(document);
            return;
        }

        // Yedek: iframe'de çekirdek yoksa (script enjekte edilmediyse) dışarıdan işle.
        // Üst pencerenin veriyolu iframe içindeki değişiklikleri görmez; bu yüzden aralıkla.
        const outside = () => {
            const frame = document.getElementById('iframe-player-withdrawals');
            let doc = null, hasCore = false;
            try { doc = frame?.contentDocument; hasCore = !!frame?.contentWindow?.GT?.__core; } catch { /* erişilemez */ }
            if (doc && !hasCore) tidy(doc);
        };
        ctx.interval(outside, 800);
        ctx.tick(outside, { lazy: true });
    },
});

/* ════════════════════════════════════════════════════════════
   10 · YATIRIM GEÇMİŞİ POPUP'I (popup:deposit-history)
   · Fee, Updated Manually, Sub Method, Info, Provider Message gizlenir
   · UTC / TRY metinleri atılır
   · Sağlayıcı adları ekibin kullandığı adlara çevrilir
   ════════════════════════════════════════════════════════════ */
const DEP_HIDE_HEADERS = new Set(['Fee', 'Updated Manually', 'Sub Method', 'Info', 'Provider Message']);
const PROVIDER_NAMES = new Map(Object.entries({
    'iSettle V2 Crypto 8 (KRPT)': 'Kriptopay | Telegram',
    'iSettle V2 Havale 14 (SRP)': 'Havale 7 | Slack',
    'iSettle V2 Havale 16 (MGP)': 'Havale 1 | Megapay Telegram',
    'iSettle V2 Havale 32 (RXP)': 'Havale 8 | Slack',
    'iSettle V2 Havale 55 (HMN PAYS)': 'Havale | Hemenpay Telegram',
    'iSettle V2 Payurus (PTRK)': 'Payurus | Telegram',
}));
const squash = (s) => s.replace(/\s+/g, ' ').trim();

GT.define({
    id: 'wd-deposit-history',
    scope: 'both',
    match: () => topHref().includes('popup:deposit-history'),
    source: 'withdrawals',
    setup(ctx) {
        function tidy() {
            const table = $('#depositsBody table');
            if (!table) return;
            ensurePopupStyle(document);

            const heads = [...(table.querySelector('thead tr')?.cells || [])]
                .filter(th => DEP_HIDE_HEADERS.has(squash(th.querySelector('a')?.textContent || '')));
            hideColumns(table, heads);

            rewriteText(table, (t) => t.includes('UTC') || t.includes('TRY'),
                (t) => t.replace(/\s*UTC/g, '').replace(/TRY\s*/g, ''));
            rewriteText(table, (t) => PROVIDER_NAMES.has(squash(t)), (t) => PROVIDER_NAMES.get(squash(t)));
        }
        ctx.tick(tidy, { lazy: true });
        tidy();
    },
});

log('GT Withdrawals v1.0.0 kayıtlı.');

});
})();
