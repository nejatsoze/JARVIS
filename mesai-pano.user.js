// ==UserScript==
// @name         Mesai Panosu — canlı giriş / mola / çıkış tablosu
// @namespace    palentis.mesai-pano
// @version      1.0.0
// @description  C08PZGND15G kanalındaki giriş, mola (m1 10, m2 30, m10, m30, ym, Mola) ve çıkış mesajlarını okuyup haftalık vardiya programıyla birleştirir; C0C87GMFWSZ'deki tek bir mesajı dakikada bir hareketli tablo (GIF) olarak günceller. Haftalık program Tampermonkey menüsünden tablo yapıştırılarak girilir.
// @match        https://app.slack.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @require      https://cdn.jsdelivr.net/npm/omggif@1.0.10/omggif.js
// @connect      files.slack.com
// @connect      slack.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * KAYNAK KANAL (C08PZGND15G) — mesaj biçimleri (gerçek kanal örneklerinden):
 *   "Giriş" / "giriş"            → mesai başladı
 *   "Çıkış" / "çıkış"            → mesai bitti
 *   "m1 10", "m2 30", "m10", "m30" → mola, süre dakikada (son sayı)
 *   "ym"                          → yemek molası (30 dk sayılır)
 *   "Mola"                        → süresiz mola
 *   Moladan dönüş: kişinin KENDİ mola mesajının thread'ine yazdığı yanıt ("+", ".", "geldim"…).
 *   Yanıtta "mola" geçerse (ör. "+kmola") dönüş + yeni süresiz mola; sonraki yanıt dönüş.
 *   Vardiyalar gece yarısını geçtiği için durum takvim gününe değil son "Giriş"e göredir.
 *
 * PANO (C0C87GMFWSZ): tek mesaj, içinde image bloğu. Her güncellemede GIF önce panonun
 * thread'ine yüklenir (kanala düşmez), mesajdaki resim yenisiyle değiştirilir, eskisi silinir.
 *
 * PROGRAM: menü → "Haftalık programı yapıştır". Excel / Sheets'ten tablo hücreleri kopyalanıp
 * yapıştırılır (ekip satırları, gün başlıkları, "OFF", "14:00 - 02:00").
 */

(() => {
'use strict';

const CONFIG = {
    SOURCE: 'C08PZGND15G',
    BOARD: 'C0C87GMFWSZ',
    POLL_SEC: 30,
    REFRESH_SEC: 60,
    LOOKBACK_H: 30,
    LATE_GRACE_MIN: 5,
    YM_MIN: 30,
    WIDTH: 900,
};

const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Mesai Panosu]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ════════════════ zaman (TR = UTC+3, yaz saati yok) ════════════════ */
const TR = 3 * 3600e3, DAY = 864e5, MIN = 60000;
const p2 = (n) => String(n).padStart(2, '0');
const trDayStart = (ms) => Math.floor((ms + TR) / DAY) * DAY - TR;
const hm = (ms) => { const d = new Date(ms + TR); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
/** "18:00" + 'de' → "18:00'de", "14:13" + 'den' → "14:13'ten" (okunuşun son kelimesine göre ünlü ve ünsüz uyumu). */
function trSuffix(time, base) {
    const [h, m] = time.split(':').map(Number);
    const n = m ? m : h;
    // [kalın ünlü mü, sert ünsüzle mi bitiyor]
    const UNIT = { 1: [0, 0], 2: [0, 0], 3: [0, 1], 4: [0, 1], 5: [0, 1], 6: [1, 0], 7: [0, 0], 8: [0, 0], 9: [1, 0] };
    const TENS = { 0: [1, 0], 10: [1, 0], 20: [0, 0], 30: [1, 0], 40: [1, 1], 50: [0, 0] };
    const [back, hard] = n % 10 ? UNIT[n % 10] : TENS[n] || [1, 0];
    const v = back ? 'a' : 'e', c = hard ? 't' : 'd';
    return `${time}'${c}${v}${base === 'den' ? 'n' : ''}`;
}
const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const dayLabel = (ms) => { const d = new Date(ms + TR); return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)} ${DAYS[d.getUTCDay()]}`; };
const fold = (s) => String(s || '').toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/* ════════════════ Slack API (açık sekmenin oturumu) ════════════════ */
let token = null;
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
    const cands = collectTokens();
    if (!cands.length) throw new Error('Slack oturum anahtarı bulunamadı');
    for (const t of cands) {
        try {
            const a = await call('conversations.info', { channel: CONFIG.SOURCE }, t);
            const b = await call('conversations.info', { channel: CONFIG.BOARD }, t);
            if (a.ok && b.ok) { token = t; return; }
        } catch { /* sonraki */ }
    }
    throw new Error(`oturum ${CONFIG.SOURCE} ve ${CONFIG.BOARD} kanallarını göremiyor (ikisinin de üyesi misin?)`);
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

/* ════════════════ kişiler ════════════════ */
const users = new Map();   // id → ad
async function userName(id) {
    if (users.has(id)) return users.get(id);
    try {
        const r = await api('users.info', { user: id });
        const p = r.user?.profile || {};
        const n = p.display_name || p.real_name || r.user?.name || id;
        users.set(id, n);
        return n;
    } catch { users.set(id, id); return id; }
}

/* ════════════════ kaynak kanalı okuma ve ayrıştırma ════════════════ */
function classify(text) {
    const t = fold(text).replace(/\s+/g, ' ');
    if (/^giris\b/.test(t)) return { kind: 'in' };
    if (/^cikis\b/.test(t)) return { kind: 'out' };
    if (/^ym\b/.test(t)) return { kind: 'break', label: 'ym', dur: CONFIG.YM_MIN };
    let m = t.match(/^m(\d)\s+(\d{1,3})\b/);                  // m1 10, m2 30
    if (m) return { kind: 'break', label: `m${m[1]} ${m[2]}`, dur: +m[2] };
    m = t.match(/^m\s?(\d{2,3})\b/);                         // m10, m30
    if (m) return { kind: 'break', label: `m${m[1]}`, dur: +m[1] };
    if (/^mola\b/.test(t)) return { kind: 'break', label: 'Mola', dur: null };
    return null;
}

const replyCache = new Map();   // ts → { latest, replies }
async function loadEvents() {
    const oldest = String((Date.now() - CONFIG.LOOKBACK_H * 3600e3) / 1000);
    let msgs = [], cursor;
    for (let i = 0; i < 5; i++) {
        const r = await api('conversations.history', { channel: CONFIG.SOURCE, oldest, limit: '200', ...(cursor ? { cursor } : {}) });
        msgs = msgs.concat(r.messages || []);
        cursor = r.response_metadata?.next_cursor;
        if (!r.has_more || !cursor) break;
    }
    const events = [];
    for (const m of msgs) {
        if (!m.user || m.subtype) continue;
        const c = classify(m.text);
        if (!c) continue;
        const at = Math.round(parseFloat(m.ts) * 1000);
        if (c.kind !== 'break') { events.push({ user: m.user, at, kind: c.kind }); continue; }
        events.push({ user: m.user, at, kind: 'break', label: c.label, dur: c.dur });
        if (m.reply_count) {
            const key = m.ts, latest = m.latest_reply || '';
            let entry = replyCache.get(key);
            if (!entry || entry.latest !== latest) {
                const r = await api('conversations.replies', { channel: CONFIG.SOURCE, ts: m.ts, limit: '20' });
                entry = { latest, replies: (r.messages || []).slice(1).filter(x => x.user === m.user) };
                replyCache.set(key, entry);
            }
            let open = true;
            for (const y of entry.replies) {
                const yat = Math.round(parseFloat(y.ts) * 1000);
                if (open) { events.push({ user: m.user, at: yat, kind: 'back' }); open = false; }
                if (/mola/.test(fold(y.text))) { events.push({ user: m.user, at: yat + 1, kind: 'break', label: 'kmola', dur: null }); open = true; }
            }
        }
    }
    for (const k of replyCache.keys()) if (parseFloat(k) * 1000 < Date.now() - (CONFIG.LOOKBACK_H + 6) * 3600e3) replyCache.delete(k);
    return events.sort((a, b) => a.at - b.at);
}

/** Kişi başına son vardiya durumu. */
function sessions(events) {
    const by = new Map();
    for (const e of events) {
        let s = by.get(e.user);
        if (e.kind === 'in') { s = { user: e.user, in: e.at, out: null, breaks: [], state: 'in' }; by.set(e.user, s); continue; }
        if (!s) { s = { user: e.user, in: null, out: null, breaks: [], state: 'in' }; by.set(e.user, s); }
        if (e.kind === 'out') { s.out = e.at; s.state = 'out'; const b = s.breaks.at(-1); if (b && !b.end) b.end = e.at; }
        else if (e.kind === 'break') { const b = s.breaks.at(-1); if (b && !b.end) b.end = e.at; s.breaks.push({ label: e.label, dur: e.dur, start: e.at, end: null }); if (s.state !== 'out') s.state = 'break'; }
        else if (e.kind === 'back') { const b = s.breaks.at(-1); if (b && !b.end) b.end = e.at; if (s.state === 'break') s.state = 'in'; }
    }
    return by;
}

/* ════════════════ haftalık program ════════════════ */
/** schedules: [{ weekStart (TR Pazartesi 00:00 ms), teams: [{ name, people: [{ name, days: [7 × 'OFF' | 'HH:MM - HH:MM' | ''] }] }] }] */
const getSchedules = () => GM_getValue('schedules', []);
const DAY_RE = /^(pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)$/;

function parseSchedule(text, fallbackWeekStart) {
    const rows = text.replace(/\r/g, '').split('\n').map(l => l.split('\t').map(c => c.trim()));
    let weekStart = null, dayCols = null;
    const teams = [];
    let team = null;
    for (const r of rows) {
        if (!r.some(Boolean)) continue;
        // başlık satırı: "Haftalık Program | 75 | 05.10 | 11.10"
        if (!weekStart) {
            const dm = r.map(c => c.match(/^(\d{1,2})\.(\d{1,2})$/)).find(Boolean);
            if (dm && /program/i.test(r.join(' '))) {
                const now = new Date(Date.now() + TR);
                let y = now.getUTCFullYear();
                if (+dm[2] === 1 && now.getUTCMonth() === 11) y++;
                weekStart = Date.UTC(y, +dm[2] - 1, +dm[1]) - TR;
                continue;
            }
        }
        // gün başlıkları: "Admin | 05 PAZARTESİ | 06 SALI …" — ilk hücre aynı zamanda ilk ekip
        const dayIdx = r.map((c, i) => (DAY_RE.test(fold(c).replace(/^\d+\s*/, '')) ? i : -1)).filter(i => i >= 0);
        if (dayIdx.length >= 5) {
            dayCols = dayIdx.slice(0, 7);
            if (r[0] && dayIdx[0] !== 0) { team = { name: r[0], people: [] }; teams.push(team); }
            continue;
        }
        const cells = (dayCols || [1, 2, 3, 4, 5, 6, 7]).map(i => r[i] || '');
        const filled = cells.filter(Boolean).length;
        if (r[0] && filled === 0) { team = { name: r[0], people: [] }; teams.push(team); continue; }   // ekip bandı
        if (!r[0] || filled === 0) continue;
        const days = cells.map(c => (/^off$/i.test(c) ? 'OFF' : (c.match(/^(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})$/) ? c.replace(/\./g, ':').replace(/\s*[-–]\s*/, ' - ') : '')));
        if (!team) { team = { name: '', people: [] }; teams.push(team); }
        team.people.push({ name: r[0], days });
    }
    return { weekStart: weekStart ?? fallbackWeekStart, teams: teams.filter(t => t.people.length) };
}

/** Şu an için kişinin ilgili vardiyası: dünkü vardiya hâlâ sürüyorsa o, değilse bugünkü. */
function shiftFor(person, sched, now) {
    const at = (dayStart) => {
        const s = sched.find(x => dayStart >= x.weekStart && dayStart < x.weekStart + 7 * DAY);
        if (!s) return null;
        for (const t of s.teams) {
            const p = t.people.find(q => fold(q.name) === fold(person));
            if (p) {
                const raw = p.days[Math.round((dayStart - s.weekStart) / DAY)] || '';
                if (raw === 'OFF') return { off: true, text: 'OFF' };
                const m = raw.match(/^(\d{1,2}):(\d{2}) - (\d{1,2}):(\d{2})$/);
                if (!m) return null;
                const start = dayStart + (+m[1] * 60 + +m[2]) * MIN;
                let end = dayStart + (+m[3] * 60 + +m[4]) * MIN;
                if (end <= start) end += DAY;
                return { start, end, text: raw };
            }
        }
        return null;
    };
    const today = trDayStart(now);
    const y = at(today - DAY);
    if (y && !y.off && y.end > now) return y;
    return at(today);
}

/* ════════════════ pano modeli ════════════════ */
async function buildModel() {
    const now = Date.now();
    const sess = sessions(await loadEvents());
    const sched = getSchedules();
    const current = sched.find(x => now >= x.weekStart && now < x.weekStart + 7 * DAY) || null;

    // Slack id → ad
    const nameOf = new Map();
    for (const id of sess.keys()) nameOf.set(id, await userName(id));
    const sessByName = new Map([...sess].map(([id, s]) => [fold(nameOf.get(id)), s]));

    const row = (name) => {
        const s = sessByName.get(fold(name));
        const shift = shiftFor(name, sched, now);
        const r = { name, shift: shift?.text || '', status: 'none', label: '', inAt: '', outAt: '', breaks: '' };
        const recent = s && (s.state !== 'out' || (s.out && now - s.out < 14 * 3600e3));
        if (s && recent) {
            r.inAt = s.in ? hm(s.in) : '';
            r.outAt = s.out ? hm(s.out) : '';
            r.breaks = s.breaks.map(b => (b.end ? `${b.label} ✓` : `${b.label} ${trSuffix(hm(b.start), 'den')}`)).join(' · ');
        }
        if (s && s.state === 'break') {
            const b = s.breaks.at(-1), mins = Math.floor((now - b.start) / MIN);
            const over = b.dur ? mins - b.dur : 0;
            r.status = over > 0 ? 'over' : 'break';
            r.label = `Molada · ${b.label} · ${mins} dk${over > 0 ? ` ⏰ +${over}` : ''}`;
        } else if (s && s.state === 'in' && (s.in || recent)) {
            r.status = 'on'; r.label = 'MESAİDE';
        } else if (shift?.off) {
            r.status = 'off'; r.label = 'OFF';
        } else if (shift && now < shift.start) {
            r.status = 'wait'; r.label = `${trSuffix(hm(shift.start), 'de')} başlıyor`;
            r.inAt = r.outAt = r.breaks = '';   // önceki vardiyanın saatleri karışmasın
        } else if (s && s.state === 'out' && recent) {
            r.status = 'out'; r.label = 'Çıktı';
        } else if (shift && now >= shift.start + CONFIG.LATE_GRACE_MIN * MIN && now < shift.end) {
            r.status = 'miss'; r.label = `Gelmedi · ${Math.floor((now - shift.start) / MIN)} dk`;
        } else if (shift && now < shift.start + CONFIG.LATE_GRACE_MIN * MIN) {
            r.status = 'wait'; r.label = 'Bekleniyor';
            r.inAt = r.outAt = r.breaks = '';
        }
        return r;
    };

    const groups = [];
    const seen = new Set();
    if (current) {
        for (const t of current.teams) {
            groups.push({ team: t.name, rows: t.people.map(p => { seen.add(fold(p.name)); return row(p.name); }) });
        }
    }
    const others = [...sessByName.keys()].filter(n => !seen.has(n))
        .map(n => row([...nameOf.values()].find(x => fold(x) === n) || n))
        .filter(r => r.status !== 'none');
    if (others.length) groups.push({ team: current ? 'Programda yok' : '', rows: others });
    return { now, day: dayLabel(now), groups, hasSchedule: !!current };
}

/* ════════════════ çizim (onaylanan tablo stili) ════════════════ */
const FONT = '"Quicksand","Nunito","Segoe UI",Roboto,Arial,sans-serif';
const HEAD_FONT = '"Oswald","Bahnschrift","Arial Narrow","Segoe UI",Arial,sans-serif';
const COL = {
    green: '#1aa34a', line: '#2a2a2a', head: '#d3dfe4', headInk: '#2f3a40', band: '#d9ead3', ink: '#1f1f1f', sub: '#3a3a3a',
    on: ['#c9f0d1', '#0f5d27'], break: ['#fff2b3', '#7a5600'], over: ['#ffd8a8', '#8a3b00'], miss: ['#ff1a1a', '#ffffff'],
    off: ['#ff0000', '#ffffff'], out: ['#eef0f2', '#59626b'], wait: ['#ffffff', '#8a919c'], none: ['#ffffff', '#b3b8c0'],
};
const COLS = [{ k: 'name', w: 150 }, { k: 'shift', w: 140, t: 'VARDİYA' }, { k: 'label', w: 250, t: 'DURUM' }, { k: 'inAt', w: 80, t: 'GİRİŞ' }, { k: 'breaks', w: 200, t: 'MOLALAR' }, { k: 'outAt', w: 80, t: 'ÇIKIŞ' }];
const RH = 34, TITLE = 50;

function layout(model) {
    const lines = [];
    model.groups.forEach((g, gi) => {
        if (gi === 0) lines.push({ type: 'head', team: g.team });
        else if (g.team) lines.push({ type: 'band', team: g.team });
        g.rows.forEach(r => lines.push({ type: 'row', r }));
    });
    if (!model.groups.length) lines.push({ type: 'head', team: '' }, { type: 'empty' });
    return { lines, height: TITLE + lines.length * RH + 2 };
}

/** frame: 0..FRAMES-1 — yalnızca atan halkalar karelere göre değişir. */
function drawFrame(g, model, lay, frame, FRAMES) {
    const Wd = CONFIG.WIDTH, Hd = lay.height;
    const phase = frame / FRAMES;
    g.fillStyle = '#fff'; g.fillRect(0, 0, Wd, Hd);
    g.textBaseline = 'middle';
    const txt = (s, x, y, font, color, align = 'left', maxW) => {
        g.font = font; g.fillStyle = color; g.textAlign = align;
        let t = String(s ?? '');
        if (maxW && g.measureText(t).width > maxW) { while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); t += '…'; }
        g.fillText(t, x, y);
        return g.measureText(t).width;
    };
    const pulse = (cx, cy, color) => {
        const r = 4 + phase * 9, a = 0.85 * (1 - phase);
        g.save(); g.globalAlpha = a; g.strokeStyle = color; g.lineWidth = 2;
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); g.restore();
        g.fillStyle = color; g.beginPath(); g.arc(cx, cy, 4.5, 0, Math.PI * 2); g.fill();
    };
    // başlık bandı
    g.fillStyle = COL.green; g.fillRect(0, 0, Wd, TITLE);
    txt('Mesai Durumu', 16, TITLE / 2 + 1, `700 27px ${FONT}`, '#fff');
    txt(model.day, 248, TITLE / 2 + 2, `600 19px ${FONT}`, '#fff');
    const badge = `CANLI · ${hm(model.now)}`;
    g.font = `700 13px ${FONT}`;
    const bw = g.measureText(badge).width + 40, bx = Wd - 14 - bw;
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.roundRect ? g.roundRect(bx, 12, bw, 26, 13) : g.rect(bx, 12, bw, 26); g.fill();
    pulse(bx + 15, 25, '#ffffff');
    txt(badge, bx + 28, 26, `700 13px ${FONT}`, '#fff');
    // satırlar
    let y = TITLE;
    const xs = []; let acc = 0; for (const c of COLS) { xs.push(acc); acc += c.w; }
    for (const ln of lay.lines) {
        if (ln.type === 'head') {
            g.fillStyle = COL.band; g.fillRect(0, y, COLS[0].w, RH);
            g.fillStyle = COL.head; g.fillRect(COLS[0].w, y, Wd - COLS[0].w, RH);
            txt(ln.team || 'Ekip', 12, y + RH / 2 + 1, `700 16px ${FONT}`, COL.headInk);
            COLS.slice(1).forEach((c, i) => txt(c.t, xs[i + 1] + c.w / 2, y + RH / 2 + 1, `500 15px ${HEAD_FONT}`, COL.headInk, 'center'));
        } else if (ln.type === 'band') {
            g.fillStyle = COL.band; g.fillRect(0, y, Wd, RH);
            txt(ln.team, 12, y + RH / 2 + 1, `700 16px ${FONT}`, COL.headInk);
        } else if (ln.type === 'empty') {
            txt('Kanalda son 30 saatte kayıt yok ve haftalık program girilmemiş.', Wd / 2, y + RH / 2, `600 14px ${FONT}`, '#8a919c', 'center');
        } else {
            const r = ln.r;
            txt(r.name, 12, y + RH / 2 + 1, `600 17px ${FONT}`, COL.ink, 'left', COLS[0].w - 18);
            if (r.status === 'off') {
                g.fillStyle = COL.off[0]; g.fillRect(COLS[0].w, y, Wd - COLS[0].w, RH);
                txt('OFF', COLS[0].w + (Wd - COLS[0].w) / 2, y + RH / 2 + 1, `600 17px ${FONT}`, '#fff', 'center');
            } else {
                txt(r.shift || '–', xs[1] + COLS[1].w / 2, y + RH / 2 + 1, `700 15px ${FONT}`, '#333', 'center');
                const [bg, fg] = COL[r.status] || COL.none;
                g.fillStyle = bg; g.fillRect(xs[2], y, COLS[2].w, RH);
                if (r.status === 'on') {
                    g.font = `700 14.5px ${FONT}`;
                    const w = g.measureText(r.label).width, x0 = xs[2] + (COLS[2].w - w - 22) / 2;
                    pulse(x0 + 6, y + RH / 2, '#16a34a');
                    txt(r.label, x0 + 22, y + RH / 2 + 1, `700 14.5px ${FONT}`, fg);
                } else {
                    txt(r.label || '–', xs[2] + COLS[2].w / 2, y + RH / 2 + 1, `700 14.5px ${FONT}`, fg, 'center', COLS[2].w - 12);
                }
                txt(r.inAt || '–', xs[3] + COLS[3].w / 2, y + RH / 2 + 1, `600 13.5px ${FONT}`, COL.sub, 'center');
                txt(r.breaks || '–', xs[4] + COLS[4].w / 2, y + RH / 2 + 1, `600 13px ${FONT}`, COL.sub, 'center', COLS[4].w - 12);
                txt(r.outAt || '–', xs[5] + COLS[5].w / 2, y + RH / 2 + 1, `600 13.5px ${FONT}`, COL.sub, 'center');
            }
        }
        // çizgiler
        g.fillStyle = COL.line;
        g.fillRect(0, y, Wd, 1);
        if (ln.type === 'head' || (ln.type === 'row' && ln.r.status !== 'off')) for (let i = 1; i < COLS.length; i++) g.fillRect(xs[i], y, 1, RH);
        else if (ln.type === 'row') g.fillRect(COLS[0].w, y, 1, RH);
        y += RH;
    }
    g.fillStyle = COL.line;
    g.fillRect(0, y, Wd, 1);
    g.fillRect(0, TITLE, Wd, 2);
    g.lineWidth = 2; g.strokeStyle = COL.line; g.strokeRect(1, 1, Wd - 2, Hd - 2);
}

/** Kareleri çiz, 256 renge indir, hareketli GIF üret (omggif). */
function renderGif(model) {
    const FRAMES = 10, DELAY = 13;   // 1,3 sn döngü
    const lay = layout(model);
    const Wd = CONFIG.WIDTH, Hd = lay.height;
    const cv = document.createElement('canvas');
    cv.width = Wd; cv.height = Hd;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const frames = [];
    const hist = new Map();
    for (let f = 0; f < FRAMES; f++) {
        drawFrame(g, model, lay, f, FRAMES);
        const d = g.getImageData(0, 0, Wd, Hd).data;
        frames.push(d);
        for (let i = 0; i < d.length; i += 4) {
            const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
            hist.set(k, (hist.get(k) || 0) + 1);
        }
    }
    // palet: en sık 256 renk (5 bit kutular)
    const top = [...hist].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => k);
    while (top.length < 256) top.push(0);
    const pal = top.map(k => (((k >> 10) & 31) << 19) | (((k >> 5) & 31) << 11) | ((k & 31) << 3));
    const palRGB = pal.map(c => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);
    const idx = new Map(top.map((k, i) => [k, i]));
    const near = (k) => {
        if (idx.has(k)) return idx.get(k);
        const r = ((k >> 10) & 31) << 3, gg = ((k >> 5) & 31) << 3, b = (k & 31) << 3;
        let best = 0, bd = Infinity;
        for (let i = 0; i < 256; i++) { const p = palRGB[i], dd = (p[0] - r) ** 2 + (p[1] - gg) ** 2 + (p[2] - b) ** 2; if (dd < bd) { bd = dd; best = i; } }
        idx.set(k, best);
        return best;
    };
    const buf = new Uint8Array(Wd * Hd * FRAMES + 1024 * 64);
    const gw = new GifWriter(buf, Wd, Hd, { palette: pal, loop: 0 });
    const ip = new Uint8Array(Wd * Hd);
    for (const d of frames) {
        for (let i = 0, j = 0; i < d.length; i += 4, j++) ip[j] = near(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
        gw.addFrame(0, 0, Wd, Hd, ip, { delay: DELAY, disposal: 1 });
    }
    return new Blob([buf.slice(0, gw.end())], { type: 'image/gif' });
}

/* ════════════════ pano mesajı ════════════════ */
function putBytes(url, blob) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: 'POST', url, data: blob, timeout: 60000, headers: { 'Content-Type': blob.type },
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve() : reject(new Error(`yükleme HTTP ${r.status}`))),
        onerror: () => reject(new Error('yükleme ağ hatası')), ontimeout: () => reject(new Error('yükleme zaman aşımı')),
    }));
}
async function uploadToThread(blob, name, threadTs) {
    const up = await api('files.getUploadURLExternal', { filename: name, length: String(blob.size) });
    await putBytes(up.upload_url, blob);
    await api('files.completeUploadExternal', { files: JSON.stringify([{ id: up.file_id, title: name }]), channel_id: CONFIG.BOARD, thread_ts: threadTs });
    return up.file_id;
}
const status = (msg) => GM_setValue('status', { msg, at: Date.now() });

let busy = false;
async function refresh(force = false) {
    if (busy) return;
    if (!force && GM_getValue('enabled', true) === false) return;
    // birden fazla Slack sekmesi: tek lider
    const ME = refresh.me || (refresh.me = Math.random().toString(36).slice(2));
    const lead = GM_getValue('leader', null);
    if (!force && lead && lead.owner !== ME && Date.now() - lead.at < 3 * CONFIG.REFRESH_SEC * 1000) return;
    GM_setValue('leader', { owner: ME, at: Date.now() });
    busy = true;
    try {
        const model = await buildModel();
        const gif = renderGif(model);
        let board = GM_getValue('board', null);
        if (!board || board.ch !== CONFIG.BOARD) {
            const r = await api('chat.postMessage', { channel: CONFIG.BOARD, text: '👥 Mesai Durumu (canlı pano hazırlanıyor…)' });
            board = { ch: CONFIG.BOARD, ts: r.ts, file: null };
            GM_setValue('board', board);
            log('pano mesajı oluşturuldu, sabitleyebilirsin:', r.ts);
        }
        const fileId = await uploadToThread(gif, `mesai-${hm(model.now).replace(':', '')}.gif`, board.ts);
        const blocks = [{ type: 'image', slack_file: { id: fileId }, alt_text: `Mesai durumu · ${model.day} · ${hm(model.now)}` }];
        const u = await api('chat.update', { channel: CONFIG.BOARD, ts: board.ts, text: `👥 Mesai Durumu · ${model.day} · ${hm(model.now)}`, blocks: JSON.stringify(blocks) }, ['message_not_found']);
        if (!u.ok) { GM_deleteValue('board'); throw new Error('pano mesajı silinmiş, bir sonraki turda yenisi oluşturulacak'); }
        if (board.file && board.file !== fileId) api('files.delete', { file: board.file }, ['file_not_found', 'file_deleted']).catch(e => warn('eski resim silinemedi:', e.message));
        GM_setValue('board', { ...board, file: fileId });
        status(`güncellendi ${hm(model.now)} · ${(gif.size / 1024).toFixed(0)} KB`);
    } catch (e) {
        warn('pano güncellenemedi:', e.message);
        status(`HATA: ${e.message}`);
    } finally { busy = false; }
}

/* ════════════════ program yapıştırma penceresi ════════════════ */
function nextMonday() {
    const today = trDayStart(Date.now());
    const dow = new Date(today + TR).getUTCDay();             // 0 = Pazar
    return today + ((8 - dow) % 7 || 7) * DAY;
}
function openScheduleDialog() {
    document.getElementById('mp-dlg')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'mp-dlg';
    wrap.innerHTML = `
<style>
#mp-dlg{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font:14px "Segoe UI",Roboto,sans-serif;color:#343a43}
#mp-dlg .box{width:min(860px,94vw);max-height:90vh;overflow:auto;background:#fff;border-radius:12px;padding:18px 20px;box-shadow:0 20px 50px rgba(0,0,0,.25)}
#mp-dlg h3{margin:0 0 6px;font-size:17px}
#mp-dlg p{margin:0 0 10px;color:#667085;font-size:13px;line-height:1.5}
#mp-dlg textarea{width:100%;height:150px;box-sizing:border-box;border:1px solid #d9dde3;border-radius:8px;padding:8px;font:12px Menlo,Consolas,monospace}
#mp-dlg .row{display:flex;gap:10px;align-items:center;margin:10px 0;flex-wrap:wrap}
#mp-dlg input[type=date]{border:1px solid #d9dde3;border-radius:8px;padding:5px 8px}
#mp-dlg button{border:1px solid #d9dde3;background:#fff;border-radius:8px;padding:6px 14px;font-weight:600;cursor:pointer}
#mp-dlg button.pri{background:#1aa34a;border-color:#1aa34a;color:#fff}
#mp-dlg table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px}
#mp-dlg td,#mp-dlg th{border:1px solid #d9dde3;padding:3px 6px;text-align:center}
#mp-dlg td:first-child{text-align:left;font-weight:600}
#mp-dlg .tm{background:#d9ead3;text-align:left !important;font-weight:700}
#mp-dlg .off{background:#ff0000;color:#fff}
#mp-dlg .warn{color:#b42318;font-weight:600}
</style>
<div class="box">
  <h3>Haftalık programı yapıştır</h3>
  <p>Program tablosunu Excel / Google Sheets'te başlık satırı dahil seç, kopyala (Ctrl+C) ve aşağıya yapıştır (Ctrl+V). "OFF", "14:00 - 02:00" ve ekip satırları (Admin, Finans, Canlı, Call) okunur.</p>
  <textarea id="mp-in" placeholder="Buraya yapıştır…"></textarea>
  <div class="row">Haftanın Pazartesi'si: <input type="date" id="mp-ws"> <span id="mp-hint" style="color:#8a919c;font-size:12px"></span></div>
  <div id="mp-prev"></div>
  <div class="row" style="justify-content:flex-end"><button id="mp-cancel">Vazgeç</button><button id="mp-save" class="pri" disabled>Kaydet</button></div>
</div>`;
    document.body.append(wrap);
    const $ = (s) => wrap.querySelector(s);
    const toInput = (ms) => { const d = new Date(ms + TR); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };
    const fromInput = (v) => { const [y, m, d] = v.split('-').map(Number); return Date.UTC(y, m - 1, d) - TR; };
    $('#mp-ws').value = toInput(nextMonday());
    let parsed = null;
    const render = () => {
        const text = $('#mp-in').value;
        if (!text.trim()) { $('#mp-prev').innerHTML = ''; $('#mp-save').disabled = true; return; }
        parsed = parseSchedule(text, fromInput($('#mp-ws').value));
        if (parsed.weekStart && text.match(/program/i)) { $('#mp-ws').value = toInput(parsed.weekStart); $('#mp-hint').textContent = 'tablodaki tarihten okundu'; }
        const ws = fromInput($('#mp-ws').value);
        parsed.weekStart = ws;
        const people = parsed.teams.reduce((n, t) => n + t.people.length, 0);
        const days = Array.from({ length: 7 }, (_, i) => dayLabel(ws + i * DAY));
        let html = `<table><tr><th></th>${days.map(d => `<th>${d}</th>`).join('')}</tr>`;
        for (const t of parsed.teams) {
            if (t.name) html += `<tr><td class="tm" colspan="8">${t.name}</td></tr>`;
            for (const p of t.people) html += `<tr><td>${p.name}</td>${p.days.map(d => (d === 'OFF' ? '<td class="off">OFF</td>' : `<td>${d || '<span class="warn">?</span>'}</td>`)).join('')}</tr>`;
        }
        html += '</table>';
        $('#mp-prev').innerHTML = people ? `<p><b>${people} kişi</b>, ${parsed.teams.length} ekip okundu. Kontrol et; "?" okunamayan hücre.</p>${html}` : '<p class="warn">Tablo okunamadı. Başlık satırı dahil hücreleri kopyaladığından emin ol.</p>';
        $('#mp-save').disabled = !people;
    };
    $('#mp-in').addEventListener('input', render);
    $('#mp-ws').addEventListener('change', render);
    $('#mp-cancel').addEventListener('click', () => wrap.remove());
    $('#mp-save').addEventListener('click', () => {
        if (!parsed) return;
        const list = getSchedules().filter(s => s.weekStart !== parsed.weekStart && s.weekStart > Date.now() - 21 * DAY);
        list.push(parsed);
        list.sort((a, b) => a.weekStart - b.weekStart);
        GM_setValue('schedules', list);
        wrap.remove();
        alert(`Program kaydedildi: ${dayLabel(parsed.weekStart)} haftası.`);
        refresh(true);
    });
}

/* ════════════════ menü ve zamanlayıcı ════════════════ */
GM_registerMenuCommand('Haftalık programı yapıştır', openScheduleDialog);
GM_registerMenuCommand('Panoyu şimdi güncelle', () => refresh(true));
GM_registerMenuCommand('Panoyu durdur / başlat', () => {
    const on = GM_getValue('enabled', true) === false;
    GM_setValue('enabled', on);
    alert(`Canlı pano ${on ? 'ÇALIŞIYOR' : 'DURDURULDU'}.`);
});
GM_registerMenuCommand('Durum', () => {
    const s = GM_getValue('status', null), b = GM_getValue('board', null), sc = getSchedules();
    alert([
        `Pano: ${GM_getValue('enabled', true) === false ? 'DURDURULDU' : 'ÇALIŞIYOR'} · ${b ? `mesaj ${b.ts}` : 'henüz oluşturulmadı'}`,
        `Son: ${s ? `${s.msg} (${new Date(s.at).toLocaleTimeString('tr-TR')})` : '—'}`,
        `Program: ${sc.length ? sc.map(x => dayLabel(x.weekStart)).join(', ') : 'girilmedi'}`,
    ].join('\n'));
});

setInterval(() => refresh(false), CONFIG.REFRESH_SEC * 1000);
setTimeout(() => refresh(false), 5000);
log('hazır.');

// Yalnızca test ortamı önceden işaret koyduysa iç fonksiyonları verir; gerçek sayfada hiçbir şey yapmaz.
if (window.__MP_TEST__) Object.assign(window.__MP_TEST__, { classify, sessions, parseSchedule, shiftFor, buildModel, renderGif, refresh });
})();
