// ==UserScript==
// @name         Pasif Oyuncular — 7 gündür oynamayanlar
// @namespace    palentis.pasif-oyuncu
// @version      1.1.1
// @description  Her sabah TR 10:00'da, bir önceki günün sonunda 7. oynamadığı günü dolduran oyuncuları (son oyunu 8 gün önceki TR gününde olanlar) Slack kanalına raporlar: ana mesajda sayı, thread'de tablo resimleri (60'ar satır) ve Excel dosyası. Herhangi bir GT sekmesinin açık olması yeterli.
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
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @connect      files.slack.com
// @connect      slack.com
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
    CHANNEL: 'C0C8HMG3KUH',
    HOUR_TR: 10,
    GRACE_MIN: 180,
    DAYS: 7,
    BRAND: 105,
    PAGE: 60,           // tablo resmi başına satır
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

    /** Ana mesaj + thread'e gidecek tablo verisi (resim ve Excel Slack sekmesinde üretilir). */
    function buildMessages({ rows, lastDay, closedDay }) {
        const title = `😴 7 Gündür Oynamayanlar · ${trDate(closedDay)}`;
        const summary = rows.length
            ? `Son oyunu *${trDate(lastDay)}* tarihinde olan *${rows.length.toLocaleString('tr-TR')}* oyuncu 7. gününü doldurdu.\nTablo ve Excel bu mesajın thread'inde ↓`
            : `Son oyunu ${trDate(lastDay)} tarihinde olup 7. gününü dolduran oyuncu yok.`;
        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
            { type: 'section', text: { type: 'mrkdwn', text: summary } },
        ];
        const table = rows.length ? {
            sub: `Son oyun ${trDate(lastDay)} · ${rows.length} oyuncu · ${trDate(closedDay)} sonu itibarıyla`,
            file: `pasif-oyuncular-${trDate(closedDay)}`,
            rows: rows.map(r => ({ id: String(r.pid), at: trStamp(r.at), user: r.user || '', name: r.name || '' })),
        } : null;
        return { text: `${title} — ${rows.length} oyuncu`, blocks, table };
    }

    function enqueue(key, msg) {
        GM_setValue('q:' + key, { ...msg, at: Date.now(), ts: null, filesDone: false });
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
   SLACK TARAFI
   1) Ana mesaj (chat.postMessage)  2) Tablo sayfaları canvas'ta PNG olarak çizilir,
   Excel (SheetJS) üretilir  3) Slack'in dosya yükleme akışı: files.getUploadURLExternal →
   dosya baytları upload_url'e → files.completeUploadExternal (thread_ts ile, tek mesaj).
   İlerleme kuyruk kaydında: yarıda kalırsa ana mesaj tekrar atılmaz.
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
    async function api(method, params) {
        for (let i = 0; i < 4; i++) {
            const r = await call(method, params);
            if (r.ok) return r;
            if (r.error === 'ratelimited') { await sleep(r.retry); continue; }
            if (/invalid_auth|not_authed|token_revoked/.test(r.error)) { token = null; await resolveToken(); continue; }
            throw new Error(`${method}: ${r.error || 'bilinmeyen hata'}`);
        }
        throw new Error(`${method}: 4 denemede olmadı`);
    }

    /* ── Tablo resmi (onaylanan tasarım, saat grafiği ve dilimler olmadan) ── */
    const SANS = '"Inter","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
    const MONO = '"JetBrains Mono",Menlo,Consolas,"Liberation Mono",monospace';
    const C = { ink: '#343a43', sub: '#525a66', mute: '#8a919c', faint: '#b3b8c0', line: '#eceef1', row: '#f3f4f6', soft: '#f8f9fb', zebra: '#fcfcfd', border: '#e4e7ec' };
    function renderPage(table, page, pages) {
        const S = 2, Wd = 620, PADX = 18, HEAD = 62, TH = 28, RH = 24, FOOT = 34;
        const rows = table.rows.slice(page * CONFIG.PAGE, page * CONFIG.PAGE + CONFIG.PAGE);
        const Hd = HEAD + TH + rows.length * RH + FOOT;
        const cv = document.createElement('canvas');
        cv.width = Wd * S; cv.height = Hd * S;
        const g = cv.getContext('2d');
        g.scale(S, S);
        g.textBaseline = 'middle';
        const text = (t, x, y, font, color, align = 'left', maxW) => {
            g.font = font; g.fillStyle = color; g.textAlign = align;
            let s = String(t);
            if (maxW && g.measureText(s).width > maxW) { while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1); s += '…'; }
            g.fillText(s, x, y);
            return g.measureText(s).width;
        };
        const hline = (y, color) => { g.fillStyle = color; g.fillRect(0, y, Wd, 1); };
        // zemin + kenar
        g.fillStyle = '#fff'; g.fillRect(0, 0, Wd, Hd);
        g.strokeStyle = C.border; g.lineWidth = 1; g.strokeRect(0.5, 0.5, Wd - 1, Hd - 1);
        // başlık
        text('😴 7 Gündür Oynamayanlar', PADX, 26, `800 15px ${SANS}`, C.ink);
        text(table.sub, PADX, 45, `500 11.5px ${SANS}`, C.mute);
        const pill = `${page + 1} / ${pages}`;
        g.font = `700 11px ${SANS}`;
        const pw = g.measureText(pill).width + 18;
        g.fillStyle = C.soft; g.strokeStyle = C.line;
        g.beginPath(); g.roundRect ? g.roundRect(Wd - PADX - pw, 24, pw, 20, 10) : g.rect(Wd - PADX - pw, 24, pw, 20); g.fill(); g.stroke();
        text(pill, Wd - PADX - pw / 2, 34.5, `700 11px ${SANS}`, C.mute, 'center');
        hline(HEAD - 1, C.line);
        // tablo başlığı
        const X = { n: 44, id: 56, t: 160, u: 282, name: 442 };
        g.fillStyle = C.soft; g.fillRect(0, HEAD, Wd, TH);
        hline(HEAD + TH - 1, C.line);
        const thf = `700 10px ${SANS}`, thy = HEAD + TH / 2;
        text('#', X.n, thy, thf, C.mute, 'right');
        text('PARTY ID', X.id, thy, thf, C.mute);
        text('SON OYUN', X.t, thy, thf, C.mute);
        text('KULLANICI ADI', X.u, thy, thf, C.mute);
        text('İSİM SOYİSİM', X.name, thy, thf, C.mute);
        // satırlar
        rows.forEach((r, i) => {
            const y0 = HEAD + TH + i * RH, y = y0 + RH / 2;
            if (i % 2) { g.fillStyle = C.zebra; g.fillRect(0, y0, Wd, RH); }
            hline(y0 + RH - 1, C.row);
            text(page * CONFIG.PAGE + i + 1, X.n, y, `500 12px ${SANS}`, C.faint, 'right');
            text(r.id, X.id, y, `600 12px ${MONO}`, C.ink);
            const [d, tm] = String(r.at).split(' ');
            const dw = text(d.slice(0, 5) + ' ', X.t, y, `500 12px ${SANS}`, C.sub);
            text(tm || '', X.t + dw, y, `700 12px ${SANS}`, C.ink);
            text(r.user || '—', X.u, y, `500 12px ${SANS}`, C.sub, 'left', 150);
            text(r.name || '—', X.name, y, `500 12px ${SANS}`, C.ink, 'left', Wd - X.name - PADX);
        });
        // alt bilgi
        const fy = HEAD + TH + rows.length * RH;
        hline(fy, C.line);
        const from = page * CONFIG.PAGE + 1, to = page * CONFIG.PAGE + rows.length;
        text(`${from}–${to} / ${table.rows.length}`, PADX, fy + FOOT / 2, `500 10.5px ${SANS}`, C.mute);
        text('Son oyuna göre, yeniden eskiye', Wd - PADX, fy + FOOT / 2, `500 10.5px ${SANS}`, C.mute, 'right');
        return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('resim üretilemedi'))), 'image/png'));
    }

    function buildXlsx(table) {
        if (typeof XLSX === 'undefined') throw new Error('Excel kütüphanesi yüklenemedi');
        const aoa = [['#', 'Party ID', 'Son oyun', 'Kullanıcı adı', 'İsim Soyisim']]
            .concat(table.rows.map((r, i) => [i + 1, Number(r.id) || r.id, r.at, r.user, r.name]));
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 5 }, { wch: 11 }, { wch: 17 }, { wch: 22 }, { wch: 28 }];
        ws['!autofilter'] = { ref: `A1:E${aoa.length}` };
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Pasif oyuncular');
        const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }

    /** Dosya baytlarını Slack'in verdiği upload_url'e gönder (çapraz alan adı: GM_xmlhttpRequest). */
    function putBytes(url, blob) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            method: 'POST', url, data: blob, timeout: 60000,
            headers: { 'Content-Type': blob.type || 'application/octet-stream' },
            onload: (r) => (r.status >= 200 && r.status < 300 ? resolve() : reject(new Error(`yükleme HTTP ${r.status}`))),
            onerror: () => reject(new Error('yükleme ağ hatası')), ontimeout: () => reject(new Error('yükleme zaman aşımı')),
        }));
    }
    async function uploadToThread(files, threadTs) {
        const done = [];
        for (const f of files) {
            const up = await api('files.getUploadURLExternal', { filename: f.name, length: String(f.blob.size) });
            await putBytes(up.upload_url, f.blob);
            done.push({ id: up.file_id, title: f.title || f.name });
        }
        await api('files.completeUploadExternal', { files: JSON.stringify(done), channel_id: CONFIG.CHANNEL, thread_ts: threadTs });
    }

    async function process(k, v) {
        if (!v.ts) {
            const r = await api('chat.postMessage', { channel: CONFIG.CHANNEL, text: v.text, blocks: JSON.stringify(v.blocks), unfurl_links: 'false' });
            v.ts = r.ts;
            GM_setValue(k, v);
        }
        if (v.table && !v.filesDone) {
            const pages = Math.ceil(v.table.rows.length / CONFIG.PAGE);
            const files = [];
            for (let p = 0; p < pages; p++) files.push({ name: `tablo-${p + 1}.png`, title: `Tablo ${p + 1} / ${pages}`, blob: await renderPage(v.table, p, pages) });
            try { files.push({ name: `${v.table.file}.xlsx`, title: `${v.table.file}.xlsx`, blob: buildXlsx(v.table) }); }
            catch (e) { warn('Excel üretilemedi:', e.message); }
            await uploadToThread(files, v.ts);
            v.filesDone = true;
            GM_setValue(k, v);
        }
    }

    async function flush() {
        if (busy) { again = true; return; }
        busy = true; again = false;
        let owned = false;
        try {
            if (!GM_listValues().some(k => k.startsWith('q:'))) return;
            const lock = GM_getValue('slackLock', null);
            if (lock && lock.owner !== ME && Date.now() - lock.at < 120000) return;
            GM_setValue('slackLock', { owner: ME, at: Date.now() });
            await sleep(300);
            if (GM_getValue('slackLock', null)?.owner !== ME) return;
            owned = true;
            if (!token) await resolveToken();
            const items = GM_listValues().filter(k => k.startsWith('q:')).map(k => [k, GM_getValue(k, null)]).filter(([, v]) => v).sort((a, b) => a[1].at - b[1].at);
            for (const [k, v] of items) {
                if (Date.now() - v.at > 12 * 3600e3) { GM_deleteValue(k); warn('eski rapor atıldı:', k); continue; }
                GM_setValue('slackLock', { owner: ME, at: Date.now() });
                await process(k, { ...v });
                GM_deleteValue(k);
                status(`son gönderim ${k.slice(2)}`);
            }
        } catch (e) { warn('gönderilemedi:', e.message); status(`HATA: ${e.message}`); }
        finally {
            busy = false;
            if (owned) GM_deleteValue('slackLock');
            if (again) setTimeout(flush, 200);
        }
    }
    GM_addValueChangeListener('ping', () => flush());
    setInterval(flush, 30000);
    setTimeout(flush, 3000);
    status('bağlı, bekliyor');
}

})();
