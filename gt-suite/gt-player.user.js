// ==UserScript==
// @name         GT Player — oyuncu detayı
// @namespace    palentis.gt
// @version      1.0.14
// @description  Oyuncu detay sayfasının tek sahibi: kimlik kartı (KYCAID fotoğrafı, btag, lock/VIP/KYC), Deposits/Withdrawals/NET paneli, giriş kayıtları + IP konumu, son 24 saat oyunları, bakiye sıfırlama butonları, duplicate (IP) ve bonus/deposit/withdrawal (PT) özeti, yorum popup'ı. Eski alanları temizler. GT Core üzerine kurulur — "GT Accounting Panel" scriptinin yerini alır.
// @match        https://core-secundus.gmntc.com/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
'use strict';

const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

(W.__GT__ = W.__GT__ || []).push((GT) => {

const { h, $, $$, txt, esc, css, log, warn, oops, at, api, ui, ICON, fmtTRY } = GT;

/* ════════════════════════════════════════════════════════════
   SABİTLER
   ════════════════════════════════════════════════════════════ */

const BTAG = {
    p3726p175p7b4a: 'CenkBey', p3481p89p3361: 'CenkBey Eski', p3433p36pdf8e: 'BahisciPablo',
    p3541p131pe562: 'RealSeo', p3262p14p299a: 'HamdiSEO', p3261p13p6c9f: 'MAILING',
    p3547p136p49ea: 'SlotBuse', p3546p135pee84: 'BonusSemti', p3551p140pf416: 'KodTime',
    p3549p138p3ff5: 'SlotJack', p3545p134pcdbf: 'BonusSoft', p3550p139pb944: 'SlotBeko',
    p3548p137p68b5: 'Papiboy',
};

const VIP_ICON = { BRONZE: '🎖️', SILVER: '♛', GOLD: '🪙', PLATINUM: '🪩', PLATINIUM: '🪩', DIAMOND: '💎' };

const STAFF = {
    Destek17ZB: ['Ecem', false], Destek4ZB: ['Bulut', false], Destek18ZB: ['Mila', false],
    Destek2ZB: ['Alina', false], Destek6ZB: ['Minerva', true], Destek8ZB: ['Marcus', true],
    Destek5ZB: ['Anderson', true], 'Ciomantony Ciomantony': ['Cioman', false], Destek1ZB: ['Arya', false],
};

const BALANCE_NOTES = {
    OLD: 'Süresi geçen etkinlik bonusu',
    IP:  'Çoklu hesap veya IP çakismasi tespit edilmesi sebebiyle, kurallar geregince promosyon iptal edilmis ve elde edilen kazanç geçersiz sayilmistir.',
    PT:  'Daha önce etkinlik kapsamında çekim yapıldıysa veya etkinlikten 5 kez faydalanılıp yatırım yapılmadıysa, yeni bir yatırım yaparak etkinliklerden tekrar faydalanabilirsiniz.',
    UST: 'Üst Bakiye',
};

const SKIP_BONUS = ['Freespin Zuma', 'Zumabet Hosgeldin Freesin'];

/* Bakiye düzeltme: Real Money kalemine tıkla → popup'ta bakiyeyi sıfırlayan
   tutarı ve notu yaz → Adjust. Hem kısayollar hem Bakiye kartı kullanır. */
const BALANCE_BUTTONS = [
    { label: 'OLD', key: 'alt+o', note: BALANCE_NOTES.OLD },
    { label: 'IP',  key: 'alt+q', note: BALANCE_NOTES.IP },
    { label: 'PT',  key: 'alt+w', note: BALANCE_NOTES.PT },
    { label: 'ÜST', key: null,    note: BALANCE_NOTES.UST },
];

function balanceFire(el, value) {
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function balanceApply(note) {
    const balance = $('div[style*="margin-bottom: 5px"]');
    if (!balance) return warn('[Bakiye] Bakiye alanı bulunamadı.');
    balanceFire($('input[name="balance-adjust-amount"]'), '-' + balance.innerText.replace('TRY', '').replace(/,/g, '').trim());
    balanceFire($('textarea[name="balance-adjust-comment"]'), note);
    setTimeout(() => {
        const btn = $('button.btn-success');
        if (btn && /Adjust/.test(btn.textContent)) btn.click();
    }, 400);
}

function balanceAdjust(note) {
    if ($('input[name="balance-adjust-amount"]')) return balanceApply(note);

    const pencil = $$('td').find(td => txt(td) === 'Real Money' && !td.closest('#gt-dash'))
        ?.nextElementSibling?.nextElementSibling
        ?.querySelector('i.fa-pencil-square-o');
    if (!pencil) return oops('[Bakiye] "Real Money" satırındaki kalem yok.');

    pencil.click();
    let tries = 0;
    const timer = setInterval(() => {
        if ($('input[name="balance-adjust-amount"]')) { clearInterval(timer); balanceApply(note); }
        else if (++tries >= 20) { clearInterval(timer); warn('[Bakiye] Popup zamanında açılmadı.'); }
    }, 150);
}

/** Yeni panelin yerini aldığı, sayfadan kaldırılan alanlar. */
const HIDE_LABELS = new Set([
    'Status', 'Partyid', 'USERID', 'Deposits', 'Withdrawals', 'NET',
    'Bonus Granted', 'Bonus Released', 'Bonus Withdrawn',
    'Locked Until', 'Lock Status', 'Account Status', 'Winners List', 'Display Msgs', 'Subscription',
    'Brand', 'Joined', 'VIP', 'KYC', 'KYC Age', 'KYC System', 'Registration Type', 'NickName',
    'Bingo Alias', 'Gender', 'CCLEVEL', 'Phone', 'Antifraud Status', 'Antifraud Check', 'AML/PEP Check',
    'Primary Wallet UUID', 'Trust Level', 'User Session',
]);

const PERIODS = [
    ['YESTERDAY', 'Dün'], ['TODAY', 'Bugün'], ['WTD', 'WTD'], ['MTD', 'MTD'],
    ['LM', 'Geçen ay'], ['YTD', 'YTD'], ['LTD', 'LTD'],
];

/** Gizlenen alanlar: etiket → {text, pencil}. Kartlar buradan okur. */
const hidden = new Map();

function field(label) {
    const hit = hidden.get(label);
    if (hit?.pencil?.isConnected || hit) return hit;
    for (const cell of $$('td.text-xs-left')) {
        if (txt(cell) !== label) continue;
        const value = cell.nextElementSibling;
        const edit = value?.nextElementSibling;
        if (value) return { text: txt(value), pencil: edit?.querySelector('i.fa-pencil-square-o') || null };
    }
    return null;
}

const pref = (k, d) => { try { return localStorage.getItem('gt.player.' + k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('gt.player.' + k, v); } catch { /* kota */ } };
const asList = (b) => Array.isArray(b) ? b : (b?.data || b?.content || b?.items || []);
const money = (n) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = (offsetDays = 0) => {
    const d = new Date(); d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dmy = (offsetDays = 0) => {
    const d = new Date(); d.setDate(d.getDate() + offsetDays);
    return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};
const hhmm = (d) => d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

/* ════════════════════════════════════════════════════════════
   VERİ KATMANI
   ════════════════════════════════════════════════════════════ */

async function profile(pid) {
    try {
        const data = await api.json(api.ics(`players/${pid}/full-profile`), { ttl: 300000 });
        const codes = data?.userTrackingCodes;
        let btag = null;
        if (Array.isArray(codes)) {
            const entry = codes.find(c => c.codeKey === 'btag');
            if (entry?.value) btag = BTAG[entry.value.split('&')[0].trim()] || 'Marketing';
        }
        return {
            firstName: data?.firstName || '', lastName: data?.lastName || '',
            birthDate: (data?.birthDate && data.birthDate !== 'N/A') ? data.birthDate : null,
            city: (data?.city && data.city !== 'N/A') ? data.city : null,
            btag,
        };
    } catch (e) { oops('[Player] full-profile:', e); return null; }
}

async function games24h(pid) {
    try {
        const data = await api.json(api.ics('player-game-play', {
            partyId: pid, startDate: ymd(-1), endDate: ymd(0), currency: 'undefined',
        }), { ttl: 120000 });
        if (!Array.isArray(data)) return [];
        return [...new Set(data.map(v => v.gameName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
    } catch (e) { oops('[Player] game-play:', e); return []; }
}

async function accounting(pid) {
    const list = asList(await api.json(api.ics(`players/${pid}/financial/deposits-and-withdrawals`), { ttl: 60000 }));
    const out = {};
    for (const row of list) {
        const period = String(row.period || '').toUpperCase();
        const type = String(row.tranType || '').toLowerCase();
        const amount = Number(row.amount) || 0;
        if (!out[period]) out[period] = { dep: 0, wd: 0 };
        if (type.startsWith('dep')) out[period].dep += amount;
        else if (type.startsWith('with')) out[period].wd += amount;
    }
    return out;
}

/* ── KYCAID portresi (ayrı CSRF akışı — Bearer ile karıştırma) ── */
const portraitCache = new Map();

function deepFind(obj, test, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return undefined;
    seen.add(obj);
    for (const [k, v] of Object.entries(obj)) {
        if (test(k, v)) return v;
        if (v && typeof v === 'object') { const r = deepFind(v, test, seen); if (r !== undefined) return r; }
    }
    return undefined;
}

async function portrait(pid) {
    if (portraitCache.has(pid)) return portraitCache.get(pid);
    try {
        const session = await api.gm({ method: 'GET', url: 'https://app.kycaid.com/api/session', headers: { Accept: 'application/json' } });
        const csrf = JSON.parse(session.responseText)?.session?.['csrf-token'];
        if (!csrf) throw new Error('CSRF yok');

        const search = await api.gm({
            method: 'POST', url: 'https://app.kycaid.com/api/verifications',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'CSRF-Token': csrf },
            data: JSON.stringify({ customer_id: 24931, timezone: 'Europe/Kiev', searchType: 'external_id', page: 1, count: 10, search: String(pid) }),
        });

        const ids = new Set();
        (function walk(o, seen = new Set()) {
            if (!o || typeof o !== 'object' || seen.has(o)) return;
            seen.add(o);
            for (const [k, v] of Object.entries(o)) {
                if (typeof v === 'string' && /id/i.test(k) && /^[0-9a-f-]{16,}$/i.test(v)) ids.add(v);
                walk(v, seen);
            }
        })(JSON.parse(search.responseText));

        for (const id of ids) {
            const res = await api.gm({ method: 'GET', url: `https://app.kycaid.com/api/verifications/${id}`, headers: { Accept: 'application/json', 'CSRF-Token': csrf } });
            let json; try { json = JSON.parse(res.responseText); } catch { continue; }
            const url = deepFind(json, (_, v) => typeof v === 'string' && /portraits\//i.test(v) && /\.(jpg|jpeg|png|webp)/i.test(v));
            if (url) { portraitCache.set(pid, url); return url; }
        }
    } catch (e) { oops('[Player] KYCAID:', e); }
    portraitCache.set(pid, null);
    return null;
}

/* ── giriş kayıtları + IP konumu ── */
const pickField = (obj, names) => {
    const keys = Object.keys(obj || {});
    for (const name of names) {
        const key = keys.find(k => k.toLowerCase() === name.toLowerCase());
        if (key !== undefined && obj[key] != null && obj[key] !== '') return obj[key];
    }
    return undefined;
};

function osFromUa(ua) {
    if (/iPhone|iPad|iPod|iOS/i.test(ua)) return 'iOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
    if (/Linux|X11/i.test(ua)) return 'Linux';
    return '';
}

function normalizeLog(r) {
    const ua = String(pickField(r, ['userAgent', 'ua', 'agent']) || '');
    const status = pickField(r, ['status', 'success', 'successful', 'loginStatus', 'result']);
    const mobile = pickField(r, ['mobile', 'isMobile']);
    let country = pickField(r, ['country', 'countryCode', 'countryIso', 'ipCountry']);
    if (country && typeof country === 'object') country = country.code || country.name || '';
    return {
        time: Number(pickField(r, ['loginTime', 'logoutTime', 'logTime', 'time', 'createdAt', 'date'])) || 0,
        type: String(pickField(r, ['type', 'logType', 'actionType', 'action', 'loginType', 'eventType']) || '').toUpperCase(),
        failed: status === false || /fail|error|denied|invalid|block/i.test(String(status ?? '')),
        mobile: mobile === true || String(mobile).toLowerCase() === 'true',
        ip: String(pickField(r, ['ip', 'ipAddress', 'loginIp', 'clientIp', 'remoteIp', 'ipAddr']) || ''),
        country: String(country || ''),
        os: String(pickField(r, ['deviceOs', 'deviceOS', 'os', 'osName', 'operatingSystem', 'platform']) || '') || osFromUa(ua),
        browser: String(pickField(r, ['browser', 'browserName', 'browserType']) || '') || ua,
        device: String(pickField(r, ['device', 'deviceType', 'deviceModel']) || ''),
    };
}

async function loginLogs(pid, days) {
    const list = asList(await api.json(api.ics(`players/${pid}/login-logs/more`, {
        startDate: ymd(-(days - 1)), endDate: ymd(1),
    }), { ttl: 60000 }));
    return list.map(normalizeLog).sort((a, b) => b.time - a.time);
}

const GEO_TTL = 7 * 864e5;
let geoCache = {};
try { geoCache = JSON.parse(localStorage.getItem('gt.geo') || '{}'); } catch { /* bozuk kayıt */ }
const geoPending = new Set();

const isPrivateIp = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/i.test(ip);
const geoOf = (ip) => { const g = geoCache[ip]; return g && Date.now() - g.t < GEO_TTL ? g : null; };

function saveGeo() {
    try {
        geoCache = Object.fromEntries(Object.entries(geoCache).sort((a, b) => b[1].t - a[1].t).slice(0, 500));
        localStorage.setItem('gt.geo', JSON.stringify(geoCache));
    } catch { /* kota */ }
}

async function geoLookup(ip, onDone) {
    if (!ip || isPrivateIp(ip) || geoOf(ip) || geoPending.has(ip)) return;
    geoPending.add(ip);
    try {
        const res = await api.gm({ method: 'GET', url: `https://ipwho.is/${encodeURIComponent(ip)}`, timeout: 8000 });
        const j = JSON.parse(res.responseText);
        geoCache[ip] = (j && j.success !== false)
            ? { t: Date.now(), city: j.city || '', region: j.region || '', cc: j.country_code || '', isp: j.connection?.isp || j.connection?.org || '' }
            : { t: Date.now(), failed: true };
        saveGeo();
    } catch { /* ağ hatası: sonraki yüklemede tekrar denenir */ }
    finally { geoPending.delete(ip); onDone?.(); }
}

/* ── bonus / deposit / withdrawal / duplicate ── */
const parseStamp = (s) => { if (!s) return null; const d = new Date(String(s).replace(' ', 'T')); return isNaN(d) ? null : d; };

async function bonuses(pid) {
    try {
        const data = await api.json(api.ics(`player-bonus/${pid}`, { currency: 'undefined' }), { ttl: 60000 });
        return (data || [])
            .filter(b => b.triggerDate && !SKIP_BONUS.includes(b.planName))
            .sort((a, b) => (parseStamp(b.triggerDate)?.getTime() || 0) - (parseStamp(a.triggerDate)?.getTime() || 0));
    } catch (e) { oops('[Player] bonus:', e); return []; }
}

async function bonusPlanNames(pid) {
    try {
        const list = await api.json(api.ics(`player-bonus/${pid}`, { currency: 'undefined' }), { ttl: 60000 });
        const ids = [...new Set((list || []).map(b => b.bonusPlanId).filter(Boolean))];
        if (!ids.length) return [];
        const plans = await api.json(api.ics('bonusplan/id', { ids: ids.join(',') }), { ttl: 300000 });
        return (plans || []).map(p => p.planName).filter(n => n && n !== 'Freespin Zuma');
    } catch { return []; }
}

async function lastDeposit(pid) {
    try {
        const data = await api.json(api.ics('player-deposit/query', {
            partyId: pid, startDate: ymd(-90), endDate: ymd(1), currency: 'TRY',
        }), { ttl: 60000 });
        return (data || [])
            .filter(d => d.paymentStatus === 'COMPLETED')
            .sort((a, b) => (b.processDate || 0) - (a.processDate || 0))[0] || null;
    } catch (e) { oops('[Player] deposit:', e); return null; }
}

async function lastWithdrawal(pid) {
    try {
        const doc = await api.doc(api.legacy('player/PlayerWithdrawals.action', {
            partyId: pid, startDate: dmy(-180), endDate: dmy(1), execute: 'Go',
        }), { ttl: 60000 });
        const table = doc.querySelector('#withdrawals');
        if (!table) { warn('[Player] #withdrawals tablosu yok'); return null; }
        for (const row of $$('tbody.tbody tr, tbody tr[id^="withdrawals_row"]', table)) {
            const c = row.cells;
            if (c.length < 7) continue;
            const status = (c[4]?.textContent || '').replace(/[a-z]+_[a-z]+/gi, '').replace(/\s+/g, ' ').trim();
            if (!status.toLowerCase().includes('completed')) continue;
            return { processDate: txt(c[2]), amount: txt(c[3]), method: txt(c[6]) };
        }
        return null;
    } catch (e) { oops('[Player] withdrawal:', e); return null; }
}

/** PlayerDuplicates.action'ı verilen ölçütle çalıştırır, satırları tekilleştirir. */
async function duplicateRows(pid, criteria) {
    const doc = await api.doc(api.legacy('player/PlayerDuplicates.action', {
        partyId: pid, matchingItems: '1', execute: 'Search Duplicates', ...criteria,
    }), { ttl: 60000 });
    const seen = new Set();
    const out = [];
    for (const row of doc.querySelectorAll('tbody tr')) {
        const c = row.querySelectorAll('td');
        if (c.length < 5) continue;
        const id = txt(c[2]);
        if (!/^\d{8}$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, first: txt(c[3]), last: txt(c[4]) });
    }
    return out;
}

/** Türkçe karakterleri ve noktalamayı düzler: "İbrahim Çağlar" ile
 *  "ibrahim caglar" aynı isim sayılsın. */
function normalizeName(s) {
    return String(s || '')
        .toLocaleLowerCase('tr-TR')
        .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
        .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/* ════════════════════════════════════════════════════════════
   STİL
   ════════════════════════════════════════════════════════════ */
css('gt-player-style', `
.gt-hidden-field{display:none !important}
/* Sıra numarası kutusu: site stilleri genişliği rakama göre daraltmasın */
.gt-num{display:inline-flex !important; align-items:center; justify-content:center; flex:none !important;
  box-sizing:border-box !important; width:28px !important; min-width:28px !important; height:28px !important;
  padding:0 !important; margin:0 !important; line-height:1 !important; font-variant-numeric:tabular-nums}
.gt-num--sm{width:24px !important; min-width:24px !important; height:24px !important}

#gt-dash{display:flex; flex-wrap:wrap; gap:14px; align-items:flex-start; margin:14px 0 0; text-align:left;
  font-family:var(--gt-font); font-size:12px; line-height:1.4; color:var(--gt-ink)}
#gt-dash *{box-sizing:border-box; font-family:var(--gt-font); letter-spacing:normal; text-transform:none;
  text-shadow:none; -webkit-font-smoothing:antialiased}
#gt-dash .fa{font-family:FontAwesome; font-style:normal}
#gt-dash .gtc{background:#fff; border:.5px solid rgba(0,0,0,.08); border-radius:16px;
  box-shadow:0 1px 2px rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.05); min-width:0}
#gt-dash .gtc.gtc-pad{padding:16px 18px 12px}
#gt-ozet{flex:0 0 auto; max-width:420px; position:relative; overflow:hidden; --fade:#fff;
  transition:background-color .2s, border-color .2s}
#gt-acc{flex:0 0 auto}
#gt-logs{flex:1 1 480px; min-width:440px; max-width:760px}
#gt-dash.floating{position:fixed; right:16px; bottom:56px; z-index:99998; flex-direction:column; flex-wrap:nowrap;
  width:560px; max-width:calc(100vw - 32px); max-height:78vh; overflow:auto; margin:0; padding:8px;
  background:rgba(255,255,255,.72); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  border-radius:18px; box-shadow:0 18px 48px rgba(0,0,0,.18)}
#gt-dash.floating .gtc{width:100%; max-width:none}
#gt-dash.floating #gt-logs{min-width:0}

#gt-dash .gtc-head{display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:12px}
#gt-dash .gtc-title{font-size:15px; font-weight:600; letter-spacing:-.2px; color:var(--gt-ink)}
#gt-dash .gtc-sub{color:var(--gt-muted); font-size:11px; margin-top:1px; display:flex; flex-wrap:wrap; gap:0 10px}
#gt-dash .gtc-refresh{all:unset; width:28px; height:28px; flex:none; border-radius:50%; color:var(--gt-muted);
  cursor:pointer; display:inline-flex; align-items:center; justify-content:center}
#gt-dash .gtc-refresh:hover{background:rgba(118,118,128,.12); color:var(--gt-ink)}
#gt-dash .gtc-refresh.busy svg{animation:gt-spin .8s linear infinite}

#gt-dash .gtc-seg{display:inline-flex; background:rgba(118,118,128,.12); border-radius:9px; padding:2px; white-space:nowrap}
#gt-dash .gtc-seg button{all:unset; padding:4px 10px; border-radius:7px; font-size:11.5px; font-weight:500; cursor:pointer; color:var(--gt-ink)}
#gt-dash .gtc-seg button[aria-selected="true"]{background:#fff; font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.12)}
#gt-dash .gtc-toolbar{display:flex; flex-wrap:wrap; gap:8px; justify-content:space-between}
#gt-dash .gtc-segwrap{overflow-x:auto; max-width:100%}
#gt-dash .gtc-content{margin-top:10px}
#gt-dash .gtc-msg{padding:10px 0 12px; color:var(--gt-muted)}
#gt-dash .gtc-msg.err{color:var(--gt-danger)}

#gt-dash table{width:100%; border-collapse:collapse; background:transparent}
#gt-dash th, #gt-dash td{padding:7px 0; border:0; border-bottom:1px solid var(--gt-line); background:transparent; vertical-align:middle; text-align:left}
#gt-dash th{color:var(--gt-muted); font-size:11px; font-weight:500}
#gt-dash tbody tr:last-child td{border-bottom:0}
#gt-dash th + th, #gt-dash td + td{padding-left:12px}
#gt-dash .num{text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums}
#gt-dash td.lbl{color:var(--gt-muted)}
#gt-dash .pos{color:#248a3d} #gt-dash .neg{color:#d70015}
#gt-dash .line{display:flex; justify-content:space-between; align-items:baseline; padding:8px 0; border-bottom:1px solid var(--gt-line)}
#gt-dash .line span:first-child{color:var(--gt-muted)}
#gt-dash .line:last-child{border-bottom:0; padding-top:10px}
#gt-dash .line.total span:first-child{color:var(--gt-ink); font-weight:600}
#gt-dash .line.total span:last-child{font-size:18px; font-weight:600}

#gt-dash .gtc-toolbar:empty{display:none}
#gt-bal{flex:0 0 auto; width:300px}
#gt-bal .gtc-head{align-items:center}
#gt-bal .gtb-actions{display:inline-flex; gap:4px; flex:none}
#gt-bal .gtb-hero{display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:12px 14px; border-radius:12px; background:var(--gt-surface-2)}
#gt-bal .gtb-cap{font-size:10.5px; font-weight:600; letter-spacing:.4px; text-transform:uppercase; color:var(--gt-muted)}
#gt-bal .gtb-big{margin-top:3px; font-size:24px; font-weight:600; letter-spacing:-.5px; line-height:1.1;
  font-variant-numeric:tabular-nums; color:var(--gt-ink)}
#gt-bal .gtb-big.z{color:var(--gt-ink-2)}
#gt-bal .gtb-big small{margin-left:5px; font-size:12px; font-weight:500; letter-spacing:0; color:var(--gt-muted)}
#gt-bal .gtb-list{margin-top:6px}
#gt-bal .gtb-row{display:grid; grid-template-columns:minmax(0,1fr) auto 40px; column-gap:10px; align-items:center;
  height:34px; border-top:.5px solid rgba(60,60,67,.12); font-size:12.5px}
#gt-bal .gtb-row:first-child{border-top-color:transparent}
#gt-bal .gtb-lbl{color:var(--gt-ink-2)}
#gt-bal .gtb-n{text-align:right; font-weight:500; font-variant-numeric:tabular-nums; color:var(--gt-ink)}
#gt-bal .gtb-n.z{color:#c7c7cc; font-weight:400}
#gt-bal .gtb-icons{display:inline-flex; align-items:center; justify-content:flex-end; gap:8px; line-height:1}
#gt-bal .gtb-icons .fa{font-size:13px; color:var(--gt-muted) !important; cursor:pointer; transition:color .12s}
#gt-bal .gtb-icons .fa:hover{color:var(--gt-accent) !important}
#gt-acc{min-width:380px}
#gt-acc .gta{font-variant-numeric:tabular-nums; margin:0 -8px}
#gt-acc .gta-head, #gt-acc .gta-row{display:grid; grid-template-columns:78px repeat(3, minmax(86px, 1fr));
  column-gap:14px; align-items:center; padding:0 8px}
#gt-acc .gta-head{padding-bottom:6px; font-size:10.5px; font-weight:600; letter-spacing:.4px;
  text-transform:uppercase; color:var(--gt-muted)}
#gt-acc .gta-head span, #gt-acc .gta-n{text-align:right; white-space:nowrap}
#gt-acc .gta-row{height:34px; border-radius:8px; font-size:12.5px; color:var(--gt-ink);
  border-top:.5px solid rgba(60,60,67,.12); transition:background .12s}
#gt-acc .gta-head + .gta-row{border-top-color:transparent}
#gt-acc .gta-row:hover{background:rgba(118,118,128,.07); border-top-color:transparent}
#gt-acc .gta-row:hover + .gta-row{border-top-color:transparent}
#gt-acc .gta-lbl{color:var(--gt-ink-2); font-weight:500}
#gt-acc .gta-n.z{color:#c7c7cc}
#gt-acc .gta-n.net{font-weight:600}
#gt-acc .gta-n.net.pos{color:#d70015}
#gt-acc .gta-n.net.neg{color:#248a3d}
#gt-acc .gta-row.ltd{margin-top:6px; height:38px; background:var(--gt-surface-2); border-top-color:transparent; font-weight:600}
#gt-acc .gta-row.ltd .gta-lbl{color:var(--gt-ink); font-weight:600}

/* Giriş kayıtları — tablo değil grid liste: sitenin global table/td
   stilleri buraya sızamaz, sütunlar her satırda aynı hizada kalır. */
#gt-logs .gtl-scroll{max-height:380px; overflow-y:auto; overflow-x:hidden; margin:0 -16px; padding:0 16px}
#gt-logs .gtl-day{position:sticky; top:0; z-index:1; padding:10px 0 6px; background:rgba(255,255,255,.92);
  backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
  font-size:11px; font-weight:600; letter-spacing:.2px; color:var(--gt-muted)}
#gt-logs .gtl-day:first-child{padding-top:2px}
#gt-logs .gtl-row{display:grid; margin:0 -8px; padding-left:8px !important; padding-right:8px !important; border-radius:8px;
  transition:background .12s; width:auto; grid-template-columns:44px minmax(150px,1fr) 96px minmax(0,120px); column-gap:12px; align-items:center;
  padding:9px 0; border-bottom:.5px solid rgba(60,60,67,.14)}
#gt-logs .gtl-row:last-child{border-bottom:0}
#gt-logs .gtl-row:hover{background:rgba(118,118,128,.07)}
#gt-logs .gtl-row > div{min-width:0}
#gt-logs .gtl-time{font-size:12px; font-weight:500; font-variant-numeric:tabular-nums; color:var(--gt-ink)}
#gt-logs .gtl-ip{display:flex; align-items:center; gap:6px; min-width:0; font-size:12.5px; font-weight:500;
  font-variant-numeric:tabular-nums; color:var(--gt-ink)}
#gt-logs .gtl-ip .gtl-addr{flex:0 1 auto; min-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
#gt-logs .gtl-dot{width:6px; height:6px; border-radius:50%; flex:none}
#gt-logs .gtl-loc{margin-top:2px; padding-left:12px; font-size:11px; color:var(--gt-muted);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
#gt-logs .gtl-loc .gtl-isp{opacity:.75}
#gt-logs .gtl-meta{display:flex; align-items:flex-start; gap:7px; font-size:12px; color:var(--gt-ink); white-space:nowrap}
#gt-logs .gtl-meta .fa{flex:none; width:14px; margin-top:1px; text-align:center; font-size:13px; color:var(--gt-muted)}
#gt-logs .gtl-meta > div{min-width:0; overflow:hidden; text-overflow:ellipsis}
#gt-logs .gtl-meta small{display:block; margin-top:2px; font-size:11px; color:var(--gt-muted)}
#gt-logs .gtl-pill{flex:none; font-size:10px; font-weight:600; padding:1px 6px; border-radius:6px}
#gt-logs .gtl-pill.in{background:rgba(52,199,89,.12); color:#248a3d}
#gt-logs .gtl-pill.out{background:rgba(118,118,128,.12); color:var(--gt-muted)}
#gt-logs .gtl-pill.fail{background:rgba(255,59,48,.10); color:var(--gt-danger)}
#gt-logs .gtl-row.failed .gtl-time{color:var(--gt-danger)}

#gt-logs .gtc-content{min-width:0; overflow:hidden}

#gt-ozet .top{display:flex; align-items:center; gap:14px; padding:14px 90px 14px 16px; border-bottom:.5px solid rgba(0,0,0,.06)}
#gt-ozet .photo,#gt-ozet .ph{width:52px; height:52px; border-radius:50%; flex-shrink:0; background:var(--gt-surface-2); border:.5px solid var(--gt-line)}
#gt-ozet .photo{object-fit:cover; cursor:pointer; transition:transform .15s}
#gt-ozet .photo:hover{transform:scale(1.06)}
#gt-ozet .ph{display:flex; align-items:center; justify-content:center; color:#c7c7cc; font-size:18px; font-weight:600}
#gt-ozet .names{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
#gt-ozet .who{font-weight:600; font-size:14.5px; letter-spacing:-.2px}
#gt-ozet .meta{color:var(--gt-muted); font-size:12px; margin-top:3px; display:flex; flex-direction:column; gap:2px}
#gt-ozet .body{padding:12px 16px 14px}
#gt-ozet .ids{display:flex; align-items:center; justify-content:space-between; gap:10px;
  margin-bottom:12px; padding-bottom:12px; border-bottom:.5px solid rgba(0,0,0,.06)}
#gt-ozet .idcol{display:flex; flex-direction:column; gap:4px; min-width:0}
#gt-ozet .idrow{display:flex; align-items:center; gap:6px; font-size:12px; color:var(--gt-ink-2); min-width:0}
#gt-ozet .idrow[hidden]{display:none}
#gt-ozet .idlabel{color:var(--gt-muted); font-weight:600; min-width:58px; flex:none}
#gt-ozet .idrow .val{font-weight:500; color:var(--gt-ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
#gt-ozet .idrow .icons{display:inline-flex; align-items:center; gap:4px; flex:none; line-height:1}
#gt-ozet .idrow .icons .fa{font-family:FontAwesome; font-style:normal; line-height:1}
#gt-ozet .idrow .icons .glyphicon{font-family:'Glyphicons Halflings'; font-style:normal; line-height:1}
#gt-ozet .idrow .icons .glyphicon:empty{display:none}
#gt-ozet .idrow .icons .fa-check-circle{color:#34c759 !important}
#gt-ozet .idrow .icons .fa-phone{color:var(--gt-muted)}
#gt-ozet .idrow .icons > *{cursor:pointer}
#gt-ozet .idrow .icons a{color:var(--gt-accent); font-size:11px; font-weight:500; text-decoration:none}
#gt-ozet .idrow .icons a:hover{text-decoration:underline}
#gt-ozet .copy{all:unset; display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px;
  border-radius:5px; background:var(--gt-accent-soft); border:.5px solid rgba(0,113,227,.25); color:var(--gt-accent); cursor:pointer}
#gt-ozet .copy:hover{background:rgba(0,113,227,.16)}
#gt-ozet .copy svg{width:10px; height:10px}
#gt-ozet .endsession{all:unset; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; height:24px; padding:0 11px; border-radius:12px;
  border:.5px solid rgba(255,59,48,.35); background:rgba(255,59,48,.08); color:var(--gt-danger);
  font-size:10.5px; font-weight:600; cursor:pointer; white-space:nowrap; flex-shrink:0}
#gt-ozet .endsession:hover{background:rgba(255,59,48,.16)}
#gt-ozet .section{font-size:10px; font-weight:600; letter-spacing:.4px; text-transform:uppercase; color:var(--gt-muted); margin-bottom:8px}
#gt-ozet .games{display:flex; flex-wrap:wrap; gap:7px}
#gt-ozet .game{padding:5px 12px; font-size:11.5px; font-weight:600; background:#fff;
  border:.5px solid rgba(0,0,0,.10); border-radius:20px; box-shadow:0 1px 2px rgba(0,0,0,.06)}
#gt-ozet .gameswrap{position:relative; overflow:hidden; max-height:1000px; transition:max-height .25s ease}
#gt-ozet .fade{position:absolute; left:0; right:0; bottom:0; height:26px; opacity:0; pointer-events:none;
  background:linear-gradient(to bottom, rgba(255,255,255,0), var(--fade) 80%); transition:opacity .2s, background .2s}
#gt-ozet .fade.on{opacity:1}
#gt-ozet .more{all:unset; display:none; align-items:center; justify-content:center; width:26px; height:16px;
  margin:6px auto 0; border-radius:8px; background:rgba(0,0,0,.05); border:.5px solid rgba(0,0,0,.09);
  color:var(--gt-muted); font-size:10px; font-weight:700; cursor:pointer}
#gt-ozet .more:hover{background:rgba(0,0,0,.10); color:var(--gt-ink-2)}
#gt-ozet .kyc{position:absolute; top:10px; right:10px; padding:6px 16px; border-radius:20px; font-size:13px;
  font-weight:700; letter-spacing:.3px; color:#fff; box-shadow:0 2px 6px rgba(0,0,0,.15)}

#gt-ozet .gto-actions{display:flex; flex-direction:column; align-items:stretch; gap:6px; flex-shrink:0}
#gt-reveal{all:unset; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; gap:5px;
  height:24px; padding:0 11px; border-radius:12px; border:.5px solid rgba(0,113,227,.28);
  background:var(--gt-accent-soft); color:var(--gt-accent); font-family:var(--gt-font);
  font-size:10.5px; font-weight:600; white-space:nowrap; cursor:pointer; transition:background .12s}
#gt-reveal:hover{background:rgba(0,113,227,.16)}
#gt-reveal svg{flex:none; width:13px; height:13px; margin:0; padding:0}
#gt-reveal span{all:unset; font:inherit; color:inherit; line-height:1; white-space:nowrap}
.gt-hidden-row{display:flex; justify-content:space-between; gap:12px; font-size:12px; padding:4px 0; border-bottom:.5px solid rgba(0,0,0,.04)}
.gt-hidden-row .k{color:var(--gt-muted); font-weight:600; flex-shrink:0}
.gt-hidden-row .v{text-align:right; word-break:break-all; display:flex; align-items:center; gap:5px}

#gt-lookup{display:inline-flex; align-items:center; gap:8px; margin-left:12px; vertical-align:middle; position:relative; top:2px}
#gt-lookup .lastbonus{font-family:var(--gt-font); font-size:12px; font-weight:500; color:var(--gt-accent); white-space:nowrap}
#gt-lookup .lastbonus b{font-weight:700}
#gt-lookup .lk{all:unset; display:inline-flex; align-items:center; gap:5px; padding:4px 11px; box-sizing:border-box;
  font-family:var(--gt-font); font-size:12px; font-weight:600; line-height:16px; white-space:nowrap;
  border-radius:20px; border:.5px solid; cursor:pointer;
  transition:background .15s, border-color .15s, transform .1s}
#gt-lookup .lk svg{width:12px; height:12px; flex:none}
#gt-lookup .lk:active{transform:scale(.97)}
#gt-lookup .lk.ip{background:rgba(255,59,48,.08); border-color:rgba(255,59,48,.35); color:var(--gt-danger)}
#gt-lookup .lk.ip:hover{background:rgba(255,59,48,.16); border-color:rgba(255,59,48,.5)}
#gt-lookup .lk.pt{background:rgba(0,113,227,.08); border-color:rgba(0,113,227,.35); color:#0071e3}
#gt-lookup .lk.pt:hover{background:rgba(0,113,227,.16); border-color:rgba(0,113,227,.5)}
#gt-lookup .lk.nm{background:rgba(52,199,89,.08); border-color:rgba(52,199,89,.35); color:var(--gt-success)}
#gt-lookup .lk.nm:hover{background:rgba(52,199,89,.16); border-color:rgba(52,199,89,.5)}

#gt-comments{position:fixed; top:20px; right:20px; width:340px; max-width:calc(100vw - 20px); max-height:70vh;
  background:rgba(255,255,255,.88); backdrop-filter:blur(20px) saturate(180%); -webkit-backdrop-filter:blur(20px) saturate(180%);
  border-radius:18px; box-shadow:0 10px 40px rgba(0,0,0,.18); z-index:999999; overflow:hidden;
  font-family:var(--gt-font); opacity:0; transform:translateY(-12px) scale(.98); transition:opacity .45s, transform .45s}
#gt-comments.in{opacity:1; transform:none}
#gt-comments.out{opacity:0; transform:translateY(-6px) scale(.96); pointer-events:none}
#gt-comments .h{display:flex; align-items:center; justify-content:space-between; padding:14px 16px 10px;
  border-bottom:1px solid rgba(0,0,0,.06); font-size:15px; font-weight:600}
#gt-comments .n{background:var(--gt-accent); color:#fff; font-size:11px; font-weight:700; border-radius:10px; padding:1px 7px; margin-left:6px}
#gt-comments .b{max-height:calc(70vh - 52px); overflow-y:auto; padding:8px 10px 12px}
#gt-comments .i{background:rgba(120,120,128,.08); border-radius:12px; padding:10px 12px; margin:6px 4px}
#gt-comments .t{display:flex; justify-content:space-between; font-size:11px; color:var(--gt-muted); margin-bottom:4px}
#gt-comments .s{font-weight:600; color:var(--gt-ink-2)}
#gt-comments .s.hot{color:var(--gt-danger); font-weight:800}
#gt-comments .c{font-size:13.5px; line-height:1.4; white-space:pre-wrap; word-break:break-word}
#gt-comments .g{margin-top:6px; font-size:10.5px; color:var(--gt-accent); font-weight:600}

img[src*="assets/flags/"]{width:18px !important; height:18px !important; border-radius:50% !important;
  object-fit:cover !important; object-position:center !important}
`);

const REFRESH_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

/* ════════════════════════════════════════════════════════════
   1 · TEMİZLİK — eski alanlar, eski tablolar, gereksiz widget'lar
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'player-declutter',
    match: at.playerDetail,
    source: 'player',
    setup(ctx) {
        const hide = (el) => el?.classList.add('gt-hidden-field');

        function sweepLabelled() {
            const touched = new Set();
            for (const cell of $$('td.text-xs-left')) {
                if (cell.closest('#gt-dash') || cell.classList.contains('gt-hidden-field')) continue;
                const label = txt(cell);
                if (!HIDE_LABELS.has(label)) continue;

                const value = cell.nextElementSibling;
                const edit = value?.nextElementSibling;
                hidden.set(label, { text: value ? txt(value) : '', pencil: edit?.querySelector('i.fa-pencil-square-o') || null });

                hide(cell); hide(value);
                if (edit?.querySelector('i.fa-pencil-square-o')) hide(edit);
                const row = cell.parentElement;
                if (label === 'Status' || label === 'Partyid') {
                    for (const gap of row.querySelectorAll('td.gap-30, td.gap-80')) hide(gap);
                }
                touched.add(row);
            }

            // Sadece boş kalan ayraç hücreleri kapanır. Satırın TAMAMINI
            // gizlemiyoruz: tek bir yanlış eşleşme sayfanın yarısını
            // götürebiliyor, kazancı da riskine değmiyor.
            for (const row of touched) {
                if (row?.tagName !== 'TR' || row.querySelector('#gt-dash')) continue;
                for (const gap of row.querySelectorAll('td.gap-30, td.gap-80')) {
                    if (!txt(gap) && !gap.querySelector('*')) hide(gap);
                }
            }
        }

        function sweepFlex() {
            for (const item of $$('div.td-flex-item')) {
                const label = txt(item.children[0]);
                if (!HIDE_LABELS.has(label)) continue;
                const value = item.children[1];
                hidden.set(label, { text: value ? txt(value) : '', pencil: value?.querySelector('i.fa-pencil-square-o') || null });
                hide(item);
            }
        }

        function sweepOldPanels() {
            // Eski Accounting başlığı — yerini yeni kart aldı
            for (const el of $$('td, th, div.underlined-header')) {
                if (el.closest('#gt-dash') || el.classList.contains('gt-hidden-field')) continue;
                const text = txt(el);
                const isHeader = el.classList.contains('underlined-header') ? /^Accounting\b/.test(text) : text === 'Accounting';
                if (!isHeader) continue;
                hide(el);
                if (el.tagName !== 'DIV') continue;
                const cell = el.parentElement;
                if (cell && /^(TH|TD)$/.test(cell.tagName)
                    && [...cell.children].every(c => c.classList.contains('gt-hidden-field'))) hide(cell);
            }
            // Eski mini giriş kayıtları tablosu
            for (const table of $$('table.player-login-logs-table')) {
                if (table.closest('#gt-dash')) continue;
                hide(table);
                if (table.parentElement?.tagName === 'TD') hide(table.parentElement);
            }
            for (const th of $$('th.player-login-logs-headers')) hide(th);
            // Grafik/özet widget'ları ve Revenue/LTD filtreleri
            for (const td of $$('td.churn-factor')) hide(td);
            // Tek sekmeli "TRY" para birimi sekmesi, Revenue grafiği ve eski
            // giriş kayıtlarının "More... / Failed Logins" bağlantıları
            const cellOf = (el) => { const td = el?.closest('td'); return td && !td.querySelector('#gt-dash') ? td : null; };
            for (const el of $$('player-revenue, a.failedLogins')) hide(cellOf(el));
            // Sekme grubunun TAMAMI değil: Bonuses/Transactions da aynı yapıda.
            // Sadece tek sekmeli para birimi grubunun (TRY) başlığı gizlenir.
            for (const group of $$('div.dashboard-tab-group mat-tab-group')) {
                const labels = group.querySelectorAll('.mat-tab-label');
                if (labels.length === 1 && /^[A-Z]{3}$/.test(txt(labels[0]))) hide(group.querySelector('mat-tab-header'));
            }
            for (const tag of ['login-device', 'player-financial', 'player-game-play-summary']) {
                for (const el of $$(tag)) hide(el.closest('td'));
            }
            for (const btn of $$('button.filter-dropdown')) {
                const label = txt(btn);
                if (!label.startsWith('Revenue') && !label.startsWith('LTD')) continue;
                (btn.closest('ss-multiselect-dropdown') || btn).classList.add('gt-hidden-field');
            }
            // Etiketi boş, değeri sadece ikon olan satırlar
            for (const cell of $$('td.text-xs-left')) {
                if (txt(cell) !== '') continue;
                const value = cell.nextElementSibling;
                if (!value?.querySelector('i.fa') || !value.classList.contains('gap-30')) continue;
                cell.remove(); value.remove();
            }
            for (const cell of $$('td.text-xs-left')) {
                if (txt(cell) !== 'Automation Withdrawals Processing' || cell.dataset.gtDone) continue;
                cell.dataset.gtDone = '1';
                hide(cell); hide(cell.nextElementSibling);
            }
        }

        ctx.tick(() => { sweepLabelled(); sweepFlex(); sweepOldPanels(); }, { lazy: true });

        /* Gizlenen bilgileri gösteren küçük buton — kimlik kartında,
           "Oturumu sonlandır"ın altında. Kart yeniden çizilirse geri konur. */
        ctx.mount('#gt-ozet .gto-actions', 'gt-reveal', () =>
            h('button', {
                type: 'button', title: 'Gizlenen alanları göster',
                html: ICON.eye + '<span>Bilgileri göster</span>',
                onclick: () => {
                    const rows = [...hidden.entries()];
                    const modal = ui.modal({ title: 'Gizlenen bilgiler', width: 420 }).open();
                    modal.html = rows.length
                        ? rows.map(([label, info], i) => `<div class="gt-hidden-row">
                             <span class="k">${esc(label)}</span>
                             <span class="v">${esc(info.text)}${info.pencil ? `<button type="button" class="gt-icon-btn" data-i="${i}">${ICON.pencil}</button>` : ''}</span>
                           </div>`).join('')
                        : ui.empty('Gizli alan bulunamadı.');
                    modal.body.addEventListener('click', (e) => {
                        const btn = e.target.closest('[data-i]');
                        if (!btn) return;
                        const info = rows[+btn.dataset.i]?.[1];
                        modal.close();
                        info?.pencil?.click();
                    });
                },
            }));
    },
});

/* ════════════════════════════════════════════════════════════
   2 · GÖSTERGE PANELİ — kimlik + hesap + giriş kayıtları
   Sayfanın bu bölgesinin TEK sahibi. Üç kart tek satırda durur,
   böylece yerleşim için birbiriyle yarışan panel kalmaz.
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'player-dashboard',
    match: at.playerDetail,
    key: () => api.partyId(),   // oyuncu değişince panel baştan kurulur
    source: 'player',
    setup(ctx) {
        const pid = api.partyId();
        if (!pid) return;

        const acc = { data: null, error: null, busy: false, at: null };
        const logs = { rows: null, error: null, busy: false, at: null, days: Number(pref('logDays', '7')), filter: pref('logFilter', 'LOGIN') };

        /* ── yerleşim ──
           Bilgi bloğu üç yoldan aranıyor: etiketlerin bir kısmı temizlik
           modülü tarafından gizlenmiş olabilir ve düzen tablo ya da flex
           olabilir. Üçü de tutmazsa panel sağ alta sabitlenir — görünmez
           kalmasındansa yanlış yerde durması yeğ. */
        function infoBlock() {
            const seen = new Set();
            for (const name of ['Status', 'Partyid', 'USERID']) {
                const snap = document.evaluate(
                    `//*[normalize-space(text())='${name}']`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < snap.snapshotLength; i++) {
                    const label = snap.snapshotItem(i);
                    if (!label || seen.has(label) || label.closest('#gt-dash')) continue;
                    seen.add(label);
                    let el = label.parentElement;
                    for (let depth = 0; el && el !== document.body && depth < 10; depth++, el = el.parentElement) {
                        if (el.querySelector('button.filter-dropdown')) break;
                        const text = el.textContent;
                        if (text.includes('USERID') && text.includes('EMAIL')) return el;
                    }
                }
            }
            const userId = $$('td.text-xs-left, div.td-flex-item > div, div').find(el => txt(el) === 'USERID');
            return userId?.closest('tr') || null;
        }

        /** Çapa bulunamadı: paneli sağ alta sabitle. */
        function floatPanel() {
            dash.classList.add('floating');
            if (dash.parentElement !== document.body) document.body.append(dash);
            document.getElementById('gt-dash-row')?.remove();
            warn('[Player] Bilgi bloğu bulunamadı — panel geçici olarak sağ alta sabitlendi, aramaya devam ediliyor.');
        }

        /** Paneli tablo sütunlarını bozmadan bilgi bloğunun altına koyar. */
        function place(dash, info) {
            const table = info.tagName === 'TABLE' ? null : info.closest('table');
            if (!table) { info.insertAdjacentElement('afterend', dash); return; }

            const isPageTable = table.querySelector('button.filter-dropdown, table.player-login-logs-table');
            if (!isPageTable) { table.insertAdjacentElement('afterend', dash); return; }

            const cols = Math.max(1, ...[...table.rows].map(r => [...r.cells].reduce((a, c) => a + c.colSpan, 0)));
            const cell = h('td', { colspan: cols, style: { padding: '0', border: '0', verticalAlign: 'top' } }, dash);
            const row = ctx.own(h('tr', { id: 'gt-dash-row' }, cell));

            const rows = info.tagName === 'TR' ? [info] : [...info.querySelectorAll('tr')];
            const anchor = rows.length ? rows[rows.length - 1] : info.closest('tr');
            anchor ? anchor.insertAdjacentElement('afterend', row) : info.insertAdjacentElement('afterend', dash);
        }

        /* ── kart iskeletleri ── */
        const card = (id, title) => h('section', { id, class: 'gtc gtc-pad' },
            h('div', { class: 'gtc-head' },
                h('div', {}, h('div', { class: 'gtc-title' }, title), h('div', { class: 'gtc-sub' })),
                h('button', { class: 'gtc-refresh', type: 'button', title: 'Yenile', html: REFRESH_SVG })),
            h('div', { class: 'gtc-toolbar' }),
            h('div', { class: 'gtc-content' }));

        const seg = (items, current, key) => items.map(([value, label]) =>
            `<button type="button" role="tab" aria-selected="${value === current}" data-${key}="${value}">${label}</button>`).join('');

        const ozet = h('section', { id: 'gt-ozet', class: 'gtc' },
            h('div', { style: { padding: '14px 16px', color: 'var(--gt-muted)', fontSize: '12px' } }, 'Kimlik yükleniyor…'));
        const accCard = card('gt-acc', 'Mali Tablo');
        const logCard = card('gt-logs', 'Giriş Kayıtları');
        const balCard = h('section', { id: 'gt-bal', class: 'gtc gtc-pad' },
            h('div', { class: 'gtc-head' },
                h('div', {}, h('div', { class: 'gtc-title' }, 'Cüzdan'), h('div', { class: 'gtc-sub' }, h('span', {}, 'TRY'))),
                h('div', { class: 'gtb-actions' }, BALANCE_BUTTONS.map(b => ui.button({
                    label: b.label, small: true,
                    title: b.key ? `${b.note.slice(0, 60)}… (${b.key.replace('alt+', 'Alt+').toUpperCase()})` : b.note,
                    onClick: () => balanceAdjust(b.note),
                })))),
            h('div', { class: 'gtc-content' }, h('div', { class: 'gtc-msg' }, 'Bakiye okunuyor…')));
        const dash = h('div', { id: 'gt-dash' }, ozet, balCard, accCard, logCard);

        /* ── Accounting ── */
        async function loadAcc() {
            acc.busy = true; acc.error = null; renderAcc();
            try { acc.data = await accounting(pid); acc.at = new Date(); }
            catch (e) { acc.error = e.message; }
            finally { acc.busy = false; renderAcc(); }
        }

        function renderAcc() {
            accCard.querySelector('.gtc-refresh').classList.toggle('busy', acc.busy);
            accCard.querySelector('.gtc-sub').innerHTML = `<span>TRY</span>${acc.at ? `<span>Güncellendi ${hhmm(acc.at)}</span>` : ''}`;

            const box = accCard.querySelector('.gtc-content');
            if (acc.error) { box.innerHTML = `<div class="gtc-msg err">${esc(acc.error)}</div>`; return; }
            if (!acc.data) { box.innerHTML = `<div class="gtc-msg">${acc.busy ? 'Yükleniyor…' : 'Veri yok.'}</div>`; return; }

            const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : 'z';
            const num = (n, extra = '') => `<span class="gta-n ${n ? '' : 'z'} ${extra}">${money(n)}</span>`;
            box.innerHTML = `<div class="gta">
              <div class="gta-head"><span></span><span>Yatırım</span><span>Çekim</span><span>Net</span></div>
              ${PERIODS.map(([key, label]) => {
                  const { dep, wd } = acc.data[key] || { dep: 0, wd: 0 };
                  const net = dep - wd;
                  return `<div class="gta-row${key === 'LTD' ? ' ltd' : ''}">
                    <span class="gta-lbl">${label}</span>${num(dep)}${num(wd)}${num(net, 'net ' + cls(net))}</div>`;
              }).join('')}
            </div>`;
        }

        /* ── giriş kayıtları ── */
        const IP_COLORS = ['#0071e3', '#bf5af2', '#ff9f0a', '#30b0c7', '#ff375f', '#34c759', '#8e8e93'];

        const osInfo = (raw, mobile) => {
            const s = raw.toLowerCase();
            if (/ios|iphone|ipad|ipod/.test(s)) return { label: 'iOS', icon: 'fa-apple', cls: 'ios' };
            if (/mac|os x/.test(s)) return { label: 'macOS', icon: 'fa-apple', cls: 'mac' };
            if (/android/.test(s)) return { label: 'Android', icon: 'fa-android', cls: 'android' };
            if (/win/.test(s)) return { label: 'Windows', icon: 'fa-windows', cls: 'win' };
            if (/linux|ubuntu|x11/.test(s)) return { label: 'Linux', icon: 'fa-linux', cls: 'linux' };
            return { label: raw || 'Bilinmiyor', icon: mobile ? 'fa-mobile' : 'fa-desktop', cls: '' };
        };

        const browserInfo = (raw) => {
            const s = raw.toLowerCase();
            if (/edg/.test(s)) return { label: 'Edge', icon: 'fa-edge' };
            if (/samsung/.test(s)) return { label: 'Samsung Internet', icon: 'fa-globe' };
            if (/opera|opr\//.test(s)) return { label: 'Opera', icon: 'fa-opera' };
            if (/firefox|fxios/.test(s)) return { label: 'Firefox', icon: 'fa-firefox' };
            if (/chrome|crios|chromium/.test(s)) return { label: 'Chrome', icon: 'fa-chrome' };
            if (/safari/.test(s)) return { label: /mobile/.test(s) ? 'Mobile Safari' : 'Safari', icon: 'fa-safari' };
            return { label: raw ? raw.slice(0, 24) : 'Bilinmiyor', icon: 'fa-globe' };
        };

        async function loadLogs() {
            logs.busy = true; logs.error = null; renderLogs();
            try {
                logs.rows = await loginLogs(pid, logs.days);
                logs.at = new Date();
                for (const ip of new Set(logs.rows.map(r => r.ip).filter(Boolean))) geoLookup(ip, renderLogs);
            } catch (e) { logs.error = e.message; }
            finally { logs.busy = false; renderLogs(); }
        }

        function locationCell(r) {
            if (!r.ip) return '';
            if (!isPrivateIp(r.ip)) {
                const g = geoOf(r.ip);
                if (g && !g.failed) {
                    const place = [g.city, g.region && g.region !== g.city ? g.region : '', g.cc].filter(Boolean).join(', ');
                    return `${esc(place || r.country)}${g.isp ? `<span class="gtl-isp"> · ${esc(g.isp)}</span>` : ''}`;
                }
                if (!g && geoPending.has(r.ip)) return 'Konum aranıyor…';
            }
            return esc(r.country);
        }

        function renderLogs() {
            if (!logCard.isConnected) return;
            logCard.querySelector('.gtc-refresh').classList.toggle('busy', logs.busy);
            logCard.querySelector('.gtc-toolbar').innerHTML = `
              <div class="gtc-segwrap"><div class="gtc-seg" role="tablist">${seg([['3', '3 gün'], ['7', '7 gün'], ['30', '30 gün']], String(logs.days), 'days')}</div></div>
              <div class="gtc-segwrap"><div class="gtc-seg" role="tablist">${seg([['LOGIN', 'Girişler'], ['ALL', 'Tümü']], logs.filter, 'filter')}</div></div>`;

            const sub = logCard.querySelector('.gtc-sub');
            const box = logCard.querySelector('.gtc-content');
            if (logs.error) { sub.innerHTML = ''; box.innerHTML = `<div class="gtc-msg err">${esc(logs.error)}</div>`; return; }
            if (!logs.rows) { sub.innerHTML = ''; box.innerHTML = `<div class="gtc-msg">${logs.busy ? 'Yükleniyor…' : 'Veri yok.'}</div>`; return; }

            const typed = logs.rows.some(r => r.type);
            const rows = (logs.filter === 'LOGIN' && typed) ? logs.rows.filter(r => r.type.startsWith('LOGIN')) : logs.rows;

            const colors = new Map();
            for (const r of rows) if (r.ip && !colors.has(r.ip)) colors.set(r.ip, IP_COLORS[colors.size % IP_COLORS.length]);

            sub.innerHTML = `<span>${rows.length} kayıt · ${colors.size} farklı IP</span>`
                + (logs.at ? `<span>Güncellendi ${hhmm(logs.at)}</span>` : '');

            if (!rows.length) { box.innerHTML = '<div class="gtc-msg">Bu aralıkta kayıt yok.</div>'; return; }

            const fmtTime = (d) => d.toLocaleTimeString('tr-TR', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
            const dayKey = (d) => d.toISOString().slice(0, 10);
            const today = dayKey(new Date());
            const yesterday = dayKey(new Date(Date.now() - 864e5));
            const dayLabel = (d) => {
                const k = dayKey(d);
                const base = d.toLocaleDateString('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long', weekday: 'long' });
                return k === today ? `Bugün · ${base}` : k === yesterday ? `Dün · ${base}` : base;
            };

            let lastDay = null;
            const html = [];
            for (const r of rows) {
                const d = r.time ? new Date(r.time) : null;
                const k = d ? dayKey(d) : '—';
                if (k !== lastDay) { lastDay = k; html.push(`<div class="gtl-day">${d ? dayLabel(d) : 'Tarihsiz'}</div>`); }

                const os = osInfo(r.os, r.mobile);
                const br = browserInfo(r.browser);
                const kind = /ipad|tablet/i.test(r.device + ' ' + r.os) ? 'Tablet' : r.mobile ? 'Mobil' : 'Masaüstü';
                const typePill = (logs.filter === 'ALL' && r.type)
                    ? `<span class="gtl-pill ${r.type.startsWith('LOGIN') ? 'in' : 'out'}">${r.type.startsWith('LOGIN') ? 'Giriş' : 'Çıkış'}</span>` : '';
                const failPill = r.failed ? '<span class="gtl-pill fail">Başarısız</span>' : '';
                html.push(`<div class="gtl-row${r.failed ? ' failed' : ''}">
                    <div class="gtl-time" title="${d ? esc(d.toISOString().replace('T', ' ').slice(0, 19)) + ' UTC' : ''}">${d ? fmtTime(d) : '—'}</div>
                    <div><div class="gtl-ip"><span class="gtl-dot" style="background:${colors.get(r.ip) || 'transparent'}"></span>
                        <span class="gtl-addr" title="${esc(r.ip)}">${esc(r.ip) || '—'}</span>${typePill}${failPill}</div>
                      <div class="gtl-loc">${locationCell(r)}</div></div>
                    <div class="gtl-meta" title="${esc(r.os || '')}"><i class="fa ${os.icon}"></i><div>${esc(os.label)}<small>${kind}</small></div></div>
                    <div class="gtl-meta" title="${esc(r.browser || '')}"><i class="fa ${br.icon}"></i><div>${esc(br.label)}</div></div>
                  </div>`);
            }
            box.innerHTML = `<div class="gtl-scroll">${html.join('')}</div>`;
        }

        /* ── kimlik kartı ── */
        function renderOzet({ p, photo, games }) {
            const name = [p?.firstName, p?.lastName].filter(Boolean).join(' ') || 'İsim bulunamadı';
            const meta = [p?.birthDate?.replace(/-/g, '.'), p?.city].filter(Boolean).join(' · ') || '—';
            const initials = ((p?.firstName || '')[0] || '') + ((p?.lastName || '')[0] || '');
            const joined = field('Joined');
            const userId = field('USERID');

            ozet.innerHTML = `
            <div class="top">
              ${photo ? `<img class="photo" src="${esc(photo)}" title="Büyütmek için tıkla">`
                      : `<div class="ph">${esc(initials.toUpperCase()) || '—'}</div>`}
              <div style="flex:1;min-width:0">
                <div class="names">
                  <span class="who">${esc(name)}</span>
                  ${p?.btag ? `<span class="gt-chip gt-chip--warn">${esc(p.btag)}</span>` : ''}
                  <span data-lock></span><span data-vip></span>
                </div>
                <div class="meta"><span>${esc(meta)}</span>${joined ? `<span>Katılım: ${esc(joined.text)}</span>` : ''}</div>
              </div>
            </div>
            <div class="body">
              <div class="ids">
                <div class="idcol contacts">
                  ${userId ? `<div class="idrow"><span class="idlabel">USERID</span><span class="val">${esc(userId.text)}</span></div>` : ''}
                  <div class="idrow"><span class="idlabel">PartyID</span><span class="val">${esc(pid)}</span>
                    <button type="button" class="copy" data-copy title="Kopyala">${ICON.copy}</button></div>
                  <div class="idcol" data-contacts></div>
                </div>
                <div class="gto-actions">
                  <button type="button" class="endsession" data-end>Oturumu sonlandır</button>
                </div>
              </div>
              <div class="section">Son 24 saatte oynanan oyunlar</div>
              <div class="gameswrap" data-open="0">
                <div class="games">${games.length
                    ? games.map(g => `<span class="game">${esc(g)}</span>`).join('')
                    : '<span style="color:#c7c7cc;font-size:12px">Son 24 saatte oyun oynanmamış.</span>'}</div>
                <div class="fade"></div>
              </div>
              <button type="button" class="more" title="Listeyi genişlet">v</button>
            </div>`;

            ozet.querySelector('.photo')?.addEventListener('click', () => {
                document.body.append(h('div', {
                    style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '999999' },
                    html: `<img src="${esc(photo)}" style="max-width:80vw;max-height:80vh;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.4)">`,
                    onclick: (e) => e.currentTarget.remove(),
                }));
            });

            ozet.querySelector('[data-copy]')?.addEventListener('click', (e) => {
                const btn = e.currentTarget;
                navigator.clipboard.writeText(String(pid)).then(() => {
                    btn.innerHTML = ICON.check; btn.style.color = 'var(--gt-success)';
                    setTimeout(() => { btn.innerHTML = ICON.copy; btn.style.color = ''; }, 1200);
                }).catch(err => oops('[Player] kopyalama:', err));
            });

            ozet.querySelector('[data-end]')?.addEventListener('click', () => {
                const icon = $$('td.text-xs-right.gap-30').map(td => td.querySelector('i.fa-times')).find(Boolean);
                icon ? icon.click() : warn('[Player] Oturum sonlandırma ikonu yok.');
            });

            requestAnimationFrame(foldGames);
        }

        function foldGames() {
            const wrap = ozet.querySelector('.gameswrap');
            const list = ozet.querySelector('.games');
            const fade = ozet.querySelector('.fade');
            const more = ozet.querySelector('.more');
            if (!wrap || !list || !fade || !more) return;

            const chips = $$('.game', list);
            const lines = [...new Set(chips.map(c => c.offsetTop))].sort((a, b) => a - b);
            if (!chips.length || lines.length <= 3) {
                more.style.display = 'none'; fade.classList.remove('on'); wrap.style.maxHeight = 'none';
                return;
            }
            const cut = lines[2];
            const height = chips.filter(c => c.offsetTop === cut)
                .reduce((max, c) => Math.max(max, c.offsetTop + c.offsetHeight), 0);
            more.style.display = 'flex';

            if (wrap.dataset.open === '1') {
                wrap.style.maxHeight = list.scrollHeight + 'px';
                fade.classList.remove('on'); more.textContent = '^'; more.title = 'Listeyi daralt';
            } else {
                wrap.style.maxHeight = height + 'px';
                fade.classList.add('on'); more.textContent = 'v'; more.title = 'Listeyi genişlet';
            }
        }

        /* ── canlı rozetler (lock / VIP / KYC) ── */
        let lastLock, lastVip, lastKyc;
        const editBtn = (kind) => `<button type="button" class="gt-icon-btn" data-edit="${kind}" title="Düzenle">${ICON.pencil}</button>`;

        const KYC_SKIN = {
            PASS:   { bg: 'rgba(52,199,89,.10)', border: 'rgba(52,199,89,.35)', fade: '#EBF9EE', color: 'rgb(52,199,89)', label: 'PASS' },
            OPEN:   { bg: 'rgba(255,59,48,.10)', border: 'rgba(255,59,48,.35)', fade: '#FFEBEA', color: 'rgb(255,59,48)', label: 'OPEN' },
            FAILED: { bg: 'rgba(255,59,48,.10)', border: 'rgba(255,59,48,.35)', fade: '#FFEBEA', color: 'rgb(255,59,48)', label: 'FAIL' },
        };

        function refreshBadges() {
            if (!ozet.isConnected) return;

            const lock = field('Lock Status');
            const lockEl = ozet.querySelector('[data-lock]');
            if (lockEl && lock?.text !== lastLock) {
                lastLock = lock?.text;
                const tone = !lock ? null
                    : lock.text.toUpperCase().includes('NOT_LOCKED') ? 'success'
                    : lock.text.toUpperCase().includes('LOCKED') ? 'danger' : 'muted';
                lockEl.innerHTML = lock ? `<span class="gt-chip gt-chip--${tone}">${esc(lock.text)}${editBtn('lock')}</span>` : '';
            }

            const vip = field('VIP');
            const vipEl = ozet.querySelector('[data-vip]');
            if (vipEl && vip?.text !== lastVip) {
                lastVip = vip?.text;
                vipEl.innerHTML = vip
                    ? `<span class="gt-chip gt-chip--vip">${VIP_ICON[vip.text.toUpperCase()] || '⭐'} ${esc(vip.text)}${editBtn('vip')}</span>` : '';
            }

            const kyc = field('KYC')?.text?.toUpperCase() || null;
            if (kyc !== lastKyc) {
                lastKyc = kyc;
                const skin = KYC_SKIN[kyc];
                if (skin) {
                    ozet.style.setProperty('background-color', skin.bg, 'important');
                    ozet.style.setProperty('border-color', skin.border, 'important');
                    ozet.style.setProperty('--fade', skin.fade);
                } else {
                    ozet.style.removeProperty('background-color');
                    ozet.style.removeProperty('border-color');
                    ozet.style.setProperty('--fade', '#fff');
                }
                ozet.querySelector('.kyc')?.remove();
                if (skin) ozet.append(h('div', { class: 'kyc', style: { background: skin.color }, title: `KYC: ${kyc}` }, skin.label));
            }
        }

        /* ── iletişim (e-posta / telefon) ──
           Sayfadaki hücreler Angular'ın; onlara dokunmuyoruz. İçeriklerinin
           KOPYASI kimlik kartına konur, asılları sadece CSS ile gizlenir.
           Asıl değişirse (Angular yeniden çizerse) kopya da yenilenir. */
        const outside = (el) => el && !el.closest('#gt-dash');
        const PHONE_MASK = /^\*{3,}\d{2,}$/;   // *********6181
        const MASKED = /\*{3,}/;

        /** Değerin solundaki etiket hücresi: boş, EMAIL yazan ya da telefon ikonlu. */
        const labelOf = (val) => {
            const l = val?.previousElementSibling;
            if (!l?.matches('td.text-xs-left, td.gap-30')) return null;
            const t = txt(l);
            return (t === '' || /^(e-?mail|phone|telefon)$/i.test(t)) ? l : null;
        };
        /** Değerin sağındaki ikon/işlem hücresi (bir sonraki telefonun etiketi değilse). */
        const extrasOf = (val) => {
            const n = val?.nextElementSibling;
            return n?.matches('td.gap-30') && !n.querySelector('i.fa-phone') ? n : null;
        };

        function findContacts() {
            const vals = $$('td.data.strong').filter(td => outside(td) && MASKED.test(txt(td)));
            const emailVal = vals.find(td => !PHONE_MASK.test(txt(td))) || null;
            const phoneVals = vals.filter(td => PHONE_MASK.test(txt(td)));
            const entry = (label, val) => {
                const lab = labelOf(val);
                const extra = extrasOf(val);
                // Etiket hücresinde ikon varsa (ör. fa-phone) o da kopyalanır.
                const icons = [lab?.children.length ? lab : null, extra].filter(Boolean);
                return { label, val, parts: [lab, val, extra].filter(Boolean), icons };
            };
            const out = [];
            if (emailVal) out.push(entry('E-posta', emailVal));
            // Numara birden fazla hücrede tekrarlanabiliyor (hep aynı) — kartta
            // tek satır gösterilir, kalanların hepsi yine de gizlenir.
            if (phoneVals.length) {
                const [first, ...rest] = phoneVals.map(v => entry('Telefon', v));
                first.icons = first.icons.filter(td => !td.querySelector('i.fa-phone'));
                first.parts.push(...rest.flatMap(r => r.parts));
                out.push(first);
            }
            // Telefon ikonlu etiket hücreleri — değerin hemen solunda olmasa da.
            const icons = $$('td.gap-30').filter(td => outside(td) && td.querySelector('i.fa-phone') && !txt(td));
            if (icons.length) (out.find(r => r.label === 'Telefon') || out[0])?.parts.push(...icons);
            return out;
        }

        /* Kopya → asıl eşlemesi. Kopyaya tıklanınca asıl (gizli) öğeye
           tıklanır; Angular'ın işleyicisi (resend activation, reset password…)
           orada çalışır. Asıl düğüm referans olarak değil "hücre + sıra" olarak
           tutulur: Angular hücrenin içini yeniden çizse de tıklama doğru yere gider. */
        const twin = new WeakMap();

        /** Hücrenin içeriğini kopyalar; tooltip metnini title'a taşır, her kopyayı aslına bağlar. */
        function copyOf(td) {
            const box = document.createElement('span');
            for (const n of td.childNodes) box.append(n.cloneNode(true));
            const origs = td.querySelectorAll('*');
            box.querySelectorAll('*').forEach((el, i) => {
                const orig = origs[i];
                twin.set(el, { td, i });
                const msgId = orig.getAttribute('aria-describedby');
                const tip = msgId && document.getElementById(msgId)?.textContent?.trim();
                if (tip) el.setAttribute('title', tip);
                for (const a of ['id', 'aria-describedby', 'cdk-describedby-host']) el.removeAttribute(a);
            });
            return box;
        }

        dash.addEventListener('click', (e) => {
            for (let el = e.target; el && el !== dash; el = el.parentElement) {
                const ref = twin.get(el);
                if (!ref) continue;
                e.preventDefault(); e.stopPropagation();
                const orig = ref.td.isConnected && ref.td.querySelectorAll('*')[ref.i];
                if (orig) orig.click();
                else warn('[Player] Kopyanın aslı sayfada yok (yeniden çiziliyor olabilir), tekrar dene.');
                return;
            }
        });

        let lastParts = [];
        function refreshContacts() {
            const slot = ozet.querySelector('[data-contacts]');
            if (!slot) return;

            const rows = findContacts();
            const parts = rows.flatMap(r => r.parts);
            for (const el of parts) el.classList.add('gt-hidden-field');

            // Angular hücreyi yeniden çizdiyse içerik aynı olsa bile düğümler
            // yenidir — eski kopyaların tıklaması boşa düşmesin diye yeniden kur.
            const sameNodes = parts.length === lastParts.length && parts.every((el, i) => el === lastParts[i]);
            const sig = parts.map(el => el.innerHTML).join('|');
            if (sameNodes && slot.dataset.sig === sig) return;
            lastParts = parts;
            slot.dataset.sig = sig;
            slot.textContent = '';

            for (const r of rows) {
                const icons = h('span', { class: 'icons' });
                for (const td of r.icons) icons.append(...copyOf(td).childNodes);
                slot.append(h('div', { class: 'idrow' },
                    h('span', { class: 'idlabel' }, r.label),
                    h('span', { class: 'val', title: txt(r.val) }, txt(r.val)),
                    icons));
            }
        }

        /* ── bakiye ──
           Değerler sayfadaki Balances satırlarından canlı okunur; kalem ve
           diğer ikonlar kopyalanır, tıklama aslına iletilir. Asıl satırlar
           ancak kart dolduktan sonra gizlenir. */
        const BAL_ROWS = ['Real Money', 'WD Bonus', 'Total WD', 'Playable Bonus', 'Pending Bonus', 'Loyalty Points'];
        const amount = (t) => {
            const n = Number(String(t).replace(/[^\d.-]/g, ''));
            return Number.isFinite(n) ? n : null;
        };

        function findBalances() {
            const out = [];
            for (const label of BAL_ROWS) {
                const lab = $$('td.text-xs-left').find(td => outside(td) && txt(td) === label);
                const val = lab?.nextElementSibling;
                if (!val) continue;
                const edit = val.nextElementSibling?.matches('td.gap-80, td.gap-30') ? val.nextElementSibling : null;
                out.push({ label, lab, val, edit });
            }
            return out;
        }

        let lastBal = [];
        function refreshBalance() {
            const box = balCard.querySelector('.gtc-content');
            const rows = findBalances();
            if (!rows.length) return;
            const parts = rows.flatMap(r => [r.lab, r.val, r.edit].filter(Boolean));
            const sameNodes = parts.length === lastBal.length && parts.every((el, i) => el === lastBal[i]);
            const sig = parts.map(el => el.innerHTML).join('|');
            if (sameNodes && box.dataset.sig === sig) return;
            lastBal = parts;
            box.dataset.sig = sig;

            const icons = (r) => {
                const wrap = h('span', { class: 'gtb-icons' });
                if (r.edit) wrap.append(...copyOf(r.edit).childNodes);
                return wrap;
            };
            const fmt = (r) => {
                const n = amount(txt(r.val));
                if (n === null) return { text: txt(r.val) || '—', zero: false };
                return { text: r.label === 'Loyalty Points' ? n.toLocaleString('tr-TR') : money(n), zero: n === 0 };
            };

            box.textContent = '';
            const [main, ...rest] = rows[0].label === 'Real Money' ? rows : [null, ...rows];
            if (main) {
                const v = fmt(main);
                box.append(h('div', { class: 'gtb-hero' },
                    h('div', {},
                        h('div', { class: 'gtb-cap' }, 'Bakiye'),
                        h('div', { class: 'gtb-big' + (v.zero ? ' z' : '') }, v.text, h('small', {}, 'TRY'))),
                    icons(main)));
            }
            box.append(h('div', { class: 'gtb-list' }, rest.map(r => {
                const v = fmt(r);
                return h('div', { class: 'gtb-row' },
                    h('span', { class: 'gtb-lbl' }, r.label),
                    h('span', { class: 'gtb-n' + (v.zero ? ' z' : '') }, v.text),
                    icons(r));
            })));

            for (const el of parts) el.classList.add('gt-hidden-field');
            $('div.underlined-header.balance-title')?.closest('th')?.classList.add('gt-hidden-field');
        }

        /* ── olaylar ── */
        accCard.addEventListener('click', (e) => {
            if (e.target.closest('button')?.classList.contains('gtc-refresh')) loadAcc();
        });

        logCard.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.classList.contains('gtc-refresh')) return void loadLogs();
            if (btn.dataset.days) { logs.days = Number(btn.dataset.days); setPref('logDays', btn.dataset.days); loadLogs(); }
            if (btn.dataset.filter) { logs.filter = btn.dataset.filter; setPref('logFilter', logs.filter); renderLogs(); }
        });

        ozet.addEventListener('click', (e) => {
            const more = e.target.closest('.more');
            if (more) {
                const wrap = ozet.querySelector('.gameswrap');
                wrap.dataset.open = wrap.dataset.open === '1' ? '0' : '1';
                foldGames();
                return;
            }
            const edit = e.target.closest('[data-edit]');
            if (!edit) return;
            e.stopPropagation();
            const info = field(edit.dataset.edit === 'vip' ? 'VIP' : 'Lock Status');
            info?.pencil ? info.pencil.click() : warn('[Player] Düzenleme ikonu bulunamadı.');
        });

        /* ── kurulum ── */
        ctx.own(dash);
        let placed = false;

        // Sağ alta sabitleme GEÇİCİ: sayfa yavaş yüklenip bilgi bloğu 4 sn'den
        // geç gelirse panel eskiden köşede kalıcı olarak kalıyordu. Artık
        // saniyede bir yeniden aranır, bulununca yerine taşınır.
        const since = Date.now();
        let lastTry = 0;
        ctx.tick(() => {
            const floating = dash.classList.contains('floating');
            if (!placed || !dash.isConnected || (floating && Date.now() - lastTry > 1000)) {
                lastTry = Date.now();
                const info = infoBlock();
                if (info) {
                    if (floating) { dash.classList.remove('floating'); log('[Player] Bilgi bloğu bulundu, panel yerine taşındı.'); }
                    place(dash, info); placed = true;
                }
                else if (!placed && Date.now() - since > 4000) { floatPanel(); placed = true; }
                else if (!placed) return;
            }
            refreshBadges();
        });

        if (!api.token()) {
            ozet.innerHTML = '<div style="padding:14px 16px;color:var(--gt-muted);font-size:12px">Oturum token bulunamadı, sayfayı yenile.</div>';
            return;
        }

        ctx.tick(refreshContacts, { lazy: true });
        ctx.tick(refreshBalance, { lazy: true });

        loadAcc();
        loadLogs();
        Promise.all([profile(pid), portrait(pid), games24h(pid)]).then(([p, photo, games]) => {
            if (!ozet.isConnected) return;
            renderOzet({ p, photo, games });
            lastLock = lastVip = lastKyc = undefined;
            refreshBadges();
        });
    },
});

/* ════════════════════════════════════════════════════════════
   3 · BAKİYE SIFIRLAMA (Alt+O / Alt+Q / Alt+W)
   NOT: Eski "ÜST" kısayolu Alt+A idi ve AI ÖZET'in panel kısayolu
   ile çakışıyordu — aynı tuş hem paneli açıp hem bakiye düşürme
   deniyordu. ÜST artık Alt+Ü (KeyBracketLeft yerine Semicolon
   kullanan klavyelerde buton her zaman elle basılabilir).
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'player-balance',
    match: at.playerDetail,
    source: 'player',
    setup(ctx) {
        for (const b of BALANCE_BUTTONS) if (b.key) ctx.hotkey(b.key, () => balanceAdjust(b.note));

        // Bakiye kartı yoksa (panel kurulamadıysa) butonlar eski başlıkta kalsın.
        ctx.mount('div.underlined-header.balance-title', 'gt-balance', (header) => {
            header.style.display = 'flex';
            header.style.alignItems = 'center';
            return h('span', { style: { display: 'inline-flex', gap: '4px', marginLeft: '12px', verticalAlign: 'middle' } },
                BALANCE_BUTTONS.map(b => ui.button({
                    label: b.label, small: true,
                    title: b.key ? b.key.replace('alt+', 'Alt+').toUpperCase() : 'Üst bakiye düzeltmesi',
                    onClick: () => balanceAdjust(b.note),
                })));
        });
    },
});

/* ════════════════════════════════════════════════════════════
   4 · IP (duplicate) + PT (bonus/deposit/withdrawal özeti)
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'player-lookup',
    match: at.playerDetail,
    key: () => api.partyId(),
    source: 'player',
    setup(ctx) {
        const pid = api.partyId();
        const clickEl = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        /* duplicate bulunan hesabı arama sayfasında aç */
        function pickDropdown(btn, label, done) {
            if (btn.textContent.includes(label)) return done();
            clickEl(btn);
            setTimeout(() => {
                clickEl($$('a, li').find(el => txt(el) === label && el.offsetParent));
                setTimeout(done, 200);
            }, 250);
        }

        function search(id) {
            let tries = 0;
            const timer = setInterval(() => {
                const input = $('input.player-search-criteria');
                const dropdowns = $$('button.dropdown-toggle');
                const go = $$('button, span').find(el => txt(el) === 'Go' && el.offsetParent);
                if (input && dropdowns.length >= 2 && go) {
                    clearInterval(timer);
                    pickDropdown(dropdowns[0], 'Party Id', () => pickDropdown(dropdowns[1], 'Equals', () => {
                        input.value = id;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        setTimeout(() => clickEl(go.closest('button') || go), 300);
                    }));
                } else if (++tries > 30) { clearInterval(timer); oops('[Lookup] Arama formu bulunamadı.'); }
            }, 200);
        }

        function goSearch(id) {
            if (location.pathname.includes('/players/search')) return search(id);
            $('a[routerlink="/app/core/players/search"]')?.click();
            let tries = 0;
            const timer = setInterval(() => {
                if ((location.pathname.includes('/players/search') && $('input.player-search-criteria')) || ++tries > 25) {
                    clearInterval(timer);
                    search(id);
                }
            }, 200);
        }

        const PERSON_ICON = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>`;

        /** IP ve NAME sonuçları aynı kartla gösteriliyor. */
        function renderAccounts(modal, rows, { tone, note }) {
            modal.html = `
            <div style="margin-bottom:12px;color:var(--gt-muted);font-size:13px">
              <b style="color:var(--gt-ink)">${rows.length} hesap</b> bulundu${note ? ` · ${esc(note)}` : ''}</div>
            ${rows.map((r, i) => `
              <div class="dup" data-party="${r.id}" style="padding:12px 16px;margin:8px 0;
                   background:linear-gradient(135deg,#f5f5f7,#fff);border:1px solid rgba(0,0,0,.06);
                   border-radius:12px;display:flex;justify-content:space-between;align-items:center;cursor:pointer">
                <div style="display:flex;align-items:center;gap:12px;pointer-events:none">
                  <span class="gt-num" style="background:${tone};color:#fff;width:28px;height:28px;border-radius:8px;
                        display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600">${i + 1}</span>
                  <div><div style="font-weight:600">${esc(r.id)}</div>
                       <div style="color:var(--gt-muted);font-size:12px;margin-top:2px">${esc(r.first)} ${esc(r.last)}</div>
                       <div class="plans" style="margin-top:4px"><span style="color:#ccc;font-size:10px">⏳</span></div></div>
                </div>
                <span class="arrow" style="color:${tone};font-size:12px;pointer-events:none">→</span>
              </div>`).join('')}
            <div style="margin-top:20px;padding:12px;background:var(--gt-accent-soft);border-radius:10px;
                 font-size:12px;color:var(--gt-accent);text-align:center">İlk satır bu hesap. Aramak için satıra tıkla.</div>`;

            modal.body.addEventListener('click', (e) => {
                const row = e.target.closest('.dup');
                if (!row) return;
                row.querySelector('.arrow').textContent = '✓';
                modal.close();
                setTimeout(() => goSearch(row.dataset.party), 250);
            });

            for (const r of rows) {
                bonusPlanNames(r.id).then(names => {
                    const box = modal.body.querySelector(`[data-party="${r.id}"] .plans`);
                    if (!box) return;
                    box.innerHTML = names.length
                        ? names.map(n => `<span style="display:inline-block;background:var(--gt-accent-soft);
                            color:var(--gt-accent);border-radius:4px;padding:1px 6px;font-size:10px;margin:1px 1px 0 0">${esc(n)}</span>`).join('')
                        : '<span style="color:#ccc;font-size:10px">—</span>';
                });
            }
        }

        async function showDuplicates() {
            const modal = ui.modal({ title: 'Aynı IP\'deki hesaplar', icon: '🔍', width: 650 }).open();
            modal.html = ui.spinner('Aranıyor…');
            try {
                const rows = await duplicateRows(pid, { checkIp: 'true' });
                if (!rows.length) { modal.html = ui.empty('Aynı IP\'yi paylaşan başka hesap yok.'); return; }
                renderAccounts(modal, rows, { tone: 'var(--gt-accent)' });
            } catch (e) { modal.html = ui.error(e.message); }
        }

        /** Aynı ad + soyada kayıtlı hesaplar. Sunucu gevşek eşleşme
         *  döndürebildiği için sonucu normalleştirilmiş tam eşleşmeye süzüyoruz. */
        async function showSameName() {
            const modal = ui.modal({ title: 'Aynı isimli hesaplar', icon: '👥', width: 650 }).open();
            modal.html = ui.spinner('Aranıyor…');
            try {
                const all = await duplicateRows(pid, { checkFirstName: 'true', checkLastName: 'true' });
                const self = all.find(r => r.id === String(pid)) || all[0];
                if (!self) { modal.html = ui.empty('Kayıt bulunamadı.'); return; }

                const first = normalizeName(self.first);
                const last = normalizeName(self.last);
                const matches = all
                    .filter(r => normalizeName(r.first) === first && normalizeName(r.last) === last)
                    .sort((a, b) => (a.id === self.id ? -1 : b.id === self.id ? 1 : 0));

                if (matches.length <= 1) {
                    modal.html = ui.empty(`"${self.first} ${self.last}" adına kayıtlı başka hesap yok — ${all.length} kayıt tarandı.`);
                    return;
                }
                renderAccounts(modal, matches, {
                    tone: 'var(--gt-success)',
                    note: `"${self.first} ${self.last}" · ${all.length} kayıt tarandı`,
                });
            } catch (e) { modal.html = ui.error(e.message); }
        }

        async function showSummary() {
            const modal = ui.modal({ title: 'Genel özet', icon: '📊', width: 650 }).open();
            modal.html = ui.spinner();
            try {
                const [all, deposit, withdrawal] = await Promise.all([bonuses(pid), lastDeposit(pid), lastWithdrawal(pid)]);
                const list = (deposit
                    ? all.filter(b => (parseStamp(b.triggerDate)?.getTime() ?? -1) > deposit.processDate)
                    : all).slice(0, 10);

                const depDate = deposit?.processDateStr
                    ? deposit.processDateStr.replace(/(\d{4})-(\d{2})-(\d{2}) (.*)/, '$3-$2-$1 $4 UTC') : '—';

                const box = (date, method, amount, color, bg, border) => `
                <div style="padding:14px 16px;background:${bg};border:1px solid ${border};border-radius:12px;
                     display:flex;justify-content:space-between;align-items:center">
                  <div><div style="font-weight:600;font-size:13px">${esc(date)}</div>
                       <div style="color:var(--gt-muted);font-size:11px;margin-top:2px">${esc(method || '—')}</div></div>
                  <div style="color:${color};font-size:15px;font-weight:700">${esc(amount)}</div></div>`;

                modal.html = `
                <div style="margin-bottom:10px;font-weight:600;font-size:13px">💰 Son başarılı yatırım</div>
                ${deposit ? box(depDate, deposit.methodName, deposit.amount, '#28a745',
                    'linear-gradient(135deg,rgba(40,167,69,.08),rgba(40,167,69,.02))', 'rgba(40,167,69,.2)')
                  : ui.empty('Son 90 günde tamamlanmış yatırım yok')}

                <div style="margin:20px 0 10px;font-weight:600;font-size:13px">🏧 Son başarılı çekim</div>
                ${withdrawal ? box(withdrawal.processDate || '—', withdrawal.method, withdrawal.amount, '#dc3545',
                    'linear-gradient(135deg,rgba(220,53,69,.08),rgba(220,53,69,.02))', 'rgba(220,53,69,.2)')
                  : ui.empty('Son 180 günde tamamlanmış çekim yok')}

                <div style="margin:20px 0 10px;font-weight:600;font-size:13px">🎁 ${deposit
                    ? `Yatırım sonrası alınan bonuslar (${list.length})`
                    : `Son ${list.length} bonus (yatırım bulunamadı)`}</div>
                ${list.length ? list.map((b, i) => `
                  <div style="padding:10px 14px;margin:6px 0;background:linear-gradient(135deg,#f5f5f7,#fff);
                       border:1px solid rgba(0,0,0,.06);border-radius:12px;display:flex;align-items:center;gap:12px">
                    <span class="gt-num gt-num--sm" style="background:var(--gt-accent);color:#fff;width:24px;height:24px;border-radius:8px;
                          display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${i + 1}</span>
                    <div><div style="font-weight:600;font-size:13px">${esc(b.planName || '—')}</div>
                         <div style="color:var(--gt-muted);font-size:11px;margin-top:2px">${esc(b.triggerDate || '—')} · ${esc(b.status || '—')}</div></div>
                  </div>`).join('') : ui.empty('Bonus geçmişi yok')}`;
            } catch (e) { modal.html = ui.error(e.message); }
        }

        ctx.hotkey('alt+p', showDuplicates);
        ctx.hotkey('alt+n', showSameName);

        const lookupBtn = (cls, icon, label, title, run) => h('button', {
            type: 'button', class: `lk ${cls}`, title, html: icon + `<span>${label}</span>`,
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); run(); },
        });

        ctx.mount(
            () => $$('mat-label').find(el => /Select Tag|Etiket Seç/.test(el.textContent))
                    ?.closest('.mat-form-field-infix, .mat-mdc-form-field-infix, .mat-form-field-flex'),
            'gt-lookup',
            () => {
                const label = h('span', { class: 'lastbonus' });
                bonuses(pid).then(list => { label.innerHTML = `<b>Son bonus:</b> ${esc(list[0]?.planName || '—')}`; }).catch(() => {});
                return h('span', {},
                    lookupBtn('ip', ICON.search, 'IP', 'Aynı IP\'deki hesaplar (Alt+P)', showDuplicates),
                    lookupBtn('pt', ICON.search, 'PT', 'Bonus + yatırım + çekim özeti', showSummary),
                    lookupBtn('nm', PERSON_ICON, 'NAME', 'Aynı ad soyadlı hesaplar (Alt+N)', showSameName),
                    label);
            },
        );
    },
});

/* ════════════════════════════════════════════════════════════
   5 · YORUM POPUP'I — oyuncuda yorum varsa otomatik açılır
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'player-comments',
    match: at.playerDetail,
    key: () => api.partyId(),
    source: 'player',
    setup(ctx) {
        const pid = api.partyId();
        let shown = false;

        const drop = () => document.getElementById('gt-comments')?.remove();

        function render(list) {
            drop();
            const root = ctx.own(h('div', { id: 'gt-comments' },
                h('div', { class: 'h' },
                    h('div', {}, 'Yorumlar', h('span', { class: 'n' }, list.length)),
                    h('button', { class: 'gt-pop__x', type: 'button', onclick: () => { root.classList.remove('in'); setTimeout(drop, 250); } }, '✕')),
                h('div', {
                    class: 'b',
                    html: [...list].sort((a, b) => new Date(b.date) - new Date(a.date)).map(c => {
                        const [name, hot] = STAFF[c.staffName] || [c.staffName || '—', false];
                        const tags = (c.tags || '').trim();
                        return `<div class="i">
                          <div class="t"><span class="s${hot ? ' hot' : ''}">${esc(name)}</span><span>${esc(c.date || '')}</span></div>
                          <div class="c">${esc(c.comment || '')}</div>
                          ${tags ? `<div class="g">${esc(tags)}</div>` : ''}</div>`;
                    }).join(''),
                })));
            document.body.append(root);
            requestAnimationFrame(() => root.classList.add('in'));
            setTimeout(() => { root.classList.add('out'); setTimeout(drop, 700); }, 10000);
        }

        function commentsTab() {
            for (const icon of $$('mat-icon.fa-comment.pin-tabs')) {
                const box = icon.closest('div');
                if (box && /COMMENTS/i.test(box.textContent)) return box;
            }
            return null;
        }

        ctx.tick(() => {
            if (shown || !pid) return;
            const tab = commentsTab();
            if (!tab) return;
            const count = Number(tab.textContent.match(/COMMENTS\s*\((\d+)\)/i)?.[1] || 0);
            if (!count) return;
            shown = true;
            api.json(api.ics(`players/${pid}/comment/`), { ttl: 30000 })
                .then(list => { if (Array.isArray(list) && list.length) render(list); })
                .catch(e => oops('[Yorumlar]', e));
        }, { lazy: true });
    },
});

/* ════════════════════════════════════════════════════════════
   6 · OPEN / PASS VURGUSU
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'player-status',
    match: at.playerDetail,
    source: 'player',
    setup(ctx) {
        const SEL = '.player-table > tbody:nth-child(1) > tr:nth-child(6) > td:nth-child(2)';
        ctx.tick(() => {
            const cell = $(SEL);
            if (!cell) return;
            const value = txt(cell).toUpperCase();
            if (cell.dataset.gtStatus === value) return;
            cell.dataset.gtStatus = value;
            Object.assign(cell.style, {
                fontWeight: 'bold', fontSize: '13px', textAlign: 'center', borderRadius: '4px', padding: '2px 8px',
                color: (value === 'OPEN' || value === 'PASS') ? '#fff' : '',
                backgroundColor: value === 'OPEN' ? '#FF3B30' : value === 'PASS' ? '#34C759' : '',
            });
        });
    },
});

log('GT Player v1.0.0 kayıtlı.');

});
})();
