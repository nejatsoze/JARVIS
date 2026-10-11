// ==UserScript==
// @name         Pasif Oyuncular — 7 gündür oynamayanlar
// @namespace    palentis.pasif-oyuncu
// @version      1.0.0
// @description  Her sabah TR 10:00'da, bir önceki günün sonunda 7. oynamadığı günü dolduran oyuncuları (son oyunu 8 gün önceki TR gününde olanlar) Slack kanalına raporlar: ana mesajda sayı, thread'de ID · son oyun · kullanıcı adı · isim soyisim. Herhangi bir GT sekmesinin açık olması yeterli.
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
 * VERİ
 *   GET /ics/player-playing?brands=105&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *     → oyuncu başına bir kayıt; lastGameActivity (ms) = son oyun hareketi.
 *   GET /ics/players/{id}/full-profile → ad, soyad, kullanıcı adı.
 *
 * KURAL (TR takvim günü, UTC+3)
 *   R günü 10:00 raporu → son oyunu (R − 8) gününde olanlar. Bu oyuncular (R − 7)'den (R − 1)'e
 *   7 tam gün oynamamıştır; rapor başlığındaki gün (R − 1), yani 7. günün kapandığı gün.
 *   Her oyuncu yalnızca bir kez raporlanır (sonraki gün 8. gününde olur).
 *
 * TAKVİM: TR 10:00; saatinde tarayıcı kapalıysa 3 saat içinde açılırsa gönderilir.
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0C80H6L4CD',
    HOUR_TR: 10,
    GRACE_MIN: 180,
    DAYS: 7,
    BRAND: 105,
    CHUNK: 80,          // thread mesajı başına satır
    PARALLEL: 6,        // aynı anda okunan profil
};

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Pasif Oyuncular]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (location.hostname === 'app.slack.com') slackSide();
else gtSide();

/* ════════════════════════════════════════════════════════════
   GT TARAFI
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
        const url = `${HOST}/ics/${path}?${new URLSearchParams({ ...params, sessionKey: t, uType: 'staff' })}`;
        const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json', Authorization: `Bearer ${t}` } });
        if (!res.ok) throw new Error(`${path.split('/')[0]}: HTTP ${res.status}`);
        return res.json();
    }

    /* ── TR takvimi (UTC+3, yaz saati yok) ── */
    const TR = 3 * 3600e3, DAY = 864e5;
    const trMidnight = (ms) => Math.floor((ms + TR) / DAY) * DAY - TR;          // o anın TR gününün 00:00'ı (UTC ms)
    const p2 = (n) => String(n).padStart(2, '0');
    const trParts = (ms) => { const d = new Date(ms + TR); return { d: p2(d.getUTCDate()), m: p2(d.getUTCMonth() + 1), y: d.getUTCFullYear(), H: p2(d.getUTCHours()), M: p2(d.getUTCMinutes()) }; };
    const trDate = (ms) => { const x = trParts(ms); return `${x.d}.${x.m}.${x.y}`; };
    const trStamp = (ms) => { const x = trParts(ms); return `${x.d}.${x.m}.${x.y} ${x.H}:${x.M}`; };
    const isoDay = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };

    /** Kullanıcı adı alanı panelde farklı adlarla gelebiliyor. */
    const pick = (o, names) => { for (const n of names) { const k = Object.keys(o || {}).find(x => x.toLowerCase() === n.toLowerCase()); if (k && o[k] != null && String(o[k]).trim()) return String(o[k]).trim(); } return ''; };
    async function profile(pid) {
        try {
            const d = await ics(`players/${pid}/full-profile`);
            return {
                user: pick(d, ['userId', 'userName', 'username', 'loginName', 'login', 'nickName', 'nickname']),
                name: [d?.firstName, d?.lastName].filter(Boolean).join(' ').trim(),
            };
        } catch (e) { warn('profil okunamadı', pid, e.message); return { user: '', name: '' }; }
    }
    async function mapLimit(list, n, fn) {
        const out = new Array(list.length);
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
            while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
        }));
        return out;
    }

    /** reportDay: rapor saatinin TR günü (00:00, UTC ms). Son oyunu (reportDay − 8) gününde olanlar. */
    async function collect(reportDay) {
        const from = reportDay - (CONFIG.DAYS + 1) * DAY;            // R−8 00:00
        const to = from + DAY;                                        // R−7 00:00
        const list = await ics('player-playing', {
            brands: CONFIG.BRAND, startDate: isoDay(from - DAY), endDate: isoDay(reportDay + DAY),
        });
        if (!Array.isArray(list)) throw new Error('player-playing beklenen listeyi döndürmedi');
        const last = new Map();
        for (const r of list) {
            const v = Number(r.lastGameActivity) || 0;
            if (r.partyId != null && v > (last.get(r.partyId) || 0)) last.set(r.partyId, v);
        }
        const hit = [...last].filter(([, v]) => v >= from && v < to).sort((a, b) => b[1] - a[1]);
        const rows = await mapLimit(hit, CONFIG.PARALLEL, async ([pid, at]) => ({ pid, at, ...(await profile(pid)) }));
        return { rows, scanned: last.size, lastDay: from, closedDay: reportDay - DAY };
    }

    function buildMessages({ rows, lastDay, closedDay }) {
        const title = `😴 7 Gündür Oynamayanlar · ${trDate(closedDay)}`;
        const summary = rows.length
            ? `Son oyunu *${trDate(lastDay)}* tarihinde olan *${rows.length.toLocaleString('tr-TR')}* oyuncu ${trDate(closedDay)} günü sonunda 7. gününü doldurdu.\nListe bu mesajın thread'inde ↓`
            : `Son oyunu ${trDate(lastDay)} tarihinde olup 7. gününü dolduran oyuncu yok.`;
        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
            { type: 'section', text: { type: 'mrkdwn', text: summary } },
        ];
        const clean = (s) => String(s || '—').replace(/[`\n]/g, ' ');
        const lines = rows.map(r => `${r.pid} · ${trStamp(r.at)} · ${clean(r.user)} · ${clean(r.name)}`);
        const chunks = [];
        for (let i = 0; i < lines.length; i += CONFIG.CHUNK) {
            const part = lines.slice(i, i + CONFIG.CHUNK);
            const head = lines.length > CONFIG.CHUNK ? `${i + 1}–${i + part.length} / ${lines.length}\n` : '';
            chunks.push(`${head}\`\`\`ID · Son oyun · Kullanıcı adı · İsim Soyisim\n${part.join('\n')}\`\`\``);
        }
        return { text: `${title} — ${rows.length} oyuncu`, blocks, chunks };
    }

    function enqueue(key, msg) {
        GM_setValue('q:' + key, { ...msg, at: Date.now(), ts: null, done: 0 });
        GM_setValue('ping', Date.now());
    }

    let busy = false;
    async function run(reportDay, key) {
        const data = await collect(reportDay);
        enqueue(key, buildMessages(data));
        log(`rapor kuyruğa alındı: ${key} · ${data.rows.length} oyuncu (taranan ${data.scanned})`);
        return data;
    }
    async function tick() {
        if (busy || GM_getValue('enabled', true) === false) return;
        const lead = GM_getValue('leader', null);
        if (lead && lead.owner !== ME && Date.now() - lead.at < 3 * 60000) return;
        GM_setValue('leader', { owner: ME, at: Date.now() });
        if (!token()) return;

        const now = Date.now(), today = trMidnight(now);
        const since = now - (today + CONFIG.HOUR_TR * 3600e3);
        if (since < 0 || since > CONFIG.GRACE_MIN * 60000) return;
        const key = trDate(today);
        const sent = GM_getValue('sent', {});
        if (sent[key]) return;
        busy = true;
        try {
            sent[key] = Date.now();
            for (const k of Object.keys(sent)) if (now - sent[k] > 30 * DAY) delete sent[k];
            GM_setValue('sent', sent);
            await run(today, key);
            GM_setValue('lastReport', { key, at: Date.now() });
        } catch (e) {
            warn('rapor hazırlanamadı:', e.message);
            const s2 = GM_getValue('sent', {}); delete s2[key]; GM_setValue('sent', s2);
            GM_setValue('lastError', { msg: e.message, at: Date.now() });
        } finally { busy = false; }
    }

    GM_registerMenuCommand('Raporu şimdi gönder', async () => {
        try {
            const d = await run(trMidnight(Date.now()), 'manual-' + Date.now());
            alert(`Rapor kuyruğa alındı: ${d.rows.length} oyuncu. Slack sekmesi gönderecek.`);
        } catch (e) { alert('Rapor hazırlanamadı: ' + e.message); }
    });
    GM_registerMenuCommand('Otomatik raporu aç / kapat', () => {
        const on = GM_getValue('enabled', true) === false;
        GM_setValue('enabled', on);
        alert(`Otomatik rapor ${on ? 'AÇIK' : 'KAPALI'}.`);
    });
    GM_registerMenuCommand('Durum', () => {
        const last = GM_getValue('lastReport', null), err = GM_getValue('lastError', null), s = GM_getValue('slackStatus', null);
        alert([
            `Otomatik rapor: ${GM_getValue('enabled', true) === false ? 'KAPALI' : 'AÇIK'} · her gün ${p2(CONFIG.HOUR_TR)}:00 (TR)`,
            `Son rapor: ${last ? `${last.key} · ${new Date(last.at).toLocaleTimeString('tr-TR')}` : '—'}`,
            err ? `Son hata: ${err.msg} (${new Date(err.at).toLocaleTimeString('tr-TR')})` : '',
            `Slack: ${s ? s.msg : 'hiç bağlanmadı'}`,
        ].filter(Boolean).join('\n'));
    });

    setInterval(tick, 60000);
    setTimeout(tick, 5000);
    log('hazır.');
}

/* ════════════════════════════════════════════════════════════
   SLACK TARAFI — ana mesaj, sonra liste parçaları thread'e.
   İlerleme kuyruk kaydında tutulur: yarıda kesilirse ana mesaj tekrar atılmaz.
   ════════════════════════════════════════════════════════════ */
function slackSide() {
    let token = null, busy = false, again = false;
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
        const cands = collectTokens();
        if (!cands.length) throw new Error('Slack oturum anahtarı bulunamadı');
        for (const t of cands) {
            try { const r = await call('conversations.info', { channel: CONFIG.CHANNEL }, t); if (r.ok) { token = t; return; } } catch { /* sonraki */ }
        }
        throw new Error(`hiçbir oturum ${CONFIG.CHANNEL} kanalını göremiyor`);
    }
    async function send(text, blocks, threadTs) {
        const params = { channel: CONFIG.CHANNEL, text, unfurl_links: 'false', unfurl_media: 'false' };
        if (blocks) params.blocks = JSON.stringify(blocks);
        if (threadTs) params.thread_ts = threadTs;
        for (let i = 0; i < 4; i++) {
            const r = await call('chat.postMessage', params);
            if (r.ok) return r;
            if (r.error === 'ratelimited') { await sleep(r.retry); continue; }
            if (/invalid_auth|not_authed|token_revoked/.test(r.error)) { token = null; await resolveToken(); continue; }
            throw new Error(r.error || 'bilinmeyen hata');
        }
        throw new Error('4 denemede gönderilemedi');
    }
    async function flush() {
        // busy ilk await'ten ÖNCE alınır; meşgulken gelen sinyal iş bitince yeniden çalıştırılır
        if (busy) { again = true; return; }
        busy = true; again = false;
        let owned = false;
        try {
            if (!GM_listValues().some(k => k.startsWith('q:'))) return;
            const lock = GM_getValue('slackLock', null);
            if (lock && lock.owner !== ME && Date.now() - lock.at < 30000) return;
            GM_setValue('slackLock', { owner: ME, at: Date.now() });
            await sleep(300);
            if (GM_getValue('slackLock', null)?.owner !== ME) return;
            owned = true;
            if (!token) await resolveToken();
            const items = GM_listValues().filter(k => k.startsWith('q:')).map(k => [k, GM_getValue(k, null)]).filter(([, v]) => v).sort((a, b) => a[1].at - b[1].at);
            for (const [k, v0] of items) {
                const v = { ...v0 };
                if (Date.now() - v.at > 12 * 3600e3) { GM_deleteValue(k); warn('eski rapor atıldı:', k); continue; }
                GM_setValue('slackLock', { owner: ME, at: Date.now() });
                if (!v.ts) {
                    const r = await send(v.text, v.blocks);
                    v.ts = r.ts;
                    GM_setValue(k, v);   // ana mesaj gitti: yarıda kalırsa tekrar atılmasın
                    await sleep(1200);
                }
                const chunks = v.chunks || [];
                while (v.done < chunks.length) {
                    GM_setValue('slackLock', { owner: ME, at: Date.now() });
                    await send(chunks[v.done], null, v.ts);
                    v.done++;
                    GM_setValue(k, v);
                    await sleep(1200);
                }
                GM_deleteValue(k);
                status(`son gönderim ${k.slice(2)} (${chunks.length} parça)`);
            }
        } catch (e) { warn('gönderilemedi:', e.message); status(`HATA: ${e.message}`); }
        finally {
            busy = false;
            if (owned) GM_deleteValue('slackLock');
            if (again) setTimeout(flush, 200);
        }
    }
    GM_addValueChangeListener('ping', () => flush());
    setInterval(flush, 20000);
    setTimeout(flush, 3000);
    status('bağlı, bekliyor');
}

})();
