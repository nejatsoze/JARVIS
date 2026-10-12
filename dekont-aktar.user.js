// ==UserScript==
// @name         Dekont Aktar — Slack'ten Megapay / Hemen Pay Telegram grubuna
// @namespace    palentis.dekont-aktar
// @version      1.1.1
// @description  C0BMBT1A6KX kanalında bir mesajda mail adresi ya da başına tırnak konmuş kullanıcı adı ("Ahmetokatan) geçince o mesaja oyuncu bilgileriyle (Party ID, ad soyad) ve [Megapay] [Hemen Pay] butonlarıyla cevap verir. Butona basınca açık Telegram Web sekmesi ilgili gruba geçip dekontu ve oyuncu bilgilerini kendisi gönderir (tek tık). Telegram sekmesi açık değilse dekont + bilgiler panoya kopyalanır ve grup açılır. Veriyi açık GT sekmesi okur, Slack sekmesi gönderir.
// @match        https://core-secundus.gmntc.com/*
// @match        https://app.slack.com/*
// @match        https://web.telegram.org/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
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
 *   Slack sekmesi: kanalı 15 sn'de bir okur. İnsanların yazdığı mesajda mail adresi ya da
 *   "kullaniciadi (başında tırnak) varsa GM deposuna 'req:' yazar.
 *   GT sekmesi: panelin oyuncu aramasıyla Party ID'yi ve ad soyadı bulur, 'q:' olarak yazar.
 *   Slack sekmesi mesaja cevap verir: Oyuncu Bilgileri + [Megapay] [Hemen Pay] (bağlantı butonları).
 *   Butona basılınca (Slack sayfasında yakalanır): görsel + bilgiler 'tgJob' olarak GM deposuna yazılır;
 *   açık Telegram Web (K) sekmesi işi alır, gruba geçer, görseli yapıştırır, açıklamaya bilgileri yazar ve
 *   gönderir; sonucu 'tgResult' ile bildirir. Telegram sekmesi yoksa: panoya kopyala + grubu aç.
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0BMBT1A6KX',
    POLL_SEC: 15,
    TARGETS: [
        // hash: Telegram Web K'daki sohbet adresi (#...). Telegram sekmesinin menüsünden "açık sohbeti hedef yap" ile değiştirilebilir.
        { id: 'megapay', label: 'Megapay', url: 'https://t.me/c/2515555411/3', hash: '#-1002515555411' },
        { id: 'hemenpay', label: 'Hemen Pay', url: 'https://web.telegram.org/k/#-4487917824', hash: '#-4487917824' },
    ],
    EMAIL_RE: /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/,
    USER_RE: /(?:^|\s)["“”„](?=[A-Za-z0-9_.-]*[A-Za-z])([A-Za-z0-9_.-]{3,40})/,   // "Ahmetokatan → kullanıcı adı (en az bir harf: "100 TL" sayılmaz)
    EMAIL_FIELD: '2',                                   // panel oyuncu araması: alan 2 = e-posta
};

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Dekont Aktar]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tr = (msg) => { try { const t = GM_getValue('trace', []); t.push(`${new Date().toLocaleTimeString('tr-TR')} ${location.hostname.split('.')[0]} ${msg}`); GM_setValue('trace', t.slice(-14)); } catch { /* yok say */ } };

if (location.hostname === 'app.slack.com') slackSide();
else if (location.hostname === 'web.telegram.org') telegramSide();
else gtSide();

/* ════════════════════════════════════════════════════════════
   GT TARAFI — mail / kullanıcı adı → Party ID + ad soyad
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
    const asList = (d) => Array.isArray(d) ? d : (Object.values(d || {}).find(Array.isArray) || []);
    const pick = (o, names) => { for (const n of names) { const k = Object.keys(o || {}).find(x => x.toLowerCase() === n.toLowerCase()); if (k && o[k] != null && o[k] !== '') return o[k]; } return null; };
    const idOf = (x) => String(pick(x, ['partyId', 'partyID', 'party_id', 'playerId', 'userId', 'id']) ?? '');
    const USER_KEYS = ['userName', 'username', 'login', 'loginName', 'nickName', 'nickname', 'alias', 'screenName'];
    const search = (fieldId, value) => ics('players/search-page', { fieldId, operatorId: '2', value, pageSize: '25', pageNum: '1' }).then(asList);

    /** Kullanıcı adının arama alanı numarası bilinmiyor: 1–15 denenir, sonucunda kullanıcı adı birebir eşleşen alan hatırlanır. */
    async function findByUser(name) {
        const low = name.toLowerCase();
        const match = (list) => list.find(x => USER_KEYS.some(k => String(pick(x, [k]) ?? '').toLowerCase() === low));
        const known = GM_getValue('userField', null);
        const order = known ? [known] : ['1', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'];   // alan bir kez bulununca yalnız o
        for (const f of order) {
            if (f === CONFIG.EMAIL_FIELD) continue;
            const list = await search(f, name).catch(() => []);
            const hit = match(list);
            if (hit) { if (known !== f) { GM_setValue('userField', f); tr(`kullanıcı adı arama alanı: ${f}`); } return hit; }
        }
        throw new Error('bu kullanıcı adıyla oyuncu bulunamadı');
    }
    async function findByEmail(email) {
        const list = await search(CONFIG.EMAIL_FIELD, email);
        const hit = list.find(x => String(pick(x, ['email', 'emailAddress', 'mail']) || '').toLowerCase() === email.toLowerCase()) || list[0];
        if (!hit) throw new Error('bu mail adresiyle oyuncu bulunamadı');
        return hit;
    }
    async function resolve(req) {
        const hit = req.kind === 'email' ? await findByEmail(req.value) : await findByUser(req.value);
        GM_setValue('lastHitKeys', Object.keys(hit).join(', '));
        const pid = idOf(hit);
        if (!/^\d{6,}$/.test(pid)) throw new Error('oyuncu bulundu ama Party ID okunamadı');
        let name = [pick(hit, ['firstName']), pick(hit, ['lastName'])].filter(Boolean).join(' ').trim();
        if (!name) {
            const prof = await ics(`players/${pid}/full-profile`).catch(() => null);
            name = [prof?.firstName, prof?.lastName].filter(Boolean).join(' ').trim();
        }
        return { pid, name: name || '—' };
    }

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
                    const r = await resolve(req);
                    tr(`${req.value} → ${r.pid}`);
                    GM_setValue('q:' + k.slice(4), { ...req, ...r });
                } catch (e) {
                    warn('bulunamadı', req.value, e.message);
                    tr(`${req.value}: ${e.message}`);
                    GM_setValue('q:' + k.slice(4), { ...req, error: e.message });
                }
                GM_setValue('ping', Date.now());
            }
        } finally { busy = false; }
    }
    GM_addValueChangeListener('reqPing', () => work());
    setInterval(work, 5000);
}

/* ════════════════════════════════════════════════════════════
   TELEGRAM TARAFI (Web K) — işi al, gruba geç, gönder
   ════════════════════════════════════════════════════════════ */
function telegramSide() {
    const ME = Math.random().toString(36).slice(2);
    const $ = (sel, root = document) => root.querySelector(sel);
    const visible = (el) => !!el && el.getClientRects().length > 0;
    const waitFor = async (fn, ms = 8000, step = 150) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
    const hashOf = (job) => GM_getValue(`tgHash_${job.target}`, null) || job.hash;
    // Slack'e "açığım" sinyali
    const beat = () => GM_setValue('tgAlive', { owner: ME, at: Date.now(), k: location.pathname.startsWith('/k') });
    beat(); setInterval(beat, 5000);

    const mainInput = () => [...document.querySelectorAll('.chat-input div.input-message-input[contenteditable="true"]')].find(visible);
    const popup = () => [...document.querySelectorAll('.popup-new-media, .popup-send-photo, .popup-new-media.active')].find(visible);
    function typeInto(el, text) {
        el.focus();
        const lines = text.split('\n');
        lines.forEach((l, i) => { if (i) document.execCommand('insertLineBreak') || document.execCommand('insertParagraph'); document.execCommand('insertText', false, l); });
        if (!(el.textContent || '').includes(lines[0])) { el.innerText = text; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    }
    const dataUrlToFile = async (u) => { const b = await (await fetch(u)).blob(); return new File([b], `dekont.${(b.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: b.type }); };
    const sendBtn = (root) => [...root.querySelectorAll('button')].find(b => visible(b) && (/btn-primary|btn-send/.test(b.className) || /^(send|gönder)$/i.test((b.textContent || '').trim())));

    async function run(job) {
        if (!job?.id || Date.now() - job.at > 60000) return;
        // birden çok Telegram sekmesi varsa biri alır
        const claimKey = `tgClaim_${job.id}`;
        if (GM_getValue(claimKey, null)) return;
        GM_setValue(claimKey, ME); await sleep(250);
        if (GM_getValue(claimKey, null) !== ME) return;
        const done = (ok, msg) => { GM_setValue('tgResult', { id: job.id, ok, msg: msg || '', at: Date.now() }); GM_deleteValue(claimKey); tr(`telegram ${job.label}: ${ok ? 'gönderildi' : 'HATA ' + msg}`); };
        try {
            if (!location.pathname.startsWith('/k')) return done(false, 'Telegram sekmesi Web K değil (adres web.telegram.org/k/ olmalı)');
            const hash = hashOf(job);
            if (location.hash !== hash) { location.hash = hash; await sleep(1800); }
            const input = await waitFor(mainInput, 10000);
            if (!input) return done(false, `${job.label} sohbeti açılamadı (mesaj kutusu yok — grup adresi doğru mu?)`);
            await sleep(400);
            if (job.image) {
                const file = await dataUrlToFile(job.image);
                const dt = new DataTransfer(); dt.items.add(file);
                input.focus();
                input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                let pop = await waitFor(popup, 4000);
                if (!pop) {   // yapıştırma tutmadıysa sürükle-bırak
                    const zone = $('.chat.active') || $('.chats-container') || document.body;
                    for (const type of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
                    pop = await waitFor(popup, 4000);
                }
                if (!pop) return done(false, 'görsel gönderme penceresi açılmadı');
                const caption = await waitFor(() => [...pop.querySelectorAll('div.input-message-input[contenteditable="true"], .input-field-input[contenteditable="true"]')].find(visible), 3000);
                if (caption) typeInto(caption, job.text);
                await sleep(300);
                const btn = sendBtn(pop);
                if (!btn) return done(false, 'gönder düğmesi bulunamadı');
                btn.click();
                const gone = await waitFor(() => !popup(), 8000);
                if (!gone) return done(false, 'gönderim onaylanmadı (pencere kapanmadı)');
                if (!caption) {   // açıklama alanı yoksa bilgileri ayrı mesaj olarak gönder
                    const inp = await waitFor(mainInput, 3000);
                    if (inp) { typeInto(inp, job.text); await sleep(200); const b = $('.chat-input .btn-send'); b ? b.click() : inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); }
                }
            } else {
                typeInto(input, job.text);
                await sleep(250);
                const b = $('.chat-input .btn-send');
                if (b) b.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await sleep(600);
            }
            done(true);
        } catch (e) { done(false, e.message); }
    }
    GM_addValueChangeListener('tgJob', (k, o, job) => { run(job); });

    for (const t of CONFIG.TARGETS) {
        GM_registerMenuCommand(`Açık sohbeti "${t.label}" hedefi yap`, () => {
            if (!location.hash) return alert('Önce Telegram\'da hedef grubu/konuyu açın.');
            GM_setValue(`tgHash_${t.id}`, location.hash);
            alert(`${t.label} hedefi kaydedildi: ${location.hash}`);
        });
    }
    GM_registerMenuCommand('Hedefleri göster', () => alert(CONFIG.TARGETS.map(t => `${t.label}: ${GM_getValue(`tgHash_${t.id}`, null) || t.hash}${GM_getValue(`tgHash_${t.id}`, null) ? ' (kaydedilmiş)' : ' (varsayılan)'}`).join('\n')));
}

/* ════════════════════════════════════════════════════════════
   SLACK TARAFI — kanalı izle, cevap ver, butonları yakala
   ════════════════════════════════════════════════════════════ */
function slackSide() {
    let token = null, me = null, busy = false, again = false;
    const ME = Math.random().toString(36).slice(2);
    const status = (msg) => GM_setValue('slackStatus', { msg, at: Date.now() });
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

    /* ── tetikleyici ── */
    function trigger(text) {
        const t = String(text || '').replace(/<mailto:([^|>]+)\|[^>]*>/g, '$1').replace(/&quot;/g, '"');
        const em = t.match(CONFIG.EMAIL_RE)?.[1];
        if (em) return { kind: 'email', value: em.toLowerCase() };
        const u = t.match(CONFIG.USER_RE)?.[1];
        if (u) return { kind: 'user', value: u };
        return null;
    }
    const request = (key, req) => {
        const done = GM_getValue('done', {}), now = Date.now();
        if (done[key]) return;
        for (const k in done) if (now - done[k] > 24 * 3600e3) delete done[k];
        done[key] = now; GM_setValue('done', done);
        GM_setValue('req:' + key, { ...req, at: now }); GM_setValue('reqPing', now);
    };

    let scanning = false;
    const isLeader = () => { const l = GM_getValue('slackLeader', null); return !l || l.owner === ME || Date.now() - l.at >= 60000; };
    async function scan() {
        if (scanning || GM_getValue('enabled', true) === false) return;
        if (!isLeader()) return;
        GM_setValue('slackLeader', { owner: ME, at: Date.now() });
        scanning = true;
        try {
            if (!token) await resolveToken();
            let last = GM_getValue('lastTs', null);
            if (!last) { last = String(Date.now() / 1000); GM_setValue('lastTs', last); tr('izleme başladı (bundan sonraki mesajlar)'); return; }   // ilk kurulum: geçmişe cevap yok
            const r = await api('conversations.history', { channel: CONFIG.CHANNEL, oldest: last, limit: '50' });
            const msgs = (r.messages || []).sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
            for (const m of msgs) {
                last = m.ts;
                const what = `${(m.text || '').slice(0, 40).replace(/\s+/g, ' ')}${m.files?.length ? ` [+${m.files.length} dosya]` : ''}`;
                if (m.bot_id || (m.subtype && m.subtype !== 'file_share')) { tr(`atlandı (${m.subtype || 'bot'}): ${what}`); continue; }   // insan mesajları (görselli olanlar dahil)
                const t = trigger(m.text);
                if (!t) { tr(`tetik yok: ${what}`); continue; }
                const img = (m.files || []).find(f => /^image\//.test(f.mimetype || ''));
                request(`${m.ts}-${t.value}`, { ...t, thread: m.ts, file: img ? { url: img.url_private_download || img.url_private, name: img.name, type: img.mimetype } : null });
                log('istek:', t.kind, t.value, 'mesaj', m.ts, img ? '(görselli)' : '(görselsiz)');
            }
            GM_setValue('lastTs', last);
            status(`izleniyor (${msgs.length} yeni mesaj)`);
        } catch (e) { warn('tarama hatası:', e.message); status(`HATA: ${e.message}`); }
        finally { scanning = false; }
    }

    /* ── cevap ── */
    const infoText = (v) => `Oyuncu Bilgileri:\n• ${v.pid} (PartyID)\n• Ad Soyad : ${v.name}`;
    async function flush() {
        if (busy) { again = true; return; }
        if (!isLeader()) return;
        busy = true; again = false;
        try {
            for (const k of GM_listValues().filter(x => x.startsWith('q:'))) {
                const v = GM_getValue(k, null);
                GM_deleteValue(k);
                if (!v) continue;
                if (v.error) {
                    await api('chat.postMessage', { channel: CONFIG.CHANNEL, thread_ts: v.thread, text: `⚠️ ${v.value}: ${v.error}` });
                    status(`bulunamadı ${v.value}`);
                    continue;
                }
                const blocks = [
                    { type: 'section', text: { type: 'mrkdwn', text: `*Oyuncu Bilgileri:*\n• \`${v.pid}\` (PartyID)\n• Ad Soyad : ${esc(v.name)}` } },
                    { type: 'actions', elements: CONFIG.TARGETS.map(t => ({ type: 'button', action_id: `dk_${t.id}`, text: { type: 'plain_text', text: t.label }, url: t.url })) },
                ];
                const r = await api('chat.postMessage', { channel: CONFIG.CHANNEL, thread_ts: v.thread, text: infoText(v), blocks: JSON.stringify(blocks), unfurl_links: 'false' });
                const map = GM_getValue('replies', {});   // cevap ts → oyuncu + o mesajın dekontu
                for (const t in map) if (Date.now() - map[t].at > 7 * 864e5) delete map[t];
                map[r.ts] = { pid: v.pid, name: v.name, thread: v.thread, reply: r.ts, file: v.file, at: Date.now() };
                GM_setValue('replies', map);
                tr(`cevap gitti ${v.pid}${v.file ? ' (görsel var)' : ' (görsel yok)'}`);
                status(`cevap gönderildi ${v.pid}`);
                await sleep(600);
            }
        } catch (e) { warn('gönderilemedi:', e.message); status(`HATA: ${e.message}`); tr(`HATA: ${e.message}`); }
        finally { busy = false; if (again) setTimeout(flush, 200); }
    }

    /* ── buton: görsel + bilgiler panoya, sonra Telegram ── */
    function fetchBlob(url) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            method: 'GET', url, responseType: 'blob', timeout: 30000,   // Slack oturum çerezleriyle
            onload: (r) => (r.status >= 200 && r.status < 300 && /^image\//.test(r.response?.type || '') ? resolve(r.response) : reject(new Error(`görsel alınamadı (HTTP ${r.status}, ${r.response?.type || 'boş'})`))),
            onerror: () => reject(new Error('görsel indirilemedi')), ontimeout: () => reject(new Error('görsel zaman aşımı')),
        }));
    }
    /** Pano yalnızca PNG kabul eder: JPEG vb. dekontu PNG'ye çevir. */
    async function toPng(blob) {
        if (blob.type === 'image/png') return blob;
        const bmp = await createImageBitmap(blob);
        const cv = document.createElement('canvas');
        cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
        return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('png üretilemedi'))), 'image/png'));
    }
    const pngCache = new Map();   // görsel adresi → Promise<Blob>
    function pngFor(entry) {
        const url = entry?.file?.url;
        if (!url) return null;
        if (!pngCache.has(url)) pngCache.set(url, fetchBlob(url).then(toPng).catch(e => { pngCache.delete(url); throw e; }));
        return pngCache.get(url);
    }
    const blobToDataUrl = (b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });

    async function copyAndOpen(entry, target) {
        const text = infoText(entry);
        const items = { 'text/plain': new Blob([text], { type: 'text/plain' }) };
        const png = pngFor(entry);
        if (png) {
            items['image/png'] = png;
            items['text/html'] = png.then(blobToDataUrl).then(u => new Blob([`<img src="${u}"><br>${esc(text).replace(/\n/g, '<br>')}`], { type: 'text/html' }));
        }
        let ok = true;
        try {
            await navigator.clipboard.write([new ClipboardItem(items)]);
        } catch (e) {
            ok = false;
            warn('pano (görselli) yazılamadı:', e.message);
            try { await navigator.clipboard.writeText(text); } catch { /* yok say */ }
        }
        tr(`${target.label}: ${ok ? (png ? 'görsel + bilgi kopyalandı' : 'bilgi kopyalandı (görsel yok)') : 'yalnızca bilgi kopyalandı'} · ${entry.pid}`);
        toast(ok ? `${png ? 'Dekont ve oyuncu bilgileri' : 'Oyuncu bilgileri'} kopyalandı → ${target.label} açılıyor, yapıştırın (Ctrl+V)` : 'Görsel kopyalanamadı, sadece bilgiler kopyalandı', ok);
        W.open(target.url, `palentis-telegram-${target.id}`);
    }

    function toast(msg, ok = true) {
        const d = document.createElement('div');
        d.textContent = msg;
        Object.assign(d.style, { position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', zIndex: 99999, padding: '10px 16px', borderRadius: '10px',
            background: ok ? '#343a43' : '#b4123f', color: '#fff', font: '700 13px Lato, "Segoe UI", sans-serif', boxShadow: '0 6px 20px rgba(0,0,0,.25)', maxWidth: '80vw' });
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 4500);
    }

    /** Slack'teki bağlantı butonu: hangi hedef, hangi oyuncu? (oyuncu, butonun mesajındaki "(PartyID)" satırından) */
    function locate(el) {
        const btn = el.closest('a, button');
        if (!btn) return null;
        const label = (btn.textContent || '').trim();
        const href = btn.getAttribute('href') || '';
        const target = CONFIG.TARGETS.find(t => label === t.label || (href && href.includes(t.url)));
        if (!target) return null;
        let box = btn;
        for (let i = 0; i < 12 && box && !/\(PartyID\)/.test(box.textContent || ''); i++) box = box.parentElement;
        const pid = (box?.textContent || '').match(/(\d{6,})\s*\(PartyID\)/)?.[1];
        if (!pid) return null;
        const map = GM_getValue('replies', {});
        // önce Slack'in mesaj kutusundaki zaman damgası (aynı oyuncunun birden çok dekontu olabilir), yoksa o oyuncunun en son cevabı
        let ts = null;
        for (let n = btn; n && !ts; n = n.parentElement) for (const at of ['data-item-key', 'data-msg-ts', 'data-ts', 'id']) { const m = String(n.getAttribute?.(at) || '').match(/(\d{10}\.\d{6})/); if (m && map[m[1]]) { ts = m[1]; break; } }
        const entry = (ts && map[ts]) || Object.values(map).filter(e => e.pid === pid).sort((a, b) => b.at - a.at)[0];
        return entry ? { target, entry } : null;
    }
    // görseli butona gelince önceden hazırla (tıklamada pano izni kaybolmasın)
    document.addEventListener('pointerover', (e) => { const l = locate(e.target); if (l) pngFor(l.entry)?.catch(() => {}); }, true);
    document.addEventListener('click', (e) => {
        const l = locate(e.target);
        if (!l) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const alive = GM_getValue('tgAlive', null);
        if (alive && Date.now() - alive.at < 20000) sendViaTelegram(l.entry, l.target);   // Telegram sekmesi açık: tek tık gönderim
        else copyAndOpen(l.entry, l.target);                                              // değilse: panoya kopyala + grubu aç
    }, true);

    /** Telegram sekmesine iş bırak, sonucu bekle. */
    const sending = new Set();
    async function sendViaTelegram(entry, target) {
        const key = `${entry.reply}-${target.id}`;
        if (sending.has(key)) return;
        sending.add(key);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        try {
            toast(`${target.label} grubuna gönderiliyor…`);
            let image = null;
            if (entry.file?.url) {
                try { image = await blobToDataUrl(await fetchBlob(entry.file.url)); } catch (e) { warn('dekont alınamadı:', e.message); toast(`Dekont alınamadı (${e.message}), yalnızca bilgiler gidecek`, false); }
            }
            GM_setValue('tgJob', { id, target: target.id, label: target.label, hash: target.hash, text: infoText(entry), image, pid: entry.pid, at: Date.now() });
            tr(`${target.label}: Telegram'a iş bırakıldı · ${entry.pid}${image ? ' (dekontlu)' : ''}`);
            const res = await new Promise((resolve) => {
                const t = setTimeout(() => resolve({ ok: false, msg: 'Telegram sekmesi 40 sn içinde cevap vermedi' }), 40000);
                const lid = GM_addValueChangeListener('tgResult', (k, o, v) => { if (v?.id === id) { clearTimeout(t); GM_removeValueChangeListener?.(lid); resolve(v); } });
            });
            tr(`${target.label}: ${res.ok ? 'gönderildi' : 'HATA ' + res.msg} · ${entry.pid}`);
            toast(res.ok ? `✓ ${target.label} grubuna gönderildi (${entry.pid})` : `${target.label}: gönderilemedi — ${res.msg}`, res.ok);
        } finally { sending.delete(key); }
    }

    GM_addValueChangeListener('ping', () => flush());
    setInterval(flush, 10000);
    setInterval(scan, CONFIG.POLL_SEC * 1000);
    setTimeout(scan, 3000);
    if (W.__DK_TEST__) Object.assign(W.__DK_TEST__, { trigger, locate, copyAndOpen, toPng });

    GM_registerMenuCommand('Dekont Aktar aç / kapat', () => {
        const on = GM_getValue('enabled', true) === false;
        GM_setValue('enabled', on);
        alert(`Dekont Aktar ${on ? 'AÇIK' : 'KAPALI'}.`);
    });
    GM_registerMenuCommand('Durum', () => {
        const s = GM_getValue('slackStatus', null);
        alert(`Dekont Aktar: ${GM_getValue('enabled', true) === false ? 'KAPALI' : 'AÇIK'} · kanal ${CONFIG.CHANNEL}\nSon: ${s ? `${s.msg} (${new Date(s.at).toLocaleTimeString('tr-TR')})` : '—'}\nKullanıcı adı arama alanı: ${GM_getValue('userField', '— (ilk aramada bulunur)')}\nSürüm: ${GM_info?.script?.version || '?'}\n\nSon adımlar:\n${GM_getValue('trace', []).join('\n') || '—'}`);
    });
}

})();
