// ==UserScript==
// @name         Oyuncu Kartı — Party ID yazılınca Slack thread'ine
// @namespace    palentis.oyuncu-kart
// @version      1.1.3
// @description  C0BMBT1A6KX kanalında bir mesajda Party ID (8 hane) geçince o mesajın thread'ine oyuncu kartı bırakır: isim, VIP, KYC, üyelik süresi, çevrimiçi durumu, dikkat satırı (KYC, aynı IP, son yatırımdan sonra bonus, haftalık net eksi), bakiye, bekleyen çekim, son yatırım, son başarılı çekim, finans tablosu, son 7 gün oyunlar, son bonuslar. Kart resim olarak çizilir (dikkat kırmızı, bakiye mavi 2 sütun, finans yeşil). Her kelimenin baş harfi büyük. Panel linki yok. 🔄 tepkisiyle kart yenilenir. Veriyi açık GT sekmesi okur, Slack sekmesi gönderir.
// @match        https://core-secundus.gmntc.com/*
// @match        https://app.slack.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      files.slack.com
// @connect      slack.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * AKIŞ
 *   Slack sekmesi: kanalı 15 sn'de bir okur; Slack istemcisinden yazılmış (client_msg_id olan,
 *   yani bot/API mesajı olmayan) mesajlardaki 8 haneli ID'leri bulur → GM deposuna 'req:' yazar.
 *   Varsayılan: kanaldaki herkesin yazdığı mesajlar; menüden "sadece ben" yapılabilir.
 *   GT sekmesi: 'req:' kayıtlarını alır, panelden veriyi okur, kart verisini 'q:' olarak yazar.
 *   Slack sekmesi kartı resim (PNG, 2x) olarak çizer ve thread'e dosya olarak paylaşır; 🔄 ile
 *   yenilemede yeni kart gider, eskisi silinir. Slack cevaplarda renkli ek kutuları, yan yana
 *   alanları ve image bloğunu göstermediği için kart thread'e doğrudan resim dosyası olarak gider.
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0BMBT1A6KX',
    POLL_SEC: 15,
    REFRESH_REACTION: 'arrows_counterclockwise',
    ID_RE: /(?<![\d])1\d{7}(?![\d])/g,
    MAX_IDS: 3,
};

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Oyuncu Kartı]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const VER = (typeof GM_info !== 'undefined' && GM_info.script?.version) || '?';
/** Teşhis izi: son adımlar GM deposunda (Durum menüsünde görünür). */
const tr = (msg) => { try { const t = GM_getValue('trace', []); t.push(`${new Date().toLocaleTimeString('tr-TR')} ${location.hostname.split('.')[0]} ${msg}`); GM_setValue('trace', t.slice(-14)); } catch { /* yok say */ } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (location.hostname === 'app.slack.com') slackSide();
else gtSide();

/* ════════════════════════════════════════════════════════════
   GT TARAFI — veri ve kart
   ════════════════════════════════════════════════════════════ */
function gtSide() {
    const ME = Math.random().toString(36).slice(2);
    function token() {
        try { const k = JSON.parse(localStorage.getItem('sessionKey') || 'null')?.key; if (k) return k; } catch { /* yok say */ }
        try {
            const raw = sessionStorage.getItem('service_auth_token');
            if (raw) { try { const p = JSON.parse(raw); return p?.external?.token || p?.token || (typeof p === 'string' ? p : null); } catch { return raw; } }
        } catch { /* yok say */ }
        return null;
    }
    async function ics(path, params = {}) {
        const t = token();
        if (!t) throw new Error('oturum anahtarı yok');
        const res = await fetch(`${HOST}/ics/${path}?${new URLSearchParams({ ...params, sessionKey: t, uType: 'staff' })}`,
            { credentials: 'include', headers: { Accept: 'application/json', Authorization: `Bearer ${t}` } });
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        const tx = await res.text();
        try { return JSON.parse(tx); } catch { return tx; }
    }
    async function legacy(path, params) {
        const t = token();
        if (!t) throw new Error('oturum anahtarı yok');
        const res = await fetch(`${HOST}/j/${path}?${new URLSearchParams({ embeddedInNewDashboard: 'true', cmslanguage: 'en', token: t, ...params })}`, { credentials: 'include' });
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return new DOMParser().parseFromString(await res.text(), 'text/html');
    }
    const asList = (d) => Array.isArray(d) ? d : (Object.values(d || {}).find(Array.isArray) || []);
    const clean = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const pick = (o, names) => { for (const n of names) { const k = Object.keys(o || {}).find(x => x.toLowerCase() === n.toLowerCase()); if (k && o[k] != null && o[k] !== '') return o[k]; } return null; };
    const p2 = (n) => String(n).padStart(2, '0');
    const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
    const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const dmy = (d) => `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()}`;
    function num(s) {
        if (typeof s === 'number') return s;
        let t = String(s ?? '').replace(/[^\d.,-]/g, '');
        if (!t) return NaN;
        const dot = t.lastIndexOf('.'), comma = t.lastIndexOf(',');
        if (dot >= 0 && comma >= 0) t = dot > comma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
        else if (comma >= 0) t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
        return parseFloat(t);
    }
    /** "29-09-2026 12:57:12 UTC" ya da "2026-09-29 12:57:12" ya da ms → ms */
    function when(v) {
        if (v == null || v === '') return null;
        if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
        let m = String(v).match(/(\d{2})[-.](\d{2})[-.](\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
        if (m) return /UTC/i.test(v) ? Date.UTC(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) : new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
        m = String(v).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
        if (m) return Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
        return null;
    }
    const tl = (n) => (Number.isFinite(Number(n)) ? `${Math.round(Number(n)).toLocaleString('tr-TR')} TL` : '–');
    const int = (n) => `${Number(n) < 0 ? '−' : ''}${Math.abs(Math.round(Number(n) || 0)).toLocaleString('tr-TR')}`;
    const signed = (n) => `${Number(n) > 0 ? '+' : Number(n) < 0 ? '−' : ''}${Math.abs(Math.round(Number(n) || 0)).toLocaleString('tr-TR')}`;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const shortMethod = (m) => (String(m || '').match(/\(([^()]+)\)\s*$/)?.[1] || String(m || '')).trim();
    function ago(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '';
        const min = Math.round(ms / 60000);
        if (min < 60) return `${min} dk önce`;
        if (min < 1440) return `${Math.floor(min / 60)} sa ${min % 60} dk önce`;
        const d = Math.floor(min / 1440);
        return d < 60 ? `${d} gün önce` : `${Math.floor(d / 30)} ay önce`;
    }
    const AYLAR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
    /** Kelime başlarını büyütür (tr: i→İ). Kesme işaretinden sonrası (IP'de) küçük kalır. */
    const titleWords = (t) => t.replace(/(^|[\s(·\/*_`-])(\p{Ll})/gu, (m, a, c) => a + c.toLocaleUpperCase('tr-TR'));
    function memberFor(ms) {
        if (!Number.isFinite(ms)) return '';
        const d = Math.floor((Date.now() - ms) / 864e5);
        if (d < 1) return 'Bugün Üye Oldu';
        if (d < 31) return `${d} Gündür Üye`;
        if (d < 365) return `${Math.floor(d / 30)} Aydır Üye`;
        return `${Math.floor(d / 365)} Yıldır Üye`;
    }

    /* ── veri parçaları (hepsi bağımsız; biri okunamazsa kartta "–") ── */
    const settle = (p) => p.then(v => v, e => { warn(e.message); return undefined; });
    const raw = {};   // teşhis için ham alan adları

    /* VIP: panel sadece seviye numarası veriyor (vipLevel 267). Adı (Bronze…) bekleyen çekimler sayfasının
       "VIP LEVEL" sütunundan öğrenilir: oradaki oyuncuların numarasıyla eşlenip hatırlanır. */
    const VIP_SEED = { 267: 'Bronze', 271: 'Diamond' };
    const vipMap = () => ({ ...VIP_SEED, ...GM_getValue('vipNames', {}) });
    async function learnVip() {
        if (Date.now() - GM_getValue('vipLearnAt', 0) < 3 * 3600e3) return;
        GM_setValue('vipLearnAt', Date.now());
        const doc = await legacy('PendingWithdrawals.action', { execute: 'Go' });
        const table = doc.getElementById('pending_withdrawals');
        const head = table && [...table.rows].find(r => /PARTY ID/i.test(clean(r)) && /VIP LEVEL/i.test(clean(r)));
        if (!head) { warn('VIP adları: bekleyen çekimler listesi okunamadı'); return; }
        const cols = {}; let p = 0;
        for (const c of head.cells) { cols[clean(c).toUpperCase()] = p; p += c.colSpan || 1; }
        const cellAt = (row, pos) => { let q = 0; for (const c of row.cells) { if (q === pos) return c; q += c.colSpan || 1; } return null; };
        const byName = new Map();   // ad → örnek oyuncu
        for (const r of table.rows) {
            const pid = clean(cellAt(r, cols['PARTY ID'])), name = clean(cellAt(r, cols['VIP LEVEL']));
            if (/^\d{8}$/.test(pid) && name && name !== 'N/A' && !byName.has(name)) byName.set(name, pid);
        }
        const map = GM_getValue('vipNames', {}), known = new Set(Object.values(vipMap()));
        for (const [name, pid] of byName) {
            if (known.has(name)) continue;
            const det = await settle(ics(`players/${pid}/detail`));
            const id = det?.vipLevel ?? det?.vipStatus;
            if (id != null) { map[id] = name; log('VIP öğrenildi', id, '→', name); }
        }
        GM_setValue('vipNames', map);
    }
    async function vipName(id) {
        if (id == null || id === '') return null;
        if (!/^\d+$/.test(String(id))) return String(id);   // zaten ad geldiyse
        if (!vipMap()[id]) await settle(learnVip());
        return vipMap()[id] || null;   // adı bilinmeyen numara kartta gösterilmez
    }

    async function identity(pid) {
        const [prof, det] = await Promise.all([settle(ics(`players/${pid}/full-profile`)), settle(ics(`players/${pid}/detail`))]);
        raw.profileKeys = prof && Object.keys(prof).join(', ');
        raw.detailKeys = det && Object.keys(det).join(', ');
        const src = { ...(det || {}), ...(prof || {}) };
        return {
            name: [prof?.firstName, prof?.lastName].filter(Boolean).join(' ').trim() || [det?.firstName, det?.lastName].filter(Boolean).join(' ').trim(),
            kyc: String(det?.kycStatus || '').toUpperCase() || null,
            vip: await vipName(det?.vipLevel ?? det?.vipStatus),
            reg: when(pick(src, ['registrationDate', 'regDate', 'registerDate', 'createdDate', 'signupDate', 'joinDate', 'registrationDateStr', 'createdOn'])),
        };
    }
    async function online(pid) {
        const r = await ics(`players/${pid}/user-has-session`);
        raw.session = typeof r === 'object' ? JSON.stringify(r).slice(0, 120) : String(r).slice(0, 60);
        if (typeof r === 'boolean') return r;
        if (typeof r === 'string') return /true/i.test(r);
        const v = pick(r, ['hasSession', 'userHasSession', 'result', 'online', 'active', 'value']);
        return v === true || v === 'true';
    }
    async function finance(pid) {
        const list = asList(await ics(`players/${pid}/financial/deposits-and-withdrawals`));
        const out = {};
        for (const r of list) {
            const per = String(r.period || '').toUpperCase(), t = String(r.tranType || '').toLowerCase();
            out[per] = out[per] || { dep: 0, wd: 0 };
            if (t.startsWith('dep')) out[per].dep += Number(r.amount) || 0;
            else if (t.startsWith('with')) out[per].wd += Number(r.amount) || 0;
        }
        raw.periods = Object.keys(out).join(', ');
        return out;
    }
    async function lastDeposit(pid) {
        const list = asList(await ics('player-deposit/query', { partyId: pid, startDate: ymd(dayOffset(-365)), endDate: ymd(dayOffset(1)), currency: 'TRY' }));
        const d = list.filter(x => x.paymentStatus === 'COMPLETED').sort((a, b) => (when(b.processDate) || 0) - (when(a.processDate) || 0))[0];
        return d ? { amount: Number(d.amount), method: d.methodName, at: when(d.processDate) ?? when(d.processDateStr) } : null;
    }
    async function withdrawals(pid) {
        const doc = await legacy('player/PlayerWithdrawals.action', { partyId: pid, startDate: dmy(dayOffset(-365)), endDate: dmy(dayOffset(1)), execute: 'Go' });
        const table = doc.querySelector('#withdrawals');
        if (!table) return { last: null, pending: 0 };
        const rows = [...table.rows];
        const head = rows.find(r => /PAYMENT STATUS/i.test(clean(r)));
        if (!head) return { last: null, pending: 0 };
        const cols = {};
        [...head.cells].forEach((c, i) => { cols[clean(c).toUpperCase()] = i; });
        let last = null, pending = 0;
        for (const r of rows) {
            if (r === head || r.cells.length < head.cells.length) continue;
            const words = [];
            const w = doc.createTreeWalker(r.cells[cols['PAYMENT STATUS']], NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n; n = w.nextNode()) for (const x of n.nodeValue.split(/\s+/)) if (x && !x.includes('_')) words.push(x);
            const st = words.join(' ');
            const amount = num(clean(r.cells[cols['AMOUNT']]));
            if (/pending|process/i.test(st) && !/complet/i.test(st)) { pending += amount || 0; continue; }
            if (!/complet|approv|success|paid/i.test(st)) continue;
            const at = when(clean(r.cells[cols['PROCESS DATE']]));
            const method = cols['PROCESS METHOD'] != null ? clean(r.cells[cols['PROCESS METHOD']]) : '';
            if (at && (!last || at > last.at)) last = { at, amount, method };
        }
        return { last, pending };
    }
    async function balance(pid) {
        const rows = asList(await ics('player-transactions/page', {
            partyid: pid, startDate: `${ymd(dayOffset(-90))} 0:0:0.000`, endDate: `${ymd(dayOffset(1))} 23:59:0.000`, pageSize: 1, pageNum: 1,
            tranTypes: 'DEPOSIT, WITHDRAWAL, WD_CANCEL, WD_REJECT, GAME_BET, GAME_WIN, CRE_BONUS, MAN_ADJUST, PLTFRM_BON, CANC_BONUS, EXP_BONUS, BONUS_REL', currency: 'TRY',
        }));
        const r = rows.sort((a, b) => (Number(b.datetime) || 0) - (Number(a.datetime) || 0))[0];
        return r ? Number(r.balance ?? (Number(r.balanceReal || 0) + Number(r.balancePlayableBonus || 0))) : null;
    }
    async function bonuses(pid) {
        const list = asList(await ics(`player-bonus/${pid}`, { currency: 'undefined' }));
        return list.map(b => ({ name: b.planName || b.name || 'Bonus', amount: Number(b.amount) || 0, at: when(b.triggerDate) }))
            .filter(b => b.at).sort((a, b) => b.at - a.at);
    }
    async function games(pid) {
        const list = asList(await ics('player-game-play', { partyId: pid, startDate: ymd(dayOffset(-7)), endDate: ymd(dayOffset(1)), currency: 'undefined' }));
        raw.gameKeys = list[0] && Object.keys(list[0]).join(', ');
        const by = new Map();
        for (const g of list) {
            const raw0 = String(g.gameName || g.game || '—').trim();
            const name = /^(single|combo)$/i.test(raw0) ? 'Spor Bahsi' : raw0;   // spor kuponları tek satırda toplanır
            const bet = Number(pick(g, ['totalBet', 'bet', 'bets', 'betAmount', 'stake', 'totalBets', 'turnover'])) || 0;
            const win = Number(pick(g, ['totalWin', 'win', 'wins', 'winAmount', 'totalWins', 'payout'])) || 0;
            const e = by.get(name) || { name, bet: 0, win: 0, n: 0 };
            e.bet += bet; e.win += win; e.n++;
            by.set(name, e);
        }
        return [...by.values()].sort((a, b) => b.bet - a.bet || b.n - a.n).slice(0, 3);
    }
    async function sameIp(pid) {
        const doc = await legacy('player/PlayerDuplicates.action', { partyId: pid, matchingItems: '1', execute: 'Search Duplicates', checkIp: 'true' });
        const ids = new Set();
        for (const row of doc.querySelectorAll('tbody tr')) { const c = row.querySelectorAll('td'); if (c.length >= 5) { const id = clean(c[2]); if (/^\d{8}$/.test(id) && id !== String(pid)) ids.add(id); } }
        return ids.size;
    }

    async function buildCard(pid) {
        for (const k of Object.keys(raw)) delete raw[k];
        const [id, on, fin, dep, wd, bal, bon, gm, ip] = await Promise.all([
            settle(identity(pid)), settle(online(pid)), settle(finance(pid)), settle(lastDeposit(pid)),
            settle(withdrawals(pid)), settle(balance(pid)), settle(bonuses(pid)), settle(games(pid)), settle(sameIp(pid)),
        ]);
        if (!id?.name && !fin && !dep) throw new Error(`${pid} için panelden veri okunamadı (oyuncu yok ya da oturum düştü)`);

        // Kart artık resim: GT tarafı yalnızca veriyi (model) hazırlar, Slack tarafı çizer.
        const T = (x) => titleWords(String(x ?? ''));   // her kelimenin baş harfi büyük
        const flags = [];
        if (id?.kyc && id.kyc !== 'PASS') flags.push(`KYC ${id.kyc}`);
        if (ip > 0) flags.push(T(`aynı IP'de ${ip} hesap`));
        if (dep?.at && bon) { const n = bon.filter(b => b.at > dep.at).length; if (n) flags.push(T(`son yatırımdan sonra ${n} bonus aldı`)); }
        const wtd = fin?.WTD;
        if (wtd && wtd.wd > wtd.dep) flags.push(T(`bu hafta çekim yatırımı geçti (${signed(wtd.dep - wtd.wd)} TL)`));

        const sub = [id?.vip ? `VIP ${T(id.vip)}` : null,
            id?.kyc ? `KYC ${id.kyc} ${id.kyc === 'PASS' ? '✓' : '✗'}` : null,
            memberFor(id?.reg) || null,
            on === true ? 'Şu An Çevrimiçi' : on === false ? 'Çevrimdışı' : null].filter(Boolean).join('  ·  ');

        const m = (label, main, extra) => ({ label, main, extra: extra || '' });
        const money = [
            m('Bakiye', bal == null ? '–' : tl(bal)),
            m('Bekleyen Çekim', wd ? (wd.pending ? tl(wd.pending) : 'Yok') : '–'),
            m('Son Yatırım', dep ? tl(dep.amount) : 'Yok', [dep?.method && T(shortMethod(dep.method)), dep?.at && T(ago(Date.now() - dep.at))].filter(Boolean).join(' · ')),
            m('Son Başarılı Çekim', wd?.last ? tl(wd.last.amount) : (wd ? 'Yok' : '–'), [wd?.last?.method && T(shortMethod(wd.last.method)), wd?.last?.at && T(ago(Date.now() - wd.last.at))].filter(Boolean).join(' · ')),
        ];
        const finRows = fin ? [['Bugün', 'TODAY'], ['Bu Hafta', 'WTD'], ['Bu Ay', 'MTD'], ['Bu Yıl', 'YTD'], ['Tüm Zaman', 'LTD']]
            .map(([label, key]) => { const r = fin[key] || { dep: 0, wd: 0 }; return [label, int(r.dep), int(r.wd), r.dep - r.wd]; }) : null;
        const hasMoney = !!gm?.some(g => g.bet || g.win);
        const model = {
            pid: String(pid), name: T(id?.name || 'İsim Alınamadı'), sub, online: on === true, flags, money,
            fin: finRows && finRows.map(([l, d, w, n]) => ({ label: l, dep: d, wd: w, net: signed(n), neg: n < 0, pos: n > 0 })),
            games: (gm || []).map(g => ({ name: T(g.name), detail: hasMoney ? `Bahis ${int(g.bet)} · Net ${signed(g.win - g.bet)}` : '', neg: g.win - g.bet < 0 })),
            bonuses: (bon || []).slice(0, 3).map(b => { const d = new Date(b.at + 3 * 3600e3); return { text: `${p2(d.getUTCDate())} ${AYLAR[d.getUTCMonth()]} · ${T(b.name)}`, amount: b.amount ? `${int(b.amount)} TL` : '' }; }),
        };

        GM_setValue('lastRaw', { pid, at: Date.now(), ...raw });
        return { text: `👤 ${model.name} · ${pid}`, card: model };
    }

    /* ── istek kuyruğu ── */
    let busy = false;
    async function work() {
        if (busy) return;
        const keys = GM_listValues().filter(k => k.startsWith('req:'));
        if (!keys.length || !token()) return;
        const lead = GM_getValue('gtLeader', null);
        if (lead && lead.owner !== ME && Date.now() - lead.at < 60000) return;
        GM_setValue('gtLeader', { owner: ME, at: Date.now() });
        busy = true;
        try {
            for (const k of keys) {
                const req = GM_getValue(k, null);
                GM_deleteValue(k);
                if (!req || Date.now() - req.at > 30 * 60000) continue;
                try {
                    const card = await buildCard(req.pid);
                    tr(`kart verisi hazır ${req.pid} (${card.card ? 'resim verisi' : 'eski biçim'})`);
                    GM_setValue('q:' + k.slice(4), { ...card, ver: VER, thread: req.thread, update: req.update || null, at: Date.now() });
                } catch (e) {
                    warn('kart hazırlanamadı', req.pid, e.message);
                    if (!req.update) GM_setValue('q:' + k.slice(4), { text: `⚠️ ${req.pid} için kart hazırlanamadı: ${e.message}`, thread: req.thread, at: Date.now() });
                }
                GM_setValue('ping', Date.now());
            }
        } finally { busy = false; }
    }
    GM_addValueChangeListener('reqPing', () => work());
    setInterval(work, 5000);
    GM_registerMenuCommand('Teşhis: son kartın ham alanları', () => {
        const r = GM_getValue('lastRaw', null);
        alert(r ? Object.entries(r).map(([k, v]) => `${k}: ${k === 'at' ? new Date(v).toLocaleTimeString('tr-TR') : v}`).join('\n\n') : 'Henüz kart hazırlanmadı.');
    });
}

/* ════════════════════════════════════════════════════════════
   SLACK TARAFI — kanalı izle, kartı gönder, 🔄 ile yenile
   ════════════════════════════════════════════════════════════ */
function slackSide() {
    let token = null, me = null, busy = false, again = false;
    const ME = Math.random().toString(36).slice(2);
    const status = (msg) => GM_setValue('slackStatus', { msg, at: Date.now() });

    function collectTokens() {
        const out = [];
        try {
            const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || 'null');
            if (cfg?.teams) {
                const last = cfg.lastActiveTeamId;
                const ids = Object.keys(cfg.teams).sort((a, b) => (a === last ? -1 : b === last ? 1 : 0));
                for (const id of ids) { const t = cfg.teams[id]?.token; if (t && !out.includes(t)) out.push(t); }
            }
        } catch { /* yok say */ }
        return out;
    }
    async function call(method, params, tok = token) {
        const body = new URLSearchParams({ token: tok, ...params }).toString();
        const init = { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body };
        const url = `${location.origin}/api/${method}`;
        let res;
        try { res = await W.fetch(url, typeof cloneInto === 'function' ? cloneInto(init, W) : init); }
        catch { res = await fetch(url, init); }
        if (res.status === 429) return { ok: false, error: 'ratelimited', retry: (+res.headers.get('retry-after') || 5) * 1000 };
        return JSON.parse(await res.text());
    }
    async function resolveToken() {
        for (const t of collectTokens()) {
            try {
                const r = await call('conversations.info', { channel: CONFIG.CHANNEL }, t);
                if (r.ok) { token = t; me = (await call('auth.test', {}, t)).user_id; return; }
            } catch { /* sonraki */ }
        }
        throw new Error(`hiçbir oturum ${CONFIG.CHANNEL} kanalını göremiyor`);
    }
    async function api(method, params, okErrors = []) {
        if (!token) await resolveToken();
        for (let i = 0; i < 4; i++) {
            const r = await call(method, params);
            if (r.ok || okErrors.includes(r.error)) return r;
            if (r.error === 'ratelimited') { await sleep(r.retry); continue; }
            if (/invalid_auth|not_authed|token_revoked/.test(r.error)) { token = null; await resolveToken(); continue; }
            throw new Error(`${method}: ${r.error || 'bilinmeyen hata'}`);
        }
        throw new Error(`${method}: 4 denemede olmadı`);
    }

    const everyone = () => GM_getValue('everyone', true);   // varsayılan: kanaldaki herkes
    const request = (key, pid, thread, update) => {
        if (!update) {   // aynı mesajdaki aynı ID'ye bir kez kart
            const done = GM_getValue('done', {}), now = Date.now();
            if (done[key]) return;
            for (const k in done) if (now - done[k] > 24 * 3600e3) delete done[k];
            done[key] = now; GM_setValue('done', done);
        }
        GM_setValue('req:' + key, { pid, thread, update, at: Date.now() }); GM_setValue('reqPing', Date.now());
    };

    /** Yeni mesajlarda ID ara; kartlarda 🔄 tepkisi ara. */
    let scanning = false;
    const isLeader = () => { const l = GM_getValue('slackLeader', null); return !l || l.owner === ME || Date.now() - l.at >= 60000; };
    async function scan() {
        if (scanning || GM_getValue('enabled', true) === false) return;
        const lead = GM_getValue('slackLeader', null);
        if (lead && lead.owner !== ME && Date.now() - lead.at < 60000) return;
        GM_setValue('slackLeader', { owner: ME, at: Date.now() });
        scanning = true;
        try {
            if (!token) await resolveToken();
            let last = GM_getValue('lastTs', null);
            if (!last) { last = String(Date.now() / 1000); GM_setValue('lastTs', last); return; }   // ilk kurulum: geçmişe cevap yok
            const r = await api('conversations.history', { channel: CONFIG.CHANNEL, oldest: last, limit: '50' });
            const msgs = (r.messages || []).sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
            for (const m of msgs) {
                last = m.ts;
                if (!m.client_msg_id || m.subtype || m.bot_id) continue;           // yalnızca insanların yazdığı mesajlar
                if (!everyone() && m.user !== me) continue;
                const ids = [...new Set((m.text || '').match(CONFIG.ID_RE) || [])].slice(0, CONFIG.MAX_IDS);
                ids.forEach(pid => request(`${m.ts}-${pid}`, pid, m.ts, null));
                if (ids.length) log('istek:', ids.join(', '), 'mesaj', m.ts);
            }
            GM_setValue('lastTs', last);
            await checkRefresh();
            status('izleniyor');
        } catch (e) { warn('tarama hatası:', e.message); status(`HATA: ${e.message}`); }
        finally { scanning = false; }
    }

    /** Son 12 saatteki kartlarda 🔄 sayısı arttıysa kartı yenile (dakikada bir). */
    let lastRefreshCheck = 0;
    async function checkRefresh() {
        if (Date.now() - lastRefreshCheck < 60000) return;
        lastRefreshCheck = Date.now();
        const cards = GM_getValue('cards', {});
        for (const [ts, c] of Object.entries(cards)) {
            if (Date.now() - c.at > 12 * 3600e3) { delete cards[ts]; continue; }
            const r = await api('reactions.get', { channel: CONFIG.CHANNEL, timestamp: ts, full: 'true' }, ['message_not_found']);
            const n = (r.message?.reactions || []).find(x => x.name === CONFIG.REFRESH_REACTION)?.count || 0;
            if (n > (c.seen || 0)) { c.seen = n; request(`upd-${ts}-${Date.now()}`, c.pid, c.thread, ts); log('yenileme istendi', c.pid); }
        }
        GM_setValue('cards', cards);
    }

    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    /* ── kart çizimi (onaylanan B tasarımı) ── */
    const FONT = '"Slack-Lato","Lato","Segoe UI",Roboto,Arial,sans-serif';
    const C = {
        head: '#525a66', ink: '#343a43',
        warn: ['#fdecef', '#e01e5a', '#8a1538'],
        money: ['#eef4fb', '#7fa7d9', '#dde7f3', '#5b6b80', '#26364d', '#6b7a8c'],
        rest: ['#f2fbf6', '#2eb67d', '#dcefe4', '#2f5f48', '#3d4a44'],
        neg: '#c0292b', pos: '#147a4b',
    };
    const CW = 460, PAD = 14, BAR = 5;
    function drawCard(g, k) {
        g.textBaseline = 'alphabetic';
        const font = (w, px) => `${w} ${px}px ${FONT}`;
        const txt = (t, x, y, f, color, align = 'left') => { g.font = f; g.fillStyle = color; g.textAlign = align; g.fillText(t, x, y); return g.measureText(t).width; };
        const fit = (t, f, maxW) => { g.font = f; t = String(t); if (g.measureText(t).width <= maxW) return t; while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };
        const wrap = (t, f, maxW) => {
            g.font = f; const out = []; let line = '';
            for (const w of String(t).split(' ')) { const tryL = line ? `${line} ${w}` : w; if (line && g.measureText(tryL).width > maxW) { out.push(line); line = w; } else line = tryL; }
            if (line) out.push(line); return out;
        };
        const band = (y, h, [bg, bar]) => { g.fillStyle = bg; g.fillRect(0, y, CW, h); g.fillStyle = bar; g.fillRect(0, y, BAR, h); };
        const X = BAR + PAD - 2, IW = CW - X - PAD;
        let y = 0;
        // başlık
        const subL = wrap(k.sub || '', font(500, 12), CW - 2 * PAD);
        const hH = 14 + 20 + subL.length * 16 + 10;
        g.fillStyle = C.head; g.fillRect(0, 0, CW, hH);
        txt(fit(`${k.name} · ${k.pid}`, font(800, 17), CW - 2 * PAD), PAD, 14 + 16, font(800, 17), '#fff');
        subL.forEach((l, i) => txt(l, PAD, 14 + 20 + 13 + i * 16, font(500, 12), 'rgba(255,255,255,0.86)'));
        if (k.online) { g.fillStyle = '#2eb67d'; g.beginPath(); g.arc(CW - PAD - 5, 14 + 10, 5, 0, Math.PI * 2); g.fill(); }
        y = hH;
        // dikkat
        if (k.flags?.length) {
            const L = wrap(`⚠ Dikkat: ${k.flags.join(' · ')}`, font(700, 12), IW);
            const h = 16 + L.length * 16;
            band(y, h, C.warn);
            L.forEach((l, i) => txt(l, X, y + 8 + 12 + i * 16, font(700, 12), C.warn[2]));
            y += h;
        }
        // para: 2×2
        const cellH = (c) => 10 + 13 + 21 + (c.extra ? 15 : 0) + 8;
        const rowsH = [Math.max(cellH(k.money[0]), cellH(k.money[1])), Math.max(cellH(k.money[2]), cellH(k.money[3]))];
        band(y, rowsH[0] + rowsH[1], C.money);
        const half = (CW - BAR) / 2;
        k.money.forEach((c, i) => {
            const cx = BAR + (i % 2) * half, cy = y + (i < 2 ? 0 : rowsH[0]);
            txt(c.label.toLocaleUpperCase('tr-TR'), cx + PAD - 2, cy + 10 + 10, font(700, 10), C.money[3]);
            txt(fit(c.main, font(800, 16), half - PAD * 2), cx + PAD - 2, cy + 10 + 13 + 17, font(800, 16), C.money[4]);
            if (c.extra) txt(fit(c.extra, font(500, 11), half - PAD * 2), cx + PAD - 2, cy + 10 + 13 + 21 + 12, font(500, 11), C.money[5]);
        });
        g.fillStyle = C.money[2];
        g.fillRect(BAR + half, y, 1, rowsH[0] + rowsH[1]);
        g.fillRect(BAR, y + rowsH[0], CW - BAR, 1);
        y += rowsH[0] + rowsH[1];
        g.fillStyle = C.money[2]; g.fillRect(BAR, y - 1, CW - BAR, 1);
        // yeşil bölüm: finans, oyunlar, bonuslar
        const sec = [];
        if (k.fin) sec.push({ type: 'fin' });
        if (k.games?.length) sec.push({ type: 'games' });
        if (k.bonuses?.length) sec.push({ type: 'bon' });
        if (!sec.length) return y;
        const title = (t, ty) => txt(t.toLocaleUpperCase('tr-TR'), X, ty, font(800, 10.5), C.rest[3]);
        const cols = [X + IW * 0.50, X + IW * 0.75, X + IW];   // sağa yaslı sütun sonları
        const parts = [];
        let h = 8;
        for (const s of sec) {
            if (s.type === 'fin') { parts.push({ s, y: h }); h += 16 + 18 + k.fin.length * 19 + 4; }
            if (s.type === 'games') { parts.push({ s, y: h }); h += 18 + k.games.length * 17 + 6; }
            if (s.type === 'bon') {
                const lines = k.bonuses.map(b => wrap(b.text, font(500, 11.5), IW - 74));
                parts.push({ s, y: h, lines }); h += 18 + lines.reduce((a, l) => a + l.length * 16 + 3, 0) + 4;
            }
        }
        h += 6;
        band(y, h, C.rest);
        for (const p of parts) {
            let py = y + p.y;
            if (p.s.type === 'fin') {
                title('Finans (TL)', py + 12);
                py += 16;
                ['Yatırım', 'Çekim', 'Net'].forEach((t, i) => txt(t.toLocaleUpperCase('tr-TR'), cols[i], py + 12, font(700, 9.5), C.rest[3], 'right'));
                py += 18;
                for (const r of k.fin) {
                    g.fillStyle = C.rest[2]; g.fillRect(X, py, IW, 1);
                    txt(r.label, X, py + 14, font(600, 12), C.rest[4]);
                    txt(r.dep, cols[0], py + 14, font(500, 12), C.rest[4], 'right');
                    txt(r.wd, cols[1], py + 14, font(500, 12), C.rest[4], 'right');
                    txt(r.net, cols[2], py + 14, font(800, 12), r.neg ? C.neg : r.pos ? C.pos : C.rest[4], 'right');
                    py += 19;
                }
            } else if (p.s.type === 'games') {
                title('Son 7 Gün Oyunlar', py + 12);
                py += 18;
                for (const gm of k.games) {
                    txt(fit(gm.name, font(600, 12), gm.detail ? IW * 0.55 : IW), X, py + 12, font(600, 12), C.rest[4]);
                    if (gm.detail) txt(gm.detail, X + IW, py + 12, font(500, 11.5), gm.neg ? C.neg : C.rest[4], 'right');
                    py += 17;
                }
            } else {
                title('Son Bonuslar', py + 12);
                py += 18;
                k.bonuses.forEach((b, i) => {
                    const L = p.lines[i];
                    L.forEach((l, j) => txt(l, X, py + 12 + j * 16, font(500, 11.5), C.rest[4]));
                    if (b.amount) txt(b.amount, X + IW, py + 12 + (L.length - 1) * 16, font(800, 12), C.rest[4], 'right');
                    py += L.length * 16 + 3;
                });
            }
        }
        return y + h;
    }
    /** Kartı 2x çözünürlükte PNG olarak çiz (önce boyu ölç, sonra çiz). */
    function renderCard(k) {
        const probe = document.createElement('canvas').getContext('2d');
        const H = Math.ceil(drawCard(probe, k));
        const S = 2, cv = document.createElement('canvas');
        cv.width = CW * S; cv.height = H * S;
        const g = cv.getContext('2d');
        g.scale(S, S);
        g.fillStyle = '#fff'; g.fillRect(0, 0, CW, H);
        drawCard(g, k);
        return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('kart resmi üretilemedi'))), 'image/png'));
    }
    function putBytes(url, blob) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            method: 'POST', url, data: blob, timeout: 60000, headers: { 'Content-Type': blob.type },
            onload: (r) => (r.status >= 200 && r.status < 300 ? resolve() : reject(new Error(`yükleme HTTP ${r.status}`))),
            onerror: () => reject(new Error('yükleme ağ hatası')), ontimeout: () => reject(new Error('yükleme zaman aşımı')),
        }));
    }
    /** Resmi thread'e dosya olarak paylaş; kart mesajının zamanını (🔄 ve silme için) dosya bilgisinden bul. */
    async function shareImage(blob, name, thread, comment) {
        tr(`resim çizildi ${Math.round(blob.size / 1024)} KB`);
        const up = await api('files.getUploadURLExternal', { filename: name, length: String(blob.size) });
        tr(`yükleme adresi alındı ${up.file_id}`);
        await putBytes(up.upload_url, blob);
        tr('resim yüklendi');
        const done = await api('files.completeUploadExternal', { files: JSON.stringify([{ id: up.file_id, title: name }]), channel_id: CONFIG.CHANNEL, thread_ts: thread, initial_comment: comment });
        tr(`thread'e paylaşıldı (${done.files?.length || 0} dosya)`);
        for (let i = 0; i < 5; i++) {
            await sleep(1200);
            const r = await api('files.info', { file: up.file_id }, ['file_not_found']).catch(() => null);
            const sh = r?.file?.shares || {};
            const ts = (sh.private?.[CONFIG.CHANNEL] || sh.public?.[CONFIG.CHANNEL] || [])[0]?.ts;
            if (ts) { tr(`kart mesajı ${ts}`); return { file: up.file_id, ts }; }
        }
        return { file: up.file_id, ts: null };
    }

    async function flush() {
        if (busy) { again = true; return; }
        if (!isLeader()) return;   // birden çok Slack sekmesi açıksa yalnızca lider gönderir (çift cevap olmasın)
        busy = true; again = false;
        try {
            const keys = GM_listValues().filter(k => k.startsWith('q:'));
            for (const k of keys) {
                const v = GM_getValue(k, null);
                GM_deleteValue(k);
                if (!v) continue;
                tr(`kuyruktan alındı: sürüm ${v.ver || '?'} · ${v.card ? 'resim verisi var' : v.blocks ? 'ESKİ biçim (blocks)' : 'sadece yazı'}`);
                if (v.ver !== VER) {   // panel sekmesi eski sürümle çalışıyor (güncellemeden sonra yenilenmemiş)
                    GM_setValue('verWarn', `Panel sekmesi ${v.ver || 'eski'} sürümde, Slack ${VER}. GT panel sekmesini yenileyin (F5).`);
                    warn(GM_getValue('verWarn'));
                } else GM_deleteValue('verWarn');
                if (v.card) {
                    // Kart resmi thread'e doğrudan dosya olarak paylaşılır (Slack cevaplarda image bloğunu göstermedi)
                    const png = await renderCard(v.card);
                    const sh = await shareImage(png, `oyuncu-${v.card.pid}.png`, v.thread, `👤 *${esc(v.card.name)}* · \`${v.card.pid}\``);
                    const cards = GM_getValue('cards', {});
                    if (v.update && cards[v.update]) {   // 🔄 yenileme: yeni kart gitti, eskisi silinir
                        const old = cards[v.update];
                        delete cards[v.update];
                        if (old.file) await api('files.delete', { file: old.file }, ['file_not_found', 'file_deleted', 'cant_delete_file']).catch(e => warn('eski kart silinemedi:', e.message));
                    }
                    if (sh.ts) cards[sh.ts] = { pid: v.card.pid, thread: v.thread, file: sh.file, at: Date.now(), seen: 0 };
                    GM_setValue('cards', cards);
                    GM_setValue('imgMode', sh.ts ? 'thread dosyası' : 'thread dosyası (mesaj zamanı alınamadı, 🔄 çalışmaz)');
                    status(`kart ${v.update ? 'yenilendi' : 'gönderildi'} ${v.text}`);
                } else if (!v.update) {
                    await api('chat.postMessage', { channel: CONFIG.CHANNEL, text: v.text, thread_ts: v.thread, unfurl_links: 'false' });
                    status(`mesaj gönderildi ${v.text}`);
                }
                await sleep(800);
            }
        } catch (e) { warn('gönderilemedi:', e.message); status(`HATA: ${e.message}`); tr(`HATA: ${e.message}`); }
        finally { busy = false; if (again) setTimeout(flush, 200); }
    }

    if (W.__OK_TEST__) W.__OK_TEST__.renderCard = renderCard;
    GM_addValueChangeListener('ping', () => flush());
    setInterval(flush, 10000);
    setInterval(scan, CONFIG.POLL_SEC * 1000);
    setTimeout(scan, 3000);

    GM_registerMenuCommand('Kimin mesajına cevap verilsin: sadece ben / herkes', () => {
        const v = !everyone();
        GM_setValue('everyone', v);
        alert(v ? 'Artık kanaldaki HERKESİN yazdığı Party ID\'lere kart bırakılacak.' : 'Artık sadece SENİN yazdığın Party ID\'lere kart bırakılacak.');
    });
    GM_registerMenuCommand('Oyuncu kartı aç / kapat', () => {
        const on = GM_getValue('enabled', true) === false;
        GM_setValue('enabled', on);
        alert(`Oyuncu kartı ${on ? 'AÇIK' : 'KAPALI'}.`);
    });
    GM_registerMenuCommand('Durum', () => {
        const s = GM_getValue('slackStatus', null);
        alert(`Oyuncu kartı: ${GM_getValue('enabled', true) === false ? 'KAPALI' : 'AÇIK'} · ${everyone() ? 'herkes' : 'sadece ben'}\nSon: ${s ? `${s.msg} (${new Date(s.at).toLocaleTimeString('tr-TR')})` : '—'}\nResim: ${GM_getValue('imgMode', '—')}${GM_getValue('verWarn', '') ? `\n⚠️ ${GM_getValue('verWarn')}` : ''}\nSürüm: ${VER}\n\nSon adımlar:\n${GM_getValue('trace', []).join('\n') || '—'}\nBekleyen istek: ${GM_listValues().filter(k => k.startsWith('req:')).length}`);
    });
}

})();
