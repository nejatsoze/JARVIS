// ==UserScript==
// @name         GT Shell — arayüz iskeleti
// @namespace    palentis.gt
// @version      1.0.18
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
   0 · KYCAID OTURUMU AÇIK TUTMA
   KYCAID oturumu HttpOnly çerezde (sayfa JS'i görmez), sunucu uzun süre istek
   gelmezse kapatıyor. KYCAID sekmesinin arka planda uyanık kalmasına güvenmek
   yerine GT (hep açık) 4 dakikada bir sitenin kendi liste isteğinin aynısını
   atar. Birden çok GT sekmesi varsa localStorage kilidiyle sadece biri atar.
   Konsol: GT.kycaid() → son durum.
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-kycaid',
    source: 'shell',
    setup(ctx) {
        const EVERY = 4 * 60 * 1000;
        const LOCK = 'gt.kyc.ping', STATE = 'gt.kyc.state';
        const ls = (() => { try { return W.localStorage; } catch { return null; } })();
        const read = () => { try { return JSON.parse(ls?.getItem(STATE) || 'null'); } catch { return null; } };
        GT.kycaid = () => { const s = read(); console.table(s ? [s] : []); return s?.ok; };

        let busy = false;
        async function ping() {
            const last = +(ls?.getItem(LOCK) || 0);
            if (busy || Date.now() - last < EVERY - 20000) return;
            busy = true;
            ls?.setItem(LOCK, String(Date.now()));
            const prev = read();
            let ok = false, why = '';
            try {
                const s = await GT.api.gm({ method: 'GET', url: 'https://app.kycaid.com/api/session', headers: { Accept: 'application/json' }, timeout: 20000 });
                let csrf; try { csrf = JSON.parse(s.responseText)?.session?.['csrf-token']; } catch { /* JSON değil: giriş sayfası */ }
                if (!csrf) why = `oturum yok (HTTP ${s.status})`;
                else {
                    const v = await GT.api.gm({
                        method: 'POST', url: 'https://app.kycaid.com/api/verifications', timeout: 20000,
                        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'CSRF-Token': csrf },
                        data: JSON.stringify({ customer_id: 24931, timezone: 'Europe/Kiev', page: 1, count: 1 }),
                    });
                    // Oturum CSRF ile doğrulandı; liste isteği sadece "gerçek hareket" için.
                    // 401/403 dışındaki cevaplar oturumun kapandığı anlamına gelmez.
                    ok = v.status !== 401 && v.status !== 403;
                    why = ok ? (v.status < 300 ? '' : `liste HTTP ${v.status}`) : `liste HTTP ${v.status}`;
                }
            } catch (e) { why = `ağ: ${e?.message || e?.error || 'hata'}`; }
            const now = new Date().toLocaleTimeString('tr-TR');
            ls?.setItem(STATE, JSON.stringify({ ok, son: now, neden: why, dusus: ok ? '' : (prev && !prev.ok ? prev.dusus : now) }));
            if (!prev || prev.ok !== ok) {
                GT.flight.log('kycaid', ok ? 'açık' : `KAPALI: ${why}`);
                ok ? log('[KYCAID] Oturum açık, 4 dk\'da bir canlı tutuluyor.')
                   : console.warn(`[GT] KYCAID oturumu kapalı (${why}). app.kycaid.com'a tekrar giriş yapılmalı.`);
            }
            busy = false;
        }

        ping();
        ctx.interval(ping, 60 * 1000);   // arka planda dakikada bir kısılır; 4 dk'lık aralık için yeterli
        ctx.on(W.document, 'visibilitychange', () => { if (!W.document.hidden) ping(); });
    },
});

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
            // Sabit sekme: "aktif" sınıfı zorlanmaz (her zaman seçili görünüyordu); rengi [data-gt-tab] ile ayrı.
            link.classList.remove('mat-tab-label-active');
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

        // Sekme × ile kapatılınca site Player Search'e düşüyor; kısa süre içinde oraya
        // (ya da overview'a) giderse Pending Withdrawals'a çevir.
        let closedAt = 0;
        ctx.on(W.document, 'click', (e) => {
            if (e.target.closest?.('.mat-tab-nav-bar .close-tabs')) closedAt = Date.now();
        }, { capture: true });
        ctx.onRoute(() => {
            if (Date.now() - closedAt > 2000) return;
            const path = location.pathname;
            if (path.includes('/players/search') || path.includes('/classic/overview')) {
                closedAt = 0;
                router.go(PENDING);
            }
        });
    },
});

/* ════════════════════════════════════════════════════════════
   2 · LOGO GİZLİ — Oyuncu Ara / Çekimler butonları kaldırıldı; yerlerini
   sekme çubuğundaki sabit Pending Withdrawals + Player Search aldı (4c).
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-nav',
    source: 'shell',
    setup(ctx) {
        const B64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA';
        const LOGO = `img[src^="${B64}"], img[src*="new_logo.png"], .sidebar-logo.omega-logo-white`;
        ctx.each(LOGO, (el) => el.style.setProperty('display', 'none', 'important'));
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
   GÖKYÜZÜ — saatler ve geri butonu AYNI hesabı kullanır (renkler hep eş)
   ════════════════════════════════════════════════════════════ */
/** NOAA yaklaşık formülü: gün doğumu / batımı, UTC dakikası. */
function sunUTC(d, lat, lng) {
    const rad = Math.PI / 180;
    const n = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
    const g = 2 * Math.PI / 365 * (n - 1);
    const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
        + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const cosH = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl);
    const ha = Math.acos(Math.min(1, Math.max(-1, cosH))) / rad;
    return { rise: 720 - 4 * (lng + ha) - eq, set: 720 - 4 * (lng - ha) - eq };
}

/* Gökyüzü durakları [üst renk, ufuk rengi]; saatleri o günün doğuş (R) ve batışına (S) göre kayar. */
const hex = (c) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const skyStops = (R, S) => [
    [0,              '#0b1026', '#1c2748'],   // gece
    [R - 2,          '#141a3a', '#2b3560'],
    [R - 1,          '#2e3a78', '#c98bb0'],   // şafak
    [R,              '#6c8fd6', '#ffc59a'],   // gün doğumu
    [R + 1.5,        '#5ea8ea', '#bfe2ff'],   // sabah
    [(R + S) / 2,    '#4a9be6', '#aedcff'],   // öğle
    [S - 2.5,        '#5aa4e4', '#cfe6f7'],
    [S - 1.2,        '#7fa8d8', '#ffd59a'],   // altın saat
    [S - 0.2,        '#f08a4b', '#ffcf7a'],   // gün batımı
    [S + 0.5,        '#c8445a', '#ff8a4c'],   // kızıl
    [S + 1.2,        '#5b3a8c', '#d9667a'],   // alacakaranlık
    [S + 2.2,        '#1e2656', '#4a3f7a'],
    [S + 3.5,        '#0e1430', '#1e2748'],
    [24,             '#0b1026', '#1c2748'],
].map(([h, a, b]) => [h, hex(a), hex(b)])
 .filter((s, i, all) => i === 0 || (s[0] > all[i - 1][0] && s[0] <= 24));

function sky(stops, hf) {
    let i = stops.findIndex(s => s[0] > hf) - 1;
    if (i < 0) i = stops.length - 2;
    const [h0, t0, b0] = stops[i], [h1, t1, b1] = stops[i + 1], f = (hf - h0) / (h1 - h0);
    const mix = (a, b) => a.map((v, k) => Math.round(v + (b[k] - v) * f));
    const top = mix(t0, t1), bot = mix(b0, b1);
    const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    return { bg: `linear-gradient(180deg, rgb(${top}) 0%, rgb(${bot}) 100%)`, light: (lum(top) + lum(bot)) / 2 > 0.55 };
}
const phase = (hf, R, S) => (hf >= R + 1 && hf < S - 1.2) ? 'day'
    : ((hf >= R - 1 && hf < R + 1) || (hf >= S - 1.2 && hf < S + 1.2)) ? 'edge' : 'night';

/** İstanbul'un şu anki gökyüzü (gerçek gün doğumu/batımı ile, günde bir hesaplanır). */
const IST = { tz: 'Europe/Istanbul', lat: 41.008, lng: 28.978 };
const istFmt = new Intl.DateTimeFormat('en-GB', { timeZone: IST.tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
let istSun = null;
function istanbulSky(d = new Date()) {
    const p = Object.fromEntries(istFmt.formatToParts(d).map(x => [x.type, +x.value]));
    const key = `${p.year}-${p.month}-${p.day}`;
    if (istSun?.key !== key) {
        const off = ((p.hour * 60 + p.minute) - (d.getUTCHours() * 60 + d.getUTCMinutes()) + 2160) % 1440 - 720;
        const { rise, set } = sunUTC(d, IST.lat, IST.lng);
        const R = (((rise + off) % 1440 + 1440) % 1440) / 60, S = (((set + off) % 1440 + 1440) % 1440) / 60;
        istSun = { key, R, S, stops: skyStops(R, S) };
    }
    const hf = p.hour + p.minute / 60;
    return { ...sky(istSun.stops, hf), phase: phase(hf, istSun.R, istSun.S) };
}

/* ════════════════════════════════════════════════════════════
   GERİ BUTONU — sol alt köşe, İstanbul'un o anki gökyüzü (saatlerle aynı hesap)
   Panel içi geçmiş GT tarafından tutulur (sessionStorage): etiket nereye
   dönüleceğini yazar, gidilecek sayfa yoksa buton soluk ve pasif.
   ════════════════════════════════════════════════════════════ */
css('gt-shell-back', `
#gt-back{position:fixed; left:16px; bottom:22px; z-index:2147482000; display:inline-flex; align-items:center; padding:0; border:0; background:none;
  cursor:pointer; font-family:var(--gt-font)}
#gt-back .b{position:relative; width:48px; height:48px; border-radius:15px; overflow:hidden; display:flex; align-items:center; justify-content:center;
  color:#fff; transition:transform .2s cubic-bezier(.2,.8,.2,1), background .8s;
  box-shadow:0 0 0 1px rgba(255,255,255,.55) inset, 0 6px 16px -6px rgba(16,24,40,.35), 0 1px 2px rgba(16,24,40,.12)}
#gt-back .b::after{content:''; position:absolute; left:0; right:0; bottom:0; height:9px; background:rgba(255,255,255,.16); border-radius:50% 50% 0 0 / 100% 100% 0 0}
#gt-back svg{width:24px; height:24px; filter:drop-shadow(0 1px 1px rgba(0,0,0,.18))}
#gt-back .arr{transition:transform .25s cubic-bezier(.3,.7,.2,1)}
#gt-back .lbl{margin-left:8px; height:28px; display:inline-flex; align-items:center; gap:6px; padding:0 11px; border-radius:8px; background:#fff;
  border:1px solid #d9dde3; box-shadow:0 1px 1.5px rgba(16,24,40,.06); font-size:12.5px; font-weight:600; color:var(--gt-text, #343a43); white-space:nowrap;
  max-width:340px; overflow:hidden; text-overflow:ellipsis; opacity:0; transform:translateX(-6px); pointer-events:none;
  transition:opacity .2s, transform .25s cubic-bezier(.2,.8,.2,1)}
#gt-back .lbl i{font-style:normal; font-weight:500; color:#98a2b3; overflow:hidden; text-overflow:ellipsis}
#gt-back:not(.off):hover .arr, #gt-back:not(.off):focus-visible .arr{transform:translateX(-3px)}
#gt-back:not(.off):hover .lbl, #gt-back:not(.off):focus-visible .lbl{opacity:1; transform:none}
#gt-back:not(.off):hover .b{transform:translateY(-1px)}
#gt-back:not(.off):active .b{transform:scale(.94)}
#gt-back.off{cursor:default} #gt-back.off .b{opacity:.4; filter:saturate(.6)}
#gt-back:focus-visible{outline:none} #gt-back:focus-visible .b{box-shadow:0 0 0 2px #fff, 0 0 0 4px #525a66}
@media (prefers-reduced-motion:reduce){#gt-back *{transition:none !important}}
`);

GT.define({
    id: 'shell-back',
    source: 'shell',
    setup(ctx) {
        const KEY = 'gt.back.stack';
        const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { return []; } };
        const write = (st) => { try { sessionStorage.setItem(KEY, JSON.stringify(st.slice(-30))); } catch { /* yok */ } };
        const here = () => location.pathname + location.search;

        /** Sayfanın okunur adı: açık sabit sekme, yoksa açık pencere sekmesi, yoksa yoldan. */
        function title() {
            const t = $('.mat-tab-nav-bar a.mat-tab-link[data-gt-tab].gt-here .inner-ellipsis-overflow')
                || $('.mat-tab-nav-bar a.mat-tab-link.mat-tab-label-active .inner-ellipsis-overflow');
            const v = txt(t);
            if (v) return v;
            const pid = location.pathname.match(/players\/(\d+)/)?.[1];
            if (/transaction-history/.test(location.pathname)) return pid ? `İşlemler ${pid}` : 'İşlemler';
            if (pid) return `Oyuncu ${pid}`;
            if (/pendingWithdrawals/i.test(location.pathname)) return 'Pending Withdrawals';
            if (/players\/search/.test(location.pathname)) return 'Player Search';
            return '';
        }

        function onRoute() {
            const st = read(), cur = here();
            if (st.length && st[st.length - 1].p === cur) return;
            if (st.length >= 2 && st[st.length - 2].p === cur) st.pop();       // geri gidildi
            else st.push({ p: cur, t: '' });
            write(st);
            paint();
        }

        const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><g class="arr"><path d="M19 12H5.5"/><path d="M11 6l-6 6 6 6"/></g></svg>';
        const sub = h('i', {});
        const lbl = h('span', { class: 'lbl' }, 'Geri', sub);
        const box = h('span', { class: 'b', html: ARROW });
        const btn = ctx.own(h('button', { id: 'gt-back', type: 'button', 'aria-label': 'Geri' }, box, lbl));
        btn.addEventListener('click', () => { if (read().length >= 2) history.back(); });

        function paint() {
            const st = read();
            const prev = st.length >= 2 ? st[st.length - 2] : null;
            btn.classList.toggle('off', !prev);
            sub.textContent = prev?.t ? `· ${prev.t}` : '';
            btn.title = prev ? `Geri${prev.t ? ': ' + prev.t : ''}` : 'Gidilecek önceki sayfa yok';
        }
        function paintSky() { box.style.background = istanbulSky().bg; }

        ctx.tick(() => {
            if (!btn.isConnected && document.body) document.body.append(btn);
            // açık sayfanın adı geç yükleniyor: gelince yığına yaz
            const st = read(), last = st[st.length - 1], t = title();
            if (last && last.p === here() && t && last.t !== t) { last.t = t; write(st); paint(); }
        }, { lazy: true });
        ctx.onRoute(onRoute);
        ctx.interval(paintSky, 60 * 1000);
        onRoute(); paintSky(); paint();
    },
});

/* ════════════════════════════════════════════════════════════
   4 · NAVBAR SAATLERİ — London / Istanbul / Pattaya / Bali / Tokyo (UTC sırası)
   Her kutu kendi yerel saatine göre gökyüzü rengini alır; gün doğumu ve
   batımı şehrin koordinatından o gün için hesaplanır. Nokta: doğuş/batış
   turuncu, gündüz sarı (beyaz ışıma), gece beyaz; hepsi yanıp söner.
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-clocks',
    source: 'shell',
    setup(ctx) {
        // London bilerek sabit UTC+0 (yaz saati uygulanmaz).
        const CLOCKS = [
            { city: 'London',   tz: 'UTC',            lat: 51.507, lng: -0.128 },
            { city: 'Istanbul', tz: 'Europe/Istanbul', lat: 41.008, lng: 28.978 },
            { city: 'Pattaya',  tz: 'Asia/Bangkok',    lat: 12.924, lng: 100.883 },
            { city: 'Bali',     tz: 'Asia/Makassar',   lat: -8.650, lng: 115.217 },
            { city: 'Tokyo',    tz: 'Asia/Tokyo',      lat: 35.676, lng: 139.650 },
        ];
        const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                        'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = new Map(CLOCKS.map(c => [c.tz, new Intl.DateTimeFormat('en-GB', {
            timeZone: c.tz, year: 'numeric', month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })]));
        const now = (tz, d) => {
            const p = Object.fromEntries(fmt.get(tz).formatToParts(d).map(x => [x.type, +x.value]));
            return { h: p.hour, m: p.minute, s: p.second, day: `${p.day} ${MONTHS[p.month - 1]} ${p.year}`, key: `${p.year}-${p.month}-${p.day}` };
        };


        const suns = new Map(); // tz → { key, R, S, stops } — günde bir hesaplanır
        function sunFor(c, t, d) {
            let v = suns.get(c.tz);
            if (v?.key === t.key) return v;
            const off = ((t.h * 60 + t.m) - (d.getUTCHours() * 60 + d.getUTCMinutes()) + 2160) % 1440 - 720;
            const { rise, set } = sunUTC(d, c.lat, c.lng);
            const R = (((rise + off) % 1440 + 1440) % 1440) / 60, S = (((set + off) % 1440 + 1440) % 1440) / 60;
            v = { key: t.key, R, S, stops: skyStops(R, S) };
            suns.set(c.tz, v);
            return v;
        }

        css('gt-shell-clocks', `
        #gt-clocks{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:10;
          display:inline-flex !important; align-items:stretch; background:#fff; border:1px solid #d9dde3; border-radius:12px;
          box-shadow:0 1px 1.5px rgba(16,24,40,.06); overflow:hidden; font-family:var(--gt-font); line-height:1}
        #gt-clocks .clk{display:flex; align-items:baseline; gap:8px; padding:7px 16px; border-left:1px solid rgba(255,255,255,.18);
          color:#fff; transition:color .8s}
        #gt-clocks .clk:first-child{border-left:0}
        #gt-clocks .clk.light{color:#1f2a37}
        #gt-clocks .city{font-size:11px; font-weight:600; opacity:.72}
        #gt-clocks .t{font-size:17px; font-weight:700; letter-spacing:-.3px; font-variant-numeric:tabular-nums}
        #gt-clocks .s{font-size:11px; font-weight:600; opacity:.5; margin-left:-5px; font-variant-numeric:tabular-nums}
        /* Güneş/ay noktası: doğuş-batış turuncu, gündüz sarı + beyaz ışıma, gece beyaz */
        #gt-clocks .dn{--c:245,158,11; --g:245,158,11; width:6px; height:6px; border-radius:50%; align-self:center;
          background:rgb(var(--c)); animation:gt-sun 2.4s ease-in-out infinite}
        #gt-clocks .dn.day{--c:250,204,21; --g:255,255,255}
        #gt-clocks .dn.night{--c:255,255,255; --g:255,255,255}
        @keyframes gt-sun{0%,100%{opacity:.35; box-shadow:0 0 0 rgba(var(--g),0)}
          50%{opacity:1; box-shadow:0 0 6px 1px rgba(var(--g),.9)}}
        #gt-clocks .dn.day{animation-name:gt-sunday}
        @keyframes gt-sunday{0%,100%{opacity:.45; box-shadow:0 0 0 rgba(255,255,255,0)}
          50%{opacity:1; box-shadow:0 0 5px 2px rgba(255,255,255,.95), 0 0 12px 4px rgba(250,204,21,.55)}}
        @media (prefers-reduced-motion:reduce){#gt-clocks .dn{animation:none; opacity:1}}`);

        const paint = (group) => {
            const d = new Date();
            [...group.children].forEach((el, i) => {
                const c = CLOCKS[i], t = now(c.tz, d), sun = sunFor(c, t, d);
                const hf = t.h + t.m / 60, { bg, light } = sky(sun.stops, hf);
                if (el.dataset.bg !== bg) { el.dataset.bg = bg; el.style.background = bg; }
                el.classList.toggle('light', light);
                const dot = el.firstChild, ph = phase(hf, sun.R, sun.S);
                if (dot.dataset.ph !== ph) { dot.dataset.ph = ph; dot.className = `dn ${ph}`; }
                el.querySelector('.t').textContent = `${pad(t.h)}:${pad(t.m)}`;
                el.querySelector('.s').textContent = pad(t.s);
                el.title = `${t.day} · gün doğumu ${pad(Math.floor(sun.R))}:${pad(Math.round(sun.R % 1 * 60) % 60)} · gün batımı ${pad(Math.floor(sun.S))}:${pad(Math.round(sun.S % 1 * 60) % 60)}`;
            });
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
   4b · HESAP ALANI — avatar/dil/tarih gizli, kullanıcı adı yerine MARCUS
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-account',
    source: 'shell',
    setup() {
        css('gt-shell-account', `
        /* Sağdaki hesap alanı: avatar, dil ve tarih gizli; kullanıcı adı yerine MARCUS.
           Tıklanınca sitenin hesap menüsü (şifre, tema) yine açılır. */
        ul.nav-account-info .thumb-sm, ul.nav-account-info > li:not(:first-child){display:none !important}
        ul.nav-account-info > li:first-child strong{font-size:0 !important}
        ul.nav-account-info > li:first-child strong::after{content:'MARCUS'; font-family:var(--gt-font); font-size:12.5px;
          font-weight:700; letter-spacing:.08em; color:var(--gt-text, #343a43)}
        /* Hesap menüsü ekranın sağ kenarında: sağa değil sola doğru açılsın. */
        ul.nav-account-info > li:first-child > .dropdown-menu{left:auto !important; right:0 !important}`);
    },
});

/* ════════════════════════════════════════════════════════════
   4c · PENCERE SEKMELERİ — sitenin üstteki oyuncu sekmeleri
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'shell-wintabs',
    source: 'shell',
    setup(ctx) {
        css('gt-shell-wintabs', `
        /* Üstteki pencere sekmeleri (sitenin açtığı oyuncu sekmeleri): adacık, aktif koyu,
           × büyük ve üzerine gelince kırmızı. Pin işlevsiz olduğu için gizli. */
        .mat-tab-nav-bar .mat-ink-bar{display:none !important}
        /* Eski tip sayfaların iframe'i site tarafından top:26px (eski ince sekme çubuğu)
           ile yerleştiriliyor; bizim çubuğumuz ~44px olduğu için sekmenin altını örtüyordu. */
        iframe-projector iframe{top:44px !important}
        .mat-tab-nav-bar .mat-tab-links{display:inline-flex !important; background:#fff; border:1px solid #d9dde3; border-radius:9px;
          box-shadow:0 1px 1.5px rgba(16,24,40,.06); overflow:hidden; margin:4px 0 6px}
        .mat-tab-nav-bar a.mat-tab-link{height:32px !important; min-width:0 !important; margin:0 !important; padding:0 0 0 12px !important;
          gap:4px; opacity:1 !important; border:0 !important; border-radius:0 !important; background:#fff !important; color:#344054 !important;
          font-family:var(--gt-font) !important; font-size:12px !important; font-weight:600 !important; text-decoration:none !important;
          transition:background-color .12s}
        .mat-tab-nav-bar a.mat-tab-link + a.mat-tab-link{border-left:1px solid #eceef1 !important}
        .mat-tab-nav-bar a.mat-tab-link:hover{background:#f5f6f8 !important}
        .mat-tab-nav-bar a.mat-tab-link .inner-ellipsis-overflow{max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:0 2px 0 0 !important}
        .mat-tab-nav-bar a.mat-tab-link .fa-thumb-tack{display:none !important}
        .mat-tab-nav-bar a.mat-tab-link .close-tabs{display:inline-flex !important; align-items:center; justify-content:center; width:32px; height:32px;
          position:static !important; float:none !important; inset:auto !important; transform:none !important; flex:none;
          margin:0 0 0 4px !important; border-radius:0; font-size:16px !important; color:#8e8e93 !important; cursor:pointer; transition:background-color .12s, color .12s}
        .mat-tab-nav-bar a.mat-tab-link .close-tabs:hover{background:#fdecec !important; color:#d70015 !important}
        /* Üç ton: sabit Pending Withdrawals koyu gri · seçili sekme açık gri · diğerleri beyaz */
        .mat-tab-nav-bar a.mat-tab-link.mat-tab-label-active{background:#e1e5ea !important; color:var(--gt-text, #343a43) !important}
        .mat-tab-nav-bar a.mat-tab-link.mat-tab-label-active + a.mat-tab-link{border-left-color:transparent !important}
        .mat-tab-nav-bar a.mat-tab-link[data-gt-tab]{background:var(--gt-strong, #525a66) !important; color:#fff !important}
        .mat-tab-nav-bar a.mat-tab-link[data-gt-tab] + a.mat-tab-link{border-left-color:transparent !important}
        .mat-tab-nav-bar a.mat-tab-link[data-gt-tab]{padding-right:12px !important}
        .mat-tab-nav-bar a.mat-tab-link[data-gt-tab] .close-tabs{display:none !important}
        .mat-tab-nav-bar a.mat-tab-link[data-gt-tab] + a.mat-tab-link[data-gt-tab]{border-left:1px solid rgba(255,255,255,.14) !important}
        /* Sabit sekmenin başında nokta: yeri hep var (yazı kaymasın), açık olanda turuncu ve yanıp söner */
        .mat-tab-nav-bar a.mat-tab-link[data-gt-tab]::before{content:''; width:6px; height:6px; border-radius:50%; flex:none;
          margin-right:4px; background:rgba(255,255,255,.22)}
        .mat-tab-nav-bar a.mat-tab-link[data-gt-tab].gt-here::before{background:#f59e0b; animation:gt-tabdot 2.4s ease-in-out infinite}
        @keyframes gt-tabdot{0%,100%{opacity:.35; box-shadow:0 0 0 rgba(245,158,11,0)}
          50%{opacity:1; box-shadow:0 0 6px 1px rgba(245,158,11,.85)}}
        @media (prefers-reduced-motion:reduce){.mat-tab-nav-bar a.mat-tab-link[data-gt-tab].gt-here::before{animation:none; opacity:1}}
        /* Sitenin kendi Player Search sekmesi gizli: yerine sabit olanı var */
        .mat-tab-nav-bar a.mat-tab-link[href*="/players/search"]:not([data-gt-tab]){display:none !important}`);

        // Sabit Player Search sekmesi: en solda, Pending Withdrawals'ın önünde.
        // Sekme listesi sitenin kodu tarafından yeniden çizilebilir; kaybolursa geri konur.
        const searchTab = ctx.own(h('a', {
            id: 'gt-search-tab', class: 'mat-tab-link', 'data-gt-tab': '2', href: SEARCH,
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); router.go(SEARCH); },
        }, h('span', { class: 'inner-ellipsis-overflow' }, 'Player Search')));

        const sync = () => {
            const list = $('.mat-tab-nav-bar .mat-tab-links');
            if (!list) return;
            const pending = list.querySelector('a.mat-tab-link[data-gt-tab="1"]');
            const placed = searchTab.parentElement === list
                && (pending ? pending.previousElementSibling === searchTab : list.firstElementChild === searchTab);
            if (!placed) pending ? pending.before(searchTab) : list.prepend(searchTab);
            const path = location.pathname;
            pending?.classList.toggle('gt-here', path.startsWith(PENDING));
            searchTab.classList.toggle('gt-here', path.includes('/players/search'));
        };
        ctx.tick(sync, { lazy: true });
        ctx.onRoute(sync);
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
