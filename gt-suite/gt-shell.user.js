// ==UserScript==
// @name         GT Shell — arayüz iskeleti
// @namespace    palentis.gt
// @version      1.0.5
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
        #gt-nav{position:absolute; left:52px; top:50%; transform:translateY(-50%); z-index:11; margin:0;
          display:inline-flex !important}
        /* Üst barın kendi a/div kuralları ID ile geçilir. */
        #gt-nav > a{color:#1b1f24; text-decoration:none; font:600 12.5px/1 var(--gt-font); height:28px; padding:0 12px}
        #gt-nav > a:hover{background:#f5f6f8}
        #gt-nav > a.is-active{background:#1b1f24; color:#fff}`);

        const link = (label, path) => h('a', {
            class: 'gt-btn', 'data-path': path,
            href: path, routerlink: path.replace('/core', ''), routerlinkactive: 'true',
            onclick: (e) => { e.preventDefault(); router.go(path); },
        }, label);

        // Logo kutusu her hâlükârda gizlenir; butonlar artık ona bağlı değil.
        ctx.each(LOGO, (el) => el.style.setProperty('display', 'none', 'important'));

        // Çapa üst bar: sidebar kapanınca logo yuvası DOM'dan gidiyordu ve
        // butonlar onunla birlikte kayboluyordu. Üst bar her zaman yerinde.
        ctx.mount(topBar, 'gt-nav', (bar) => {
            if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
            return h('div', { class: 'gt-group' }, link('Oyuncu Ara', SEARCH), link('Çekimler', PENDING));
        });

        // Bulunulan sayfanın butonu koyu (seçili) görünür.
        const markActive = () => {
            for (const a of $$('#gt-nav a[data-path]')) a.classList.toggle('is-active', location.pathname.startsWith(a.dataset.path));
        };
        ctx.tick(markActive, { lazy: true });
        ctx.onRoute(markActive);
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
        // London bilerek sabit UTC+0 (yaz saati uygulanmaz); İstanbul ve Hong Kong zaten sabit.
        const CLOCKS = [
            { city: 'London', tz: 'UTC' },
            { city: 'Istanbul', tz: 'Europe/Istanbul' },
            { city: 'Hong Kong', tz: 'Asia/Hong_Kong' },
        ];
        const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                        'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = new Map(CLOCKS.map(c => [c.tz, new Intl.DateTimeFormat('en-GB', {
            timeZone: c.tz, year: 'numeric', month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })]));
        const now = (tz) => {
            const p = Object.fromEntries(fmt.get(tz).formatToParts(new Date()).map(x => [x.type, +x.value]));
            return { h: p.hour, m: p.minute, s: p.second, day: `${p.day} ${MONTHS[p.month - 1]} ${p.year}` };
        };
        const isNight = (h) => h < 7 || h >= 19;

        css('gt-shell-clocks', `
        #gt-clocks{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:10;
          display:inline-flex !important; align-items:stretch; background:#fff; border:1px solid #d9dde3; border-radius:12px;
          box-shadow:0 1px 1.5px rgba(16,24,40,.06); overflow:hidden; font-family:var(--gt-font); line-height:1}
        #gt-clocks .clk{display:flex; align-items:baseline; gap:8px; padding:7px 16px; border-left:1px solid #eceef1;
          background:#fff; transition:background-color .4s, color .4s}
        #gt-clocks .clk:first-child{border-left:0}
        #gt-clocks .dn{width:6px; height:6px; border-radius:50%; background:#f59e0b; align-self:center}
        #gt-clocks .city{font-size:11px; font-weight:600; color:#8e8e93}
        #gt-clocks .t{font-size:17px; font-weight:700; letter-spacing:-.3px; color:#1b1f24; font-variant-numeric:tabular-nums}
        #gt-clocks .s{font-size:11px; font-weight:600; color:#b0b4bb; margin-left:-5px; font-variant-numeric:tabular-nums}
        /* Gece (19:00–07:00): o şehrin kutusu koyu */
        #gt-clocks .clk.night{background:#1b1f24; border-left-color:#1b1f24}
        #gt-clocks .clk.night + .clk{border-left-color:transparent}
        #gt-clocks .clk.night .dn{background:#8b93ff}
        #gt-clocks .clk.night .city{color:#9aa0a8}
        #gt-clocks .clk.night .t{color:#fff}
        #gt-clocks .clk.night .s{color:#6b7280}
        /* Hong Kong: gökdelen tepesindeki uyarı ışığı gibi yavaşça yanıp söner, gece de turuncu */
        #gt-clocks .clk[data-tz="Asia/Hong_Kong"] .dn{background:#f59e0b !important; animation:gt-beacon 2.4s ease-in-out infinite}
        @keyframes gt-beacon{0%,100%{opacity:.25; box-shadow:0 0 0 rgba(245,158,11,0)}
          50%{opacity:1; box-shadow:0 0 6px 1px rgba(245,158,11,.85)}}
        @media (prefers-reduced-motion:reduce){#gt-clocks .clk[data-tz="Asia/Hong_Kong"] .dn{animation:none}}

        /* Sağdaki hesap alanı: avatar, dil ve tarih gizli; kullanıcı adı yerine MARCUS.
           Tıklanınca sitenin hesap menüsü (şifre, tema) yine açılır. */
        ul.nav-account-info .thumb-sm, ul.nav-account-info > li:not(:first-child){display:none !important}
        ul.nav-account-info > li:first-child strong{font-size:0 !important}
        ul.nav-account-info > li:first-child strong::after{content:'MARCUS'; font-family:var(--gt-font); font-size:12.5px;
          font-weight:700; letter-spacing:.08em; color:#1b1f24}`);

        const paint = (group) => {
            for (const el of group.children) {
                const { h: hh, m, s, day } = now(el.dataset.tz);
                el.classList.toggle('night', isNight(hh));
                el.querySelector('.t').textContent = `${pad(hh)}:${pad(m)}`;
                el.querySelector('.s').textContent = pad(s);
                el.title = day;
            }
        };

        ctx.mount(topBar, 'gt-clocks', (bar) => {
            if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
            const group = h('div', {}, CLOCKS.map(c =>
                h('span', { class: 'clk', dataset: { tz: c.tz } },
                    h('span', { class: 'dn' }), h('span', { class: 'city' }, c.city),
                    h('span', { class: 't' }), h('span', { class: 's' }))));
            paint(group);
            return group;
        });

        ctx.interval(() => {
            const group = document.getElementById('gt-clocks');
            if (group?.isConnected) paint(group);
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
