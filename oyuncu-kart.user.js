// ==UserScript==
// @name         Oyuncu Kartı — Party ID yazılınca Slack thread'ine
// @namespace    palentis.oyuncu-kart
// @version      1.0.5
// @description  C0BMBT1A6KX kanalında bir mesajda Party ID (8 hane) geçince o mesajın thread'ine oyuncu kartı bırakır: isim, VIP, KYC, üyelik süresi, çevrimiçi durumu, dikkat satırı (KYC, aynı IP, son yatırımdan sonra bonus, haftalık net eksi), bakiye, bekleyen çekim, son yatırım, son başarılı çekim, finans tablosu, son 7 gün oyunlar, son bonuslar (satır satır). Her kelimenin baş harfi büyük. Panel linki yok. 🔄 tepkisiyle kart yenilenir. Veriyi açık GT sekmesi okur, Slack sekmesi gönderir.
// @match        https://core-secundus.gmntc.com/*
// @match        https://app.slack.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * AKIŞ
 *   Slack sekmesi: kanalı 15 sn'de bir okur; Slack istemcisinden yazılmış (client_msg_id olan,
 *   yani bot/API mesajı olmayan) mesajlardaki 8 haneli ID'leri bulur → GM deposuna 'req:' yazar.
 *   Varsayılan: kanaldaki herkesin yazdığı mesajlar; menüden "sadece ben" yapılabilir.
 *   GT sekmesi: 'req:' kayıtlarını alır, panelden veriyi okur, kartı (Block Kit) 'q:' olarak yazar.
 *   Slack sekmesi kartı thread'e gönderir (ya da 🔄 ile istenen kartı chat.update ile yeniler).
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
    /** Bloklardaki tüm metinlerde kelime başlarını büyütür (tr: i→İ). Kesme işaretinden sonrası (IP'de) küçük kalır. */
    function titleCase(node) {
        if (Array.isArray(node)) { node.forEach(titleCase); return; }
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
            if (k === 'text' && typeof v === 'string') node[k] = v.replace(/(^|[\s(·\/*_`-])(\p{Ll})/gu, (m, a, c) => a + c.toLocaleUpperCase('tr-TR'));
            else if (typeof v === 'object') titleCase(v);
        }
    }
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

    async function identity(pid) {
        const [prof, det] = await Promise.all([settle(ics(`players/${pid}/full-profile`)), settle(ics(`players/${pid}/detail`))]);
        raw.profileKeys = prof && Object.keys(prof).join(', ');
        raw.detailKeys = det && Object.keys(det).join(', ');
        const src = { ...(det || {}), ...(prof || {}) };
        return {
            name: [prof?.firstName, prof?.lastName].filter(Boolean).join(' ').trim() || [det?.firstName, det?.lastName].filter(Boolean).join(' ').trim(),
            kyc: String(det?.kycStatus || '').toUpperCase() || null,
            vip: pick(src, ['vipLevelName', 'vipLevel', 'vipStatus', 'vip', 'vipName']),
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
            const name = g.gameName || g.game || '—';
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

        // ⚠️ dikkat satırı
        const flags = [];
        if (id?.kyc && id.kyc !== 'PASS') flags.push(`KYC ${esc(id.kyc)}`);
        if (ip > 0) flags.push(`aynı IP'de ${ip} hesap`);
        if (dep?.at && bon) { const n = bon.filter(b => b.at > dep.at).length; if (n) flags.push(`son yatırımdan sonra ${n} bonus aldı`); }
        const wtd = fin?.WTD;
        if (wtd && wtd.wd > wtd.dep) flags.push(`bu hafta çekim yatırımı geçti (${signed(wtd.dep - wtd.wd)} TL)`);

        const sub = [id?.vip && !/^\d+$/.test(String(id.vip)) ? `VIP ${esc(id.vip)}` : null,
            id?.kyc ? `KYC *${esc(id.kyc)}* ${id.kyc === 'PASS' ? '✅' : '⛔'}` : null,
            memberFor(id?.reg) || null,
            on === true ? '🟢 *Şu an çevrimiçi*' : on === false ? '⚪ Çevrimdışı' : null].filter(Boolean).join(' · ');

        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: `👤 ${id?.name || 'İsim alınamadı'} · ${pid}`, emoji: true } },
            { type: 'section', text: { type: 'mrkdwn', text: sub || '–' } },
        ];
        if (flags.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Dikkat:* ${flags.join(' · ')}` } });
        // 2 sütun: Slack'in yan yana kutuları dar thread panelinde alt alta düşüyor, kod kutusu her ekranda hizalı kalır
        const cut = (t, n = 18) => (t = String(t || '')).length > n ? t.slice(0, n - 1) + '…' : t;
        const two = (l, r) => `${cut(l).padEnd(19)}${cut(r)}`.trimEnd();
        const dAt = dep?.at ? ago(Date.now() - dep.at) : '', wAt = wd?.last?.at ? ago(Date.now() - wd.last.at) : '';
        const money = [
            two('Bakiye', 'Bekleyen çekim'),
            two(bal == null ? '–' : tl(bal), wd ? (wd.pending ? tl(wd.pending) : 'yok') : '–'),
            '',
            two('Son yatırım', 'Son başarılı çekim'),
            two(dep ? tl(dep.amount) : 'yok', wd?.last ? tl(wd.last.amount) : (wd ? 'yok' : '–')),
        ];
        const dM = dep?.method ? esc(shortMethod(dep.method)) : '', wM = wd?.last?.method ? esc(shortMethod(wd.last.method)) : '';
        if (dM || wM) money.push(two(dM, wM));
        if (dAt || wAt) money.push(two(dAt, wAt));
        blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${money.join('\n')}\`\`\`` } });

        if (fin) {
            const rowsDef = [['Bugün', 'TODAY'], ['Bu hafta', 'WTD'], ['Bu ay', 'MTD'], ['Bu yıl', 'YTD'], ['Tüm zaman', 'LTD']];
            const pad = (s, n) => String(s).padStart(n);
            const lines = [`${''.padEnd(10)}${pad('Yatırım', 10)}${pad('Çekim', 10)}${pad('Net', 10)}`];
            for (const [label, key] of rowsDef) {
                const r = fin[key];
                if (!r) { lines.push(`${label.padEnd(10)}${pad('–', 10)}${pad('–', 10)}${pad('–', 10)}`); continue; }
                const net = r.dep - r.wd;
                lines.push(`${label.padEnd(10)}${pad(int(r.dep), 10)}${pad(int(r.wd), 10)}${pad(signed(net), 10)}${net < 0 ? ' ▼' : ''}`);
            }
            blocks.push({ type: 'divider' },
                { type: 'section', text: { type: 'mrkdwn', text: `*Finans (TL)*\n\`\`\`${lines.join('\n')}\`\`\`` } },
                { type: 'context', elements: [{ type: 'mrkdwn', text: 'Net = yatırım − çekim · ▼ oyuncu lehine (site eksi)' }] });
        }
        if (gm?.length) {
            const pad = (s, n) => String(s).padStart(n);
            const hasMoney = gm.some(g => g.bet || g.win);
            const lines = gm.map(g => {
                const name = g.name.length > 20 ? g.name.slice(0, 19) + '…' : g.name;
                return hasMoney ? `${name.padEnd(21)}bahis ${pad(int(g.bet), 9)}  ${pad(signed(g.win - g.bet), 9)}` : name;
            });
            blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*Son 7 gün oyunlar*\n\`\`\`${lines.join('\n')}\`\`\`` } });
        }
        if (bon?.length) {
            const lines = bon.slice(0, 3).map(b => { const d = new Date(b.at + 3 * 3600e3); return `${p2(d.getUTCDate())} ${AYLAR[d.getUTCMonth()]} · ${esc(b.name)}${b.amount ? ` ${int(b.amount)} TL` : ''}`; });
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Son bonuslar:\n${lines.join('\n')}` }] });
        }
        titleCase(blocks);   // kartın tamamında her kelimenin baş harfi büyük

        GM_setValue('lastRaw', { pid, at: Date.now(), ...raw });
        return { text: `👤 ${id?.name || pid} · ${pid}`, blocks };
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
                    GM_setValue('q:' + k.slice(4), { ...card, thread: req.thread, update: req.update || null, at: Date.now() });
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
                if (v.update) {
                    await api('chat.update', { channel: CONFIG.CHANNEL, ts: v.update, text: v.text, blocks: JSON.stringify(v.blocks) }, ['message_not_found', 'cant_update_message']);
                    status(`kart yenilendi ${v.text}`);
                } else {
                    const r = await api('chat.postMessage', { channel: CONFIG.CHANNEL, thread_ts: v.thread, text: v.text, unfurl_links: 'false', ...(v.blocks ? { blocks: JSON.stringify(v.blocks) } : {}) });
                    if (v.blocks) {
                        const cards = GM_getValue('cards', {});
                        cards[r.ts] = { pid: (v.text.match(CONFIG.ID_RE) || [])[0], thread: v.thread, at: Date.now(), seen: 0 };
                        GM_setValue('cards', cards);
                    }
                    status(`kart gönderildi ${v.text}`);
                }
                await sleep(800);
            }
        } catch (e) { warn('gönderilemedi:', e.message); status(`HATA: ${e.message}`); }
        finally { busy = false; if (again) setTimeout(flush, 200); }
    }

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
        alert(`Oyuncu kartı: ${GM_getValue('enabled', true) === false ? 'KAPALI' : 'AÇIK'} · ${everyone() ? 'herkes' : 'sadece ben'}\nSon: ${s ? `${s.msg} (${new Date(s.at).toLocaleTimeString('tr-TR')})` : '—'}\nBekleyen istek: ${GM_listValues().filter(k => k.startsWith('req:')).length}`);
    });
}

})();
