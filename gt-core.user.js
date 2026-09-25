// ==UserScript==
// @name         GT Core — paylaşılan çalışma zamanı
// @namespace    http://tampermonkey.net/
// @version      1.1.2
// @description  GamingTec script ailesinin ortak çekirdeği: tek veriyolu, rota-farkındalıklı modül yaşam döngüsü, sessionKey disiplinli API katmanı, tasarım token'ları + UI kiti, kısayol defteri, gameTranId veri katmanı ve Firefox için main-world ağ köprüsü. UI üretmez — tüm özellikler uydu scriptlerde yaşar. Çapraz origin izinleri (KYCAID, ipwho.is) burada toplanır; uydular GT.api.gm üzerinden kullanır, kendi @grant'ine ihtiyaç duymaz.
// @match        https://core-secundus.gmntc.com/*
// @match        https://core-ui-secundus.gmntc.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttprequest
// @grant        GM.xmlHttpRequest
// @connect      app.kycaid.com
// @connect      ipwho.is
// @run-at       document-start
// ==/UserScript==

/*
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  UYDU SCRIPT ŞABLONU                                                 ║
 ║                                                                      ║
 ║  Çekirdek daha yüklenmemiş olsa bile kayıt kaybolmaz: kuyruğa        ║
 ║  yazılır, çekirdek hazır olunca boşaltılır. Yükleme sırasıyla        ║
 ║  uğraşmana gerek yok.                                                ║
 ║                                                                      ║
 ║  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; ║
 ║  (W.__GT__ = W.__GT__ || []).push((GT) => {                          ║
 ║      GT.define({                                                     ║
 ║          id: 'accounting-panel',                                     ║
 ║          match: GT.at.playerDetail,                                  ║
 ║          setup(ctx) {                                                ║
 ║              ctx.mount('#anchor', 'gt-acc-panel', () => GT.h('div')); ║
 ║          },                                                          ║
 ║      });                                                             ║
 ║  });                                                                 ║
 ╚══════════════════════════════════════════════════════════════════════╝
*/

(() => {
'use strict';

const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

// Çekirdek iki kez yüklenirse (iki sekme scripti, hatalı kurulum) ikincisi çekilir.
if (W.GT && W.GT.__core) return;

const VERSION   = '1.1.2';
const API_LEVEL = 1;
const IN_FRAME  = window.self !== window.top;

/* ═══════════════════ temel yardımcılar ═══════════════════ */

const log  = (...a) => console.log('%c[GT]', 'color:#007AFF;font-weight:600', ...a);
const warn = (...a) => console.warn('[GT]', ...a);
const oops = (...a) => console.error('[GT]', ...a);
const safe = (fn, ...args) => { try { return fn(...args); } catch (e) { oops('yakalanan hata:', e); } };

const $   = (sel, root = document) => root.querySelector(sel);
const $$  = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const txt = (n) => (n?.textContent || '').trim();
const idle = (fn) => ('requestIdleCallback' in window) ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 60);

function h(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
        if (kid == null || kid === false) continue;
        node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
}

const css = (id, text) => {
    if (document.getElementById(id)) return;
    (document.head || document.documentElement).append(h('style', { id, html: text }));
};

const parseMoney = (s) => s ? (parseFloat(String(s).replace(/[A-Z₺$€£%]/gi, '').replace(/,/g, '').trim()) || 0) : 0;
const fmtTRY = (n) => `TRY ${Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 })}`;
const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };

/** "DD-MM-YYYY HH:mm:ss" → Date. (pendingWithdrawals ve transaction tabloları bu formatta.) */
function parseTrDate(s) {
    const m = String(s || '').trim().match(/(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    const [, dd, MM, yyyy, hh = '00', mi = '00', ss = '00'] = m;
    const d = new Date(`${yyyy}-${MM}-${dd}T${hh}:${mi}:${ss}`);
    return isNaN(d) ? null : d;
}

/* ═══════════════════ veriyolu ═══════════════════
   Tek MutationObserver. Aboneler mutation başına değil, KARE başına
   çağrılır — Angular'ın mutation fırtınalarında CPU'yu yiyen buydu.
   Ağır işler {lazy:true} ile requestIdleCallback kuyruğuna düşer.

   Kalp atışı: bu uygulamada mutation gelmeyen ölü anlar oluyor ve
   modül orada asılı kalabiliyor. Bu yüzden saniyede bir bedava bir
   flush tetikliyoruz (abone yoksa hiçbir maliyeti yok).
   ═══════════════════════════════════════════════ */
const bus = (() => {
    const now = new Set();
    const soon = new Set();
    let queued = false, idleQueued = false, observing = false;

    function flush() {
        queued = false;
        for (const fn of now) safe(fn);
        if (soon.size && !idleQueued) {
            idleQueued = true;
            idle(() => { idleQueued = false; for (const fn of soon) safe(fn); });
        }
    }
    function poke() { if (queued) return; queued = true; requestAnimationFrame(flush); }

    function observe() {
        if (observing) return;
        const root = document.documentElement;
        if (!root) { setTimeout(observe, 10); return; }
        observing = true;
        new MutationObserver(poke).observe(root, { childList: true, subtree: true });
        setInterval(() => { if (now.size || soon.size) poke(); }, 1000);
    }

    return {
        /** @returns {() => void} aboneliği iptal eden fonksiyon */
        on(fn, { lazy = false } = {}) {
            const set = lazy ? soon : now;
            set.add(fn); observe(); poke();
            return () => set.delete(fn);
        },
        poke,
        get size() { return now.size + soon.size; },
    };
})();

/* ═══════════════════ router ═══════════════════ */
const router = (() => {
    const subs = new Set();
    let href = location.href;
    const emit = () => {
        if (location.href === href) return;
        href = location.href;
        for (const fn of subs) safe(fn, href);
    };
    for (const m of ['pushState', 'replaceState']) {
        const orig = history[m];
        history[m] = function (...a) { const r = orig.apply(this, a); queueMicrotask(emit); return r; };
    }
    addEventListener('popstate', emit);
    addEventListener('hashchange', emit);
    bus.on(emit); // yedek: event üretmeden değişen URL'ler

    return {
        on(fn) { subs.add(fn); return () => subs.delete(fn); },
        go(path) {
            if (location.pathname === path) return;
            history.pushState(null, '', path);
            dispatchEvent(new PopStateEvent('popstate'));
        },
    };
})();

/** Sık kullanılan rota testleri — uydu scriptler bunları paylaşsın. */
const at = {
    playerDetail: () => /\/players\/\d+\/detail/.test(location.href),
    playerSearch: () => location.pathname.includes('/players/search'),
    txHistory:    () => location.href.includes('transaction-history'),
    // Klasik liste iframe'de "PendingWithdrawals.action" olarak açılıyor —
    // büyük/küçük harf duyarsız olmalı, yoksa iframe içinde eşleşmez.
    pending:      () => /pendingwithdrawals/i.test(location.href),
    bonusPlan:    () => location.pathname.includes('/core/app/core/promotion/bonusPlan/'),
};

/* ═══════════════════ kısayol defteri ═══════════════════ */
const hotkeys = (() => {
    const map = new Map();
    const norm = (combo) => combo.toLowerCase().split('+').map(s => s.trim()).sort().join('+');

    addEventListener('keydown', (e) => {
        const key = (e.code || '').replace(/^(Key|Digit)/, '').toLowerCase();
        if (!key) return;
        const parts = [];
        if (e.altKey) parts.push('alt');
        if (e.ctrlKey) parts.push('ctrl');
        if (e.shiftKey) parts.push('shift');
        parts.push(key);
        const set = map.get(parts.sort().join('+'));
        if (!set?.size) return;
        e.preventDefault(); e.stopImmediatePropagation();
        for (const fn of set) safe(fn, e);
    }, true);

    return {
        on(combo, fn) {
            const k = norm(combo);
            if (!map.has(k)) map.set(k, new Set());
            map.get(k).add(fn);
            return () => map.get(k)?.delete(fn);
        },
        /** Çakışma denetimi için: hangi kombinasyon kimde? */
        list: () => [...map.entries()].filter(([, s]) => s.size).map(([k, s]) => `${k} ×${s.size}`),
    };
})();

/* ═══════════════════ API katmanı ═══════════════════
   Kurallar:
   · Token HER İSTEKTE sessionStorage'dan taze okunur, asla saklanmaz —
     sessionKey rotasyonlu ve bayat anahtar sessiz 401 döndürüyor.
   · Yanıt cache'i URL'den sessionKey çıkarılarak anahtarlanır, böylece
     anahtar dönse de aynı veri iki kez çekilmez ama istek hep taze
     anahtarla gider.
   · Aynı anda aynı isteği yapan iki modül tek ağ çağrısını paylaşır.
   ═══════════════════════════════════════════════════ */
const api = (() => {
    const HOST = 'https://core-secundus.gmntc.com';
    const TOKEN_KEYS = ['service_auth_token', 'auth_token', 'session_auth_token'];

    function token() {
        for (const key of TOKEN_KEYS) {
            try {
                const raw = sessionStorage.getItem(key);
                if (!raw) continue;
                try {
                    const parsed = JSON.parse(raw);
                    const t = parsed?.external?.token || parsed?.token || (typeof parsed === 'string' ? parsed : null);
                    if (t) return t;
                } catch { if (raw.split('.').length === 3) return raw; }
            } catch { /* sessionStorage erişilemiyor */ }
        }
        return null;
    }
    function need() {
        const t = token();
        if (!t) throw new Error('Oturum token bulunamadı (sessionStorage)');
        return t;
    }

    const partyId = () => location.href.match(/players\/(\d+)/)?.[1] ?? null;

    const store = new Map();
    const keyOf = (url) => url.replace(/([?&])sessionKey=[^&]*/g, '$1sessionKey=*');

    function cached(prefix, url, ttl, factory) {
        const key = prefix + keyOf(url);
        const hit = store.get(key);
        if (hit && (ttl === Infinity || Date.now() - hit.t < ttl)) return hit.p;
        const p = factory().catch((e) => { store.delete(key); throw e; });
        store.set(key, { t: Date.now(), p });
        return p;
    }

    /** ICS gateway URL'i — sessionKey her çağrıda taze. */
    const ics = (path, params = {}) =>
        `${HOST}/ics/${path}?${new URLSearchParams({ sessionKey: need(), uType: 'staff', ...params })}`;

    /** Eski Struts (.action) URL'i. */
    const legacy = (path, params = {}) =>
        `${HOST}/j/${path}?${new URLSearchParams({ embeddedInNewDashboard: 'true', cmslanguage: 'en', token: need(), ...params })}`;

    function json(url, { ttl = 15000 } = {}) {
        return cached('J', url, ttl, async () => {
            const t = token();
            const res = await fetch(url, {
                credentials: 'include',
                headers: { Accept: 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.split('?')[0]}`);
            return res.json();
        });
    }

    function doc(url, { ttl = 15000 } = {}) {
        return cached('D', url, ttl, async () => {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return new DOMParser().parseFromString(await res.text(), 'text/html');
        });
    }

    /** Çapraz origin (KYCAID) için — ayrı CSRF akışı, Bearer ile karıştırma. */
    function gm(details) {
        const fn = (typeof GM_xmlhttprequest === 'function') ? GM_xmlhttprequest
                 : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest
                 : null;
        if (!fn) return Promise.reject(new Error('GM_xmlhttprequest yok (@grant eksik)'));
        return new Promise((resolve, reject) =>
            fn({ ...details, onload: resolve, onerror: reject, ontimeout: () => reject(new Error('zaman aşımı')) }));
    }

    router.on(() => store.clear()); // oyuncu değişti → oyuncuya özel veri bayat

    return { HOST, token, need, partyId, json, doc, ics, legacy, gm, clear: () => store.clear() };
})();

/* ═══════════════════ main-world ağ köprüsü ═══════════════════
   Firefox'ta userscript'in kendi fetch/XHR'ı sayfanın gerçek ağ
   trafiğinden yalıtık — içeriden pasif dinleme hiçbir şey yakalamıyor.
   Çalışan desen: sayfanın gerçek JS bağlamına <script> enjekte edip
   fetch/XHR'ı orada yamalamak ve veriyi CustomEvent ile geri almak.
   ════════════════════════════════════════════════════════════ */
const capture = (() => {
    const EVENT = 'gt:net';
    const subs = new Set();
    let injected = false;

    function inject() {
        if (injected) return;
        injected = true;

        const patch = function (EVENT) {
            const relay = (payload) => {
                try { document.dispatchEvent(new CustomEvent(EVENT, { detail: payload })); } catch (e) { /* yut */ }
            };

            const origFetch = window.fetch;
            window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : input?.url;
                return origFetch.apply(this, arguments).then((res) => {
                    try {
                        res.clone().text().then(
                            (body) => relay({ via: 'fetch', url, status: res.status, body }),
                            () => {});
                    } catch (e) { /* yut */ }
                    return res;
                });
            };

            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url) {
                this.__gtUrl = url;
                return origOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function () {
                this.addEventListener('load', () => {
                    let body = '';
                    try { body = this.responseType === '' || this.responseType === 'text' ? this.responseText : ''; } catch (e) { /* yut */ }
                    relay({ via: 'xhr', url: this.__gtUrl, status: this.status, body });
                });
                return origSend.apply(this, arguments);
            };
        };

        const el = document.createElement('script');
        el.textContent = `(${patch.toString()})(${JSON.stringify(EVENT)});`;
        (document.head || document.documentElement).prepend(el);
        el.remove();

        document.addEventListener(EVENT, (e) => {
            const payload = e.detail;
            if (!payload?.url) return;
            for (const { test, fn } of subs) {
                if (!safe(test, payload.url)) continue;
                safe(fn, payload);
            }
        });
    }

    return {
        /**
         * Sayfanın gerçek ağ trafiğini dinle.
         * @param {RegExp|string|(url:string)=>boolean} pattern
         * @param {(payload:{url,status,body,via})=>void} fn
         */
        on(pattern, fn) {
            inject();
            const test = typeof pattern === 'function' ? pattern
                       : pattern instanceof RegExp ? (u) => pattern.test(u)
                       : (u) => u.includes(pattern);
            const rec = { test, fn };
            subs.add(rec);
            return () => subs.delete(rec);
        },
        /** İlk eşleşen yanıtı bekle (JSON olarak). */
        once(pattern, { timeout = 15000 } = {}) {
            return new Promise((resolve, reject) => {
                const off = capture.on(pattern, (p) => {
                    off(); clearTimeout(timer);
                    try { resolve(JSON.parse(p.body)); } catch (e) { resolve(p.body); }
                });
                const timer = setTimeout(() => { off(); reject(new Error('yakalama zaman aşımı')); }, timeout);
            });
        },
    };
})();

/* ═══════════════════ işlem verisi (gameTranId) ═══════════════════
   Kural: bir tur birden fazla BET/WIN satırı üretebilir → gameTranId
   altında TİP BAZINDA TOPLA, ilkini alma. Ürün/sağlayıcı filtresi
   platformName üzerinden yapılır, gameName üzerinden değil.
   Sıralama datetime (sayısal) ile, gösterim datetimeStr ile.
   ═══════════════════════════════════════════════════════════════ */
const rounds = {
    /**
     * Ağdan gelen ham işlem kayıtlarını gameTranId'ye göre gruplar.
     * @param {Array} records player-transactions kayıtları
     */
    group(records = []) {
        const map = new Map();
        for (const r of records) {
            const id = r.gameTranId ?? r.gameTranID ?? r.tranId;
            if (!id) continue;
            let round = map.get(id);
            if (!round) {
                round = {
                    id, bet: 0, win: 0, rows: [],
                    platformName: r.platformName || '',
                    gameName: r.gameName || '',
                    datetime: r.datetime ?? 0,
                    datetimeStr: r.datetimeStr || '',
                };
                map.set(id, round);
            }
            const type = String(r.tranType || r.type || '').toUpperCase();
            const amount = Math.abs(Number(r.amount ?? 0));
            if (type.includes('GAME_BET')) round.bet += amount;
            else if (type.includes('GAME_WIN')) round.win += amount;
            round.rows.push(r);
            if ((r.datetime ?? 0) > round.datetime) {
                round.datetime = r.datetime ?? round.datetime;
                round.datetimeStr = r.datetimeStr || round.datetimeStr;
            }
        }
        return map;
    },

    /** Oranı sınırın altında kalan turlar (bet>0 ve win>0 olanlar arasında). */
    belowRatio(grouped, min) {
        const out = [];
        for (const round of grouped.values()) {
            if (!round.bet || !round.win) continue;
            const ratio = round.win / round.bet;
            if (ratio < min) out.push({ ...round, ratio });
        }
        return out.sort((a, b) => a.ratio - b.ratio);
    },

    /** BET'i olmayan WIN turları — matematiksel olarak imkânsız, elle incelenir. */
    orphanWins(grouped) {
        return [...grouped.values()].filter(r => r.win > 0 && r.bet === 0);
    },

    byPlatform(grouped, needle) {
        const n = String(needle).toUpperCase();
        return [...grouped.values()].filter(r => (r.platformName || '').toUpperCase().includes(n));
    },

    chronological(grouped) {
        return [...grouped.values()].sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
    },
};

/* ═══════════════════ tasarım token'ları + UI kiti ═══════════════════ */
css('gt-core-style', `
:root{
  --gt-accent:#007AFF; --gt-accent-soft:rgba(0,122,255,.08);
  --gt-danger:#FF3B30; --gt-success:#34C759; --gt-warn:#FF9500; --gt-vip:#AF52DE;
  --gt-ink:#1c1c1e; --gt-ink-2:#48484a; --gt-muted:#8e8e93;
  --gt-surface:#fff; --gt-surface-2:#f2f2f7; --gt-line:rgba(0,0,0,.08);
  --gt-r:12px; --gt-r-lg:16px;
  --gt-shadow:0 1px 3px rgba(0,0,0,.06);
  --gt-shadow-pop:0 6px 28px rgba(0,0,0,.14);
  --gt-shadow-modal:0 20px 60px rgba(0,0,0,.14);
  --gt-font:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif;
}
.gt-btn,.gt-chip,.gt-icon-btn,.gt-pop__x{touch-action:manipulation}

.gt-btn{
  all:unset; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; gap:5px;
  padding:4px 12px; font-family:var(--gt-font); font-size:13px; line-height:20px; font-weight:500;
  color:var(--gt-accent); background:var(--gt-surface); border:.5px solid var(--gt-accent);
  border-radius:var(--gt-r); cursor:pointer; white-space:nowrap;
  transition:background .15s,color .15s,transform .1s;
}
.gt-btn:hover{background:var(--gt-accent); color:#fff}
.gt-btn:active{transform:scale(.97)}
.gt-btn:focus-visible{outline:2px solid var(--gt-accent); outline-offset:2px}
.gt-btn.is-active{background:var(--gt-accent); color:#fff}
.gt-btn.is-busy{opacity:.55; pointer-events:none}
.gt-btn[disabled]{opacity:.45; cursor:not-allowed}
.gt-btn--sm{padding:1px 8px; font-size:11px; line-height:18px}
.gt-btn--warn{color:var(--gt-warn); border-color:var(--gt-warn)}
.gt-btn--warn:hover,.gt-btn--warn.is-active{background:var(--gt-warn); color:#fff}
.gt-btn--danger{color:var(--gt-danger); border-color:var(--gt-danger)}
.gt-btn--danger:hover,.gt-btn--danger.is-active{background:var(--gt-danger); color:#fff}
.gt-btn--quiet{color:var(--gt-ink-2); background:var(--gt-surface-2); border-color:#c6c6c8}
.gt-btn--quiet:hover{background:#e5e5ea; color:var(--gt-ink)}

.gt-group{
  display:inline-flex; align-items:center; gap:6px; margin-left:8px; padding:4px; vertical-align:middle;
  background:rgba(255,255,255,.6); border:.5px solid rgba(60,60,67,.12); border-radius:var(--gt-r-lg);
  box-shadow:0 1px 3px rgba(0,0,0,.04);
}

.gt-chip{
  display:inline-flex; align-items:center; gap:5px; padding:2px 9px; vertical-align:middle;
  font-family:var(--gt-font); font-size:10.5px; font-weight:600; white-space:nowrap;
  border-radius:20px; border:.5px solid; user-select:none;
}
.gt-chip--accent {background:var(--gt-accent-soft);   border-color:rgba(0,122,255,.35);  color:var(--gt-accent)}
.gt-chip--danger {background:rgba(255,59,48,.08);     border-color:rgba(255,59,48,.35);  color:var(--gt-danger)}
.gt-chip--success{background:rgba(52,199,89,.08);     border-color:rgba(52,199,89,.35);  color:var(--gt-success)}
.gt-chip--warn   {background:rgba(255,149,0,.10);     border-color:rgba(255,149,0,.35);  color:var(--gt-warn)}
.gt-chip--vip    {background:rgba(175,82,222,.08);    border-color:rgba(175,82,222,.35); color:var(--gt-vip)}
.gt-chip--muted  {background:rgba(142,142,147,.08);   border-color:rgba(142,142,147,.3); color:var(--gt-muted)}

.gt-icon-btn{
  all:unset; display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px;
  border-radius:50%; background:rgba(0,0,0,.38); color:#fff; cursor:pointer; transition:background .15s;
}
.gt-icon-btn:hover{background:rgba(0,0,0,.55)}
.gt-icon-btn svg{width:10px; height:10px}

.gt-pop{
  position:fixed; z-index:2147483647; max-height:75vh; overflow-y:auto;
  max-width:calc(100vw - 16px); box-sizing:border-box;
  background:var(--gt-surface); border:.5px solid #c6c6c8; border-radius:14px;
  box-shadow:var(--gt-shadow-pop); font-family:var(--gt-font); font-size:12px; color:var(--gt-ink);
}
.gt-pop__head{
  position:sticky; top:0; display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:10px 12px; background:var(--gt-surface-2); border-bottom:.5px solid #c6c6c8; border-radius:14px 14px 0 0;
}
.gt-pop__title{display:flex; align-items:center; gap:8px; font-weight:600; font-size:13px; letter-spacing:-.1px}
.gt-pop__x{all:unset; display:flex; align-items:center; justify-content:center; width:20px; height:20px;
  border-radius:6px; color:var(--gt-muted); font-size:14px; cursor:pointer}
.gt-pop__x:hover{background:#e5e5ea}
.gt-pop__body{padding:12px}
.gt-pop::-webkit-scrollbar,.gt-scroll::-webkit-scrollbar{width:4px}
.gt-pop::-webkit-scrollbar-thumb,.gt-scroll::-webkit-scrollbar-thumb{background:#c6c6c8; border-radius:4px}
.gt-dot{width:8px; height:8px; border-radius:50%; display:inline-block}

.gt-modal{position:fixed; inset:0; z-index:999999; display:flex; align-items:center; justify-content:center;
  background:rgba(0,0,0,.35); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px)}
.gt-modal__card{width:90%; max-height:72vh; overflow-y:auto; box-sizing:border-box;
  background:rgba(255,255,255,.97); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
  border:1px solid var(--gt-line); border-radius:20px; box-shadow:var(--gt-shadow-modal);
  font-family:var(--gt-font); font-size:14px; color:var(--gt-ink); animation:gt-pop-in .22s ease}
.gt-modal__head{position:sticky; top:0; display:flex; align-items:center; justify-content:space-between;
  padding:18px 26px; background:rgba(255,255,255,.75); backdrop-filter:blur(10px);
  border-bottom:1px solid rgba(0,0,0,.06); border-radius:20px 20px 0 0}
.gt-modal__title{display:flex; align-items:center; gap:10px; font-size:17px; font-weight:600}
.gt-modal__body{padding:18px 26px 24px; line-height:1.6}
@keyframes gt-pop-in{from{opacity:0; transform:scale(.97)}to{opacity:1; transform:scale(1)}}

.gt-kv{display:grid; grid-template-columns:1fr auto; gap:2px 16px}
.gt-kv span:nth-child(even){font-weight:600; text-align:right}
.gt-box{background:var(--gt-surface-2); border-radius:10px; padding:10px 12px}
.gt-stat{border:.5px solid #c6c6c8; border-radius:10px; padding:9px 12px; text-align:center; background:var(--gt-surface-2)}
.gt-stat__label{font-size:10px; font-weight:600; color:var(--gt-muted); letter-spacing:.4px; text-transform:uppercase; margin-bottom:3px}
.gt-stat__value{font-size:18px; font-weight:700; font-variant-numeric:tabular-nums}
.gt-card{background:var(--gt-surface-2); border:.5px solid #e5e5ea; border-radius:10px; padding:8px 10px; margin-bottom:5px}
.gt-card__id{color:var(--gt-muted); font-size:10px; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.gt-card__row{display:flex; justify-content:space-between; align-items:center}
.gt-status{color:var(--gt-muted); font-size:11px; text-align:center; padding:4px 0}
.gt-spinner{width:16px; height:16px; border:2px solid var(--gt-accent); border-right-color:transparent;
  border-radius:50%; animation:gt-spin .8s linear infinite; display:inline-block}
@keyframes gt-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms !important; transition-duration:.01ms !important}}
`);

const ui = {
    button({ label, title, variant, small, onClick, id }) {
        return h('button', {
            type: 'button', id, title,
            class: `gt-btn${variant ? ' gt-btn--' + variant : ''}${small ? ' gt-btn--sm' : ''}`,
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); onClick?.(e); },
        }, label);
    },

    chip: (label, tone = 'muted', extra) => h('span', { class: `gt-chip gt-chip--${tone}` }, label, extra),

    /** Butonu "çalışıyor" durumuna al, iş bitince geri ver. */
    busy(btn, promise) {
        if (!btn) return promise;
        btn.classList.add('is-busy');
        return Promise.resolve(promise).finally(() => btn.classList.remove('is-busy'));
    },

    /** anchorId'ye tutunan popover — çapa yeniden yaratılsa da id ile bulunur. */
    popover({ anchorId, title, width = 300, dot }) {
        const body = h('div', { class: 'gt-pop__body' });
        const heading = h('span', { class: 'gt-pop__title' },
            dot ? h('i', { class: 'gt-dot', style: { background: dot } }) : null, h('span', {}, title));
        const root = h('div', { class: 'gt-pop', style: { width: width + 'px' } },
            h('div', { class: 'gt-pop__head' }, heading,
                h('button', { class: 'gt-pop__x', type: 'button', onclick: () => ctrl.close() }, '✕')),
            body);

        let open = false;
        const anchor = () => document.getElementById(anchorId);
        const place = () => {
            const a = anchor();
            if (!a) return ctrl.close();
            const r = a.getBoundingClientRect();
            root.style.left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - width - 8)) + 'px';
            root.style.top = (r.bottom + 6) + 'px';
        };
        const outside = (e) => { if (!root.contains(e.target) && !anchor()?.contains(e.target)) ctrl.close(); };
        const onKey = (e) => { if (e.key === 'Escape') ctrl.close(); };

        const ctrl = {
            root, body,
            get isOpen() { return open; },
            setTitle(t) { heading.lastChild.textContent = t; },
            set html(v) { body.innerHTML = v; place(); },
            open() {
                if (open) return ctrl;
                open = true;
                document.body.append(root); place();
                addEventListener('scroll', place, true);
                addEventListener('resize', place);
                document.addEventListener('keydown', onKey);
                setTimeout(() => document.addEventListener('click', outside, true), 0);
                return ctrl;
            },
            close() {
                if (!open) return ctrl;
                open = false;
                root.remove();
                removeEventListener('scroll', place, true);
                removeEventListener('resize', place);
                document.removeEventListener('keydown', onKey);
                document.removeEventListener('click', outside, true);
                return ctrl;
            },
            toggle() { return open ? ctrl.close() : ctrl.open(); },
            place,
        };
        return ctrl;
    },

    modal({ title, icon, width = 640 }) {
        const body = h('div', { class: 'gt-modal__body' });
        const card = h('div', { class: 'gt-modal__card', style: { maxWidth: width + 'px' } },
            h('div', { class: 'gt-modal__head' },
                h('div', { class: 'gt-modal__title' }, icon ? h('span', {}, icon) : null, title),
                h('button', { class: 'gt-pop__x', type: 'button', onclick: () => ctrl.close() }, '✕')),
            body);
        const back = h('div', { class: 'gt-modal', onclick: (e) => { if (e.target === back) ctrl.close(); } }, card);
        const onKey = (e) => { if (e.key === 'Escape') ctrl.close(); };
        const ctrl = {
            body, root: back,
            set html(v) { body.innerHTML = v; },
            open() { document.body.append(back); document.addEventListener('keydown', onKey); return ctrl; },
            close() { back.remove(); document.removeEventListener('keydown', onKey); return ctrl; },
        };
        return ctrl;
    },

    spinner: (label = 'Yükleniyor…') =>
        `<div style="display:flex;align-items:center;gap:12px;color:var(--gt-muted)"><span class="gt-spinner"></span><span>${esc(label)}</span></div>`,
    empty: (label) => `<div style="text-align:center;padding:18px;color:var(--gt-muted);font-size:12px">${esc(label)}</div>`,
    error: (msg) => `<div style="padding:20px;text-align:center">
        <div style="font-size:28px;margin-bottom:10px;opacity:.5">⚠️</div>
        <div style="color:var(--gt-ink-2);margin-bottom:6px">İstek tamamlanamadı</div>
        <div style="color:var(--gt-muted);font-size:12px">${esc(msg)}</div></div>`,
};

const ICON = {
    pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
    copy:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    check:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    eye:    `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    search: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
};

/* ═══════════════════ modül yaşam döngüsü ═══════════════════ */
const modules = [];

function makeCtx(def) {
    const ac = new AbortController();
    const cleanups = new Set();
    const owned = new Set();

    const ctx = {
        id: def.id,
        signal: ac.signal,

        on(target, ev, fn, opts = {}) { target.addEventListener(ev, fn, { ...opts, signal: ac.signal }); return ctx; },
        tick(fn, opts) { cleanups.add(bus.on(fn, opts)); return ctx; },
        interval(fn, ms) { const id = setInterval(fn, ms); cleanups.add(() => clearInterval(id)); return ctx; },
        timeout(fn, ms) { const id = setTimeout(fn, ms); cleanups.add(() => clearTimeout(id)); return ctx; },
        hotkey(combo, fn) { cleanups.add(hotkeys.on(combo, fn)); return ctx; },
        onRoute(fn) { cleanups.add(router.on(fn)); return ctx; },
        capture(pattern, fn) { cleanups.add(capture.on(pattern, fn)); return ctx; },
        /** Modül sökülürken temizlenecek her şey: DOM düğümü, observer, worker… */
        own(disposable) { owned.add(disposable); return disposable; },
        onDestroy(fn) { cleanups.add(fn); return ctx; },

        /**
         * Çapaya bir kez monte et. Angular düğümü silerse bir sonraki
         * tick'te kendiliğinden geri gelir. Maliyet: tick başına tek
         * getElementById.
         */
        mount(anchorSel, id, build, place = 'append') {
            const install = () => {
                if (document.getElementById(id)?.isConnected) return;
                const anchor = typeof anchorSel === 'function' ? safe(anchorSel) : $(anchorSel);
                if (!anchor) return;
                const node = safe(build, anchor);
                if (!node) return;
                node.id = id;
                owned.add(node);
                if (place === 'after') anchor.insertAdjacentElement('afterend', node);
                else if (place === 'before') anchor.insertAdjacentElement('beforebegin', node);
                else if (place === 'body') document.body.append(node);
                else anchor.append(node);
            };
            ctx.tick(install); install();
            return ctx;
        },

        /** Eşleşen her YENİ düğüm için bir kez çalıştır. */
        each(sel, fn, opts) {
            const seen = new WeakSet();
            const run = () => {
                for (const node of $$(sel)) {
                    if (seen.has(node)) continue;
                    seen.add(node);
                    safe(fn, node);
                }
            };
            ctx.tick(run, opts); run();
            return ctx;
        },

        destroy() {
            ac.abort();
            for (const fn of cleanups) safe(fn);
            cleanups.clear();
            for (const item of owned) {
                if (typeof item?.remove === 'function') safe(() => item.remove());
                else if (typeof item?.disconnect === 'function') safe(() => item.disconnect());
                else if (typeof item?.terminate === 'function') safe(() => item.terminate());
            }
            owned.clear();
        },
    };
    return ctx;
}

function define(def) {
    if (!def?.id || typeof def.setup !== 'function') {
        oops('define(): id ve setup zorunlu', def);
        return null;
    }
    if (modules.some(m => m.id === def.id)) {
        warn(`define(): "${def.id}" zaten kayıtlı, yenisi yok sayıldı`);
        return null;
    }
    modules.push(def);
    if (booted) sync();
    return def;
}

function start(def) {
    def._ctx = makeCtx(def);
    const t0 = performance.now();
    safe(def.setup, def._ctx);
    def._ms = +(performance.now() - t0).toFixed(1);
}

function stop(def) {
    def._ctx.destroy();
    def._ctx = null;
    def._key = undefined;
}

function sync() {
    for (const def of modules) {
        const scope = def.scope || 'top';
        const scopeOk = scope === 'both' || (IN_FRAME ? scope === 'frame' : scope === 'top');
        const active = scopeOk && (!def.match || safe(def.match, location.href, location.pathname) === true);

        if (!active) { if (def._ctx) stop(def); continue; }

        // key: modülün konusu (ör. oyuncu id'si). İki rota da match'lese bile
        // konu değiştiyse modül baştan kurulur — "A oyuncusundan B oyuncusuna
        // geçtim ama panel A'nın verisiyle duruyor" sorunu böyle biter.
        const key = def.key ? safe(def.key) : null;
        if (def._ctx && def._key !== key) stop(def);
        if (!def._ctx) { def._key = key; start(def); }
    }
}

/* ═══════════════════ hata ayıklama ═══════════════════ */
function debug() {
    console.table(modules.map(m => ({
        id: m.id,
        aktif: !!m._ctx,
        kapsam: m.scope || 'top',
        'kurulum(ms)': m._ms ?? '—',
        kaynak: m.source || '—',
    })));
    log('veriyolu abone sayısı:', bus.size, '· kısayollar:', hotkeys.list().join(', ') || 'yok');
}

/* ═══════════════════ dışa açılan sözleşme ═══════════════════ */
const GT = {
    __core: true,
    VERSION, API_LEVEL, IN_FRAME,

    // v3 geriye dönük uyumluluk — eski scriptler kırılmasın
    observe: (fn) => bus.on(fn),
    parseMoney,
    getAuthToken: () => api.token(),
    navigateSPA: (path) => router.go(path),

    // çekirdek
    define, sync, modules, debug,
    bus, router, at, hotkeys, api, capture, rounds, ui, ICON, css,

    // yardımcılar
    h, $, $$, txt, esc, idle, safe, log, warn, oops,
    fmtTRY, parseTrDate,

    /** Çekirdek hazır olduğunda çalışacak kayıt fonksiyonu. */
    ready(fn) { safe(fn, GT); },
};

W.GT = GT;

/* Kuyruğu boşalt: çekirdekten ÖNCE yüklenen uydu scriptler burada devreye girer. */
const queue = W.__GT__;
W.__GT__ = { push: (fn) => safe(fn, GT) };
if (Array.isArray(queue)) for (const fn of queue) safe(fn, GT);

let booted = false;
function boot() {
    if (booted) return;
    booted = true;
    sync();
    router.on(sync);
    log(`Core v${VERSION} hazır · ${modules.length} modül kayıtlı · ${IN_FRAME ? 'iframe' : 'ana pencere'}`);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

})();
