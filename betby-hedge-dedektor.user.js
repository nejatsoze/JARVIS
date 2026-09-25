// ==UserScript==
// @name         Betby — Çift Taraf (Hedge) Dedektörü
// @namespace    betby-hedge-dedektor
// @version      1.3.0
// @description  Betby backoffice bahis geçmişini arka planda tarar; aynı maçın aynı marketinde farklı hesaplardan zıt taraf (alt/üst, handikap, farklı sonuç) oynanan bahisleri IP, zaman yakınlığı ve ödeme dengesiyle puanlayıp listeler.
// @author       —
// @match        https://backoffice.sptenv.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 0. SABİTLER / AYARLAR
  // ============================================================
  const VERSION = '1.3.0';
  const PREFIX = '[HEDGE]';
  const STORAGE_KEY = 'bbHedge.settings.v1';
  const LEARN_KEY = 'bbHedge.learned.v1';
  const SEEN_KEY = 'bbHedge.seen.v1';
  const LOCK_KEY = 'bbHedge.leader';
  const DEFAULT_API = 'https://gw9yca5f-admin.sptenv.com';
  const GQL_CANDIDATES = [
    '/api/v1/BetSlipsAdmin/bet-history-graphql',
    '/api/v1/BetSlipsAdmin/bet-history-graphql/',
  ];
  const REST_PATH = '/api/v1/BetSlipsAdmin/betslips/clickhouse';
  const MAX_BETS = 60000;
  const GT_HOST = 'https://core-secundus.gmntc.com';
  const GT_WINDOW = 'gtcore';   // açılan GT sekmesinin adı; sonraki tıklamalar aynı sekmeyi kullanır

  const DEFAULTS = Object.freeze({
    autoStart: true,
    intervalSec: 30,        // tarama aralığı
    window: 'month',        // taranan/tutulan pencere: bkz. WINDOWS
    pageSize: 200,
    maxPages: 150,          // tek taramada en fazla sayfa
    includeCombos: false,   // kombine bahislerin ayaklarını da say
    onlyTotals: false,      // yalnızca alt/üst
    onlySameIp: false,
    onlyUpcoming: false,    // yalnızca başlamamış maçlar
    maxLineGap: 1,          // alt/üst'te farklı çizgi toleransı (gol)
    minScore: 50,
    notifyScore: 75,
    sound: true,
    desktop: false,
    tab: 'groups',
    theme: 'auto',
  });

  const BET_QUERY = `query getBetHistoryList($inputFilters: BetHistoryTableFilters) {
  data: getBetHistoryList(inputFilters: $inputFilters) {
    items {
      playerId betId betStatus username accepted betType event eventId betTimestamp eventScheduled
      odd stake won betCurrency stakeCurrency ip isVirtual brandName extPlayerId operatorBrandId country
      selections {
        selectionId status eventId tournamentId marketId outcomeId live rollback sport category tournament
        event market outcome k eventScheduled userCancelled isBetBuilder
      }
    }
    total
  }
}`;

  const WINDOWS = [
    ['12h', 'Son 12 saat'], ['24h', 'Son 24 saat'], ['3d', 'Son 3 gün'], ['7d', 'Son 7 gün'],
    ['14d', 'Son 14 gün'], ['month', 'Ay başından'], ['30d', 'Son 30 gün'], ['prevmonth', 'Geçen ay başından'],
  ];
  // Pencere başlangıcı (UTC; backoffice tarih filtresi de UTC).
  function windowStart(w, now = Date.now()) {
    const d = new Date(now);
    if (w === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    if (w === 'prevmonth') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
    const m = /^(\d+)([hd])$/.exec(w || '');
    if (!m) return now - 12 * 3600e3;
    return now - +m[1] * (m[2] === 'd' ? 864e5 : 3600e3);
  }
  const windowLabel = (w) => (WINDOWS.find((x) => x[0] === w) || [w, w])[1];

  const log = (...a) => console.log(PREFIX, ...a);
  const warn = (...a) => console.warn(PREFIX, ...a);

  const IS_LIVE = typeof location !== 'undefined' && /(^|\.)sptenv\.com$/.test(location.hostname || '');

  function readJSON(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  const S = Object.assign({}, DEFAULTS, readJSON(STORAGE_KEY, {}));
  const saveSettings = () => writeJSON(STORAGE_KEY, S);
  const learned = Object.assign({ gqlUrl: null, mode: null, refresh: null }, readJSON(LEARN_KEY, {}));
  const saveLearned = () => writeJSON(LEARN_KEY, learned);

  // ============================================================
  // 1. YARDIMCILAR
  // ============================================================
  function num(v) {
    if (typeof v === 'number') return v;
    if (v == null) return NaN;
    let s = String(v).replace(/[^\d.,\-]/g, '');
    if (!s) return NaN;
    const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
    if (c > -1 && d > -1) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (c > -1) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    return parseFloat(s);
  }

  // Backoffice saatleri UTC gösteriyor/gönderiyor; bölge bilgisi olmayan metinler UTC kabul edilir.
  function parseTs(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return parseTs(Number(s));
    let m = /^(\d{4})[\/.-](\d{2})[\/.-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if (m) {
      const ms = m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0;
      const base = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms);
      if (!m[8] || m[8] === 'Z') return base;
      const z = /([+-])(\d{2}):?(\d{2})/.exec(m[8]);
      return base - (z[1] === '-' ? -1 : 1) * (+z[2] * 60 + +z[3]) * 60000;
    }
    m = /^(\d{2})[.\/-](\d{2})[.\/-](\d{4})[ ,T]+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) return Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    return Date.parse(s);
  }

  const pick = (o, ...ks) => { if (!o) return undefined; for (const k of ks) if (o[k] != null && o[k] !== '') return o[k]; return undefined; };
  const str = (v) => (v == null ? '' : String(v));
  const clean = (s) => str(s).replace(/\s+/g, ' ').trim();
  const esc = (s) => str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const nfMoney = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtMoney = (v, cur) => (isFinite(v) ? nfMoney.format(v) : '—') + (cur ? ' ' + cur : '');
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTs(ms, withDate = true) {
    if (!isFinite(ms)) return '—';
    const d = new Date(ms);
    const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    return withDate ? `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${t}` : t;
  }
  function fmtDur(ms) {
    const s = Math.round(Math.abs(ms) / 1000);
    if (s < 60) return s + ' sn';
    if (s < 3600) return Math.round(s / 60) + ' dk';
    return (s / 3600).toFixed(1).replace('.', ',') + ' sa';
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function jwtExp(token) {
    try {
      const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return p.exp ? p.exp * 1000 : NaN;
    } catch { return NaN; }
  }
  function originOf(u) { try { return new URL(u).origin; } catch { return null; } }

  function findItems(json) {
    const seen = new Set();
    const walk = (o, d) => {
      if (!o || typeof o !== 'object' || d > 6 || seen.has(o)) return null;
      seen.add(o);
      if (Array.isArray(o)) return o.length && typeof o[0] === 'object' && pick(o[0], 'betId', 'bet_id') != null ? o : null;
      if (Array.isArray(o.items)) return o.items;
      for (const v of Object.values(o)) { const r = walk(v, d + 1); if (r) return r; }
      return null;
    };
    return walk(json, 0) || [];
  }

  function findTotal(json) {
    const walk = (o, d) => {
      if (!o || typeof o !== 'object' || Array.isArray(o) || d > 6) return NaN;
      if (Array.isArray(o.items)) { const t = num(pick(o, 'total', 'totalCount', 'total_count', 'count')); return isFinite(t) ? t : NaN; }
      for (const v of Object.values(o)) { const t = walk(v, d + 1); if (isFinite(t)) return t; }
      return NaN;
    };
    const t = walk(json, 0);
    if (isFinite(t)) return t;
    const top = json && num(pick(json, 'total', 'totalCount', 'total_count', 'count'));
    return isFinite(top) ? top : NaN;
  }
  const pageOf = (json) => ({ items: findItems(json), total: findTotal(json) });

  // ============================================================
  // 2. ÇEKİRDEK: normalize + imza + analiz (DOM'suz, test edilebilir)
  // ============================================================
  function normSel(s) {
    return {
      eventId: str(pick(s, 'eventId', 'event_id')),
      event: clean(pick(s, 'event', 'event_name')),
      marketId: str(pick(s, 'marketId', 'market_id')),
      market: clean(pick(s, 'market', 'market_name')),
      outcomeId: str(pick(s, 'outcomeId', 'outcome_id')),
      outcome: clean(pick(s, 'outcome', 'outcome_name')),
      specifiers: str(pick(s, 'specifiers')),
      k: num(pick(s, 'k', 'odd')),
      live: !!pick(s, 'live'),
      sport: clean(pick(s, 'sport', 'sport_name')),
      tournament: clean(pick(s, 'tournament', 'tournament_name')),
      scheduled: parseTs(pick(s, 'eventScheduled', 'event_scheduled')),
      cancelled: !!pick(s, 'userCancelled', 'user_cancelled') || !!pick(s, 'rollback'),
    };
  }

  function normalizeBet(raw) {
    const id = pick(raw, 'betId', 'bet_id', 'id');
    if (id == null) return null;
    let sels = pick(raw, 'selections');
    sels = Array.isArray(sels) && sels.length ? sels.map(normSel)
      : (pick(raw, 'eventId', 'event_id') != null ? [normSel(raw)] : []);
    return {
      id: str(id),
      playerId: str(pick(raw, 'playerId', 'player_id')),
      extPlayerId: str(pick(raw, 'extPlayerId', 'ext_player_id')),
      username: str(pick(raw, 'username', 'user_name')),
      brand: str(pick(raw, 'brandName', 'brand_name', 'brand')),
      ip: clean(pick(raw, 'ip')),
      country: str(pick(raw, 'country')),
      betType: str(pick(raw, 'betType', 'bet_type')),
      status: str(pick(raw, 'betStatus', 'bet_status', 'status')),
      accepted: pick(raw, 'accepted'),
      ts: parseTs(pick(raw, 'betTimestamp', 'bet_timestamp', 'betDate', 'bet_date')),
      stakeEur: num(pick(raw, 'stake', 'stake_eur')),
      stakeCur: num(pick(raw, 'stakeCurrency', 'stake_currency', 'stake_cur')),
      currency: str(pick(raw, 'betCurrency', 'bet_currency', 'currency')),
      odd: num(pick(raw, 'odd')),
      selections: sels,
    };
  }

  const isRejected = (b) => b.accepted === false || /^(no|false)$/i.test(str(b.accepted)) || /reject/i.test(b.status);

  // Çok sonuçlu (ters oynamanın risk dengelemediği) marketler dışarıda.
  const NOISY_MARKET = /correct score|exact|goalscorer|scorer|halftime\s*\/\s*fulltime|range|&|interval|minute|player|method|margin|race to|winning|which team will win the (final|3rd)/i;
  const NUM = '([+-]?\\d+(?:[.,]\\d+)?)';
  const RX_TOTAL = new RegExp('^(over|under|üst|alt)\\b\\s*\\(?\\s*' + NUM, 'i');
  const RX_HCP = new RegExp('^(.*?)\\s*\\(\\s*' + NUM + '\\s*\\)\\s*$');

  function signature(sel, opts = S) {
    if (!sel.eventId) return null;
    const market = sel.market.toLowerCase();
    const base = `${sel.eventId}|${sel.marketId || market}|${market}`;
    const t = RX_TOTAL.exec(sel.outcome);
    if (t) {
      return { key: base + '|total', kind: 'total', side: /^(over|üst)/i.test(t[1]) ? 'over' : 'under', line: num(t[2]), label: sel.outcome };
    }
    if (opts.onlyTotals) return null;
    const h = RX_HCP.exec(sel.outcome);
    if (h && /handicap|hcp/i.test(market)) {
      const line = num(h[2]);
      return { key: base + '|h' + Math.abs(line), kind: 'handicap', side: h[1].trim().toLowerCase(), line, label: sel.outcome };
    }
    if (NOISY_MARKET.test(market)) return null;
    return { key: base, kind: 'generic', side: sel.outcomeId ? 'o' + sel.outcomeId : sel.outcome.toLowerCase(), line: null, label: sel.outcome };
  }

  function legsOf(bet, opts = S) {
    if (!bet || isRejected(bet) || !bet.selections.length) return [];
    const combo = bet.selections.length > 1;
    if (combo && !opts.includeCombos) return [];
    const out = [];
    for (const sel of bet.selections) {
      if (sel.cancelled) continue;
      const sig = signature(sel, opts);
      if (sig) out.push(Object.assign({ bet, sel, combo }, sig));
    }
    return out;
  }

  // İki ayak zıt mı? Döner: { base, relation } ya da null.
  function relationOf(a, b, opts = S) {
    if (a.side === b.side) return null;
    if (a.kind === 'total') {
      const over = a.side === 'over' ? a : b, under = a.side === 'over' ? b : a;
      const gap = over.line - under.line;
      if (!isFinite(gap) || Math.abs(gap) > opts.maxLineGap) return null;
      if (gap === 0) return { base: 40, relation: 'tam ters' };
      if (gap < 0) return { base: 25, relation: 'orta (ikisi de kazanabilir)' };
      return { base: 12, relation: 'boşluklu ters' };
    }
    if (a.kind === 'handicap') return { base: 40, relation: 'ters handikap' };
    return { base: 20, relation: 'farklı sonuç' };
  }

  const subnet = (ip) => { const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip); return m ? m[1] : null; };

  function scorePair(a, b, opts = S) {
    const rel = relationOf(a, b, opts);
    if (!rel) return null;
    const A = a.bet, B = b.bet;
    let score = rel.base;
    const flags = [];
    const sameIp = !!A.ip && A.ip === B.ip;
    if (sameIp) { score += 45; flags.push('aynı IP'); }
    else if (A.ip && subnet(A.ip) && subnet(A.ip) === subnet(B.ip)) { score += 15; flags.push('aynı /24 ağ'); }
    const dt = Math.abs(A.ts - B.ts);
    if (isFinite(dt)) {
      if (dt <= 60e3) score += 25;
      else if (dt <= 5 * 60e3) score += 15;
      else if (dt <= 30 * 60e3) score += 6;
    }
    const pa = A.stakeEur * (a.combo ? A.odd : (a.sel.k || A.odd));
    const pb = B.stakeEur * (b.combo ? B.odd : (b.sel.k || B.odd));
    const balance = isFinite(pa) && isFinite(pb) && pa > 0 && pb > 0 ? Math.min(pa, pb) / Math.max(pa, pb) : NaN;
    if (balance >= 0.85) score += 15;
    else if (balance >= 0.65) score += 7;
    if (a.combo || b.combo) { score = Math.round(score * 0.6); flags.push('kombine'); }
    return { a, b, score: Math.min(100, score), baseScore: score, relation: rel.relation, sameIp, dt, balance, flags };
  }

  const playerKey = (bet) => bet.playerId || bet.extPlayerId || bet.username;

  function analyze(bets, opts = S) {
    const groups = new Map();
    for (const bet of bets) {
      for (const leg of legsOf(bet, opts)) {
        let g = groups.get(leg.key);
        if (!g) {
          g = { key: leg.key, kind: leg.kind, eventId: leg.sel.eventId, event: leg.sel.event, marketId: leg.sel.marketId,
            market: leg.sel.market, sport: leg.sel.sport, tournament: leg.sel.tournament, scheduled: leg.sel.scheduled, legs: [] };
          groups.set(leg.key, g);
        }
        g.legs.push(leg);
      }
    }

    const hits = [];
    const pairAgg = new Map();
    for (const g of groups.values()) {
      if (g.legs.length < 2) continue;
      const sides = new Set(g.legs.map((l) => l.side));
      const players = new Set(g.legs.map((l) => playerKey(l.bet)));
      if (sides.size < 2 || players.size < 2) continue;
      const legs = g.legs.length > 400 ? g.legs.slice().sort((x, y) => y.bet.ts - x.bet.ts).slice(0, 400) : g.legs;
      const pairs = [];
      for (let i = 0; i < legs.length; i++) {
        for (let j = i + 1; j < legs.length; j++) {
          const a = legs[i], b = legs[j];
          const pa = playerKey(a.bet), pb = playerKey(b.bet);
          if (pa === pb) continue;
          const p = scorePair(a, b, opts);
          if (!p) continue;
          p.pk = pa < pb ? pa + '~' + pb : pb + '~' + pa;
          pairs.push(p);
          let agg = pairAgg.get(p.pk);
          if (!agg) {
            const [x, y] = pa < pb ? [a.bet, b.bet] : [b.bet, a.bet];
            agg = { pk: p.pk, players: [playerInfo(x), playerInfo(y)], events: new Set(), groups: new Set(), sameIp: false,
              stakeEur: 0, best: 0, pairs: [] };
            pairAgg.set(p.pk, agg);
          }
          agg.events.add(g.eventId);
          agg.groups.add(g.key);
          agg.sameIp = agg.sameIp || p.sameIp;
          agg.pairs.push(p);
        }
      }
      if (pairs.length) hits.push(Object.assign(g, { pairs }));
    }

    // Aynı hesap çifti birden fazla maçta karşı karşıya geldiyse tüm eşleşmeleri yükselt.
    for (const agg of pairAgg.values()) {
      const extra = Math.max(0, agg.events.size - 1);
      const seenBets = new Set();
      for (const p of agg.pairs) {
        if (extra) { p.score = Math.min(100, p.baseScore + 15 * extra); p.flags.push(`${agg.events.size} maçta karşılaştı`); }
        agg.best = Math.max(agg.best, p.score);
        for (const bet of [p.a.bet, p.b.bet]) if (!seenBets.has(bet.id)) { seenBets.add(bet.id); agg.stakeEur += bet.stakeEur || 0; }
      }
    }
    for (const g of hits) {
      g.pairs.sort((x, y) => y.score - x.score || x.dt - y.dt);
      g.score = g.pairs[0].score;
      g.lastTs = Math.max(...g.legs.map((l) => l.bet.ts).filter(isFinite));
    }
    hits.sort((x, y) => y.score - x.score || y.lastTs - x.lastTs);
    const pairList = [...pairAgg.values()].sort((x, y) => y.best - x.best || y.events.size - x.events.size);
    return { groups: hits, pairs: pairList };
  }

  function playerInfo(b) {
    return { playerId: b.playerId, extPlayerId: b.extPlayerId, username: b.username, brand: b.brand, ip: b.ip };
  }

  function sideLabel(leg) {
    if (leg.kind === 'total') return `${leg.side} ${String(leg.line).replace('.', ',')}`;
    return leg.label || leg.side;
  }

  function filterGroups(groups, opts = S, q = '') {
    const now = Date.now();
    const needle = q.trim().toLowerCase();
    return groups.filter((g) => {
      if (g.score < opts.minScore) return false;
      if (opts.onlySameIp && !g.pairs.some((p) => p.sameIp)) return false;
      if (opts.onlyUpcoming && isFinite(g.scheduled) && g.scheduled < now) return false;
      if (!needle) return true;
      if ((g.event + ' ' + g.market + ' ' + g.eventId).toLowerCase().includes(needle)) return true;
      return g.legs.some((l) => [l.bet.username, l.bet.extPlayerId, l.bet.playerId, l.bet.ip].join(' ').toLowerCase().includes(needle));
    });
  }

  // ============================================================
  // 3. VERİ DEPOSU
  // ============================================================
  const state = {
    bets: new Map(),
    watermark: 0,
    result: { groups: [], pairs: [] },
    running: false,
    polling: false,
    primed: false,
    lastPoll: 0,
    lastError: null,
    progress: null,
    lastScan: null,
    hookAuth: null,
    hookApi: null,
    leader: false,
    seen: new Set(readJSON(SEEN_KEY, [])),
    listeners: new Set(),
  };

  function ingestItems(items, source) {
    let added = 0;
    for (const raw of items || []) {
      const b = normalizeBet(raw);
      if (!b) continue;
      if (!state.bets.has(b.id)) added++;
      state.bets.set(b.id, b);
    }
    if (added) log(`${source}: +${added} bahis (toplam ${state.bets.size})`);
    return { added, total: (items || []).length };
  }

  function prune() {
    const cutoff = windowStart(S.window);
    for (const [id, b] of state.bets) if (isFinite(b.ts) && b.ts < cutoff) state.bets.delete(id);
    if (state.bets.size > MAX_BETS) {
      const sorted = [...state.bets.values()].sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < sorted.length - MAX_BETS; i++) state.bets.delete(sorted[i].id);
    }
  }

  function reanalyze() {
    state.result = analyze(state.bets.values(), S);
    notifyNew();
    state.listeners.forEach((fn) => { try { fn(); } catch (e) { warn(e); } });
    return state.result;
  }

  // ============================================================
  // 4. OTURUM + API
  // ============================================================
  function readSession() {
    let best = null;
    try {
      const st = JSON.parse(localStorage.getItem('spt-state') || 'null');
      const users = (st && st.persistable && st.persistable.users) || {};
      for (const [schemaUrl, u] of Object.entries(users)) {
        if (u && u.token) { best = { token: u.token, api: originOf(schemaUrl) || DEFAULT_API, refreshUrl: u.refresh_url || null, exp: jwtExp(u.token) }; break; }
      }
    } catch {}
    if (state.hookAuth) {
      const exp = jwtExp(state.hookAuth);
      if (!best || (isFinite(exp) && (!isFinite(best.exp) || exp > best.exp))) {
        best = { token: state.hookAuth, api: state.hookApi || (best && best.api) || DEFAULT_API, refreshUrl: best && best.refreshUrl, exp };
      }
    }
    return best;
  }

  class AuthError extends Error {}

  function buildFilters(sinceMs, offset) {
    return {
      filterEventId: [], limit: S.pageSize, offset, orderBy: 'bet_timestamp', orderByAscDesc: 'DESC',
      filterOperatorBrandId: [], filterBetId: [], filterLivePrematch: [], filterOutcomeName: [], testPlayers: 'exclude',
      filterBetType: [], filterEventName: [], filterBetStatus: [], filterHasOperatorBonus: false, filterClientLicense: [],
      filterOutcomeId: [], rBetDate: { rangeFrom: new Date(sinceMs).toISOString(), rangeTo: null }, filterCategoryName: [],
      acceptedBets: ['Yes'], filterExtPlayerId: [], filterBetbuilderOnly: false, filterMarketName: [], filterMarketId: [],
      filterSportId: [], filterCurrency: [], filterTournamentName: [], filterPlayerId: [], filterBonus: [],
    };
  }

  async function httpJson(url, init, session) {
    const res = await ORIG_FETCH(url, Object.assign({}, init, {
      headers: Object.assign({ accept: 'application/json', authorization: 'Bearer ' + session.token }, init.headers || {}),
      credentials: 'omit',
    }));
    if (res.status === 401 || res.status === 403) throw new AuthError('HTTP ' + res.status);
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  async function fetchGql(url, sinceMs, offset, session) {
    const j = await httpJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: 'getBetHistoryList', variables: { inputFilters: buildFilters(sinceMs, offset) }, query: BET_QUERY }),
    }, session);
    if (j && j.errors && !(j.data && j.data.data)) {
      const msg = j.errors.map((e) => e.message).join('; ');
      if (/unauth|token|expired/i.test(msg)) throw new AuthError(msg);
      throw new Error('GraphQL: ' + msg);
    }
    return pageOf(j);
  }

  async function fetchRest(sinceMs, offset, session) {
    const p = new URLSearchParams({
      'r_bet_date[range_from]': new Date(sinceMs).toISOString(), accepted_bets: 'Yes', test_players: 'exclude',
      limit: String(S.pageSize), offset: String(offset), order_by: 'bet_timestamp', order_by_asc_desc: 'DESC',
    });
    return pageOf(await httpJson(session.api + REST_PATH + '?' + p, { method: 'GET' }, session));
  }

  async function fetchPage(sinceMs, offset, session) {
    if (learned.mode === 'rest') return fetchRest(sinceMs, offset, session);
    const urls = [...new Set([learned.gqlUrl, ...GQL_CANDIDATES.map((p) => session.api + p)].filter(Boolean))];
    let lastErr = null;
    for (const url of urls) {
      try {
        const page = await fetchGql(url, sinceMs, offset, session);
        if (learned.gqlUrl !== url || learned.mode !== 'gql') { learned.gqlUrl = url; learned.mode = 'gql'; saveLearned(); log('GraphQL ucu:', url); }
        return page;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        lastErr = e;
      }
    }
    try {
      const page = await fetchRest(sinceMs, offset, session);
      learned.mode = 'rest'; saveLearned(); log('REST ucuna geçildi:', REST_PATH);
      return page;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw lastErr || e;
    }
  }

  async function poll(full) {
    if (state.polling) return;
    const session = readSession();
    if (!session) { setError('Oturum bulunamadı — backoffice\'e giriş yapın.'); return; }
    if (isFinite(session.exp) && session.exp < Date.now()) {
      setError('Oturum süresi doldu — sayfayı yenileyin ya da bir filtre uygulayın.'); return;
    }
    state.polling = true;
    render();
    try {
      // Tam tarama: geriye dönük tüm pencere. Artımlı: yalnızca son taramadan beri (5 dk örtüşmeyle).
      const incremental = !full && state.primed && state.watermark;
      const since = incremental ? state.watermark - 5 * 60e3 : windowStart(S.window);
      let offset = 0, pages = 0, fetched = 0, total = NaN, newest = 0;
      state.progress = { pages: 0, fetched: 0, total: NaN };
      while (pages < S.maxPages) {
        const { items, total: t } = await fetchPage(since, offset, session);
        if (isFinite(t)) total = t;
        const r = ingestItems(items, 'tarama');
        for (const raw of items) { const ts = parseTs(pick(raw, 'betTimestamp', 'bet_timestamp')); if (ts > newest) newest = ts; }
        pages++; fetched += items.length; offset += items.length;
        state.progress = { pages, fetched, total };
        render();
        if (!items.length) break;                                   // boş sayfa: bitti
        if (isFinite(total) && offset >= total) break;              // toplam kadar çekildi
        if (!isFinite(total) && items.length < S.pageSize && items.length < 150) break; // toplam bilinmiyorsa kısa sayfa = son
        if (incremental && r.added === 0) break;                    // DESC sıralı: yeni bahis kalmadı
        await sleep(200);
      }
      if (pages >= S.maxPages && isFinite(total) && offset < total) {
        toast(`Uyarı: ${S.maxPages} sayfa sınırına ulaşıldı (${fetched}/${total}). Ayarlardan sayfa sınırını artırın ya da geriye dönük süreyi kısaltın.`, 8000);
      }
      if (newest > state.watermark) state.watermark = newest;
      state.lastScan = { at: Date.now(), pages, fetched, total, full: !incremental, since: new Date(since).toISOString() };
      prune();
      state.lastPoll = Date.now();
      state.lastError = null;
      reanalyze();
      if (!state.primed) {
        state.primed = true;
        const n = filterGroups(state.result.groups).length;
        toast(`İlk tarama bitti: ${fetched} bahis (${pages} sayfa), ${n} şüpheli maç/market.`);
      } else if (!incremental) {
        toast(`Tam tarama bitti: ${fetched} bahis (${pages} sayfa).`);
      }
    } catch (e) {
      setError(e instanceof AuthError ? 'Yetki reddedildi (' + e.message + ') — sayfayı yenileyin.' : 'Tarama hatası: ' + e.message);
      warn(e);
    } finally {
      state.polling = false;
      state.progress = null;
      render();
    }
  }

  function setError(msg) { state.lastError = msg; warn(msg); render(); }

  // --- Birden fazla sekme açıksa yalnızca biri tarar ---
  const TAB_ID = Math.random().toString(36).slice(2);
  function tryLead(force) {
    const now = Date.now();
    const l = readJSON(LOCK_KEY, null);
    if (force || !l || l.id === TAB_ID || now - l.ts > S.intervalSec * 3000) {
      writeJSON(LOCK_KEY, { id: TAB_ID, ts: now });
      state.leader = true;
    } else state.leader = false;
    return state.leader;
  }

  let timer = 0;
  function tick() {
    clearTimeout(timer);
    if (!state.running) return;
    if (tryLead(false)) poll();
    timer = setTimeout(tick, Math.max(10, S.intervalSec) * 1000);
    render();
  }
  function start(force) { state.running = true; if (force) tryLead(true); tick(); }
  function stop() {
    state.running = false; clearTimeout(timer);
    const l = readJSON(LOCK_KEY, null);
    if (l && l.id === TAB_ID) { try { localStorage.removeItem(LOCK_KEY); } catch {} }
    state.leader = false; render();
  }

  // ============================================================
  // 5. PASİF YAKALAMA (sayfanın kendi istekleri)
  // ============================================================
  const ORIG_FETCH = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  function noteRequest(url, headers, body) {
    try {
      const u = String(url || '');
      if (!/sptenv\.com\/api\//.test(u)) return;
      const auth = headers && (headers.authorization || headers.Authorization);
      if (auth && /^Bearer\s+/i.test(auth)) { state.hookAuth = auth.replace(/^Bearer\s+/i, ''); state.hookApi = originOf(u); }
      if (typeof body === 'string' && body.includes('getBetHistoryList') && learned.gqlUrl !== u) {
        learned.gqlUrl = u; learned.mode = 'gql'; saveLearned(); log('Bahis geçmişi ucu öğrenildi:', u);
      }
      const s = readSession();
      if (s && s.refreshUrl && u.startsWith(s.refreshUrl) && !learned.refresh) {
        let keys = null; try { keys = Object.keys(JSON.parse(body)); } catch {}
        learned.refresh = { url: u, bodyKeys: keys }; saveLearned();
      }
    } catch {}
  }
  function noteResponse(body, text) {
    if (typeof body !== 'string' || !body.includes('getBetHistoryList')) return;
    try {
      const r = ingestItems(findItems(JSON.parse(text)), 'sayfa');
      if (r.added) reanalyzeSoon();
    } catch {}
  }
  let reTimer = 0;
  function reanalyzeSoon() { clearTimeout(reTimer); reTimer = setTimeout(reanalyze, 300); }

  function headersToObj(h) {
    const o = {};
    try { if (h) new Headers(h).forEach((v, k) => { o[k] = v; }); } catch {}
    return o;
  }

  if (ORIG_FETCH) {
    window.fetch = function (input, init) {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      const url = isReq ? input.url : String(input);
      const headers = headersToObj((init && init.headers) || (isReq ? input.headers : undefined));
      const body = init && typeof init.body === 'string' ? init.body : null;
      noteRequest(url, headers, body);
      const p = ORIG_FETCH.apply(this, arguments);
      if (body && body.includes('getBetHistoryList')) {
        p.then((res) => res.clone().text().then((t) => noteResponse(body, t))).catch(() => {});
      }
      return p;
    };
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    const P = XMLHttpRequest.prototype, oOpen = P.open, oSet = P.setRequestHeader, oSend = P.send;
    P.open = function (m, u) { this.__bbh = { u: String(u), h: {} }; return oOpen.apply(this, arguments); };
    P.setRequestHeader = function (k, v) { if (this.__bbh) this.__bbh.h[String(k).toLowerCase()] = v; return oSet.apply(this, arguments); };
    P.send = function (b) {
      const c = this.__bbh;
      if (c) {
        noteRequest(c.u, c.h, typeof b === 'string' ? b : null);
        if (typeof b === 'string' && b.includes('getBetHistoryList')) {
          this.addEventListener('load', () => {
            if (this.status >= 200 && this.status < 300 && (this.responseType === '' || this.responseType === 'text')) noteResponse(b, this.responseText);
          });
        }
      }
      return oSend.apply(this, arguments);
    };
  }

  // ============================================================
  // 6. BİLDİRİM
  // ============================================================
  const alertId = (g, p) => `${g.key}#${p.a.bet.id}#${p.b.bet.id}`;

  function notifyNew() {
    const fresh = [];
    for (const g of state.result.groups) {
      for (const p of g.pairs) {
        if (p.score < S.notifyScore) break;
        const id = alertId(g, p);
        if (state.seen.has(id)) continue;
        state.seen.add(id);
        if (state.primed) fresh.push({ g, p });
      }
    }
    if (state.seen.size > 5000) state.seen = new Set([...state.seen].slice(-3000));
    writeJSON(SEEN_KEY, [...state.seen]);
    if (!fresh.length) return;
    const top = fresh[0];
    const msg = `${top.g.event} · ${top.g.market}: ${who(top.p.a.bet)} ↔ ${who(top.p.b.bet)} (skor ${top.p.score})` +
      (fresh.length > 1 ? ` +${fresh.length - 1} yeni` : '');
    toast('🚨 ' + msg, 8000);
    if (S.sound) beep();
    if (S.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('Çift taraf bahis', { body: msg, tag: 'bb-hedge' }); } catch {}
    }
    flashTitle(fresh.length);
  }

  const who = (b) => b.username || b.extPlayerId || b.playerId;

  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.25);
    } catch {}
  }

  let titleTimer = 0, baseTitle = null;
  function flashTitle(n) {
    if (typeof document === 'undefined' || !document.title) return;
    if (baseTitle == null) baseTitle = document.title;
    clearInterval(titleTimer);
    let on = false, count = 0;
    titleTimer = setInterval(() => {
      on = !on; document.title = on ? `🚨 (${n}) çift taraf` : baseTitle;
      if (++count > 20 || (typeof document.hasFocus === 'function' && document.hasFocus() && count > 4)) { clearInterval(titleTimer); document.title = baseTitle; }
    }, 1000);
  }

  // ============================================================
  // 7. ARAYÜZ
  // ============================================================
  const CSS = `
#bbh-btn{position:fixed;left:18px;bottom:18px;z-index:2147483000;background:#c62828;color:#fff;border:0;border-radius:22px;
  padding:9px 14px;font:600 13px/1 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
#bbh-btn .n{background:#fff;color:#c62828;border-radius:10px;padding:2px 6px;margin-left:6px}
#bbh{--bg:#fff;--fg:#1d2330;--mut:#667085;--line:#e4e7ec;--card:#f8f9fb;--acc:#1570ef;--hi:#d92d20;--mid:#dc6803;--lo:#667085;
  position:fixed;left:18px;bottom:64px;z-index:2147483001;width:760px;height:620px;min-width:420px;min-height:300px;
  max-width:calc(100vw - 24px);max-height:calc(100vh - 80px);resize:both;overflow:hidden;display:flex;flex-direction:column;
  background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);
  font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
#bbh.dark{--bg:#161b26;--fg:#e6e9ef;--mut:#98a2b3;--line:#2b3445;--card:#1d2433;--acc:#53b1fd}
#bbh[hidden]{display:none}
#bbh header{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line);cursor:move;user-select:none}
#bbh header b{font-size:14px}
#bbh .sp{flex:1}
#bbh button,#bbh select,#bbh input[type=text],#bbh input[type=number]{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
#bbh button{cursor:pointer}
#bbh button.pri{background:var(--acc);border-color:var(--acc);color:#fff}
#bbh .status{padding:6px 12px;font-size:12px;color:var(--mut);border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap}
#bbh .status .err{color:var(--hi);font-weight:600}
#bbh .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--lo);margin-right:4px}
#bbh .dot.on{background:#12b76a}#bbh .dot.busy{background:#f79009}#bbh .dot.bad{background:var(--hi)}
#bbh .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line)}
#bbh .bar label{display:flex;gap:4px;align-items:center;white-space:nowrap}
#bbh .bar input[type=text]{flex:1;min-width:140px}
#bbh .tabs{display:flex;gap:4px}
#bbh .tabs button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
#bbh .set{padding:8px 12px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 12px}
#bbh .set label{display:flex;justify-content:space-between;gap:6px;align-items:center}
#bbh .set input[type=number]{width:80px}
#bbh .list{flex:1;overflow:auto;padding:8px 12px}
#bbh .empty{color:var(--mut);text-align:center;padding:40px 10px}
#bbh .it{border:1px solid var(--line);border-left:4px solid var(--lo);border-radius:8px;background:var(--card);margin-bottom:8px;padding:8px 10px}
#bbh .it.hi{border-left-color:var(--hi)}#bbh .it.mid{border-left-color:var(--mid)}
#bbh .h1{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
#bbh .sc{font-weight:700;min-width:30px;text-align:center;border-radius:6px;padding:1px 6px;color:#fff;background:var(--lo)}
#bbh .hi .sc{background:var(--hi)}#bbh .mid .sc{background:var(--mid)}
#bbh .meta{color:var(--mut);font-size:12px}
#bbh .chip{font-size:11px;border:1px solid var(--line);border-radius:10px;padding:0 6px;color:var(--mut)}
#bbh .chip.red{color:var(--hi);border-color:var(--hi)}
#bbh .sides{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-top:6px}
#bbh .side{border:1px dashed var(--line);border-radius:6px;padding:4px 6px}
#bbh .side h4{margin:0 0 3px;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
#bbh .bet{font-size:12px;display:flex;gap:6px;flex-wrap:wrap;padding:1px 0}
#bbh .bet.key{font-weight:600}
#bbh .bet .u{cursor:pointer;color:var(--acc)}
#bbh a.gt{font-size:11px;font-weight:600;color:#fff;background:var(--acc);border-radius:4px;padding:0 5px;text-decoration:none;cursor:pointer}
#bbh .pr{font-size:12px;margin-top:6px;color:var(--mut)}
#bbh .acts{display:flex;gap:6px;margin-top:6px}
#bbh .acts a,#bbh .acts button{font-size:12px;color:var(--acc);text-decoration:none;background:none;border:0;padding:0;cursor:pointer}
#bbh table{width:100%;border-collapse:collapse;font-size:12px}
#bbh th,#bbh td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
#bbh-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483002;background:#1d2330;color:#fff;
  padding:9px 14px;border-radius:8px;font:13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3);max-width:80vw}
`;

  let ui = null;
  let query = '';
  let showSettings = false;

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  function mountUI() {
    if (ui || typeof document === 'undefined' || !document.body) return;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    const btn = el('<button id="bbh-btn" title="Çift taraf dedektörü (Alt+H)">🛡️ Çift Taraf<span class="n">0</span></button>');
    const panel = el('<div id="bbh" hidden></div>');
    document.body.appendChild(btn); document.body.appendChild(panel);
    ui = { btn, panel };
    btn.addEventListener('click', toggle);
    panel.addEventListener('click', onClick);
    panel.addEventListener('input', onInput);
    panel.addEventListener('change', onInput);
    enableDrag(panel);
    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); toggle(); }
      else if (e.key === 'Escape' && !panel.hidden) toggle(false);
    });
    applyTheme();
    render();
  }

  function applyTheme() {
    if (!ui) return;
    const dark = S.theme === 'dark' || (S.theme === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    ui.panel.classList.toggle('dark', !!dark);
  }

  function toggle(force) {
    if (!ui) return;
    ui.panel.hidden = typeof force === 'boolean' ? !force : !ui.panel.hidden;
    render();
  }

  function enableDrag(panel) {
    let sx, sy, ox, oy, drag = false;
    panel.addEventListener('mousedown', (e) => {
      if (!e.target.closest('header') || e.target.closest('button,input,select')) return;
      const r = panel.getBoundingClientRect();
      drag = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  let toastTimer = 0;
  function toast(msg, ms = 4000) {
    log(msg);
    if (typeof document === 'undefined' || !document.body) return;
    let t = document.getElementById('bbh-toast');
    if (!t) { t = document.createElement('div'); t.id = 'bbh-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function historyLink(filters) {
    const f = Object.assign({ testPlayers: 'exclude', acceptedBets: ['Yes'],
      rBetDate: { rangeFrom: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10) + 'T00:00:00.000Z', rangeTo: null } }, filters);
    return '/bet-history?filters=' + encodeURIComponent(JSON.stringify(f));
  }

  // Betby'deki extPlayerId = GT core party id.
  function gtUrl(id) {
    const pid = str(id).trim();
    return /^\d+$/.test(pid) ? `${GT_HOST}/core/app/core/players/${pid}/detail` : null;
  }

  let gtWin = null;
  function openGt(id) {
    const url = gtUrl(id);
    if (!url) { toast('Bu oyuncunun GT party id\'si yok.'); return; }
    try {
      if (gtWin && !gtWin.closed) { gtWin.location.href = url; gtWin.focus(); return; }
    } catch {}
    gtWin = window.open(url, GT_WINDOW);
    if (!gtWin) { toast('Açılır pencere engellendi — backoffice.sptenv.com için açılır pencerelere izin verin.'); return; }
    try { gtWin.focus(); } catch {}
  }
  const gtBtn = (id) => (gtUrl(id) ? `<a class="gt" href="${esc(gtUrl(id))}" data-gt="${esc(id)}" title="GT core'da oyuncu profilini aç (party ${esc(id)})">GT ↗</a>` : '');

  const lvl = (s) => (s >= S.notifyScore ? 'hi' : s >= S.minScore ? 'mid' : '');

  function renderGroup(g) {
    const keyBets = new Set();
    g.pairs.slice(0, 5).forEach((p) => { keyBets.add(p.a.bet.id); keyBets.add(p.b.bet.id); });
    const bySide = new Map();
    for (const l of g.legs.slice().sort((a, b) => a.bet.ts - b.bet.ts)) {
      const k = sideLabel(l);
      if (!bySide.has(k)) bySide.set(k, []);
      bySide.get(k).push(l);
    }
    const sides = [...bySide.entries()].sort((a, b) => a[0].localeCompare(b[0], 'tr'));
    const top = g.pairs[0];
    const chips = [top.relation, ...new Set(g.pairs.slice(0, 5).flatMap((p) => p.flags))]
      .map((f) => `<span class="chip ${/IP|maçta/.test(f) ? 'red' : ''}">${esc(f)}</span>`).join('');
    const sideHtml = sides.map(([label, legs]) => `
      <div class="side"><h4>${esc(label)} <span class="meta">(${legs.length})</span></h4>
      ${legs.slice(0, 12).map((l) => betRow(l, keyBets.has(l.bet.id))).join('')}
      ${legs.length > 12 ? `<div class="meta">+${legs.length - 12} bahis daha</div>` : ''}</div>`).join('');
    const prs = g.pairs.slice(0, 3).map((p) =>
      `<div>• <b>${esc(who(p.a.bet))}</b> ${esc(sideLabel(p.a))} ↔ <b>${esc(who(p.b.bet))}</b> ${esc(sideLabel(p.b))} — skor ${p.score}, ` +
      `${isFinite(p.dt) ? fmtDur(p.dt) + ' arayla' : ''}${isFinite(p.balance) ? ', ödeme dengesi %' + Math.round(p.balance * 100) : ''}</div>`).join('');
    return `<div class="it ${lvl(g.score)}" data-key="${esc(g.key)}">
      <div class="h1"><span class="sc">${g.score}</span><b>${esc(g.event || g.eventId)}</b><span>${esc(g.market)}</span>
        <span class="meta">${esc(g.sport)}${g.tournament ? ' · ' + esc(g.tournament) : ''} · maç ${fmtTs(g.scheduled)} UTC</span>${chips}</div>
      <div class="sides">${sideHtml}</div>
      <div class="pr">${prs}</div>
      <div class="acts"><a href="${esc(historyLink({ filterEventId: [g.eventId] }))}" target="_blank">Bahis geçmişinde aç ↗</a>
        <button data-act="copy">Özeti kopyala</button></div>
    </div>`;
  }

  function betRow(l, key) {
    const b = l.bet;
    const amt = isFinite(b.stakeCur) && b.currency ? fmtMoney(b.stakeCur, b.currency) : fmtMoney(b.stakeEur, 'EUR');
    return `<div class="bet ${key ? 'key' : ''}"><span class="u" data-q="${esc(b.playerId || b.extPlayerId)}" title="Bu oyuncuyla filtrele">${esc(who(b))}</span>${gtBtn(b.extPlayerId)}
      <span>${amt}</span><span>@${isFinite(l.sel.k) ? l.sel.k : b.odd}</span><span class="meta">${fmtTs(b.ts, false)}</span>
      ${b.ip ? `<span class="meta">${esc(b.ip)}</span>` : ''}${l.combo ? '<span class="chip">kombine</span>' : ''}${b.brand ? `<span class="meta">${esc(b.brand)}</span>` : ''}</div>`;
  }

  function renderPairs(pairs) {
    const needle = query.trim().toLowerCase();
    const rows = pairs.filter((p) => p.best >= S.minScore && (!S.onlySameIp || p.sameIp) &&
      (!needle || JSON.stringify(p.players).toLowerCase().includes(needle))).slice(0, 300);
    if (!rows.length) return '<div class="empty">Eşik üstünde hesap çifti yok.</div>';
    const pl = (x) => `<span class="u" data-q="${esc(x.playerId || x.extPlayerId)}">${esc(x.username || x.extPlayerId || x.playerId)}</span> ${gtBtn(x.extPlayerId)}` +
      `<div class="meta">ext ${esc(x.extPlayerId)} · ${esc(x.ip || 'IP yok')}</div>`;
    return `<table><thead><tr><th>Skor</th><th>Hesap A</th><th>Hesap B</th><th>Maç</th><th>Toplam stake</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr class="${lvl(p.best)}"><td><b>${p.best}</b></td><td>${pl(p.players[0])}</td><td>${pl(p.players[1])}</td>
        <td>${p.events.size}</td><td>${fmtMoney(p.stakeEur, 'EUR')}</td>
        <td>${p.sameIp ? '<span class="chip red">aynı IP</span>' : ''}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function renderSettings() {
    const n = (k, label, min, max, step = 1) => `<label>${label}<input type="number" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${S[k]}"></label>`;
    const c = (k, label) => `<label>${label}<input type="checkbox" data-set="${k}" ${S[k] ? 'checked' : ''}></label>`;
    return `<div class="set">
      ${n('intervalSec', 'Tarama aralığı (sn)', 10, 600)}${n('pageSize', 'Sayfa boyu', 50, 1000, 50)}
      ${n('maxPages', 'Tarama başı en çok sayfa', 1, 200)}${n('maxLineGap', 'Alt/üst çizgi toleransı', 0, 5, 0.5)}
      ${n('minScore', 'Liste eşiği (skor)', 0, 100)}${n('notifyScore', 'Alarm eşiği (skor)', 0, 100)}
      ${c('sound', 'Sesli uyarı')}${c('desktop', 'Masaüstü bildirimi')}${c('autoStart', 'Açılışta otomatik başlat')}
      <label>Tema<select data-set="theme">${['auto', 'light', 'dark'].map((t) => `<option ${S.theme === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label><button data-act="reset">Veriyi sıfırla</button><button data-act="export">CSV indir</button></label>
    </div>`;
  }

  let renderQueued = false;
  function render() {
    if (!ui) return;
    if (renderQueued) return;
    renderQueued = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(() => { renderQueued = false; renderNow(); });
  }

  function renderNow() {
    if (!ui) return;
    const groups = filterGroups(state.result.groups, S, query);
    const hiCount = groups.filter((g) => g.score >= S.notifyScore).length;
    ui.btn.querySelector('.n').textContent = String(hiCount || groups.length);
    ui.btn.style.background = hiCount ? '#c62828' : '#475467';
    if (ui.panel.hidden) return;

    const s = readSession();
    const expLeft = s && isFinite(s.exp) ? s.exp - Date.now() : NaN;
    const dot = state.lastError ? 'bad' : state.polling ? 'busy' : state.running && state.leader ? 'on' : '';
    const pg = state.progress;
    const statusTxt = state.polling ? `Taranıyor… sayfa ${pg ? pg.pages : 0}${pg && isFinite(pg.total) ? ` · ${pg.fetched.toLocaleString('tr-TR')}/${pg.total.toLocaleString('tr-TR')}` : ''}` : !state.running ? 'Durduruldu' : state.leader ? 'Çalışıyor' : 'Başka sekme tarıyor';

    const listScroll = ui.panel.querySelector('.list') ? ui.panel.querySelector('.list').scrollTop : 0;
    const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.role === 'q';

    ui.panel.innerHTML = `
      <header><b>🛡️ Çift Taraf Dedektörü</b><span class="meta">v${VERSION}</span><span class="sp"></span>
        ${state.running ? '<button data-act="stop">⏸ Durdur</button>' : '<button class="pri" data-act="start">▶ Başlat</button>'}
        <button data-act="scan" ${state.polling ? 'disabled' : ''} title="Son taramadan bu yana gelen bahisler">⟳ Şimdi tara</button>
        <button data-act="full" ${state.polling ? 'disabled' : ''} title="Seçili pencerenin tamamını (${esc(windowLabel(S.window))}) baştan tara">⇊ Tümünü tara</button>
        <button data-act="settings">⚙</button><button data-act="close">✕</button></header>
      <div class="status"><span><span class="dot ${dot}"></span>${statusTxt}</span>
        <span>Son tarama: ${state.lastPoll ? fmtDur(Date.now() - state.lastPoll) + ' önce' : '—'}</span>
        <span>Bellekte ${state.bets.size.toLocaleString('tr-TR')} bahis</span>
        ${state.lastScan ? `<span>Çekilen: ${state.lastScan.fetched} satır / ${state.lastScan.pages} sayfa${state.lastScan.full ? ' (tam)' : ''}</span>` : ''}
        <span>Token: ${isFinite(expLeft) ? (expLeft > 0 ? fmtDur(expLeft) + ' kaldı' : '<span class="err">süresi doldu</span>') : '—'}</span>
        <span>Uç: ${esc(learned.mode || '?')}</span>
        ${state.lastError ? `<span class="err">${esc(state.lastError)}</span>` : ''}</div>
      ${showSettings ? renderSettings() : ''}
      <div class="bar">
        <div class="tabs"><button data-tab="groups" class="${S.tab === 'groups' ? 'on' : ''}">Maçlar (${groups.length})</button>
          <button data-tab="pairs" class="${S.tab === 'pairs' ? 'on' : ''}">Hesap çiftleri</button></div>
        <select data-set="window" title="Taranan zaman penceresi">${WINDOWS.map(([v, l]) => `<option value="${v}" ${S.window === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="text" data-role="q" placeholder="Maç, oyuncu, ext ID, IP ara…" value="${esc(query)}">
        <label><input type="checkbox" data-set="onlyTotals" ${S.onlyTotals ? 'checked' : ''}>Sadece alt/üst</label>
        <label><input type="checkbox" data-set="onlySameIp" ${S.onlySameIp ? 'checked' : ''}>Aynı IP</label>
        <label><input type="checkbox" data-set="onlyUpcoming" ${S.onlyUpcoming ? 'checked' : ''}>Başlamamış</label>
        <label><input type="checkbox" data-set="includeCombos" ${S.includeCombos ? 'checked' : ''}>Kombineler</label>
      </div>
      <div class="list">${S.tab === 'pairs' ? renderPairs(state.result.pairs)
        : groups.length ? groups.slice(0, 200).map(renderGroup).join('') + (groups.length > 200 ? `<div class="empty">+${groups.length - 200} kayıt daha — aramayı daraltın.</div>` : '')
        : `<div class="empty">${state.primed || state.bets.size ? 'Eşik üstünde çift taraf bahis yok.' : 'Henüz veri yok — tarama başlatılıyor ya da bahis geçmişinde Apply\'a basın.'}</div>`}</div>`;

    const list = ui.panel.querySelector('.list');
    if (list) list.scrollTop = listScroll;
    if (focused) { const q = ui.panel.querySelector('[data-role=q]'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  function onClick(e) {
    const t = e.target;
    const act = t.closest('[data-act]');
    const tab = t.closest('[data-tab]');
    const u = t.closest('[data-q]');
    const gt = t.closest('[data-gt]');
    if (gt) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return; // yeni sekme isteği: tarayıcıya bırak
      e.preventDefault(); openGt(gt.dataset.gt); return;
    }
    if (tab) { S.tab = tab.dataset.tab; saveSettings(); render(); return; }
    if (u && !act) { query = u.dataset.q; S.tab = 'groups'; render(); return; }
    if (!act) return;
    switch (act.dataset.act) {
      case 'start': S.autoStart = true; saveSettings(); start(true); break;
      case 'stop': S.autoStart = false; saveSettings(); stop(); break;
      case 'scan': tryLead(true); poll(); break;
      case 'full': tryLead(true); poll(true); break;
      case 'settings': showSettings = !showSettings; render(); break;
      case 'close': toggle(false); break;
      case 'reset': state.bets.clear(); state.watermark = 0; state.primed = false; reanalyze(); toast('Veri sıfırlandı; sonraki taramada geriye dönük yüklenecek.'); break;
      case 'export': exportCsv(); break;
      case 'copy': {
        const g = state.result.groups.find((x) => x.key === act.closest('[data-key]').dataset.key);
        if (g) copyText(summaryOf(g));
        break;
      }
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset.role === 'q') { query = t.value; render(); return; }
    const k = t.dataset.set;
    if (!k) return;
    if (e.type === 'input' && t.type === 'number') return; // sayılar change'te
    const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
    S[k] = v; saveSettings();
    if (k === 'desktop' && v && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
    if (k === 'theme') applyTheme();
    if (k === 'intervalSec' && state.running) tick();
    if (k === 'window') {
      prune(); reanalyze();
      if (state.running || state.primed) { tryLead(true); poll(true); }
      return;
    }
    if (['includeCombos', 'onlyTotals', 'maxLineGap'].includes(k)) reanalyze(); else render();
  }

  function summaryOf(g) {
    const lines = [`${g.event} (${g.eventId}) · ${g.market} · maç ${fmtTs(g.scheduled)} UTC · skor ${g.score}`];
    for (const p of g.pairs.slice(0, 5)) {
      const d = (l) => `${who(l.bet)} [ext ${l.bet.extPlayerId}, IP ${l.bet.ip || '-'}] ${sideLabel(l)} ${fmtMoney(l.bet.stakeCur, l.bet.currency)} @${l.sel.k} ${fmtTs(l.bet.ts)}`;
      lines.push(`- ${d(p.a)}  ↔  ${d(p.b)} | ${p.relation}; skor ${p.score}; ${p.flags.join(', ')}`);
    }
    return lines.join('\n');
  }

  function copyText(s) {
    try { navigator.clipboard.writeText(s).then(() => toast('Kopyalandı.'), () => { log(s); toast('Kopyalanamadı — konsola yazıldı.'); }); }
    catch { log(s); }
  }

  function csvRows() {
    const head = ['skor', 'ilişki', 'event_id', 'maç', 'market', 'maç_saati_utc', 'a_oyuncu', 'a_ext', 'a_ip', 'a_taraf', 'a_stake', 'a_para', 'a_oran', 'a_zaman_utc',
      'b_oyuncu', 'b_ext', 'b_ip', 'b_taraf', 'b_stake', 'b_para', 'b_oran', 'b_zaman_utc', 'fark_sn', 'denge', 'işaretler'];
    const rows = [head];
    for (const g of filterGroups(state.result.groups, S, query)) {
      for (const p of g.pairs) {
        if (p.score < S.minScore) break;
        const side = (l) => [who(l.bet), l.bet.extPlayerId, l.bet.ip, sideLabel(l), nfMoney.format(l.bet.stakeCur || 0), l.bet.currency, l.sel.k, fmtTs(l.bet.ts)];
        rows.push([p.score, p.relation, g.eventId, g.event, g.market, fmtTs(g.scheduled), ...side(p.a), ...side(p.b),
          isFinite(p.dt) ? Math.round(p.dt / 1000) : '', isFinite(p.balance) ? Math.round(p.balance * 100) + '%' : '', p.flags.join(' | ')]);
      }
    }
    return rows;
  }

  function exportCsv() {
    const csv = '﻿' + csvRows().map((r) => r.map((v) => `"${str(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `cift-taraf-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  state.listeners.add(render);
  if (typeof setInterval === 'function' && IS_LIVE) setInterval(render, 15000); // "x sn önce" metinleri

  // ============================================================
  // 8. BAŞLATMA + KONSOL API'Sİ
  // ============================================================
  function boot() {
    mountUI();
    if (S.autoStart) setTimeout(() => start(false), 1500);
  }
  if (IS_LIVE) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    window.addEventListener('beforeunload', () => {
      const l = readJSON(LOCK_KEY, null);
      if (l && l.id === TAB_ID) { try { localStorage.removeItem(LOCK_KEY); } catch {} }
    });
  }

  window.BBHedge = {
    version: VERSION,
    start: () => start(true),
    stop,
    scan: () => { tryLead(true); return poll(); },
    fullScan: () => { tryLead(true); return poll(true); },
    bets: () => [...state.bets.values()],
    groups: () => filterGroups(state.result.groups, S, query),
    allGroups: () => state.result.groups,
    pairs: () => state.result.pairs,
    ingest: (json) => { const r = ingestItems(Array.isArray(json) ? json : findItems(json), 'elle'); reanalyze(); return r; },
    analyze: reanalyze,
    settings: S,
    set: (k, v) => { S[k] = v; saveSettings(); reanalyze(); },
    csv: exportCsv,
    csvRows,
    clear: () => { state.bets.clear(); state.watermark = 0; state.primed = false; reanalyze(); },
    toggle,
    debug: () => ({ learned, session: (() => { const s = readSession(); return s && { api: s.api, exp: new Date(s.exp).toISOString(), refreshUrl: s.refreshUrl }; })(),
      running: state.running, leader: state.leader, window: S.window, windowStart: new Date(windowStart(S.window)).toISOString(), lastScan: state.lastScan, watermark: new Date(state.watermark || 0).toISOString(), lastError: state.lastError }),
    openGt,
    core: { windowStart, gtUrl, findTotal, num, parseTs, normalizeBet, signature, legsOf, relationOf, scorePair, analyze, filterGroups, findItems, buildFilters, DEFAULTS },
  };
  if (IS_LIVE) log(`v${VERSION} yüklendi. Panel: Alt+H · Konsol: BBHedge`);
})();
