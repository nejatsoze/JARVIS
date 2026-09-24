// ==UserScript==
// @name         GT Withdrawals — çekim masası
// @namespace    palentis.gt
// @version      1.0.5
// @description  Çekim sayfalarının tek sahibi: keep-alive, satır tıklama, zaman aşımı otomatik reddi (OTORED), tek tıkla şablonlu red, ONAY butonu ve red şablonu kısayolları. GT Core üzerine kurulur. Dört ayrı scriptin (Keep-Alive, Full Row Click, OTORED, Auto Process) birleşiğidir — o dördünü kapat.
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
#gt-otored{display:inline-flex; align-items:center; gap:6px; margin-left:8px; padding:3px 10px;
  font-family:var(--gt-font); font-size:11px; font-weight:600; border-radius:10px; cursor:pointer;
  white-space:nowrap; border:.5px solid var(--gt-muted); background:#fff; color:var(--gt-muted);
  transition:background .15s, color .15s, border-color .15s}
#gt-otored[data-on="1"]{background:var(--gt-success); border-color:var(--gt-success); color:#fff}
#gt-otored .gt-dot{background:currentColor; opacity:.8}

.gt-quick-reject{display:flex; flex-direction:column; align-items:stretch; gap:4px; margin-top:6px}
.gt-quick-reject .gt-btn{padding:2px 8px; font-size:11px; line-height:18px}
.gt-quick-reject[data-busy="1"]{pointer-events:none; opacity:.6}

a.gt-onay{
  display:block !important; width:fit-content; margin-bottom:4px; padding:2px 10px;
  font-family:var(--gt-font); font-size:11px; line-height:18px; font-weight:600; text-align:center;
  background:#fff; color:var(--gt-success); border:.5px solid var(--gt-success); border-radius:10px;
  text-decoration:none; white-space:nowrap; cursor:pointer; transition:background .15s, color .15s}
a.gt-onay:hover{background:var(--gt-success); color:#fff}

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
   3 · HIZLI RED — en üstteki bekleyen talebe şablon butonları
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'wd-quick-reject',
    scope: 'both',   // klasik liste iframe içinde render ediliyor
    match: at.pending,
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

    return {
        keepAlive(tag) {
            for (const doc of docs()) {
                const btn = button(doc);
                if (!btn) continue;
                btn.click();
                log(`Continue Session tıklandı (${tag}).`);
                return true;
            }
            return false;
        },
    };
})();

GT.define({
    id: 'wd-session-guard',
    source: 'withdrawals',
    setup(ctx) {
        // "Continue Session" gözlemi/tıklaması her sayfada geçerli — zararsız,
        // sadece o diyalog gerçekten varsa bir şey yapar.
        ctx.tick(() => session.keepAlive('gözlemci'), { lazy: true });
        ctx.interval(() => session.keepAlive('yoklama'), 4000);
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

        const blob = URL.createObjectURL(new Blob(
            ['setInterval(() => postMessage(0), 1000);'], { type: 'application/javascript' }));
        const worker = new Worker(blob);
        URL.revokeObjectURL(blob);
        ctx.own(worker); // ctx.destroy → worker.terminate()

        const nextGap = () => 240 + Math.floor(Math.random() * 181); // 240–420 sn
        let elapsed = 0, target = nextGap();

        const paint = () => {
            const left = Math.max(target - elapsed, 0);
            indicator.querySelector('b').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        };
        paint();

        worker.onmessage = () => {
            elapsed++;
            paint();
            if (session.keepAlive('sayaç')) pulse('var(--gt-danger)');
            if (elapsed < target) return;
            clickGo();
            elapsed = 0; target = nextGap(); paint();
        };

        log('Keep-Alive başladı.');
    },
});

log('GT Withdrawals v1.0.0 kayıtlı.');

});
})();
