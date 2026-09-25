// ==UserScript==
// @name         GT Shell — arayüz iskeleti
// @namespace    palentis.gt
// @version      1.0.2
// @description  Her sayfada geçerli arayüz katmanı: varsayılan sayfa yönlendirme, logo yerine hızlı gezinme butonları, kapalı başlayan sidebar, navbar saatleri (GMT+0/+3/+8), alt sekmelerin butonlaştırılması, COMMENTS uyarısı ve bildirim şeritlerinin toast'a dönüşümü. GT Core üzerine kurulur.
// @match        https://core-secundus.gmntc.com/*
// @match        https://core-ui-secundus.gmntc.com/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
'use strict';

const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

(W.__GT__ = W.__GT__ || []).push((GT) => {

const { h, $, $$, txt, css, log, router } = GT;

const PENDING = '/core/app/classic/payment/pendingWithdrawals';
const SEARCH = '/core/app/core/players/search';

/** Personel menüsünü barındıran üst bar. Saatler ve gezinme butonları
 *  buraya tutunur — sidebar'ın açık/kapalı olmasından etkilenmez. */
function topBar() {
    for (const toggle of $$('li.nav-item.dropdown > a.dropdown-toggle')) {
        const menu = toggle.parentElement.querySelector('.dropdown-menu');
        if (!menu?.querySelector('a.dropdown-item') || !menu.textContent.includes('Edit Avatar')) continue;
        const container = toggle.closest('.container-fluid');
        if (container) return container;
        let el = toggle.parentElement;
        while (el && el !== document.body) {
            if (el.tagName === 'NAV' || [...(el.classList || [])].some(c => c.toLowerCase().includes('navbar'))) return el;
            el = el.parentElement;
        }
    }
    return null;
}

/* ════════════════════════════════════════════════════════════
   1 · VARSAYILAN SAYFA — overview yerine bekleyen çekimler
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-default-page',
    source: 'shell',
    setup(ctx) {
        const onOverview = () =>
            location.pathname.includes('/core/app/classic/overview')
            && location.search.includes('service=new-core');

        // Tek seferlik: Angular bizi overview'a geri atarsa gidip gelme olmasın.
        let redirected = false;
        const guard = () => {
            if (redirected || !onOverview()) return;
            redirected = true;
            sessionStorage.setItem('gtSuite_closeOverviewTabPending', '1');
            router.go(PENDING);
        };

        /** Overview sekmesini "Pending Withdrawals" sekmesine çevirir. */
        const retab = () => {
            const link = $('a.mat-tab-link[href*="/core/app/classic/overview?service=new-core"]');
            if (!link) return;
            link.setAttribute('href', PENDING);
            if (!link.dataset.gtTab) {
                link.dataset.gtTab = '1';
                link.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    router.go(PENDING);
                }, true);
            }
            link.className = 'mat-tab-link ng-star-inserted cdk-focused cdk-mouse-focused mat-tab-label-active';
            const label = link.querySelector('span.inner-ellipsis-overflow');
            if (label && label.textContent !== 'Pending Withdrawals') label.textContent = 'Pending Withdrawals';
            if (!link.querySelector('i.pin-tabs')) {
                const pin = h('i', { class: 'fa fa-thumb-tack pin-tabs ng-star-inserted' });
                const close = link.querySelector('i.close-tabs');
                close ? link.insertBefore(pin, close) : link.append(pin);
            }
        };

        guard();
        ctx.onRoute(guard);
        ctx.tick(() => { guard(); retab(); });
    },
});

/* ════════════════════════════════════════════════════════════
   2 · LOGO YERİNE HIZLI GEZİNME
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-nav',
    source: 'shell',
    setup(ctx) {
        const B64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA';
        const LOGO = `img[src^="${B64}"], img[src*="new_logo.png"], .sidebar-logo.omega-logo-white`;

        css('gt-shell-nav', `
        #gt-nav{all:initial; position:absolute; left:52px; top:50%; transform:translateY(-50%);
          display:flex !important; flex-direction:row; flex-wrap:nowrap; align-items:center; gap:6px;
          z-index:11; font-family:var(--gt-font)}
        #gt-nav a{all:unset; display:inline-block; padding:5px 11px; box-sizing:border-box; cursor:pointer;
          white-space:nowrap; font-family:var(--gt-font); font-size:12.5px; font-weight:600; color:var(--gt-accent);
          background:#fff; border:.5px solid var(--gt-line); border-radius:var(--gt-r);
          box-shadow:0 1px 2px rgba(0,0,0,.06); transition:background .15s, transform .1s}
        #gt-nav a:hover{background:var(--gt-surface-2)}
        #gt-nav a:active{transform:scale(.97)}`);

        const link = (label, path) => h('a', {
            href: path, routerlink: path.replace('/core', ''), routerlinkactive: 'true',
            onclick: (e) => { e.preventDefault(); router.go(path); },
        }, label);

        // Logo kutusu her hâlükârda gizlenir; butonlar artık ona bağlı değil.
        ctx.each(LOGO, (el) => el.style.setProperty('display', 'none', 'important'));

        // Çapa üst bar: sidebar kapanınca logo yuvası DOM'dan gidiyordu ve
        // butonlar onunla birlikte kayboluyordu. Üst bar her zaman yerinde.
        ctx.mount(topBar, 'gt-nav', (bar) => {
            if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
            return h('div', {}, link('Oyuncu Ara', SEARCH), link('Çekimler', PENDING));
        });
    },
});

/* ════════════════════════════════════════════════════════════
   3 · SIDEBAR KAPALI BAŞLASIN
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-sidebar',
    source: 'shell',
    setup(ctx) {
        let done = false;
        // each() değil tick(): buton DOM'a ikonsuz düşüp ikonunu sonradan
        // alıyor. each düğümü ilk görüşte işaretleyip bir daha bakmadığı için
        // o ilk boş hâli görüp vazgeçiyordu.
        ctx.tick(() => {
            if (done) return;
            const btn = $('button.collapse-button.mat-fab.mat-accent') || $('button.collapse-button');
            if (!btn) return;
            // Ok sola bakıyorsa sidebar açık demektir; zaten kapalıysa dokunma.
            if (!btn.querySelector('i.fa-chevron-left')) return;
            btn.click();
            done = true;
        });
    },
});

/* ════════════════════════════════════════════════════════════
   4 · NAVBAR SAATLERİ (GMT+0 / +3 / +8)
   Enjeksiyon bir kez; saniyede bir sadece üç metin düğümü yazılır.
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-clocks',
    source: 'shell',
    setup(ctx) {
        const CLOCKS = [
            { offset: 0, flag: '🇬🇧' },
            { offset: 3, flag: '🇹🇷' },
            { offset: 8, flag: '🕉️' },
        ];
        const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                        'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
        const pad = (n) => String(n).padStart(2, '0');
        const shifted = (offset) => new Date(Date.now() + offset * 3600000);
        const clock = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        const day = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

        css('gt-shell-clocks', `
        #gt-clocks{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
          display:flex; align-items:center; gap:8px; z-index:10; pointer-events:none}
        #gt-clocks .pill{display:inline-flex; align-items:center; gap:6px; padding:4px 12px;
          background:#F2F2F4; color:var(--gt-ink-2); border:.5px solid var(--gt-line); border-radius:14px;
          font-family:var(--gt-font); font-size:13px; line-height:1.2; font-variant-numeric:tabular-nums;
          box-shadow:0 1px 2px rgba(0,0,0,.04); pointer-events:auto}`);

        ctx.mount(topBar, 'gt-clocks', (bar) => {
            if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
            return h('div', {}, CLOCKS.map(c =>
                h('span', { class: 'pill', dataset: { offset: String(c.offset) } },
                    h('span', {}, c.flag),
                    h('span', { class: 'time' }, clock(shifted(c.offset))))));
        });

        // Sağdaki orijinal "UTC+0000" tarih öğesini gizle
        ctx.each('span.hidden-xs-down', (span) => {
            if (!span.textContent.includes('UTC+0000')) return;
            const li = span.closest('li');
            if (li) li.style.display = 'none';
        });

        ctx.interval(() => {
            const group = document.getElementById('gt-clocks');
            if (!group?.isConnected) return;
            for (const pill of group.children) {
                const d = shifted(Number(pill.dataset.offset));
                pill.querySelector('.time').textContent = clock(d);
                pill.title = day(d);
            }
        }, 1000);
    },
});

/* ════════════════════════════════════════════════════════════
   5 · ALT SEKMELER — buton görünümü + COMMENTS uyarısı
   (Üst pencere-tab barı .mat-tab-link hariç tutulur.)
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-tabs',
    source: 'shell',
    setup(ctx) {
        css('gt-shell-tabs', `
        .mat-tab-label:not(.mat-tab-link){
          min-width:auto !important; height:auto !important; padding:5px 12px !important; margin:2px 3px !important;
          background:#f0f2f5 !important; border:1px solid #d7dbe0 !important; border-radius:6px !important;
          opacity:1 !important; transition:background .15s, border-color .15s}
        .mat-tab-label:not(.mat-tab-link):hover{background:#e2e6ea !important; border-color:#b9c0c8 !important}
        .mat-tab-label-active:not(.mat-tab-link){background:#2f6fed !important; border-color:#2f6fed !important}
        .mat-tab-label-active:not(.mat-tab-link) .mat-tab-label-content{color:#fff !important}
        :not(.mat-tab-links) > .mat-ink-bar{display:none !important}

        .mat-tab-label.gt-has-comments:not(.mat-tab-link){background:#e74c3c !important; border-color:#c0392b !important}
        .mat-tab-label.gt-has-comments:not(.mat-tab-link):hover{background:#c0392b !important; border-color:#a93226 !important}
        .mat-tab-label.gt-has-comments:not(.mat-tab-link) .mat-tab-label-content{color:#fff !important}`);

        ctx.tick(() => {
            for (const tab of $$('.mat-tab-label:not(.mat-tab-link)')) {
                const m = txt(tab).match(/^COMMENTS?\s*\((\d+)\)/i);
                if (!m) continue;
                tab.classList.toggle('gt-has-comments', Number(m[1]) > 0);
            }
        }, { lazy: true });
    },
});

/* ════════════════════════════════════════════════════════════
   6 · BİLDİRİM ŞERİDİ → SAĞ ÜST TOAST
   Angular elementi önce boş basıp metni ~2 sn sonra dolduruyor;
   bu yüzden metin düğümü ile varyant class'ı ayrı ayrı izleniyor.
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-alerts',
    source: 'shell',
    setup(ctx) {
        css('gt-shell-alerts', `
        alert.alert-nav{
          position:fixed !important; top:16px !important; right:16px !important; left:auto !important; bottom:auto !important;
          width:auto !important; min-width:220px !important; max-width:320px !important; margin:0 !important; padding:0 !important;
          z-index:999999 !important; opacity:0 !important; visibility:hidden !important; pointer-events:none !important}
        alert.alert-nav.gt-ready{opacity:1 !important; visibility:visible !important; pointer-events:auto !important;
          animation:gt-toast-in .25s ease-out !important}
        alert.alert-nav .alert{
          display:flex !important; align-items:center !important; justify-content:space-between !important; gap:10px !important;
          margin:0 !important; padding:12px 16px !important; background:#fff !important; color:var(--gt-ink) !important;
          border:.5px solid var(--gt-line) !important; border-left:3px solid var(--gt-muted) !important;
          border-radius:var(--gt-r) !important; box-shadow:0 4px 16px rgba(0,0,0,.12) !important;
          font-family:var(--gt-font) !important; font-size:13px !important; line-height:1.4 !important}
        alert.alert-nav.gt-v-success .alert{border-left-color:var(--gt-success) !important}
        alert.alert-nav.gt-v-danger  .alert{border-left-color:var(--gt-danger)  !important}
        alert.alert-nav.gt-v-warning .alert{border-left-color:var(--gt-warn)    !important}
        alert.alert-nav.gt-v-info    .alert{border-left-color:var(--gt-accent)  !important}
        alert.alert-nav .alert__content, alert.alert-nav .msg{margin:0 !important}
        alert.alert-nav .close{flex-shrink:0 !important; background:transparent !important; border:none !important;
          cursor:pointer !important; opacity:.5 !important; font-size:16px !important; line-height:1 !important}
        @keyframes gt-toast-in{from{opacity:0; transform:translateY(-8px)}to{opacity:1; transform:none}}`);

        const VARIANTS = ['success', 'danger', 'warning', 'info'];

        ctx.each('alert.alert-nav', (root) => {
            const inner = root.querySelector('.alert.alert-dismissible');
            const msg = root.querySelector('.msg');
            if (!inner || !msg) return;

            const sync = () => {
                const found = VARIANTS.find(v => inner.classList.contains(`alert-${v}`));
                for (const v of VARIANTS) root.classList.toggle(`gt-v-${v}`, v === found);
                root.classList.toggle('gt-ready', txt(msg).length > 0);
            };
            sync();

            // Element DOM'dan çıkınca gözlemciler de gitsin.
            const textWatch = new MutationObserver(sync);
            const classWatch = new MutationObserver(sync);
            textWatch.observe(msg, { childList: true, characterData: true, subtree: true });
            classWatch.observe(inner, { attributes: true, attributeFilter: ['class'] });
            ctx.own(textWatch);
            ctx.own(classWatch);
        });
    },
});

log('GT Shell v1.0.0 kayıtlı.');

});
})();
