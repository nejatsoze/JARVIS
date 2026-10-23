// ==UserScript==
// @name         Dekont Aktar — Slack'ten Megapay / Hemen Pay Telegram grubuna
// @namespace    palentis.dekont-aktar
// @version      2.3.0
// @description  C08TKRJQ96G kanalında bir mesajda mail adresi ya da başına tırnak konmuş kullanıcı adı ("Ahmetokatan) geçince o mesajın altına YALNIZ SENİN TARAYICINDA görünen bir kart çizer (Slack'e cevap gönderilmez): oyuncu bilgileri (Party ID, ad soyad), [Megapay] [Hemen Pay], [Altyapıda Sorgula] (yatırımı seç → açık Pingwi sekmesinden işlem bulunur → Transaction check formu dekont dahil kendiliğinden dolar), [📋 Kopyala] (Telegram Web'de tek Ctrl+V ile görsel + açıklama), [TALEP] [ONAY] (thread'e gerçek mesaj). Butona basınca açık Telegram Web sekmesi ilgili gruba geçip dekontu ve oyuncu bilgilerini kendisi gönderir (tek tık). Telegram sekmesi cevap vermezse bilgiler panoya kopyalanır ve uyarı çıkar. Veriyi açık GT sekmesi okur, Slack sekmesi gönderir. Telegram'da Megapay / Hemen Pay sohbetlerinde yazma kutusunun üstünde "Talep" butonu ("Talep kt lütfen" gönderir).
// @match        https://core-secundus.gmntc.com/*
// @match        https://app.slack.com/*
// @match        https://web.telegram.org/*
// @match        https://*.safepaymentprocessingservice.com/*
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
 *   gönderir; sonucu 'tgResult' ile bildirir. Telegram sekmesi 'tgPing'e cevap vermezse: bilgiler panoya + uyarı.
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C08TKRJQ96G',
    POLL_SEC: 15,
    TARGETS: [
        // hash: Telegram Web K'daki sohbet adresi (#...). Telegram sekmesinin menüsünden "açık sohbeti hedef yap" ile değiştirilebilir.
        // Megapay grubu forum (alt konulu): 1 General, 3 Megapay Havale, 4 Megapay Kredi Kartı → 3'e gider
        { id: 'megapay', label: 'Megapay', url: 'https://t.me/c/2515555411/3', hash: '#-2515555411', topic: { id: 3, name: 'Megapay Havale' } },
        { id: 'hemenpay', label: 'Hemen Pay', url: 'https://web.telegram.org/k/#-4487917824', hash: '#-4487917824' },
    ],
    ALTYAPI_CHANNEL: 'C07MNHZ1KDM',                      // "Altyapıda Sorgula": Transaction check iş akışının kanalı
    WORKFLOW_URL: 'https://slack.com/shortcuts/Ft0B25CC7A4R/03cdfbfc53b717e48f71117346f043f7',                                    // Transaction check iş akışının linki (boşsa form elle açılır, yine otomatik dolar)
    PINGWI_API: 'https://pingwi-admin.safepaymentprocessingservice.com/api/transactions',
    COPY_LABEL: '📋 Kopyala',                            // dekont + oyuncu bilgilerini birlikte panoya alan geniş buton
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
else if (/safepaymentprocessingservice\.com$/.test(location.hostname)) pingwiSide();
else gtSide();

/* ════════════════════════════════════════════════════════════
   PINGWI TARAFI — CORE TX ID ile Pingwi işlemini bul (Slack'in sorusuna cevap)
   ════════════════════════════════════════════════════════════ */
function pingwiSide() {
    const ME = Math.random().toString(36).slice(2);
    GM_setValue('pwAlive', { owner: ME, at: Date.now() });
    GM_addValueChangeListener('pwReq', async (k, o, req) => {
        if (!req?.id || Date.now() - req.at > 60000) return;
        const claim = `pwClaim_${req.id}`;   // birden çok Pingwi sekmesi açıksa yalnız biri cevaplar
        if (GM_getValue(claim, null)) return;
        GM_setValue(claim, ME); await sleep(200);
        if (GM_getValue(claim, null) !== ME) return;
        const done = (v) => { GM_setValue('pwRes', { id: req.id, at: Date.now(), ...v }); GM_deleteValue(claim); };
        try {
            const n = Date.now();
            const url = `${CONFIG.PINGWI_API}?${new URLSearchParams({ filterField: 'referenceNo', filterValue: req.ref, fromDate: String(n - 60 * 864e5), toDate: String(n + 432e5), updatedDate: 'false', page: '1', perPage: '10' })}`;
            const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(`Pingwi HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' — Pingwi oturumu düşmüş olabilir' : ''}`);
            const list = (await res.json())?.transactions?.content || [];
            const tx = list.find(t => String(t.referenceNumber) === String(req.ref));   // birebir eşleşme şart
            if (!tx) return done({ ok: false, msg: `Pingwi'de ${req.ref} bulunamadı` });
            done({ ok: true, tx: { uuid: tx.transactionUUID || '', clientId: tx.client?.merchantClientId || '', amount: tx.amount || '', created: tx.createdDate || '', status: tx.status || '' } });
        } catch (e) { done({ ok: false, msg: e.message }); }
    });
    log('Pingwi köprüsü hazır');
}

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

    /* Slack kartı "Altyapıda Sorgula": oyuncunun son yatırımları (Deposits sekmesiyle aynı veri) */
    GM_addValueChangeListener('depReq', async (k, o, req) => {
        if (!req?.id || Date.now() - req.at > 60000 || !token()) return;
        const claim = `depClaim_${req.id}`;
        if (GM_getValue(claim, null)) return;
        GM_setValue(claim, ME); await sleep(200);
        if (GM_getValue(claim, null) !== ME) return;
        const ymd = (t) => new Date(t).toISOString().slice(0, 10);
        try {
            const list = asList(await ics('player-deposit/query', { partyId: req.pid, startDate: ymd(Date.now() - 30 * 864e5), endDate: ymd(Date.now() + 864e5), currency: 'TRY' }))
                .filter(d => String(d.paymentType || d.type || '').toUpperCase().startsWith('DEP'))
                .sort((a, b) => (b.requestDate || 0) - (a.requestDate || 0)).slice(0, 8)
                .map(d => ({ id: String(d.id), amount: Number(d.amount) || 0, method: d.methodName || '', status: d.status || d.paymentStatus || '', at: d.requestDate || 0, atStr: d.requestDateStr || '' }));
            GM_setValue('depRes', { id: req.id, ok: true, list, at: Date.now() });
        } catch (e) { GM_setValue('depRes', { id: req.id, ok: false, msg: e.message, at: Date.now() }); }
        GM_deleteValue(claim);
    });
}

/* ════════════════════════════════════════════════════════════
   TELEGRAM TARAFI (Web K) — işi al, gruba geç, gönder
   ════════════════════════════════════════════════════════════ */
function telegramSide() {
    const ME = Math.random().toString(36).slice(2);
    const $ = (sel, root = document) => root.querySelector(sel);
    const visible = (el) => !!el && el.getClientRects().length > 0;
    const waitFor = async (fn, ms = 8000, step = 150) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await tsleep(step); } };
    const hashOf = (job) => GM_getValue(`tgHash_${job.target}`, null) || job.hash;
    // Arka plandaki sekmede setTimeout dakikada bire düşebilir: bekleme Worker saatiyle (yavaşlatılmaz), olmazsa setTimeout
    let worker = null, wseq = 0; const wwait = new Map();
    try {
        worker = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' })));
        worker.onmessage = (e) => { const r = wwait.get(e.data); if (r) { wwait.delete(e.data); r(); } };
    } catch { worker = null; }
    // Worker (Telegram'ın güvenlik kuralı engellerse hiç cevap vermez) ile normal zamanlayıcı yarışır: hangisi önce biterse
    const tsleep = (ms) => new Promise(r => {
        let fin = false; const end = () => { if (!fin) { fin = true; r(); } };
        setTimeout(end, ms);
        if (worker) { const id = ++wseq; wwait.set(id, end); try { worker.postMessage({ id, ms }); } catch { /* yok say */ } }
    });
    if (worker) worker.onerror = () => { worker = null; };
    // Slack'in "orada mısın?" sorusuna cevap (olay tabanlı, zamanlayıcıya bağlı değil)
    GM_addValueChangeListener('tgPing', (k, o, v) => { if (v?.id) GM_setValue('tgPong', { id: v.id, owner: ME, k: location.pathname.startsWith('/k'), at: Date.now() }); });
    GM_setValue('tgAlive', { owner: ME, at: Date.now(), k: location.pathname.startsWith('/k') });

    const mainInput = () => [...document.querySelectorAll('.chat-input div.input-message-input[contenteditable="true"]')].find(visible);
    const popup = () => [...document.querySelectorAll('.popup-new-media, .popup-send-photo, .popup-new-media.active')].find(visible);
    function typeInto(el, text) {
        el.focus();
        const lines = text.split('\n');
        lines.forEach((l, i) => { if (i) document.execCommand('insertLineBreak') || document.execCommand('insertParagraph'); document.execCommand('insertText', false, l); });
        if (!(el.textContent || '').includes(lines[0])) { el.innerText = text; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    }
    /* Firefox + Tampermonkey: script'in kendi dünyasında oluşturulan DataTransfer/File'ı Telegram'ın kodu okuyamaz.
       Bu yüzden dosya, aktarım nesnesi ve olay sayfanın (Telegram'ın) kendi kurucularıyla oluşturulur. */
    const PW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const toPage = (o) => (typeof cloneInto === 'function' ? cloneInto(o, PW, { wrapReflectors: true }) : o);
    async function pageTransfer(dataUrl) {
        // data: adresi fetch ile okunmaz (Telegram'ın güvenlik kuralı engelleyebilir): base64 burada çözülür
        const [head, b64] = String(dataUrl).split(',');
        const type = head.match(/data:([^;]+)/)?.[1] || 'image/png';
        const bin = atob(b64), u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const file = new PW.File(toPage([u8]), `dekont.${ext}`, toPage({ type }));
        const dt = new PW.DataTransfer();
        dt.items.add(file);
        return dt;
    }
    /** Sayfa olayı + dosya taşıyıcısı olaya sonradan özellik olarak eklenir (Firefox, kurucuya verilen dosyaları siler). */
    function pageEvent(Ctor, type, prop, dt) {
        const ev = new (PW[Ctor] || PW.Event)(type, toPage({ bubbles: true, cancelable: true }));
        try { PW.Object.defineProperty(ev.wrappedJSObject || ev, prop, toPage({ value: dt, configurable: true })); } catch (e) { warn('olay özelliği eklenemedi:', e.message); }
        return ev;
    }
    /** Telegram'ın sürükle-bırak yolu: gövdeye dragenter/dragover → Telegram bırakma kutusunu açar → dosya o kutuya bırakılır. */
    async function dropFiles(dt) {
        const body = document.body;
        body.dispatchEvent(pageEvent('DragEvent', 'dragenter', 'dataTransfer', dt));
        let zone = null;
        for (let i = 0; i < 20 && !zone; i++) {
            body.dispatchEvent(pageEvent('DragEvent', 'dragover', 'dataTransfer', dt));   // 500 ms'de bir yenilenmezse kutu kapanır
            await tsleep(150);
            const drops = [...document.querySelectorAll('.drops-container .drop')];
            zone = drops[drops.length - 1] || null;   // son kutu: "hızlı gönder" (medya)
        }
        if (!zone) return false;
        zone.dispatchEvent(pageEvent('DragEvent', 'dragover', 'dataTransfer', dt));
        zone.dispatchEvent(pageEvent('DragEvent', 'drop', 'dataTransfer', dt));
        return true;
    }
    const sendBtn = (root) => [...root.querySelectorAll('button')].find(b => visible(b) && (/btn-primary|btn-send/.test(b.className) || /^(send|gönder)$/i.test((b.textContent || '').trim())));

    async function run(job) {
        if (!job?.id || Date.now() - job.at > 60000) return;
        // birden çok Telegram sekmesi varsa biri alır
        const claimKey = `tgClaim_${job.id}`;
        if (GM_getValue(claimKey, null)) return;
        GM_setValue(claimKey, ME); await tsleep(250);
        if (GM_getValue(claimKey, null) !== ME) return;
        tr(`telegram: iş alındı (${job.label}${job.topic ? ' / ' + job.topic.name : ''}${job.image ? ', dekontlu' : ''})`);
        const done = (ok, msg) => { GM_setValue('tgResult', { id: job.id, ok, msg: msg || '', at: Date.now() }); GM_deleteValue(claimKey); tr(`telegram ${job.label}: ${ok ? 'gönderildi' : 'HATA ' + msg}`); };
        try {
            if (!location.pathname.startsWith('/k')) return done(false, 'Telegram sekmesi Web K değil (adres web.telegram.org/k/ olmalı)');
            const base = hashOf(job).split('?')[0];
            // alt konulu grup: Telegram Web K konuyu adresle açar (#-ID?thread=N)
            const hash = job.topic ? `${base}?thread=${job.topic.id}` : base;
            if (location.hash !== hash) { location.hash = hash; await tsleep(1800); }
            tr(`telegram: sohbet ${hash} açıldı`);
            if (job.topic) {   // doğru konu mu? Üst başlıkta konunun adı görünmeli; değilse listeden seçmeyi dene
                const name = job.topic.name.toLowerCase();
                const inTopic = () => [...document.querySelectorAll('.topbar .peer-title, .chat.active .peer-title')].some(el => visible(el) && (el.textContent || '').trim().toLowerCase().startsWith(name));
                let ok = await waitFor(inTopic, 6000);
                if (!ok) {
                    const peer = base.replace(/^#/, '');
                    const row = [...document.querySelectorAll(`[data-peer-id="${peer}"][data-thread-id="${job.topic.id}"]`)].find(visible)
                        || [...document.querySelectorAll('.chatlist-chat, li[data-peer-id]')].find(el => visible(el) && (el.querySelector('.peer-title')?.textContent || '').trim().toLowerCase().startsWith(name));
                    if (row) {
                        for (const type of ['mousedown', 'mouseup', 'click']) row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
                        ok = await waitFor(inTopic, 5000);
                    }
                }
                if (!ok) return done(false, `"${job.topic.name}" konusu açılamadı (yanlış yere gitmesin diye gönderilmedi)`);
                tr(`telegram: konu açık (${job.topic.name})`);
            }
            const input = await waitFor(mainInput, 10000);
            if (!input) return done(false, `${job.label} sohbeti açılamadı (mesaj kutusu yok — grup adresi doğru mu?)`);
            await tsleep(400);
            if (job.image) {
                const dt = await pageTransfer(job.image);
                input.focus();
                input.dispatchEvent(pageEvent('ClipboardEvent', 'paste', 'clipboardData', dt));
                let pop = await waitFor(popup, 4000);
                if (!pop) {   // yapıştırma tutmadıysa sürükle-bırak
                    tr('telegram: yapıştırma tutmadı, sürükle-bırak deneniyor');
                    const dropped = await dropFiles(dt);
                    if (!dropped) tr('telegram: bırakma kutusu açılmadı');
                    pop = await waitFor(popup, 5000);
                }
                if (!pop) {
                    const seen = [...document.querySelectorAll('[class*="popup"]')].filter(visible).map(e => e.className).slice(0, 4).join(' | ');
                    return done(false, `görsel gönderme penceresi açılmadı${seen ? ` (ekrandaki pencereler: ${seen})` : ''}`);
                }
                tr('telegram: görsel penceresi açıldı');
                const caption = await waitFor(() => [...pop.querySelectorAll('div.input-message-input[contenteditable="true"], .input-field-input[contenteditable="true"]')].find(visible), 3000);
                if (caption) typeInto(caption, job.text);
                await tsleep(300);
                const btn = sendBtn(pop);
                if (!btn) return done(false, 'gönder düğmesi bulunamadı');
                btn.click();
                const gone = await waitFor(() => !popup(), 8000);
                if (!gone) return done(false, 'gönderim onaylanmadı (pencere kapanmadı)');
                if (!caption) {   // açıklama alanı yoksa bilgileri ayrı mesaj olarak gönder
                    const inp = await waitFor(mainInput, 3000);
                    if (inp) { typeInto(inp, job.text); await tsleep(200); const b = $('.chat-input .btn-send'); b ? b.click() : inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); }
                }
            } else {
                typeInto(input, job.text);
                await tsleep(250);
                const b = $('.chat-input .btn-send');
                if (b) b.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await tsleep(600);
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

    /* ── Kopyala ile alınan dekont + bilgiler tek Ctrl+V ile: görsel gönderme penceresi açılınca bilgiler açıklamaya yazılır ── */
    document.addEventListener('paste', (e) => {
        const dt = e.clipboardData;
        if (!dt) return;
        const text = (dt.getData('text/plain') || '').trim();
        const hasImg = [...(dt.items || [])].some(i => i.kind === 'file' && /^image\//.test(i.type));
        if (!hasImg || !/^Oyuncu Bilgileri/.test(text)) return;
        (async () => {
            const pop = await waitFor(popup, 5000);
            const cap = pop && await waitFor(() => [...pop.querySelectorAll('div.input-message-input[contenteditable="true"], .input-field-input[contenteditable="true"]')].find(visible), 3000);
            if (cap && !(cap.textContent || '').trim()) typeInto(cap, text);
        })();
    }, true);

    /* ── Hızlı mesaj kartı (Talep / Mail KT): Megapay / Hemen Pay sohbetlerinde, tutamaktan sürüklenebilir ── */
    const QUICK = [
        { label: 'Talep', text: 'Talep kt lütfen', bg: '#3390ec', hover: '#2a7fd4' },
        { label: 'Mail KT', text: 'Mail iletilmiştir kt lütfen', bg: '#1f9d6b', hover: '#188a5d' },
    ];
    const chatId = (h) => String(h || '').split('?')[0];
    const inTarget = () => CONFIG.TARGETS.some(t => chatId(GM_getValue(`tgHash_${t.id}`, null) || t.hash) === chatId(location.hash));
    async function quickSend(q, b) {
        const flash = (t, bg) => { b.textContent = t; b.style.background = bg; setTimeout(() => { b.textContent = q.label; b.style.background = q.bg; }, 1600); };
        const input = mainInput();
        if (!input) return;
        if ((input.textContent || '').trim()) { flash('Kutu dolu', '#b4123f'); return; }   // yazılmış taslağı bozma
        typeInto(input, q.text);
        await tsleep(150);
        const send = $('.chat-input .btn-send');
        send ? send.click() : input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        flash('✓ Gönderildi', '#475467');
    }
    let card = null;
    function quickCard() {
        const box = document.createElement('div');
        box.id = 'dk-quick';
        Object.assign(box.style, { position: 'fixed', zIndex: 50, display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 8px 7px 6px',
            background: '#fff', borderRadius: '14px', boxShadow: '0 4px 16px rgba(16,24,40,.18), 0 0 0 1px rgba(16,24,40,.06)',
            font: '600 14px/1 -apple-system, "Segoe UI", Roboto, sans-serif', userSelect: 'none' });
        const grip = document.createElement('div');
        grip.textContent = '⠿'; grip.title = 'Sürükle: kartı taşı (çift tık: varsayılan yere dön)';
        Object.assign(grip.style, { cursor: 'grab', color: '#98a2b3', fontSize: '18px', padding: '0 2px' });
        box.appendChild(grip);
        for (const q of QUICK) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = q.label; b.title = `"${q.text}" gönder`;
            Object.assign(b.style, { height: '36px', padding: '0 18px', border: '0', borderRadius: '10px', background: q.bg, color: '#fff',
                font: 'inherit', cursor: 'pointer', boxShadow: '0 1px 2px rgba(16,24,40,.12)' });
            b.addEventListener('mouseenter', () => { if (b.textContent === q.label) b.style.background = q.hover; });
            b.addEventListener('mouseleave', () => { if (b.textContent === q.label) b.style.background = q.bg; });
            b.addEventListener('mousedown', (e) => e.preventDefault());   // yazma kutusunun odağı kaybolmasın
            b.addEventListener('click', () => quickSend(q, b));
            box.appendChild(b);
        }
        // Sürükle-bırak: konum (sağ / alt boşluk) kaydedilir, tüm Telegram sekmelerinde aynı
        let drag = null;
        grip.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const r = box.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            grip.style.cursor = 'grabbing'; e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!drag) return;
            const x = Math.min(Math.max(0, e.clientX - drag.dx), innerWidth - box.offsetWidth);
            const y = Math.min(Math.max(0, e.clientY - drag.dy), innerHeight - box.offsetHeight);
            box.style.left = `${x}px`; box.style.top = `${y}px`;
        });
        document.addEventListener('mouseup', () => {
            if (!drag) return;
            drag = null; grip.style.cursor = 'grab';
            const r = box.getBoundingClientRect();
            GM_setValue('quickPos', { right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) });
        });
        grip.addEventListener('dblclick', () => GM_deleteValue('quickPos'));
        return box;
    }
    // Hedef sohbetteyken göster: kayıtlı konum varsa orada, yoksa yazma kutusunun sağ üstünde; değilse kaldır
    setInterval(() => {
        const input = inTarget() && mainInput();
        if (!input) { if (card) { card.remove(); card = null; } return; }
        if (!card || !card.isConnected) { card = quickCard(); document.body.appendChild(card); }
        if (card.style.cursor === 'grabbing' || card.querySelector('div').style.cursor === 'grabbing') return;   // sürüklenirken dokunma
        const pos = GM_getValue('quickPos', null);
        if (pos) {
            card.style.left = `${Math.max(0, innerWidth - pos.right - card.offsetWidth)}px`;
            card.style.top = `${Math.max(0, innerHeight - pos.bottom - card.offsetHeight)}px`;
        } else {
            const box = input.closest('.chat-input-container, .rows-wrapper') || input;
            const r = box.getBoundingClientRect();
            card.style.left = `${Math.round(r.right - card.offsetWidth)}px`;
            card.style.top = `${Math.round(r.top - card.offsetHeight - 8)}px`;
        }
    }, 500);
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
    const INSTANCE = Math.random().toString(36).slice(2);
    async function claimReply(id) {
        const key = `dekontAktar.claim.${id}`;
        try {
            const cur = localStorage.getItem(key);
            if (cur && cur !== INSTANCE) return false;
            localStorage.setItem(key, INSTANCE);
            await sleep(400 + Math.random() * 300);   // aynı anda yazan diğer kopya varsa son yazan kazanır
            if (localStorage.getItem(key) !== INSTANCE) return false;
            const cutoff = Date.now() / 1000 - 2 * 86400;   // 2 günden eski sahiplenmeleri temizle
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith('dekontAktar.claim.') && parseFloat(k.slice(18)) < cutoff) localStorage.removeItem(k);
            }
            return true;
        } catch { return true; }
    }
    const infoText = (v) => `Oyuncu Bilgileri:\n• ${v.pid}\n• Ad Soyad : ${v.name}`;
    async function flush() {
        if (busy) { again = true; return; }
        if (!isLeader()) return;
        busy = true; again = false;
        try {
            for (const k of GM_listValues().filter(x => x.startsWith('q:'))) {
                const v = GM_getValue(k, null);
                GM_deleteValue(k);
                if (!v) continue;
                // Cevap Slack'e gönderilmez: dekont mesajının altına YALNIZ bu tarayıcıda görünen kart çizilir
                const map = GM_getValue('cards', {});
                for (const t in map) if (Date.now() - map[t].at > 7 * 864e5) delete map[t];
                map[v.thread] = v.error ? { thread: v.thread, reply: v.thread, value: v.value, error: v.error, at: Date.now() }
                    : { pid: v.pid, name: v.name, thread: v.thread, reply: v.thread, file: v.file, at: Date.now() };
                GM_setValue('cards', map);
                tr(v.error ? `kart: ${v.value} bulunamadı` : `kart hazır ${v.pid}${v.file ? ' (görsel var)' : ' (görsel yok)'}`);
                status(v.error ? `bulunamadı ${v.value}` : `kart hazır ${v.pid}`);
                renderCards();
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
    const blobToDataUrl = (b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });

    function toast(msg, ok = true) {
        const d = document.createElement('div');
        d.textContent = msg;
        Object.assign(d.style, { position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', zIndex: 99999, padding: '10px 16px', borderRadius: '10px',
            background: ok ? '#343a43' : '#b4123f', color: '#fff', font: '700 13px Lato, "Segoe UI", sans-serif', boxShadow: '0 6px 20px rgba(0,0,0,.25)', maxWidth: '80vw' });
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 4500);
    }

    /** Slack emojiyi resme çevirir (metinde yalnız "Kopyala" kalır): baştaki emoji/işaretler yok sayılır. */
    const isCopyBtn = (el) => !!el && /^[^\p{L}]*Kopyala$/u.test((el.textContent || '').trim());

    /** Slack'teki bağlantı butonu: hangi hedef, hangi oyuncu? (oyuncu, butonun mesajındaki "Oyuncu Bilgileri" altındaki ilk numara) */
    function locate(el) {
        const btn = el.closest('a, button');
        if (!btn) return null;
        const label = (btn.textContent || '').trim();
        const href = btn.getAttribute('href') || '';
        const target = isCopyBtn(btn) ? { id: 'copy', label: 'Kopyala' }
            : CONFIG.TARGETS.find(t => label === t.label || (href && href.includes(t.url)));
        if (!target) return null;
        let box = btn;
        for (let i = 0; i < 12 && box && !/Oyuncu Bilgileri/.test(box.textContent || ''); i++) box = box.parentElement;
        const pid = (box?.textContent || '').match(/Oyuncu Bilgileri:?[\s\S]*?(\d{6,})/)?.[1];
        if (!pid) return null;
        const map = GM_getValue('replies', {});
        // önce Slack'in mesaj kutusundaki zaman damgası (aynı oyuncunun birden çok dekontu olabilir), yoksa o oyuncunun en son cevabı
        let ts = null;
        for (let n = btn; n && !ts; n = n.parentElement) for (const at of ['data-item-key', 'data-msg-ts', 'data-ts', 'id']) { const m = String(n.getAttribute?.(at) || '').match(/(\d{10}\.\d{6})/); if (m && map[m[1]]) { ts = m[1]; break; } }
        const entry = (ts && map[ts]) || Object.values(map).filter(e => e.pid === pid).sort((a, b) => b.at - a.at)[0];
        return entry ? { target, entry } : null;
    }
    document.addEventListener('click', (e) => {
        const l = locate(e.target);
        if (!l) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (l.target.id === 'copy') { copyAll(l.entry); return; }
        telegramClick(l.entry, l.target);
    }, true);
    /** Telegram sekmesine "orada mısın?" (arka plandaki sekmede zamanlayıcılar yavaşladığı için kalp atışına değil cevaba bakılır) */
    function telegramClick(entry, target) {
        const id = Math.random().toString(36).slice(2);
        let answered = false;
        const lid = GM_addValueChangeListener('tgPong', (k, o, v) => { if (v?.id === id) answered = true; });
        GM_setValue('tgPing', { id, at: Date.now() });
        const t0 = Date.now();
        (async () => {
            while (!answered && Date.now() - t0 < 2500) await sleep(100);
            GM_removeValueChangeListener?.(lid);
            if (answered) sendViaTelegram(entry, target);    // tek tık gönderim
            else copyFallback(entry, target);                // Telegram sekmesi cevap vermedi
        })();
    }
    async function copyFallback(entry, target) {
        tr(`${target.label}: Telegram sekmesi cevap vermedi, panoya kopyalandı · ${entry.pid}`);
        try { await navigator.clipboard.writeText(infoText(entry)); } catch { /* yok say */ }
        toast(`Telegram sekmesi cevap vermedi. Telegram Web sekmesini F5 ile yenileyip tekrar basın. (Bilgiler panoya kopyalandı.)`, false);
    }

    /* ── 📋 Kopyala: dekont (PNG) + oyuncu bilgileri tek seferde panoya ──
       Pano yazımı kullanıcı tıklamasının ardından birkaç saniye içinde yapılmalı; bu yüzden görsel fareyle
       butonun üstüne gelince önceden hazırlanır. Firefox'ta pano nesneleri sayfanın kurucularıyla oluşturulur. */
    const pngCache = new Map();   // cevap ts → Promise<{ u8, dataUrl } | null>
    function preparePng(entry) {
        if (!entry.file?.url) return Promise.resolve(null);
        if (!pngCache.has(entry.reply)) {
            pngCache.set(entry.reply, (async () => {
                const blob = await fetchBlob(entry.file.url);
                const bmp = await createImageBitmap(blob);
                const c = document.createElement('canvas');
                c.width = bmp.width; c.height = bmp.height;
                c.getContext('2d').drawImage(bmp, 0, 0);
                const png = await new Promise((r) => c.toBlob(r, 'image/png'));
                return { u8: new Uint8Array(await png.arrayBuffer()), dataUrl: c.toDataURL('image/png') };
            })().catch((e) => { pngCache.delete(entry.reply); warn('dekont hazırlanamadı:', e.message); return null; }));
        }
        return pngCache.get(entry.reply);
    }
    const htmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    async function copyAll(entry) {
        const text = infoText(entry);
        const img = await preparePng(entry);
        const P = W, pg = (o) => (typeof cloneInto === 'function' ? cloneInto(o, P, { wrapReflectors: true }) : o);
        const pblob = (part, type) => new P.Blob(pg([part]), pg({ type }));
        try {
            const data = { 'text/plain': pblob(text, 'text/plain'),
                'text/html': pblob(`${img ? `<img src="${img.dataUrl}"><br>` : ''}${htmlEsc(text).replace(/\n/g, '<br>')}`, 'text/html') };
            if (img) data['image/png'] = pblob(img.u8, 'image/png');
            await P.navigator.clipboard.write(pg([new P.ClipboardItem(pg(data))]));
            tr(`kopyalandı ${entry.pid}${img ? ' (dekont + bilgiler)' : ' (yalnız bilgiler)'}`);
            toast(img ? `📋 Dekont ve bilgiler panoya kopyalandı (${entry.pid})` : `📋 Bilgiler panoya kopyalandı (${entry.pid}) — bu mesajda dekont yok`);
        } catch (e) {
            warn('pano yazılamadı:', e.message);
            try { await navigator.clipboard.writeText(text); } catch { /* yok say */ }
            toast(img ? 'Dekont kopyalanamadı, yalnız bilgiler kopyalandı — bir kez daha basın (görsel artık hazır).' : `Bilgiler kopyalandı (${entry.pid})`, !img);
        }
    }
    // Fare butona gelince dekontu önceden hazırla (tıklamada pano izni süresi dolmasın)
    document.addEventListener('pointerover', (e) => {
        if (!isCopyBtn(e.target.closest?.('a, button'))) return;
        const l = locate(e.target);
        if (l?.target.id === 'copy') preparePng(l.entry);
    }, true);
    // Kopyala butonunu Megapay + Hemen Pay'in toplam genişliğine yay
    function widenCopy(root) {
        for (const b of root.querySelectorAll?.('button, a') || []) {
            if (b.dataset.dkWide || !isCopyBtn(b)) continue;
            let box = b.parentElement, row = null;
            for (let i = 0; i < 10 && box && !row; i++, box = box.parentElement) {
                const bs = [...box.querySelectorAll('button, a')].filter(x => CONFIG.TARGETS.some(t => (x.textContent || '').trim() === t.label));
                if (bs.length >= 2) row = bs;
            }
            if (!row) continue;
            const w = row.at(-1).getBoundingClientRect().right - row[0].getBoundingClientRect().left;
            if (w < 40) continue;   // henüz çizilmedi
            b.dataset.dkWide = '1';
            Object.assign(b.style, { width: `${Math.round(w)}px`, maxWidth: 'none', justifyContent: 'center' });
        }
    }

    /* ── Özel kart: dekont mesajının altında yalnız bu tarayıcıda görünür (Slack'e gönderilmez) ── */
    const REPLY_TALEP = 'Talep alalım lütfen', REPLY_ONAY = 'Onaylanmıştır';
    const REPLY_MEGA_HH = 'kolaydekontmail@gmail.com adresine banka girişinden itibaren çift cihaz olarak videolu hesap hareketleri rica edelim.';
    const REPLY_HEMEN_HH = 'desteksupport1@gmail.com adresine banka girişinden itibaren çift cihaz olarak videolu hesap hareketleri rica edelim.';
    const CARD_CSS = `
.dk-card{margin:8px 0 4px;max-width:440px;box-sizing:border-box;padding:12px 14px;background:#fff;border:1px solid #e4e7ec;border-radius:12px;
  box-shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);font:14px/1.45 Lato,"Segoe UI",sans-serif;color:#343a43}
.dk-card .dk-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.dk-card .dk-name{font-weight:800;font-size:15px;color:#2b3036}
.dk-card .dk-id{display:inline-block;margin-top:2px;font:12px/18px ui-monospace,Menlo,monospace;color:#475467;background:#f2f4f7;border-radius:6px;padding:1px 7px}
.dk-card .dk-lock{flex:none;font-size:10.5px;font-weight:700;color:#667085;background:#f2f4f7;border-radius:999px;padding:3px 9px;letter-spacing:.2px}
.dk-card .dk-warn{color:#b42318;font-weight:700}
.dk-card .dk-row{display:flex;gap:8px;margin-top:8px}
.dk-card .dk-btn{flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 12px;box-sizing:border-box;
  border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:700 13px/1 Lato,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;
  box-shadow:0 1px 2px rgba(16,24,40,.05);transition:background-color .12s,border-color .12s,transform .05s}
.dk-card .dk-btn:hover{background:#f9fafb;border-color:#b9c0cb}
.dk-card .dk-btn:active{transform:translateY(1px)}
.dk-card .dk-btn[disabled]{opacity:.7;cursor:default}
.dk-card .dk-blue{background:#2e90fa;border-color:#2e90fa;color:#fff}
.dk-card .dk-blue:hover{background:#1570ef;border-color:#1570ef}
.dk-card .dk-green{background:#12b76a;border-color:#12b76a;color:#fff}
.dk-card .dk-green:hover{background:#039855;border-color:#039855}
.dk-card .dk-sep{height:1px;background:#eaecf0;margin:12px 0 4px}
.dk-card .dk-dep{margin-top:8px;padding:8px;background:#f9fafb;border:1px solid #eaecf0;border-radius:10px;display:flex;flex-direction:column;gap:6px}
.dk-card .dk-note{font-size:12.5px;color:#475467;line-height:1.45}
.dk-card .dk-dep-item{display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto auto;column-gap:10px;align-items:center;text-align:left;
  padding:7px 10px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;cursor:pointer;font:13px/1.3 Lato,"Segoe UI",sans-serif;color:#344054}
.dk-card .dk-dep-item:hover{border-color:#2e90fa;background:#f5faff}
.dk-card .dk-dep-amt{font-weight:800;grid-row:1}
.dk-card .dk-dep-meta{color:#667085;font-size:12px;grid-row:1}
.dk-card .dk-dep-st{font-size:11px;font-weight:700;color:#475467;background:#f2f4f7;border-radius:999px;padding:2px 8px;grid-row:1}
.dk-card .dk-dep-id{grid-column:1 / -1;font:11px ui-monospace,Menlo,monospace;color:#98a2b3}`;
    function ensureCardCss() {
        if (document.getElementById('dk-card-css')) return;
        const st = document.createElement('style');
        st.id = 'dk-card-css'; st.textContent = CARD_CSS;
        (document.head || document.documentElement).appendChild(st);
    }
    function cardButton(label, cls, onClick) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = `dk-btn ${cls || ''}`; b.textContent = label;
        const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
        b.addEventListener('mousedown', stop);
        b.addEventListener('click', (e) => { stop(e); if (!b.disabled) onClick(b); });
        return b;
    }
    const flashBtn = (b, text, ms = 1800) => { const old = b.dataset.label || b.textContent; b.dataset.label = old; b.textContent = text; b.disabled = true; setTimeout(() => { b.textContent = old; b.disabled = false; }, ms); };
    async function threadReply(e, text, b) {
        flashBtn(b, '…', 1200);
        try {
            if (!token) await resolveToken();
            await api('chat.postMessage', { channel: CONFIG.CHANNEL, thread_ts: e.thread, text });
            flashBtn(b, '✓ Gönderildi');
            tr(`thread'e yazıldı: "${text}"${e.pid ? ' · ' + e.pid : ''}`);
        } catch (err) { toast(`Gönderilemedi: ${err.message}`, false); }
    }
    function putBytes(url, blob) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            method: 'POST', url, data: blob, timeout: 60000, headers: { 'Content-Type': blob.type || 'application/octet-stream' },
            onload: (r) => (r.status >= 200 && r.status < 300 ? resolve() : reject(new Error(`yükleme HTTP ${r.status}`))),
            onerror: () => reject(new Error('yükleme ağ hatası')), ontimeout: () => reject(new Error('yükleme zaman aşımı')),
        }));
    }
    /* ── "Altyapıda Sorgula": yatırım seç → Pingwi → Transaction check formu kendiliğinden dolar (dekont dahil) ── */
    /** GM köprüsüyle başka sekmeye soru sor, cevabı bekle (GT: depReq/depRes, Pingwi: pwReq/pwRes). */
    function ask(reqKey, resKey, payload, ms = 15000) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return new Promise((resolve) => {
            const t = setTimeout(() => { GM_removeValueChangeListener?.(lid); resolve(null); }, ms);
            const lid = GM_addValueChangeListener(resKey, (k, o, v) => { if (v?.id === id) { clearTimeout(t); GM_removeValueChangeListener?.(lid); resolve(v); } });
            GM_setValue(reqKey, { id, at: Date.now(), ...payload });
        });
    }
    const tlFmt = (n) => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const whenFmt = (t) => { const d = new Date(t); return isNaN(d) ? '' : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    async function altyapiSorgula(e, b, box) {
        let panel = box.querySelector('.dk-dep');
        if (panel) { panel.remove(); return; }   // ikinci tıklama kapatır
        panel = document.createElement('div'); panel.className = 'dk-dep';
        panel.innerHTML = '<div class="dk-note">Yatırımlar getiriliyor…</div>';
        b.closest('.dk-row').after(panel);
        const r = await ask('depReq', 'depRes', { pid: e.pid });
        if (!r) { panel.innerHTML = '<div class="dk-note dk-warn">Panel cevap vermedi — açık GT sekmesi var mı?</div>'; return; }
        if (!r.ok) { panel.innerHTML = `<div class="dk-note dk-warn">${esc(r.msg)}</div>`; return; }
        if (!r.list.length) { panel.innerHTML = '<div class="dk-note">Son 30 günde yatırım yok.</div>'; return; }
        panel.innerHTML = '<div class="dk-note">Hangi yatırım? (Deposits sekmesi, en yenisi üstte)</div>';
        for (const d of r.list) {
            const it = document.createElement('button');
            it.type = 'button'; it.className = 'dk-dep-item';
            it.innerHTML = `<span class="dk-dep-amt">${esc(tlFmt(d.amount))} TL</span><span class="dk-dep-meta">${esc(whenFmt(d.at))} · ${esc(d.method)}</span><span class="dk-dep-st">${esc(d.status)}</span><span class="dk-dep-id">${esc(d.id)}</span>`;
            it.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
            it.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); chooseDeposit(e, d, panel); });
            panel.appendChild(it);
        }
    }
    async function chooseDeposit(e, d, panel) {
        panel.innerHTML = `<div class="dk-note">${esc(d.id)} · Pingwi sorgulanıyor…</div>`;
        const pw = await ask('pwReq', 'pwRes', { ref: d.id });
        const tx = pw?.ok ? pw.tx : null;
        const fields = {
            'Client ID': e.pid,   // Merchant Client ID = Party ID
            'Merchant order ID': d.id,
            'Pingwi transaction ID': tx?.uuid || '',
            'Date of the transaction': tx?.created || d.atStr || whenFmt(d.at),
            'Amount': tx?.amount || `${d.amount} TRY`,
            'Status in CORE': d.status,
            'What is the issue with the transaction': 'Not Credited',
        };
        GM_setValue('wfPending', { at: Date.now(), fields, file: e.file || null, pid: e.pid, dep: d.id });
        const pwLine = tx ? `Pingwi: ${esc(tx.amount)} · ${esc(tx.status)}` : `<span class="dk-warn">Pingwi: ${esc(pw ? pw.msg : 'Pingwi sekmesi cevap vermedi')}</span>`;
        panel.innerHTML = `<div class="dk-note">✓ ${esc(d.id)} hazır · ${pwLine}<br>${CONFIG.WORKFLOW_URL ? 'Transaction check formu açılıyor' : 'Transaction check formunu aç'} — alanlar ve dekont kendiliğinden dolacak.</div>`;
        tr(`altyapı formu hazır ${e.pid} / ${d.id}${tx ? '' : ' (Pingwi yok)'}`);
        if (CONFIG.WORKFLOW_URL) W.open(CONFIG.WORKFLOW_URL, '_self');
    }

    /** Slack form alanına değer yaz (React'in fark etmesi için tarayıcının kendi yazma yolu, olmazsa değer + olaylar) */
    async function setField(el, value) {
        el.focus(); await sleep(30);
        el.select?.();
        if (document.execCommand('insertText', false, value) && el.value === value) { el.dispatchEvent(new Event('blur', { bubbles: true })); return; }
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    /** Etiketin hemen altındaki yazı kutusu (etiket birebir — "(optional)" ve parantezli ekler yok sayılır) */
    function fieldFor(modal, label) {
        const norm = (t) => String(t || '').replace(/\(.*?\)|optional|\?/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const want = norm(label);
        const labels = [...modal.querySelectorAll('label, span, div, p')].filter(el => !el.children.length && norm(el.textContent) === want);
        for (const lab of labels) {
            for (let n = lab.parentElement, i = 0; n && n !== modal && i < 6; n = n.parentElement, i++) {
                const inp = [...n.querySelectorAll('input:not([type=hidden]):not([type=file]), textarea')]
                    .find(x => lab.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
                if (inp) return inp;
            }
        }
        return null;
    }
    async function attachFile(modal, file) {
        const input = modal.querySelector('input[type=file]');
        if (!input || !file?.url) return false;
        const blob = await fetchBlob(file.url);
        const P = W, pg = (o) => (typeof cloneInto === 'function' ? cloneInto(o, P, { wrapReflectors: true }) : o);
        const u8 = new Uint8Array(await blob.arrayBuffer());
        const f = new P.File(pg([u8]), file.name || 'dekont.jpg', pg({ type: blob.type || file.type || 'image/jpeg' }));
        const dt = new P.DataTransfer(); dt.items.add(f);
        (input.wrappedJSObject || input).files = dt.files;
        input.dispatchEvent(new (P.Event)('change', pg({ bubbles: true })));
        return true;
    }
    let filling = false;
    async function autofillWorkflow() {
        if (filling) return;
        const pend = GM_getValue('wfPending', null);
        if (!pend || Date.now() - pend.at > 20 * 60000) return;
        const head = [...document.querySelectorAll('h1, h2, [data-qa*="modal_title"], [role="dialog"] *')].find(el => !el.children.length && (el.textContent || '').trim() === 'Transaction check');
        const modal = head && (head.closest('[role="dialog"], .c-sk-modal, .p-block_kit_modal') || head.parentElement?.parentElement?.parentElement);
        if (!modal || modal.dataset.dkFilled === pend.dep) return;
        filling = true;
        try {
            modal.dataset.dkFilled = pend.dep;
            let n = 0;
            for (const [label, value] of Object.entries(pend.fields)) {
                if (!value) continue;
                const el = fieldFor(modal, label);
                if (!el || el.value) continue;   // elle yazılmış alanı ezme
                await setField(el, String(value)); n++;
                await sleep(150);
            }
            let fileOk = false;
            try { fileOk = await attachFile(modal, pend.file); } catch (err) { warn('dekont eklenemedi:', err.message); }
            GM_deleteValue('wfPending');
            tr(`form dolduruldu: ${n} alan${fileOk ? ' + dekont' : pend.file ? ' (dekont eklenemedi)' : ''}`);
            toast(`✓ Transaction check: ${n} alan dolduruldu${fileOk ? ', dekont eklendi' : pend.file ? ' — dekontu elle ekleyin' : ''}`, fileOk || !pend.file);
        } finally { filling = false; }
    }

    function buildCard(e) {
        ensureCardCss();
        const box = document.createElement('div');
        box.className = 'dk-card';
        const top = document.createElement('div'); top.className = 'dk-top';
        const who = document.createElement('div');
        if (e.error) who.innerHTML = `<span class="dk-warn">⚠️ ${esc(e.value)}</span><div>${esc(e.error)}</div>`;
        else who.innerHTML = `<div class="dk-name">${esc(e.name)}</div><span class="dk-id">${esc(e.pid)}</span>`;
        const lock = document.createElement('span'); lock.className = 'dk-lock'; lock.textContent = '🔒 Yalnızca sen';
        top.append(who, lock);
        box.appendChild(top);
        const row = (...btns) => { const r = document.createElement('div'); r.className = 'dk-row'; r.append(...btns); return r; };
        if (!e.error) {
            box.appendChild(row(...CONFIG.TARGETS.map(t => cardButton(`✈ ${t.label}`, '', () => telegramClick(e, t)))));
            box.appendChild(row(cardButton('🔍 Altyapıda Sorgula', '', (b) => altyapiSorgula(e, b, box))));
            const copy = cardButton(CONFIG.COPY_LABEL, '', () => copyAll(e));
            copy.addEventListener('pointerenter', () => preparePng(e));
            box.appendChild(row(copy));
        }
        const sep = document.createElement('div'); sep.className = 'dk-sep'; box.appendChild(sep);
        box.appendChild(row(
            cardButton('TALEP', 'dk-blue', (b) => threadReply(e, REPLY_TALEP, b)),
            cardButton('ONAY', 'dk-green', (b) => threadReply(e, REPLY_ONAY, b)),
        ));
        box.appendChild(row(
            cardButton('Mega HH', '', (b) => threadReply(e, REPLY_MEGA_HH, b)),
            cardButton('Hemen HH', '', (b) => threadReply(e, REPLY_HEMEN_HH, b)),
        ));
        return box;
    }
    function renderCards() {
        if (!location.pathname.includes(CONFIG.CHANNEL)) return;
        const map = GM_getValue('cards', {});
        for (const [ts, e] of Object.entries(map)) {
            for (const item of document.querySelectorAll(`[data-item-key="${ts}"], [data-msg-ts="${ts}"]`)) {
                if (item.querySelector('.dk-card')) continue;
                const host = item.querySelector('[data-qa="message_content"], .c-message_kit__gutter__right') || item;
                host.appendChild(buildCard(e));
            }
        }
    }
    GM_addValueChangeListener('cards', () => renderCards());

    let widenQueued = false;
    new MutationObserver(() => {
        if (widenQueued) return;
        widenQueued = true;
        setTimeout(() => { widenQueued = false; widenCopy(document); renderCards(); autofillWorkflow(); }, 400);   // Slack sık değişir: en fazla 400 ms'de bir bak
    }).observe(document.documentElement, { childList: true, subtree: true });

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
            GM_setValue('tgJob', { id, target: target.id, label: target.label, hash: target.hash, topic: target.topic || null, text: infoText(entry), image, pid: entry.pid, at: Date.now() });
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
    if (W.__DK_TEST__) Object.assign(W.__DK_TEST__, { trigger, locate });

    GM_registerMenuCommand('Dekont Aktar aç / kapat', () => {
        const on = GM_getValue('enabled', true) === false;
        GM_setValue('enabled', on);
        alert(`Dekont Aktar ${on ? 'AÇIK' : 'KAPALI'}.`);
    });
    /* Deneme: Slack bu oturumla "yalnızca sizin görebildiğiniz" (ephemeral) mesaja izin veriyor mu? */
    GM_registerMenuCommand('Test: sadece bana görünen mesaj', async () => {
        try {
            if (!token) await resolveToken();
            const blocks = [
                { type: 'section', text: { type: 'mrkdwn', text: '*🔒 Deneme* — bu mesajı kanalda yalnızca sen görüyorsun.' } },
                { type: 'actions', elements: CONFIG.TARGETS.map(t => ({ type: 'button', action_id: `dk_test_${t.id}`, text: { type: 'plain_text', text: t.label }, url: t.url })) },
            ];
            const r = await call('chat.postEphemeral', { channel: CONFIG.CHANNEL, user: me, text: 'Deneme: yalnızca sen görüyorsun', blocks: JSON.stringify(blocks) });
            alert(r.ok ? `Slack kabul etti. ${CONFIG.CHANNEL} kanalında "Yalnızca siz görebilirsiniz" notlu bir mesaj ve iki buton görmelisin.`
                       : `Slack izin vermedi: ${r.error}`);
        } catch (e) { alert('Test hatası: ' + e.message); }
    });
    GM_registerMenuCommand('Durum', () => {
        const s = GM_getValue('slackStatus', null);
        alert(`Dekont Aktar: ${GM_getValue('enabled', true) === false ? 'KAPALI' : 'AÇIK'} · kanal ${CONFIG.CHANNEL}\nSon: ${s ? `${s.msg} (${new Date(s.at).toLocaleTimeString('tr-TR')})` : '—'}\nTelegram sekmesi: ${(() => { const a = GM_getValue('tgPong', null) || GM_getValue('tgAlive', null); return a ? `son görülme ${new Date(a.at).toLocaleTimeString('tr-TR')}${a.k === false ? ' (Web K DEĞİL)' : ''}` : 'hiç görülmedi'; })()}\nKullanıcı adı arama alanı: ${GM_getValue('userField', '— (ilk aramada bulunur)')}\nSürüm: ${GM_info?.script?.version || '?'}\n\nSon adımlar:\n${GM_getValue('trace', []).join('\n') || '—'}`);
    });
}

})();
