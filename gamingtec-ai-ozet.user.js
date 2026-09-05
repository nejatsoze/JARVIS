// ==UserScript==
// @name         GamingTec — AI ÖZET (Yüksek Oranlı Kazanç Dedektörü)
// @namespace    gamingtec-ai-ozet
// @version      6.0.0
// @description  Aynı Game Tran ID'ye ait BET/WIN/iptal hareketlerini tek turda birleştirir, Win/Bet oranı eşiği aşan turları canlı filtrelenebilir, sürüklenebilir ve tema uyumlu bir panelde gösterir. Sayfalar arası biriktirme, sanal liste, CSV dışa aktarma.
// @author       —
// @match        https://core-secundus.gmntc.com/core/app/core/players/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 0. SABİTLER
  // ============================================================
  const VERSION = '6.0.0';
  const PREFIX = '[AI ÖZET]';
  const EVENT_NAME = '__gtAiOzetResponse';
  const TARGETS = ['/ics/player-transactions/page'];

  const STORAGE_KEY = 'gtAiOzet.settings.v2';
  const LEGACY_KEY = 'gtAiOzetSettings_v1';

  const MAX_ROWS = 20000;   // bellekte tutulan azami ham işlem sayısı
  const CHUNK = 60;         // listede tek seferde basılan satır sayısı (sanal liste)
  const REBUILD_DEBOUNCE = 120;

  const DEFAULTS = Object.freeze({
    ratioThreshold: 3,
    minBet: 0,
    minWin: 0,
    includeNoBet: true,      // bet'i olmayan (freespin/jackpot) kazançları da göster
    accumulate: true,        // sayfalar arasında veriyi biriktir
    excludedProducts: ['pragmatic', 'betby'],
    sortMode: 'time-asc',
    theme: 'auto',           // auto | light | dark
    filtersOpen: false,
    panel: { x: null, y: null, w: 640, h: 560 },
  });

  const log = (...a) => console.log(PREFIX, ...a);
  const warn = (...a) => console.warn(PREFIX, ...a);
  const fail = (...a) => console.error(PREFIX, ...a);

  // ============================================================
  // 1. YARDIMCILAR
  // ============================================================
  function debounce(fn, ms) {
    let t = 0;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    wrapped.flush = function (...args) { clearTimeout(t); fn.apply(this, args); };
    return wrapped;
  }

  function rafThrottle(fn) {
    let id = 0, lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (id) return;
      id = requestAnimationFrame(() => { id = 0; fn.apply(this, lastArgs); });
    };
  }

  const nfMoney = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfInt = new Intl.NumberFormat('tr-TR');
  const nfRatio = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });

  function fmtMoney(v, cur) {
    const n = Number(v) || 0;
    return nfMoney.format(n) + (cur ? ' ' + cur : '');
  }
  function fmtRatio(r) {
    if (!isFinite(r)) return '∞';
    return nfRatio.format(r) + 'x';
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDateTime(ms, fallback) {
    if (!ms) return fallback || '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return fallback || '';
    return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** "1.234,56", "1234.56", "-12,5", "(12,5)" ve "12,5 TRY" biçimlerini sayıya çevirir. */
  function parseNumber(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    let t = String(v).trim();
    let negative = /^\(.*\)$/.test(t) || t.startsWith('-');
    t = t.replace(/[()\s]/g, '').replace(/[A-Za-z₺$€£]/g, '').replace(/^[+-]/, '');
    const hasDot = t.indexOf('.') !== -1;
    const hasComma = t.indexOf(',') !== -1;
    if (hasDot && hasComma) {
      // Son gelen ayraç ondalıktır.
      if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
      else t = t.replace(/,/g, '');
    } else if (hasComma) {
      t = t.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    }
    const n = Number(t);
    if (!isFinite(n)) return 0;
    return negative ? -n : n;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    fallbackCopy(text);
    return Promise.resolve();
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* yoksay */ }
    ta.remove();
  }

  // ============================================================
  // 2. AYARLAR
  // ============================================================
  function loadSettings() {
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw) || {};
        if (Number(p.ratioThreshold) > 0) s.ratioThreshold = Number(p.ratioThreshold);
        if (Number(p.minBet) >= 0) s.minBet = Number(p.minBet) || 0;
        if (Number(p.minWin) >= 0) s.minWin = Number(p.minWin) || 0;
        if (typeof p.includeNoBet === 'boolean') s.includeNoBet = p.includeNoBet;
        if (typeof p.accumulate === 'boolean') s.accumulate = p.accumulate;
        if (Array.isArray(p.excludedProducts)) s.excludedProducts = p.excludedProducts.map(String);
        if (typeof p.sortMode === 'string') s.sortMode = p.sortMode;
        if (typeof p.theme === 'string') s.theme = p.theme;
        if (typeof p.filtersOpen === 'boolean') s.filtersOpen = p.filtersOpen;
        if (p.panel && typeof p.panel === 'object') Object.assign(s.panel, p.panel);
        return s;
      }
      // v1 ayarlarından geçiş
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const p = JSON.parse(legacy) || {};
        if (Number(p.ratioThreshold) > 0) s.ratioThreshold = Number(p.ratioThreshold);
        if (Array.isArray(p.excludedProducts)) s.excludedProducts = p.excludedProducts.map(String);
        log('v1 ayarları taşındı.');
      }
    } catch (e) {
      warn('Ayarlar okunamadı, varsayılanlar kullanılıyor.', e);
    }
    return s;
  }

  const settings = loadSettings();
  const persist = debounce(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* kota dolu olabilir */ }
  }, 300);

  // ============================================================
  // 3. ALAN OKUYUCULAR / SINIFLANDIRMA
  // ============================================================
  const TYPE_MAP = new Map([
    ['GAME_BET', 'BET'], ['BET', 'BET'], ['CASINO_BET', 'BET'], ['SPORT_BET', 'BET'],
    ['GAME_WIN', 'WIN'], ['WIN', 'WIN'], ['CASINO_WIN', 'WIN'], ['SPORT_WIN', 'WIN'],
    ['GAME_JACKPOT_WIN', 'WIN'], ['JACKPOT_WIN', 'WIN'],
    ['GAME_ROLLBACK', 'VOID'], ['ROLLBACK', 'VOID'], ['GAME_REFUND', 'VOID'], ['REFUND', 'VOID'],
    ['GAME_BET_CANCEL', 'VOID'], ['GAME_WIN_CANCEL', 'VOID'], ['GAME_CANCEL', 'VOID'],
    ['BET_CANCEL', 'VOID'], ['WIN_CANCEL', 'VOID'],
  ]);

  /** BET | WIN | VOID | '' (ilgisiz) */
  function classify(row) {
    const raw = String((row && (row.tranType || row.type)) || '').trim().toUpperCase();
    if (!raw) return '';
    const mapped = TYPE_MAP.get(raw);
    if (mapped) return mapped;
    // Bilinmeyen türler: iptal/geri alma önce, sonra bet/win kalıbı.
    if (raw.indexOf('CANCEL') !== -1 || raw.indexOf('ROLLBACK') !== -1 || raw.indexOf('REFUND') !== -1) return 'VOID';
    if (raw.indexOf('BET') !== -1) return 'BET';
    if (raw.indexOf('WIN') !== -1) return 'WIN';
    return '';
  }

  const firstString = (...vals) => {
    for (const v of vals) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return '';
  };

  const getGameTranId = (row) => (row && row.gameTranId != null ? String(row.gameTranId).trim() : '');
  const getGameName = (row) => firstString(row && row.gameName, row && row.game, row && row.gameTitle) || '(bilinmeyen oyun)';
  const getProduct = (row) => firstString(row && row.platformName, row && row.product, row && row.providerName);
  const getCurrency = (row) => firstString(row && row.currency, row && row.currencyCode);
  const getDebit = (row) => Math.abs(parseNumber(row && row.debit));
  const getCredit = (row) => Math.abs(parseNumber(row && row.credit));

  function getDatetimeMs(row) {
    if (!row) return 0;
    const n = Number(row.datetime);
    if (isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n; // saniye/ms otomatik
    const s = firstString(row.datetimeStr, row.transactionDate, row.createdAt, row.date);
    if (!s) return 0;
    const m = s.match(/^(\d{2})[-./](\d{2})[-./](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
    }
    const parsed = Date.parse(s);
    return isFinite(parsed) ? parsed : 0;
  }

  /** Satırı sayfalar arasında tekilleştirmek için kararlı anahtar. */
  function rowKey(row) {
    const id = firstString(row && row.id, row && row.tranId, row && row.transactionId, row && row.trxId);
    if (id) return 'id:' + id;
    return [
      getGameTranId(row), classify(row), row && row.debit, row && row.credit,
      row && (row.datetime || row.datetimeStr),
    ].join('|');
  }

  function isExcluded(product, excluded) {
    if (!excluded.length) return false;
    const text = String(product || '').toLowerCase();
    if (!text) return false;
    for (let i = 0; i < excluded.length; i++) {
      const kw = excluded[i];
      if (kw && text.indexOf(kw) !== -1) return true;
    }
    return false;
  }

  // ============================================================
  // 4. VERİ DEPOSU + ANALİZ
  // ============================================================
  const store = {
    rows: new Map(),      // rowKey -> ham satır
    groups: new Map(),    // gameTranId -> tur
    result: null,
    currency: '',
    lastUpdate: 0,
    responses: 0,
  };

  function ingest(rows) {
    if (!settings.accumulate && store.rows.size) store.rows.clear();
    let added = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row !== 'object') continue;
      const key = rowKey(row);
      if (store.rows.has(key)) continue;
      store.rows.set(key, row);
      added++;
      if (!store.currency) {
        const c = getCurrency(row);
        if (c) store.currency = c;
      }
    }
    // FIFO tavan: Map ekleme sırasını koruduğu için en eskiyi at.
    while (store.rows.size > MAX_ROWS) {
      const oldest = store.rows.keys().next().value;
      store.rows.delete(oldest);
    }
    store.responses++;
    return added;
  }

  /** Ağır adım: ham satırlardan tur (gameTranId) grupları. Sadece veri değişince çalışır. */
  function buildGroups() {
    const groups = new Map();
    for (const row of store.rows.values()) {
      const kind = classify(row);
      if (!kind) continue;
      const id = getGameTranId(row);
      if (!id) continue;

      let g = groups.get(id);
      if (!g) {
        g = {
          id, bet: 0, win: 0, voided: false, events: 0,
          gameName: '', product: '', productLc: '',
          ms: 0, timeText: '', searchBlob: '',
        };
        groups.set(id, g);
      }
      g.events++;
      if (!g.gameName) g.gameName = getGameName(row);
      if (!g.product) {
        g.product = getProduct(row);
        g.productLc = g.product.toLowerCase();
      }
      const ms = getDatetimeMs(row);
      if (ms && (!g.ms || ms < g.ms)) g.ms = ms;
      if (!g.timeText && row.datetimeStr) g.timeText = String(row.datetimeStr);

      if (kind === 'BET') {
        g.bet += getDebit(row);
      } else if (kind === 'WIN') {
        g.win += getCredit(row);
      } else { // VOID: credit -> bet iadesi, debit -> kazanç geri alımı
        const credit = getCredit(row);
        const debit = getDebit(row);
        if (credit) g.bet -= credit;
        if (debit) g.win -= debit;
        g.voided = true;
      }
    }
    for (const g of groups.values()) {
      if (g.bet < 0.005) g.bet = 0;
      if (g.win < 0.005) g.win = 0;
      g.timeText = fmtDateTime(g.ms, g.timeText);
      g.searchBlob = (g.gameName + ' ' + g.product + ' ' + g.id).toLowerCase();
    }
    store.groups = groups;
    return groups;
  }

  /** Hafif adım: eşik/filtre değişiminde sadece bu çalışır. */
  function evaluate() {
    const excluded = settings.excludedProducts.map((k) => String(k).toLowerCase()).filter(Boolean);
    const flagged = [];
    let totalWin = 0, totalBet = 0, maxRatio = 0, scanned = 0;
    const byGame = new Map();

    for (const g of store.groups.values()) {
      scanned++;
      if (isExcluded(g.productLc, excluded)) continue;
      if (g.win <= 0) continue;
      if (g.win < settings.minWin) continue;

      let ratio;
      if (g.bet <= 0) {
        if (!settings.includeNoBet) continue;
        ratio = Infinity;
      } else {
        if (g.bet < settings.minBet) continue;
        ratio = g.win / g.bet;
        if (ratio < settings.ratioThreshold) continue;
      }

      flagged.push({
        id: g.id, gameName: g.gameName, product: g.product,
        time: g.timeText, ms: g.ms,
        bet: g.bet, win: g.win, net: g.win - g.bet,
        ratio, voided: g.voided, searchBlob: g.searchBlob,
      });
      totalWin += g.win;
      totalBet += g.bet;
      if (isFinite(ratio) && ratio > maxRatio) maxRatio = ratio;
      byGame.set(g.gameName, (byGame.get(g.gameName) || 0) + 1);
    }

    let topGame = '', topCount = 0;
    for (const [name, count] of byGame) if (count > topCount) { topCount = count; topGame = name; }

    store.result = {
      flagged, totalWin, totalBet, net: totalWin - totalBet,
      maxRatio, scanned, topGame, topCount,
    };
    store.lastUpdate = Date.now();
    return store.result;
  }

  function visibleList() {
    const res = store.result;
    if (!res) return [];
    let list = res.flagged;
    const q = ui.searchTerm;
    if (q) list = list.filter((f) => f.searchBlob.indexOf(q) !== -1);
    else list = list.slice();

    switch (settings.sortMode) {
      case 'ratio': list.sort((a, b) => b.ratio - a.ratio || b.win - a.win); break;
      case 'win': list.sort((a, b) => b.win - a.win); break;
      case 'time-desc': list.sort((a, b) => (b.ms || 0) - (a.ms || 0)); break;
      default: list.sort((a, b) => (a.ms || 0) - (b.ms || 0)); break;
    }
    return list;
  }

  const recompute = () => { evaluate(); syncUI(); };

  const rebuild = debounce(() => {
    const t0 = performance.now();
    buildGroups();
    evaluate();
    syncUI();
    log(
      `Analiz: ${store.rows.size} işlem → ${store.groups.size} tur → ${store.result.flagged.length} şüpheli`,
      `(${(performance.now() - t0).toFixed(1)} ms)`
    );
  }, REBUILD_DEBOUNCE);

  // ============================================================
  // 5. AĞ KANCASI (MAIN WORLD)
  // ============================================================
  function pageHook(eventName, targets) {
    if (window.__gtAiOzetPageHook) return;
    window.__gtAiOzetPageHook = true;

    const isTarget = (url) => {
      const u = String(url || '').toLowerCase();
      for (let i = 0; i < targets.length; i++) if (u.indexOf(targets[i]) !== -1) return true;
      return false;
    };
    const publish = (body) => {
      if (!body) return;
      try {
        window.dispatchEvent(new CustomEvent(eventName, { detail: String(body) }));
      } catch (e) {
        try {
          const ev = document.createEvent('CustomEvent');
          ev.initCustomEvent(eventName, false, false, String(body));
          window.dispatchEvent(ev);
        } catch (e2) { /* yoksay */ }
      }
    };

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        const p = origFetch.apply(this, arguments);
        const url = (input && input.url) || input;
        if (isTarget(url)) {
          p.then((res) => {
            if (!res || !res.ok || res.bodyUsed) return null;
            try { return res.clone().text(); } catch (e) { return null; }
          }).then(publish).catch(() => {});
        }
        return p;
      };
    }

    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__gtUrl = String(url || '');
        this.__gtDone = false;
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        const xhr = this;
        if (isTarget(xhr.__gtUrl)) {
          // Sadece readyState 4: yarım kalmış gövdeyi ayrıştırmaya çalışmayız.
          xhr.addEventListener('loadend', function () {
            if (xhr.__gtDone || xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return;
            xhr.__gtDone = true;
            let text = '';
            try {
              const rt = xhr.responseType;
              if (!rt || rt === 'text') text = xhr.responseText || '';
              else if (rt === 'json' && xhr.response) text = JSON.stringify(xhr.response);
            } catch (e) { return; }
            publish(text);
          }, { once: true });
        }
        return origSend.apply(this, arguments);
      };
    }
  }

  function installHooks() {
    const source = '(' + pageHook.toString() + ')(' + JSON.stringify(EVENT_NAME) + ',' + JSON.stringify(TARGETS) + ');';

    // 1) Sandbox'ta çalışıyorsak sayfaya enjekte et.
    const inject = () => {
      const parent = document.head || document.documentElement;
      if (!parent) return false;
      try {
        const script = document.createElement('script');
        script.textContent = source;
        parent.appendChild(script);
        script.remove();
        return true;
      } catch (e) {
        return false;
      }
    };

    if (!inject()) {
      const mo = new MutationObserver(() => { if (inject()) mo.disconnect(); });
      mo.observe(document, { childList: true, subtree: true });
    }
    // 2) CSP enjeksiyonu engellerse (veya @grant none ile zaten sayfa dünyasındaysak)
    //    aynı kancayı doğrudan kur; bayrak çift kancayı önler.
    try { pageHook(EVENT_NAME, TARGETS); } catch (e) { fail('Kanca kurulamadı:', e); }
    log('Ağ kancası hazır →', TARGETS.join(', '));
  }

  function extractRows(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    const c = [
      data.data, data.content, data.items, data.results, data.rows, data.records,
      data.data && data.data.data, data.data && data.data.content, data.data && data.data.items,
      data.result && data.result.data, data.result && data.result.content,
      data.page && data.page.content,
    ];
    for (let i = 0; i < c.length; i++) if (Array.isArray(c[i])) return c[i];
    return null;
  }

  function handleResponse(text) {
    if (!text || text.length < 2) return false;
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return false; }
    const rows = extractRows(parsed);
    if (!rows || !rows.length) return false;
    const added = ingest(rows);
    if (!added && store.groups.size) { syncUI(); return true; } // aynı sayfa tekrar geldi
    rebuild();
    return true;
  }

  window.addEventListener(EVENT_NAME, (e) => {
    try { handleResponse(String(e.detail || '')); } catch (err) { fail('Cevap işlenemedi:', err); }
  }, false);

  // ============================================================
  // 6. STİL (tek stylesheet — satır içi stil yok, daha az reflow)
  // ============================================================
  const CSS = `
  #gtz-fab, #gtz-panel, #gtz-toast { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
  #gtz-panel *, #gtz-fab * { box-sizing: border-box; }

  @keyframes gtzPop { from { opacity:0; transform: translateY(10px) scale(.98); } to { opacity:1; transform:none; } }
  @keyframes gtzPulse { 0% { box-shadow:0 0 0 0 rgba(255,69,58,.55);} 70% { box-shadow:0 0 0 9px rgba(255,69,58,0);} 100% { box-shadow:0 0 0 0 rgba(255,69,58,0);} }
  @keyframes gtzFlash { 0%,100% { background-color: transparent; } 15%,60% { background-color: rgba(255,69,58,.22); } }
  @keyframes gtzFadeUp { from { opacity:0; transform: translate(-50%, 12px);} to { opacity:1; transform: translate(-50%, 0);} }

  /* ---------- FAB ---------- */
  #gtz-fab {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
    display: inline-flex; align-items: center; gap: 7px;
    padding: 11px 18px; border: 0; border-radius: 999px;
    background: linear-gradient(135deg, #0a84ff, #5b5bd6);
    color: #fff; font-size: 13px; font-weight: 600; line-height: 1; cursor: pointer;
    box-shadow: 0 6px 20px rgba(10,132,255,.35);
    transition: transform .16s cubic-bezier(.2,.8,.2,1), box-shadow .16s ease;
  }
  #gtz-fab:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(10,132,255,.45); }
  #gtz-fab:active { transform: translateY(0); }
  #gtz-fab .gtz-badge {
    position: absolute; top: -7px; right: -7px; min-width: 21px; height: 21px; padding: 0 6px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 999px; background: #ff453a; color: #fff; font-size: 11px; font-weight: 700;
  }
  #gtz-fab.gtz-hot .gtz-badge { animation: gtzPulse 1.9s infinite; }

  /* ---------- Panel ---------- */
  #gtz-panel {
    --bg: #ffffff; --surface: #f5f6f8; --surface2: #eceef2; --text: #14161a; --sub: #6b7280;
    --border: rgba(0,0,0,.10); --blue: #0a84ff; --red: #ff3b30; --amber: #ff9500; --green: #28b761;
    --shadow: 0 18px 50px rgba(0,0,0,.20);
    position: fixed; z-index: 2147483646; display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 16px; box-shadow: var(--shadow); font-size: 13px;
    animation: gtzPop .16s cubic-bezier(.2,.8,.2,1);
  }
  #gtz-panel[data-theme="dark"] { --bg:#181b20; --surface:#20242b; --surface2:#2a2f38; --text:#e9ecf1; --sub:#98a0ad; --border: rgba(255,255,255,.11); --shadow: 0 18px 50px rgba(0,0,0,.55); }
  @media (prefers-color-scheme: dark) {
    #gtz-panel[data-theme="auto"] { --bg:#181b20; --surface:#20242b; --surface2:#2a2f38; --text:#e9ecf1; --sub:#98a0ad; --border: rgba(255,255,255,.11); --shadow: 0 18px 50px rgba(0,0,0,.55); }
  }
  #gtz-panel button { font-family: inherit; color: inherit; }

  .gtz-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); cursor: grab; user-select: none; flex: 0 0 auto; }
  .gtz-head:active { cursor: grabbing; }
  .gtz-head-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .gtz-logo { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #0a84ff, #5b5bd6); font-size: 15px; }
  .gtz-title { font-size: 14px; font-weight: 700; letter-spacing: .2px; }
  .gtz-sub { font-size: 11px; color: var(--sub); margin-top: 1px; }
  .gtz-head-actions { display: flex; align-items: center; gap: 2px; }

  .gtz-icon { border: 0; background: transparent; cursor: pointer; border-radius: 8px; padding: 6px 8px; font-size: 13px; line-height: 1; color: var(--sub); transition: background-color .12s ease, color .12s ease; }
  .gtz-icon:hover { background: var(--surface2); color: var(--text); }
  .gtz-icon.gtz-on { color: var(--blue); }

  .gtz-stats { display: flex; gap: 6px; padding: 10px 14px; overflow-x: auto; scrollbar-width: none; flex: 0 0 auto; }
  .gtz-stats::-webkit-scrollbar { display: none; }
  .gtz-stat { flex: 0 0 auto; padding: 6px 10px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); }
  .gtz-stat b { display: block; font-size: 12.5px; font-weight: 700; white-space: nowrap; }
  .gtz-stat span { font-size: 10px; color: var(--sub); text-transform: uppercase; letter-spacing: .4px; }
  .gtz-stat.red b { color: var(--red); } .gtz-stat.green b { color: var(--green); } .gtz-stat.blue b { color: var(--blue); }

  .gtz-controls { padding: 0 14px 10px; display: flex; flex-direction: column; gap: 8px; flex: 0 0 auto; border-bottom: 1px solid var(--border); }
  .gtz-row { display: flex; align-items: center; gap: 8px; }
  .gtz-search { flex: 1; display: flex; align-items: center; gap: 6px; padding: 0 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
  .gtz-search input { flex: 1; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 12.5px; padding: 7px 0; min-width: 0; }
  .gtz-search input::placeholder { color: var(--sub); }
  .gtz-select { border: 1px solid var(--border); background: var(--surface); color: inherit; font: inherit; font-size: 12px; border-radius: 10px; padding: 7px 8px; cursor: pointer; }
  .gtz-thr { display: flex; align-items: center; gap: 9px; }
  .gtz-thr label { font-size: 11px; color: var(--sub); white-space: nowrap; }
  .gtz-thr input[type="range"] { flex: 1; accent-color: var(--blue); min-width: 0; }
  .gtz-thr b { font-size: 12.5px; min-width: 42px; text-align: right; }
  .gtz-adv { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 10px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); }
  .gtz-adv[hidden] { display: none; }
  .gtz-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .gtz-field > span { font-size: 10.5px; color: var(--sub); }
  .gtz-field input[type="text"], .gtz-field input[type="number"] { border: 1px solid var(--border); background: var(--bg); color: inherit; font: inherit; font-size: 12px; border-radius: 8px; padding: 6px 8px; outline: 0; min-width: 0; }
  .gtz-field input:focus { border-color: var(--blue); }
  .gtz-check { display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer; align-self: end; padding-bottom: 6px; }
  .gtz-check input { accent-color: var(--blue); margin: 0; }
  .gtz-adv-wide { grid-column: 1 / -1; }

  .gtz-list { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 6px; contain: layout paint; }
  .gtz-list::-webkit-scrollbar { width: 10px; }
  .gtz-list::-webkit-scrollbar-thumb { background: var(--surface2); border: 3px solid transparent; background-clip: content-box; border-radius: 999px; }
  .gtz-empty { padding: 34px 18px; text-align: center; color: var(--sub); font-size: 12.5px; line-height: 1.6; }

  .gtz-item { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; cursor: pointer; content-visibility: auto; contain-intrinsic-size: 54px; }
  .gtz-item:hover { background: var(--surface); }
  .gtz-ratio { flex: 0 0 auto; min-width: 46px; text-align: center; padding: 4px 6px; border-radius: 8px; font-size: 11.5px; font-weight: 700; color: #fff; background: var(--blue); }
  .gtz-ratio.warn { background: var(--amber); }
  .gtz-ratio.crit { background: var(--red); }
  .gtz-ratio.inf  { background: linear-gradient(135deg, #8e5bff, #ff3b8e); }
  .gtz-main { flex: 1; min-width: 0; }
  .gtz-l1 { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gtz-l1 .gtz-time { color: var(--sub); font-weight: 500; flex: 0 0 auto; }
  .gtz-l1 .gtz-game { overflow: hidden; text-overflow: ellipsis; }
  .gtz-tag { flex: 0 0 auto; font-size: 9.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .3px; padding: 2px 6px; border-radius: 6px; background: var(--surface2); color: var(--sub); }
  .gtz-tag.void { background: rgba(255,149,0,.18); color: var(--amber); }
  .gtz-l2 { font-size: 11.5px; color: var(--sub); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gtz-l2 em { font-style: normal; color: var(--green); font-weight: 600; }
  .gtz-acts { flex: 0 0 auto; display: flex; gap: 1px; opacity: 0; transition: opacity .12s ease; }
  .gtz-item:hover .gtz-acts, .gtz-item:focus-within .gtz-acts { opacity: 1; }

  .gtz-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); flex: 0 0 auto; }
  .gtz-foot-info { font-size: 11px; color: var(--sub); }
  .gtz-foot-acts { display: flex; gap: 6px; }
  .gtz-btn { border: 1px solid var(--border); background: var(--surface); border-radius: 10px; padding: 7px 12px; font-size: 12px; font-weight: 600; cursor: pointer; transition: filter .12s ease, background-color .12s ease; }
  .gtz-btn:hover { filter: brightness(1.04); background: var(--surface2); }
  .gtz-btn.primary { border-color: transparent; background: var(--blue); color: #fff; }
  .gtz-btn.primary:hover { background: #0a74e0; }

  .gtz-grip { position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px; cursor: nwse-resize; opacity: .45; }
  .gtz-grip::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px; border-right: 2px solid var(--sub); border-bottom: 2px solid var(--sub); border-radius: 0 0 3px 0; }

  #gtz-toast {
    position: fixed; left: 50%; bottom: 90px; transform: translate(-50%, 0); z-index: 2147483647;
    padding: 10px 16px; border-radius: 12px; background: rgba(20,22,26,.94); color: #fff;
    font-size: 12.5px; font-weight: 500; box-shadow: 0 10px 30px rgba(0,0,0,.3);
    animation: gtzFadeUp .18s ease-out; pointer-events: none; max-width: 70vw; text-align: center;
  }

  .gtz-hl { animation: gtzFlash 2.2s ease-out; outline: 2px solid #ff453a !important; outline-offset: -2px; }
  `;

  function mountStyles() {
    if (document.getElementById('gtz-style')) return;
    const style = document.createElement('style');
    style.id = 'gtz-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ============================================================
  // 7. TABLO SATIRI BULUCU (indeksli + mutasyonla geçersizleşen)
  // ============================================================
  const locator = { map: null, dirty: true, observer: null };

  function watchTable() {
    if (locator.observer || !document.body) return;
    locator.observer = new MutationObserver(() => { locator.dirty = true; });
    locator.observer.observe(document.body, { childList: true, subtree: true });
  }

  function buildRowIndex() {
    const map = new Map();
    const rows = document.querySelectorAll('tr, [role="row"]');
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td, [role="cell"]');
      for (let j = 0; j < cells.length; j++) {
        const text = (cells[j].textContent || '').trim();
        if (text.length >= 4 && text.length <= 80 && !map.has(text)) map.set(text, rows[i]);
      }
    }
    locator.map = map;
    locator.dirty = false;
  }

  function findTableRow(id) {
    watchTable();
    if (locator.dirty || !locator.map) buildRowIndex();
    let el = locator.map.get(id);
    if (el && !el.isConnected) { buildRowIndex(); el = locator.map.get(id); }
    return el || null;
  }

  function gotoTransaction(item) {
    const row = findTableRow(item.id);
    if (!row) {
      copyToClipboard(item.id);
      toast('Satır ekranda yok — Game Tran ID panoya kopyalandı');
      return;
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('gtz-hl');
    void row.offsetWidth; // animasyonu yeniden tetikle
    row.classList.add('gtz-hl');
    setTimeout(() => row.classList.remove('gtz-hl'), 2300);
  }

  // ============================================================
  // 8. TOAST
  // ============================================================
  let toastTimer = 0;
  function toast(message) {
    if (!document.body) return;
    let el = document.getElementById('gtz-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gtz-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2200);
  }

  // ============================================================
  // 9. METİN / DIŞA AKTARIM
  // ============================================================
  function lineText(item) {
    return `${item.time} ${item.gameName} Bet: ${fmtMoney(item.bet, store.currency)} Win: ${fmtMoney(item.win, store.currency)} Oran: ${fmtRatio(item.ratio)}`;
  }

  function summaryText() {
    const list = visibleList();
    if (!list.length) return 'Şüpheli bir tur bulunamadı.';
    const total = list.reduce((s, f) => s + f.win, 0);
    return [
      'Aşağıdaki yer alan turlarda elde edilen kazançların incelenmesinde fayda var:',
      '',
      ...list.map(lineText),
      '',
      `Toplam: ${list.length} tur · ${fmtMoney(total, store.currency)}`,
    ].join('\n');
  }

  function exportCsv() {
    const list = visibleList();
    if (!list.length) { toast('Dışa aktarılacak kayıt yok'); return; }
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const header = ['Tarih', 'Oyun', 'Sağlayıcı', 'Game Tran ID', 'Bet', 'Win', 'Net', 'Oran', 'İptal/Geri Alma'];
    const lines = [header.map(esc).join(';')];
    for (const f of list) {
      lines.push([
        f.time, f.gameName, f.product, f.id,
        nfMoney.format(f.bet), nfMoney.format(f.win), nfMoney.format(f.net),
        isFinite(f.ratio) ? nfRatio.format(f.ratio) : '∞',
        f.voided ? 'Evet' : 'Hayır',
      ].map(esc).join(';'));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-ozet-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${list.length} satır CSV olarak indirildi`);
  }

  // ============================================================
  // 10. ARAYÜZ
  // ============================================================
  const ui = {
    fab: null, panel: null, refs: null,
    searchTerm: '',
    visible: [],
    rendered: 0,
    sentinel: null,
    io: null,
  };

  const ITEM_TPL = document.createElement('template');
  ITEM_TPL.innerHTML =
    '<div class="gtz-item" tabindex="0">' +
      '<div class="gtz-ratio"></div>' +
      '<div class="gtz-main">' +
        '<div class="gtz-l1"><span class="gtz-time"></span><span class="gtz-game"></span><span class="gtz-tag void" hidden>iptal</span></div>' +
        '<div class="gtz-l2"></div>' +
      '</div>' +
      '<div class="gtz-acts">' +
        '<button class="gtz-icon" data-act="copy" title="Satırı kopyala">📋</button>' +
        '<button class="gtz-icon" data-act="goto" title="Tabloda göster">🎯</button>' +
      '</div>' +
    '</div>';

  const PANEL_HTML =
    '<header class="gtz-head" data-ref="head">' +
      '<div class="gtz-head-main">' +
        '<div class="gtz-logo">🤖</div>' +
        '<div><div class="gtz-title">AI ÖZET</div><div class="gtz-sub" data-ref="sub"></div></div>' +
      '</div>' +
      '<div class="gtz-head-actions">' +
        '<button class="gtz-icon" data-ref="theme" title="Tema: otomatik / açık / koyu">◐</button>' +
        '<button class="gtz-icon" data-ref="clear" title="Yakalanan veriyi temizle">↺</button>' +
        '<button class="gtz-icon" data-ref="close" title="Kapat (Esc)">✕</button>' +
      '</div>' +
    '</header>' +
    '<div class="gtz-stats" data-ref="stats"></div>' +
    '<div class="gtz-controls">' +
      '<div class="gtz-row">' +
        '<div class="gtz-search"><span>🔎</span><input data-ref="search" type="search" placeholder="Oyun, sağlayıcı veya Tran ID ara…"></div>' +
        '<select class="gtz-select" data-ref="sort">' +
          '<option value="time-asc">Zaman ↑</option>' +
          '<option value="time-desc">Zaman ↓</option>' +
          '<option value="ratio">Oran ↓</option>' +
          '<option value="win">Kazanç ↓</option>' +
        '</select>' +
        '<button class="gtz-icon" data-ref="toggleAdv" title="Gelişmiş filtreler">⚙</button>' +
      '</div>' +
      '<div class="gtz-row gtz-thr">' +
        '<label>Eşik</label>' +
        '<input type="range" data-ref="slider" min="1" max="50" step="0.5">' +
        '<b data-ref="thrLabel"></b>' +
      '</div>' +
      '<div class="gtz-adv" data-ref="adv" hidden>' +
        '<label class="gtz-field"><span>Min. bet</span><input type="number" data-ref="minBet" min="0" step="1"></label>' +
        '<label class="gtz-field"><span>Min. kazanç</span><input type="number" data-ref="minWin" min="0" step="1"></label>' +
        '<label class="gtz-check"><input type="checkbox" data-ref="noBet"> Bet\'siz kazançlar (∞)</label>' +
        '<label class="gtz-check"><input type="checkbox" data-ref="accum"> Sayfaları biriktir</label>' +
        '<label class="gtz-field gtz-adv-wide"><span>Hariç tutulan sağlayıcılar (virgülle)</span><input type="text" data-ref="excl" placeholder="pragmatic, betby"></label>' +
      '</div>' +
    '</div>' +
    '<div class="gtz-list" data-ref="list"></div>' +
    '<footer class="gtz-foot">' +
      '<span class="gtz-foot-info" data-ref="footInfo"></span>' +
      '<div class="gtz-foot-acts">' +
        '<button class="gtz-btn" data-ref="csv">⬇ CSV</button>' +
        '<button class="gtz-btn primary" data-ref="copy">📋 Özeti kopyala</button>' +
      '</div>' +
    '</footer>' +
    '<div class="gtz-grip" data-ref="grip"></div>';

  // ---------- FAB ----------
  function mountFab() {
    if (!document.body || ui.fab) return;
    mountStyles();
    const fab = document.createElement('button');
    fab.id = 'gtz-fab';
    fab.type = 'button';
    fab.title = 'AI ÖZET  (Alt+A)';
    fab.innerHTML = '<span>🤖</span><span>AI ÖZET</span>';
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
    ui.fab = fab;
    syncFab();
    log(`v${VERSION} hazır — eşik ${settings.ratioThreshold}x, Alt+A ile aç/kapat.`);
  }

  function syncFab() {
    if (!ui.fab) return;
    const count = store.result ? store.result.flagged.length : 0;
    let badge = ui.fab.querySelector('.gtz-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'gtz-badge';
        ui.fab.appendChild(badge);
      }
      badge.textContent = count > 99 ? '99+' : String(count);
      ui.fab.classList.add('gtz-hot');
    } else {
      if (badge) badge.remove();
      ui.fab.classList.remove('gtz-hot');
    }
  }

  // ---------- Panel ----------
  function buildPanel() {
    mountStyles();
    const panel = document.createElement('div');
    panel.id = 'gtz-panel';
    panel.dataset.theme = settings.theme;
    panel.innerHTML = PANEL_HTML;

    const refs = {};
    panel.querySelectorAll('[data-ref]').forEach((n) => { refs[n.dataset.ref] = n; });
    ui.panel = panel;
    ui.refs = refs;

    // Boyut & konum
    const p = settings.panel;
    panel.style.width = Math.max(380, Math.min(p.w || 640, window.innerWidth - 24)) + 'px';
    panel.style.height = Math.max(320, Math.min(p.h || 560, window.innerHeight - 24)) + 'px';
    if (p.x == null || p.y == null) {
      panel.style.left = Math.max(12, window.innerWidth - (p.w || 640) - 18) + 'px';
      panel.style.top = Math.max(12, window.innerHeight - (p.h || 560) - 84) + 'px';
    } else {
      panel.style.left = p.x + 'px';
      panel.style.top = p.y + 'px';
    }

    // Kontrollerin ilk değerleri
    refs.search.value = ui.searchTerm;
    refs.sort.value = settings.sortMode;
    refs.slider.value = String(settings.ratioThreshold);
    refs.thrLabel.textContent = fmtRatio(settings.ratioThreshold);
    refs.minBet.value = settings.minBet || '';
    refs.minWin.value = settings.minWin || '';
    refs.noBet.checked = settings.includeNoBet;
    refs.accum.checked = settings.accumulate;
    refs.excl.value = settings.excludedProducts.join(', ');
    refs.adv.hidden = !settings.filtersOpen;
    refs.toggleAdv.classList.toggle('gtz-on', settings.filtersOpen);

    wirePanel(refs, panel);
    document.body.appendChild(panel);
    clampPanel();
    syncUI(true);
    return panel;
  }

  function wirePanel(refs, panel) {
    refs.close.addEventListener('click', closePanel);

    refs.theme.addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
      panel.dataset.theme = settings.theme;
      refs.theme.title = 'Tema: ' + settings.theme;
      toast('Tema: ' + settings.theme);
      persist();
    });

    refs.clear.addEventListener('click', () => {
      clearData();
      toast('Yakalanan veri temizlendi');
    });

    const onSearch = debounce(() => {
      ui.searchTerm = refs.search.value.trim().toLowerCase();
      renderList(true);
      syncFooter();
    }, 120);
    refs.search.addEventListener('input', onSearch);

    refs.sort.addEventListener('change', () => {
      settings.sortMode = refs.sort.value;
      persist();
      renderList(true);
    });

    refs.toggleAdv.addEventListener('click', () => {
      settings.filtersOpen = !settings.filtersOpen;
      refs.adv.hidden = !settings.filtersOpen;
      refs.toggleAdv.classList.toggle('gtz-on', settings.filtersOpen);
      persist();
    });

    // Eşik: etiket anında, yeniden hesap gecikmeli (kaydırma akıcı kalsın)
    const applyThreshold = debounce(() => { recompute(); persist(); }, 90);
    refs.slider.addEventListener('input', () => {
      settings.ratioThreshold = Number(refs.slider.value) || DEFAULTS.ratioThreshold;
      refs.thrLabel.textContent = fmtRatio(settings.ratioThreshold);
      applyThreshold();
    });

    const applyNumeric = debounce(() => { recompute(); persist(); }, 200);
    refs.minBet.addEventListener('input', () => { settings.minBet = Math.max(0, Number(refs.minBet.value) || 0); applyNumeric(); });
    refs.minWin.addEventListener('input', () => { settings.minWin = Math.max(0, Number(refs.minWin.value) || 0); applyNumeric(); });

    refs.noBet.addEventListener('change', () => { settings.includeNoBet = refs.noBet.checked; recompute(); persist(); });
    refs.accum.addEventListener('change', () => { settings.accumulate = refs.accum.checked; persist(); });

    const applyExcl = debounce(() => { recompute(); persist(); }, 250);
    refs.excl.addEventListener('input', () => {
      settings.excludedProducts = refs.excl.value.split(',').map((s) => s.trim()).filter(Boolean);
      applyExcl();
    });

    refs.copy.addEventListener('click', () => {
      copyToClipboard(summaryText());
      refs.copy.textContent = '✓ Kopyalandı';
      setTimeout(() => { refs.copy.textContent = '📋 Özeti kopyala'; }, 1300);
    });
    refs.csv.addEventListener('click', exportCsv);

    // Liste: tek dinleyici ile olay devri
    refs.list.addEventListener('click', (e) => {
      const itemEl = e.target.closest('.gtz-item');
      if (!itemEl) return;
      const item = ui.visible[Number(itemEl.dataset.i)];
      if (!item) return;
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'copy') {
        e.stopPropagation();
        copyToClipboard(lineText(item));
        act.textContent = '✓';
        setTimeout(() => { act.textContent = '📋'; }, 900);
        return;
      }
      gotoTransaction(item);
    });
    refs.list.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const itemEl = e.target.closest('.gtz-item');
      const item = itemEl && ui.visible[Number(itemEl.dataset.i)];
      if (item) gotoTransaction(item);
    });

    enableDrag(panel, refs.head);
    enableResize(panel, refs.grip);
  }

  function openPanel() {
    if (ui.panel) return;
    buildPanel();
    ui.refs.search.focus({ preventScroll: true });
  }
  function closePanel() {
    if (!ui.panel) return;
    if (ui.io) { ui.io.disconnect(); ui.io = null; }
    ui.sentinel = null;
    ui.panel.remove();
    ui.panel = null;
    ui.refs = null;
  }
  function togglePanel() { ui.panel ? closePanel() : openPanel(); }

  function clearData() {
    store.rows.clear();
    store.groups.clear();
    store.result = null;
    store.responses = 0;
    syncUI(true);
  }

  // ---------- Senkronizasyon ----------
  function syncUI(resetScroll) {
    syncFab();
    if (!ui.panel) return;
    syncHeader();
    syncStats();
    renderList(!!resetScroll);
    syncFooter();
  }

  function syncHeader() {
    const r = store.result;
    ui.refs.sub.textContent = r
      ? `${nfInt.format(r.flagged.length)} şüpheli tur · ${nfInt.format(r.scanned)} tur / ${nfInt.format(store.rows.size)} işlem tarandı`
      : 'Veri bekleniyor — işlem listesini bir kez yükleyin.';
  }

  function statChip(label, value, tone) {
    const d = document.createElement('div');
    d.className = 'gtz-stat' + (tone ? ' ' + tone : '');
    const b = document.createElement('b');
    b.textContent = value;
    const s = document.createElement('span');
    s.textContent = label;
    d.appendChild(b);
    d.appendChild(s);
    return d;
  }

  function syncStats() {
    const box = ui.refs.stats;
    box.textContent = '';
    const r = store.result;
    if (!r || !r.flagged.length) { box.hidden = true; return; }
    box.hidden = false;
    const frag = document.createDocumentFragment();
    frag.appendChild(statChip('şüpheli tur', nfInt.format(r.flagged.length), 'blue'));
    frag.appendChild(statChip('toplam kazanç', fmtMoney(r.totalWin, store.currency), 'red'));
    frag.appendChild(statChip('toplam bet', fmtMoney(r.totalBet, store.currency)));
    frag.appendChild(statChip('net', fmtMoney(r.net, store.currency), r.net >= 0 ? 'green' : ''));
    frag.appendChild(statChip('en yüksek oran', fmtRatio(r.maxRatio)));
    if (r.topGame) frag.appendChild(statChip('en sık oyun', `${r.topGame} (${r.topCount})`));
    box.appendChild(frag);
  }

  function syncFooter() {
    if (!ui.refs) return;
    const total = store.result ? store.result.flagged.length : 0;
    const shown = ui.visible.length;
    ui.refs.footInfo.textContent = shown === total
      ? `${nfInt.format(total)} kayıt`
      : `${nfInt.format(shown)} / ${nfInt.format(total)} kayıt`;
  }

  // ---------- Liste (parça parça / sanal) ----------
  function buildItem(item, index) {
    const node = ITEM_TPL.content.firstElementChild.cloneNode(true);
    node.dataset.i = String(index);
    const ratio = node.firstElementChild;
    ratio.textContent = fmtRatio(item.ratio);
    ratio.className = 'gtz-ratio ' + (!isFinite(item.ratio) ? 'inf' : item.ratio >= 10 ? 'crit' : item.ratio >= 5 ? 'warn' : '');
    const l1 = node.querySelector('.gtz-l1');
    l1.querySelector('.gtz-time').textContent = item.time;
    l1.querySelector('.gtz-game').textContent = item.gameName;
    if (item.voided) l1.querySelector('.gtz-tag').hidden = false;
    node.querySelector('.gtz-l2').textContent =
      `Bet ${fmtMoney(item.bet, store.currency)} · Win ${fmtMoney(item.win, store.currency)}` +
      (item.product ? ` · ${item.product}` : '');
    return node;
  }

  function appendChunk(count) {
    if (!ui.refs) return;
    const list = ui.refs.list;
    const end = Math.min(ui.rendered + count, ui.visible.length);
    if (end <= ui.rendered) { updateSentinel(); return; }
    const frag = document.createDocumentFragment();
    for (let i = ui.rendered; i < end; i++) frag.appendChild(buildItem(ui.visible[i], i));
    ui.rendered = end;
    list.appendChild(frag);
    updateSentinel();
  }

  function updateSentinel() {
    if (!ui.refs) return;
    const list = ui.refs.list;
    if (ui.rendered >= ui.visible.length) {
      if (ui.sentinel && ui.sentinel.parentNode) ui.sentinel.remove();
      return;
    }
    if (!ui.sentinel) {
      ui.sentinel = document.createElement('div');
      ui.sentinel.style.height = '1px';
    }
    list.appendChild(ui.sentinel);
    if (!ui.io) {
      ui.io = new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) { appendChunk(CHUNK); break; }
      }, { root: list, rootMargin: '240px' });
    }
    ui.io.observe(ui.sentinel);
  }

  function renderList(resetScroll) {
    if (!ui.refs) return;
    const list = ui.refs.list;
    const prevScroll = list.scrollTop;
    const prevRendered = ui.rendered;

    ui.visible = visibleList();
    ui.rendered = 0;
    list.textContent = '';

    if (!ui.visible.length) {
      const empty = document.createElement('div');
      empty.className = 'gtz-empty';
      empty.textContent = !store.result
        ? 'Henüz veri yakalanmadı.\nİşlem (transactions) listesini yükleyin ya da filtreleyin.'
        : ui.searchTerm
          ? 'Bu aramayla eşleşen tur yok.'
          : 'Bu eşikte şüpheli tur bulunamadı.';
      empty.style.whiteSpace = 'pre-line';
      list.appendChild(empty);
      return;
    }

    appendChunk(resetScroll ? CHUNK : Math.max(CHUNK, prevRendered));
    if (!resetScroll) list.scrollTop = Math.min(prevScroll, Math.max(0, list.scrollHeight - list.clientHeight));
  }

  // ---------- Sürükle / boyutlandır ----------
  function clampPanel() {
    if (!ui.panel) return;
    const r = ui.panel.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - r.width - 8));
    const y = Math.min(Math.max(8, r.top), Math.max(8, window.innerHeight - r.height - 8));
    ui.panel.style.left = x + 'px';
    ui.panel.style.top = y + 'px';
    settings.panel.x = x;
    settings.panel.y = y;
  }

  function enableDrag(panel, handle) {
    let startX = 0, startY = 0, baseX = 0, baseY = 0, active = false;
    const move = rafThrottle((cx, cy) => {
      if (!active) return;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const x = Math.min(Math.max(8 - w * 0.5, baseX + cx - startX), window.innerWidth - w * 0.5);
      const y = Math.min(Math.max(0, baseY + cy - startY), window.innerHeight - 40);
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      settings.panel.x = x;
      settings.panel.y = y;
    });
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      active = true; startX = e.clientX; startY = e.clientY; baseX = rect.left; baseY = rect.top;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (active) move(e.clientX, e.clientY); });
    const stop = () => { if (!active) return; active = false; persist(); };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function enableResize(panel, grip) {
    let startX = 0, startY = 0, baseW = 0, baseH = 0, active = false;
    const move = rafThrottle((cx, cy) => {
      if (!active) return;
      const w = Math.min(Math.max(380, baseW + cx - startX), window.innerWidth - 16);
      const h = Math.min(Math.max(320, baseH + cy - startY), window.innerHeight - 16);
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
      settings.panel.w = w;
      settings.panel.h = h;
    });
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      active = true; startX = e.clientX; startY = e.clientY;
      baseW = panel.offsetWidth; baseH = panel.offsetHeight;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => { if (active) move(e.clientX, e.clientY); });
    const stop = () => { if (!active) return; active = false; persist(); };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  }

  window.addEventListener('resize', debounce(() => { if (ui.panel) { clampPanel(); persist(); } }, 200), { passive: true });

  // ---------- Klavye ----------
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      togglePanel();
      return;
    }
    if (!ui.panel) return;
    if (e.key === 'Escape' && (!typing || ui.panel.contains(document.activeElement))) {
      closePanel();
      return;
    }
    if (e.key === '/' && !typing) {
      e.preventDefault();
      ui.refs.search.focus();
    }
  }, true);

  // ============================================================
  // 11. GENEL API (konsoldan hata ayıklama)
  // ============================================================
  window.GTAiOzet = {
    version: VERSION,
    rows: () => Array.from(store.rows.values()),
    groups: () => Array.from(store.groups.values()),
    result: () => store.result,
    settings: () => settings,
    setThreshold(n) {
      settings.ratioThreshold = Number(n) || DEFAULTS.ratioThreshold;
      persist();
      recompute();
      if (ui.refs) { ui.refs.slider.value = String(settings.ratioThreshold); ui.refs.thrLabel.textContent = fmtRatio(settings.ratioThreshold); }
      return store.result;
    },
    analyze() { buildGroups(); evaluate(); syncUI(true); return store.result; },
    ingest(rowsOrJson) {
      const data = typeof rowsOrJson === 'string' ? JSON.parse(rowsOrJson) : rowsOrJson;
      const rows = extractRows(data);
      if (!rows) { warn('Satır dizisi bulunamadı.'); return null; }
      ingest(rows);
      return this.analyze();
    },
    summary: summaryText,
    csv: exportCsv,
    clear: clearData,
    show: openPanel,
    hide: closePanel,
    toggle: togglePanel,
  };

  // ============================================================
  // 12. BAŞLAT
  // ============================================================
  installHooks();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountFab, { once: true });
  } else {
    mountFab();
  }
})();
