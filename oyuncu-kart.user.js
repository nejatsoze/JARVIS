// ==UserScript==
// @name         Oyuncu Kartı — Party ID yazılınca Slack thread'ine
// @namespace    palentis.oyuncu-kart
// @version      1.3.1
// @description  C0C8HMG3KUH kanalında bir mesajda Party ID (8 hane) geçince ya da mesaj "info ad@mail.com" ise (mail ile arama) o mesajın thread'ine oyuncu kartı bırakır: isim, VIP, KYC, üyelik süresi, çevrimiçi durumu, dikkat satırı (KYC, aynı IP, son yatırımdan sonra bonus, haftalık net eksi), bakiye, bekleyen çekim, son yatırım, son başarılı çekim, finans tablosu, son 7 gün oyunlar, son bonuslar, son giriş cihazı. Kart resim olarak çizilir (koyu başlık, kırmızı dikkat bandı, mavi 4 sütun para şeridi, yeşil finans). Her kelimenin baş harfi büyük. Panel linki yok. 🔄 tepkisiyle kart yenilenir. Veriyi açık GT sekmesi okur, Slack sekmesi gönderir.
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
    CHANNEL: 'C0C8HMG3KUH',
    POLL_SEC: 15,
    REFRESH_REACTION: 'arrows_counterclockwise',
    ID_RE: /(?<![\d])1\d{7}(?![\d])/g,
    MAX_IDS: 3,
    EMAIL_RE: /^\s*info\s+([^\s@<>|]+@[^\s@<>|]+\.[a-z]{2,})/i,   // "info ad@alan.com" → mail ile oyuncu kartı
};

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Oyuncu Kartı]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const P2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
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

    /* VIP: oyuncu detayında sadece seviye numarası var (vipLevel 267). Adlar panelin kendi listesinden
       (/ics/players/vip-status: [{id:267,name:'Bronze'}, …]) okunur, günde bir tazelenir. */
    const VIP_SEED = { 267: 'Bronze', 268: 'Silver', 269: 'Gold', 270: 'Platinum', 271: 'Diamond' };   // liste okunamazsa yedek
    async function vipName(id) {
        if (id == null || id === '') return null;
        if (!/^\d+$/.test(String(id))) return String(id);   // zaten ad geldiyse
        let c = GM_getValue('vipList', null);
        if (!c || Date.now() - c.at > 864e5 || !c.map[id]) {
            const list = asList(await settle(ics('players/vip-status')));
            if (list.length) { c = { at: Date.now(), map: Object.fromEntries(list.filter(v => v.id != null).map(v => [v.id, v.name || v.code])) }; GM_setValue('vipList', c); }
        }
        return c?.map?.[id] || VIP_SEED[id] || null;
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
    /** Mail adresinden Party ID (panelin oyuncu aramasıyla aynı istek: alan 2 = e-posta, operatör 2 = eşittir). */
    async function pidByEmail(email) {
        const r = await ics('players/search-page', { fieldId: '2', operatorId: '2', value: email, pageSize: '25', pageNum: '1' });
        const list = asList(r);
        raw.searchKeys = list[0] && Object.keys(list[0]).join(', ');
        const idOf = (x) => String(pick(x, ['partyId', 'partyID', 'party_id', 'playerId', 'userId', 'id']) ?? '');
        const hit = list.find(x => String(pick(x, ['email', 'emailAddress', 'mail']) || '').toLowerCase() === email.toLowerCase()) || list[0];
        const pid = hit && idOf(hit);
        if (!pid || !/^\d{6,}$/.test(pid)) throw new Error('bu mail adresiyle oyuncu bulunamadı');
        if (list.length > 1) warn(`${email}: ${list.length} sonuç, ilk eşleşen alındı (${pid})`);
        return pid;
    }
    /** Son başarılı girişin tarayıcı + işletim sistemi (GT Player'daki giriş kayıtlarıyla aynı kaynak). */
    async function lastDevice(pid) {
        const list = asList(await ics(`players/${pid}/login-logs/more`, { startDate: ymd(dayOffset(-29)), endDate: ymd(dayOffset(1)) }));
        raw.loginKeys = list[0] && Object.keys(list[0]).join(', ');
        const f = (o, names) => { const k = Object.keys(o || {}).find(x => names.includes(x.toLowerCase())); return k && o[k] != null ? String(o[k]) : ''; };
        const rows = list.map(r => ({
            t: Number(f(r, ['logintime', 'logtime', 'time', 'createdat', 'date'])) || 0,
            type: f(r, ['type', 'logtype', 'actiontype', 'action', 'logintype', 'eventtype']).toUpperCase(),
            bad: /fail|error|denied|invalid|block|false/i.test(f(r, ['status', 'success', 'successful', 'loginstatus', 'result'])),
            ua: f(r, ['useragent', 'ua', 'agent']), os: f(r, ['deviceos', 'os', 'osname', 'operatingsystem', 'platform']), br: f(r, ['browser', 'browsername', 'browsertype']),
        })).filter(r => !r.bad && (!r.type || r.type.startsWith('LOGIN'))).sort((a, b) => b.t - a.t);
        const r = rows[0];
        if (!r) return null;
        const s = `${r.br} ${r.ua}`.toLowerCase(), o = `${r.os} ${r.ua}`.toLowerCase();
        const br = /edg/.test(s) ? 'Edge' : /samsung/.test(s) ? 'Samsung' : /opera|opr\//.test(s) ? 'Opera' : /firefox|fxios/.test(s) ? 'Firefox'
            : /chrome|crios|chromium/.test(s) ? 'Chrome' : /safari/.test(s) ? 'Safari' : (r.br || '').slice(0, 12);
        const os = /iphone|ipad|ipod|ios/.test(o) ? 'iOS' : /android/.test(o) ? 'Android' : /win/.test(o) ? 'Windows' : /mac|os x/.test(o) ? 'macOS' : /linux|x11/.test(o) ? 'Linux' : '';
        return [br, os].filter(Boolean).join(' · ') || null;
    }
    async function sameIp(pid) {
        const doc = await legacy('player/PlayerDuplicates.action', { partyId: pid, matchingItems: '1', execute: 'Search Duplicates', checkIp: 'true' });
        const ids = new Set();
        for (const row of doc.querySelectorAll('tbody tr')) { const c = row.querySelectorAll('td'); if (c.length >= 5) { const id = clean(c[2]); if (/^\d{8}$/.test(id) && id !== String(pid)) ids.add(id); } }
        return ids.size;
    }

    async function buildCard(pid) {
        for (const k of Object.keys(raw)) delete raw[k];
        const [id, on, fin, dep, wd, bal, bon, gm, ip, dev] = await Promise.all([
            settle(identity(pid)), settle(online(pid)), settle(finance(pid)), settle(lastDeposit(pid)),
            settle(withdrawals(pid)), settle(balance(pid)), settle(bonuses(pid)), settle(games(pid)), settle(sameIp(pid)), settle(lastDevice(pid)),
        ]);
        if (!id?.name && !fin && !dep) throw new Error(`${pid} için panelden veri okunamadı (oyuncu yok ya da oturum düştü)`);

        // Kart artık resim: GT tarafı yalnızca veriyi (model) hazırlar, Slack tarafı çizer.
        const T = (x) => titleWords(String(x ?? ''));   // her kelimenin baş harfi büyük
        const flags = [];
        if (id?.kyc && id.kyc !== 'PASS') flags.push(`KYC ${id.kyc}`);
        if (ip >= 2) flags.push(T(`aynı IP'de ${ip} hesap`));   // tek eşleşme dikkat sayılmaz
        if (dep?.at && bon) { const n = bon.filter(b => b.at > dep.at).length; if (n) flags.push(T(`son yatırımdan sonra ${n} bonus aldı`)); }
        const wtd = fin?.WTD;
        if (wtd && wtd.wd > wtd.dep) flags.push(T(`bu hafta çekim yatırımı geçti (${signed(wtd.dep - wtd.wd)} TL)`));

        const regDays = Number.isFinite(id?.reg) ? Math.floor((Date.now() - id.reg) / 864e5) : null;
        const member = regDays == null ? '' : regDays < 1 ? 'Bugün' : regDays < 31 ? `${regDays} Gün` : regDays < 365 ? `${Math.floor(regDays / 30)} Ay` : `${Math.floor(regDays / 365)} Yıl`;
        const meta = [
            id?.vip ? { k: 'VIP', v: T(id.vip) } : null,
            id?.kyc ? { k: 'KYC', v: id.kyc === 'PASS' ? 'PASS ✓' : `${id.kyc} ✗`, tone: id.kyc === 'PASS' ? 'ok' : 'bad' } : null,
            member ? { k: 'Üyelik', v: member } : null,
            dev ? { k: 'Son Giriş', v: dev } : null,
        ].filter(Boolean);

        const m = (label, main, extra = []) => ({ label, main, extra: extra.filter(Boolean) });
        const money = [
            m('Bakiye', bal == null ? '–' : tl(bal)),
            m('Bekleyen', wd ? (wd.pending ? tl(wd.pending) : 'Yok') : '–'),
            m('Son Yatırım', dep ? tl(dep.amount) : 'Yok', [dep?.method && T(shortMethod(dep.method)), dep?.at && T(ago(Date.now() - dep.at))]),
            m('Son Çekim', wd?.last ? tl(wd.last.amount) : (wd ? 'Yok' : '–'), [wd?.last?.method && T(shortMethod(wd.last.method)), wd?.last?.at && T(ago(Date.now() - wd.last.at))]),
        ];
        const finRows = fin ? [['Bugün', 'TODAY'], ['Bu Hafta', 'WTD'], ['Bu Ay', 'MTD'], ['Bu Yıl', 'YTD'], ['Tüm Zaman', 'LTD']]
            .map(([label, key]) => { const r = fin[key] || { dep: 0, wd: 0 }; return [label, int(r.dep), int(r.wd), r.dep - r.wd]; }) : null;
        const hasMoney = !!gm?.some(g => g.bet || g.win);
        const model = {
            pid: String(pid), name: T(id?.name || 'İsim Alınamadı'), meta, online: on === true ? true : on === false ? false : null, flags, money,
            fin: finRows && finRows.map(([l, d, w, n]) => ({ label: l, dep: d, wd: w, net: signed(n), neg: n < 0, pos: n > 0 })),
            games: (gm || []).map(g => ({ name: T(g.name), detail: hasMoney ? `Bahis ${int(g.bet)} · Net ${signed(g.win - g.bet)}` : '', neg: g.win - g.bet < 0 })),
            bonuses: (bon || []).slice(0, 3).map(b => { const d = new Date(b.at + 3 * 3600e3); return { date: `${p2(d.getUTCDate())} ${AYLAR[d.getUTCMonth()]}`, name: T(b.name), amount: b.amount ? `${int(b.amount)} TL` : '' }; }),
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
                    if (!req.pid && req.email) {
                        req.pid = await pidByEmail(req.email);
                        tr(`mail ${req.email} → ${req.pid}`);
                    }
                    const card = await buildCard(req.pid);
                    tr(`kart verisi hazır ${req.pid} (${card.card ? 'resim verisi' : 'eski biçim'})`);
                    GM_setValue('q:' + k.slice(4), { ...card, ver: VER, thread: req.thread, update: req.update || null, at: Date.now() });
                } catch (e) {
                    warn('kart hazırlanamadı', req.pid || req.email, e.message);
                    if (!req.update) GM_setValue('q:' + k.slice(4), { text: `⚠️ ${req.pid || req.email} için kart hazırlanamadı: ${e.message}`, thread: req.thread, at: Date.now() });
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
    const request = (key, pid, thread, update, email) => {
        if (!update) {   // aynı mesajdaki aynı ID'ye bir kez kart
            const done = GM_getValue('done', {}), now = Date.now();
            if (done[key]) return;
            for (const k in done) if (now - done[k] > 24 * 3600e3) delete done[k];
            done[key] = now; GM_setValue('done', done);
        }
        GM_setValue('req:' + key, { pid, email: email || null, thread, update, at: Date.now() }); GM_setValue('reqPing', Date.now());
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
                const text = (m.text || '').replace(/<mailto:([^|>]+)\|[^>]*>/g, '$1');   // Slack mailleri <mailto:x|x> diye saklar
                const em = text.match(CONFIG.EMAIL_RE)?.[1]?.toLowerCase();
                if (em) { request(`${m.ts}-${em}`, null, m.ts, null, em); log('istek (mail):', em, 'mesaj', m.ts); continue; }
                const ids = [...new Set(text.replace(/\S+@\S+/g, ' ').match(CONFIG.ID_RE) || [])].slice(0, CONFIG.MAX_IDS);   // mail içindeki rakamlar ID sayılmaz
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
            if (c.ch && c.ch !== CONFIG.CHANNEL) { delete cards[ts]; continue; }   // kanal değiştiyse eski kanalın kartları izlenmez
            if (Date.now() - c.at > 12 * 3600e3) { delete cards[ts]; continue; }
            const r = await api('reactions.get', { channel: CONFIG.CHANNEL, timestamp: ts, full: 'true' }, ['message_not_found']);
            const n = (r.message?.reactions || []).find(x => x.name === CONFIG.REFRESH_REACTION)?.count || 0;
            if (n > (c.seen || 0)) { c.seen = n; request(`upd-${ts}-${Date.now()}`, c.pid, c.thread, ts); log('yenileme istendi', c.pid); }
        }
        GM_setValue('cards', cards);
    }

    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    /* ── kart çizimi (onaylanan B tasarımı: koyu başlık, yatay şeritler) ── */
    const FONT = '"Slack-Lato","Lato","Segoe UI",Roboto,Arial,sans-serif';
    const C = {
        head: ['#3f4651', '#525a66'], ok: '#5fd99a', bad: '#ff7a90', online: '#2eb67d', offline: '#a0a7b1',
        warn: '#e01e5a', kpi: '#eef4fb', kpiLine: '#dde7f3', kpiLbl: '#5b6b80', kpiVal: '#1f2d40', kpiSub: '#7b8796',
        green: '#2f7a55', zebra: '#f4fbf7', th: '#8a94a1', ink: '#343a43', ink2: '#4a5361', neg: '#c0292b', pos: '#16794a',
        line: '#edf0f3', foot: '#f8f9fb', footInk: '#9aa3ae',
    };
    const CW = 520, PX = 20;
    /** VIP seviye sembolü (vektör, emoji fontuna bağlı değil): madalya / platin altıgen / elmas. */
    function vipIcon(g, cx, cy, name) {
        const n = String(name).toLowerCase();
        const tone = /bronz/.test(n) ? ['#e0a36b', '#a8642e'] : /silver|gümüş/.test(n) ? ['#e9edf2', '#a3adb9'] : /gold|altın/.test(n) ? ['#ffd866', '#d19a12']
            : /platin/.test(n) ? ['#d9f1fb', '#7fb8cf'] : /diamond|elmas/.test(n) ? ['#9ee7ff', '#3aa7d6'] : ['#d5d9df', '#8a94a1'];
        g.save();
        const grad = g.createLinearGradient(cx - 7, cy - 7, cx + 7, cy + 7); grad.addColorStop(0, tone[0]); grad.addColorStop(1, tone[1]);
        g.fillStyle = grad; g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
        g.beginPath();
        if (/diamond|elmas/.test(n)) {   // elmas: üst taç + sivri alt
            g.moveTo(cx - 7, cy - 2.5); g.lineTo(cx - 3.5, cy - 6.5); g.lineTo(cx + 3.5, cy - 6.5); g.lineTo(cx + 7, cy - 2.5); g.lineTo(cx, cy + 7); g.closePath();
            g.fill(); g.stroke();
            g.beginPath(); g.moveTo(cx - 7, cy - 2.5); g.lineTo(cx + 7, cy - 2.5); g.moveTo(cx - 2, cy - 2.5); g.lineTo(cx, cy + 7); g.lineTo(cx + 2, cy - 2.5); g.stroke();
        } else if (/platin/.test(n)) {   // platin: altıgen
            for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; g[i ? 'lineTo' : 'moveTo'](cx + 7 * Math.cos(a), cy + 7 * Math.sin(a)); }
            g.closePath(); g.fill(); g.stroke();
            g.beginPath(); g.arc(cx, cy, 2.6, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fill();
        } else {   // bronz / gümüş / altın: yıldızlı madalya
            g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill(); g.stroke();
            g.beginPath();
            for (let i = 0; i < 10; i++) { const r = i % 2 ? 1.6 : 3.8, a = -Math.PI / 2 + i * Math.PI / 5; g[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a)); }
            g.closePath(); g.fillStyle = 'rgba(255,255,255,0.85)'; g.fill();
        }
        g.restore();
    }
    function drawCard(g, k) {
        g.textBaseline = 'alphabetic';
        const F = (w, px) => `${w} ${px}px ${FONT}`;
        const txt = (t, x, y, f, color, align = 'left') => { g.font = f; g.fillStyle = color; g.textAlign = align; g.fillText(String(t), x, y); g.font = f; return g.measureText(String(t)).width; };
        const W_ = (t, f) => { g.font = f; return g.measureText(String(t)).width; };
        const fit = (t, f, maxW) => { t = String(t); if (W_(t, f) <= maxW) return t; while (t.length > 1 && W_(t + '…', f) > maxW) t = t.slice(0, -1); return t + '…'; };
        /** Kelime kaydırma; parçalar [{t, f, c}] — kalın tutar gibi farklı yazı tipleri aynı satırda. */
        const flow = (parts, x, y, maxW, lh, draw) => {
            let cx = 0, lines = 1;
            for (const p of parts) for (const [i, w] of p.t.split(' ').entries()) {
                const word = (i ? ' ' : '') + w, ww = W_(word, p.f);
                if (cx && cx + ww > maxW) { cx = 0; lines++; if (draw) txt(w, x, y + (lines - 1) * lh, p.f, p.c); cx = W_(w, p.f); continue; }
                if (draw) txt(word, x + cx, y + (lines - 1) * lh, p.f, p.c);
                cx += ww;
            }
            return lines;
        };
        const UP = (t) => String(t).toLocaleUpperCase('tr-TR');
        let y = 0;

        // ── başlık
        const metaH = k.meta?.length ? 38 : 0, hH = 18 + 24 + (metaH ? 10 + metaH : 0) + 14;
        const grad = g.createLinearGradient(0, 0, CW, hH); grad.addColorStop(0, C.head[0]); grad.addColorStop(1, C.head[1]);
        g.fillStyle = grad; g.fillRect(0, 0, CW, hH);
        let stW = 0;
        if (k.online !== null && k.online !== undefined) {
            const st = k.online ? 'Çevrimiçi' : 'Çevrimdışı';
            stW = W_(st, F(700, 12)) + 18;
            txt(st, CW - PX, 18 + 17, F(700, 12), 'rgba(255,255,255,0.88)', 'right');
            g.fillStyle = k.online ? C.online : C.offline; g.beginPath(); g.arc(CW - PX - stW + 5, 18 + 13, 5, 0, Math.PI * 2); g.fill();
        }
        const nmW = txt(fit(k.name, F(900, 20), CW - 2 * PX - stW - 110), PX, 18 + 20, F(900, 20), '#fff');
        txt(k.pid, PX + nmW + 10, 18 + 20, F(700, 13), 'rgba(255,255,255,0.72)');
        if (metaH) {
            let mx = PX; const my = 18 + 24 + 10;
            for (const m of k.meta) {
                const ic = m.k === 'VIP' ? 20 : 0;   // VIP değerinin önünde seviye sembolü
                const vw = W_(m.v, F(900, 14)) + ic, lw = W_(UP(m.k), F(700, 10.5));
                txt(UP(m.k), mx, my + 11, F(700, 10.5), 'rgba(255,255,255,0.62)');
                if (ic) vipIcon(g, mx + 7, my + 25, m.v);
                txt(m.v, mx + ic, my + 30, F(900, 14), m.tone === 'ok' ? C.ok : m.tone === 'bad' ? C.bad : '#fff');
                mx += Math.max(vw, lw) + 26;
            }
        }
        y = hH;

        // ── dikkat bandı
        if (k.flags?.length) {
            const parts = [{ t: k.flags.join(' · '), f: F(900, 12.5), c: '#fff' }];
            const n = flow(parts, PX, 0, CW - 2 * PX, 18, false), h = 12 + 13 + n * 18 + 6;
            g.fillStyle = C.warn; g.fillRect(0, y, CW, h);
            txt('DİKKAT', PX, y + 12 + 9, F(900, 10), 'rgba(255,255,255,0.85)');
            flow(parts, PX, y + 12 + 13 + 13, CW - 2 * PX, 18, true);
            y += h;
        }

        // ── para: 4 sütun
        const colW = CW / 4, maxEx = Math.max(0, ...k.money.map(c => c.extra.length));
        const kH = 12 + 12 + 22 + maxEx * 15 + 12;
        g.fillStyle = C.kpi; g.fillRect(0, y, CW, kH);
        k.money.forEach((c, i) => {
            const x = i * colW + 16, inner = colW - 26;
            if (i) { g.fillStyle = C.kpiLine; g.fillRect(i * colW, y, 1, kH); }
            txt(UP(c.label), x, y + 12 + 9, F(900, 9.5), C.kpiLbl);
            txt(fit(c.main, F(900, 16.5), inner), x, y + 12 + 12 + 18, F(900, 16.5), C.kpiVal);
            c.extra.forEach((e, j) => txt(fit(e, F(700, 10.5), inner), x, y + 12 + 12 + 22 + 12 + j * 15, F(700, 10.5), C.kpiSub));
        });
        g.fillStyle = C.kpiLine; g.fillRect(0, y + kH - 1, CW, 1);
        y += kH;

        // ── finans
        if (k.fin) {
            y += 14;
            txt('FİNANS (TL)', PX, y + 10, F(900, 10.5), C.green);
            y += 18;
            const cols = [CW - PX - 10 - 190, CW - PX - 10 - 95, CW - PX - 10];
            ['YATIRIM', 'ÇEKİM', 'NET'].forEach((t, i) => txt(t, cols[i], y + 10, F(900, 10), C.th, 'right'));
            y += 16;
            k.fin.forEach((r, i) => {
                const rh = 26;
                if (i % 2 === 0) { g.fillStyle = C.zebra; g.beginPath(); g.roundRect ? g.roundRect(PX, y, CW - 2 * PX, rh, 6) : g.rect(PX, y, CW - 2 * PX, rh); g.fill(); }
                txt(r.label, PX + 10, y + 17.5, F(900, 13), C.ink);
                txt(r.dep, cols[0], y + 17.5, F(700, 13), C.ink2, 'right');
                txt(r.wd, cols[1], y + 17.5, F(700, 13), C.ink2, 'right');
                txt(r.net, cols[2], y + 17.5, F(900, 13), r.neg ? C.neg : r.pos ? C.pos : C.ink2, 'right');
                y += rh;
            });
            y += 10;
        }

        // ── oyunlar | bonuslar
        const hasG = k.games?.length, hasB = k.bonuses?.length;
        if (hasG || hasB) {
            g.fillStyle = C.line; g.fillRect(0, y, CW, 1);
            const top = y + 16, gw = hasB ? 168 : CW - 2 * PX, bx = hasG ? PX + gw + 18 : PX, bw = CW - PX - bx;
            let gy = top, by = top;
            if (hasG) {
                txt('SON 7 GÜN OYUNLAR', PX, gy + 10, F(900, 10.5), C.green); gy += 22;
                for (const gm of k.games) {
                    txt(fit(gm.name, F(700, 12.5), gw), PX, gy + 10, F(700, 12.5), C.ink); gy += 18;
                    if (gm.detail) { txt(fit(gm.detail, F(700, 10.5), gw), PX, gy + 8, F(700, 10.5), gm.neg ? C.neg : C.th); gy += 16; }
                }
            }
            if (hasB) {
                txt('SON BONUSLAR', bx, by + 10, F(900, 10.5), C.green); by += 22;
                for (const b of k.bonuses) {
                    const parts = [{ t: UP(b.date), f: F(900, 11), c: C.th }, { t: ' ' + b.name, f: F(700, 12), c: C.ink2 }];
                    if (b.amount) parts.push({ t: ' · ' + b.amount, f: F(900, 12), c: C.kpiVal });
                    const n = flow(parts, bx, by + 10, bw, 16, true);
                    by += n * 16 + 6;
                }
            }
            y = Math.max(gy, by) + 8;
        }

        // ── alt bilgi
        const now = new Date(Date.now() + 3 * 3600e3);
        g.fillStyle = C.line; g.fillRect(0, y, CW, 1);
        g.fillStyle = C.foot; g.fillRect(0, y + 1, CW, 30);
        txt(`${P2(now.getUTCDate())} ${MONTHS[now.getUTCMonth()]} ${P2(now.getUTCHours())}:${P2(now.getUTCMinutes())} · 🔄 tepkisiyle yenilenir`, PX, y + 20, F(700, 10.5), C.footInk);
        return y + 31;
    }
    /** Kartı 2x çözünürlükte PNG olarak çiz (önce boyu ölç, sonra çiz). */
    function renderCard(k) {
        const probe = document.createElement('canvas').getContext('2d');
        const H = Math.ceil(drawCard(probe, k));
        const S = 2, cv = document.createElement('canvas');
        cv.width = CW * S; cv.height = H * S;
        const g = cv.getContext('2d');
        g.scale(S, S);
        g.beginPath(); g.roundRect ? g.roundRect(0, 0, CW, H, 12) : g.rect(0, 0, CW, H); g.clip();
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
                    if (sh.ts) cards[sh.ts] = { ch: CONFIG.CHANNEL, pid: v.card.pid, thread: v.thread, file: sh.file, at: Date.now(), seen: 0 };
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
