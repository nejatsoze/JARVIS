// ==UserScript==
// @name         Otomatik Red — KYC ve 8 saat kuralı
// @namespace    palentis.otomatik-red
// @version      1.0.0
// @description  Pending Withdrawals'a düşen talepleri iki kurala göre değerlendirir: (1) hiç yatırımı olmayan ve KYC'si PASS olmayan üye, (2) son başarılı çekimden bu yana 8 saat dolmamış talep. Kural tutarsa red açıklamasını yazıp talebi reddeder ve Slack kanalına bildirir. VARSAYILAN DENEME MODU: hiçbir şey reddetmez, sadece kararı Slack'e yazar. Tampermonkey menüsünden Kapalı / Deneme / Canlı seçilir.
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
// ==/UserScript==

/*
 * MODLAR (Tampermonkey menüsü, GT sekmesinde)
 *   Kapalı  : hiçbir şey yapmaz.
 *   Deneme  : (varsayılan) kuralları değerlendirir, kararı Slack'e "DENEME — reddedilmedi"
 *             notuyla yazar. Hiçbir talep reddedilmez.
 *   Canlı   : kural tutan talebi gerçekten reddeder (red açıklaması = Slack'teki Sebep).
 *
 * KURALLAR (sırayla; ilk tutan uygulanır)
 *   1 · KYC: üyenin hiç tamamlanmış yatırımı yok VE KYC durumu PASS değil
 *       → GT Withdrawals'taki KYC butonunun metniyle red.
 *   2 · 8 saat: son başarılı çekimin Process Date'i (UTC) + 8 saat, bu talebin
 *       Request Date'inden sonraysa → "Talebinizi (GG.AA.YYYY SS:DD) itibari ile…"
 *       (saat UTC+3 / Türkiye saatiyle yazılır).
 *
 * GÜVENLİK
 *   · Bir veri okunamazsa (KYC, yatırım, çekim geçmişi) o kural UYGULANMAZ — şüphede red yok.
 *   · Her talep bir kez değerlendirilir; sekmeler/iframe'ler arası ortak kilit.
 *   · Sadece listeye düştükten sonra MAX_AGE_MIN içinde görülen talepler değerlendirilir.
 *   · Menüde "Teşhis: ilk bekleyeni değerlendir": reddetmeden, Slack'e yazmadan kararı ve
 *     okunan ham verileri gösterir.
 *
 * Slack'e gönderim "Slack Çekim Bildirimi" ile aynı yöntem: açık Slack sekmesi senin
 * oturumunla chat.postMessage atar. Bu script'in kendi kuyruğu vardır (GM deposu ayrı).
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0C80H6L4CD',
    POLL_SEC: 30,             // arka plan liste yoklaması
    MAX_AGE_MIN: 60,          // bundan eski talepler değerlendirilmez
    GAP_HOURS: 8,             // kural 2
    TR_OFFSET_H: 3,           // Process Date UTC → Türkiye saati
};

const REASON_KYC = 'Profilinizdeki "Doğrulama" bölümünden, kimliğinizin veya ehliyetinizin fotoğrafını yükleyerek hesabınızı doğrulayabilirsiniz. Fotoğrafta TC kimlik no, ad, soyad ve doğum tarihi net görünmelidir. Bulanık, eksik veya karanlık fotoğraflar reddedilecektir.';
const REASON_GAP = (when) => `İki çekim işlemi arasında 8 saat fark olmalıdır. Talebinizi (${when}) itibari ile yeniden iletebilirsiniz.`;

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Otomatik Red]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const topHref = () => { try { return window.top.location.href; } catch { return location.href; } };

const MODES = { off: 'Kapalı', dry: 'Deneme', live: 'Canlı' };
const mode = () => GM_getValue('mode', 'dry');

if (location.hostname === 'app.slack.com') { if (window.top === window) slackSide(); }
else gtSide();

/* ════════════════════════════════════════════════════════════
   GT TARAFI
   ════════════════════════════════════════════════════════════ */
function gtSide() {
    const onPendingPage = () => /classic\/payment\/pendingWithdrawals/i.test(topHref()) && !topHref().includes('popup:');

    /* ── Panel API ── */
    function token() {
        for (const key of ['service_auth_token', 'auth_token', 'session_auth_token']) {
            try {
                const raw = sessionStorage.getItem(key);
                if (!raw) continue;
                try {
                    const p = JSON.parse(raw);
                    const t = p?.external?.token || p?.token || (typeof p === 'string' ? p : null);
                    if (t) return t;
                } catch { if (raw.split('.').length === 3) return raw; }
            } catch { /* erişilemiyor */ }
        }
        return null;
    }
    const need = () => { const t = token(); if (!t) throw new Error('oturum token yok'); return t; };
    async function ics(path, params = {}) {
        const t = need();
        const url = `${HOST}/ics/${path}?${new URLSearchParams({ sessionKey: t, uType: 'staff', ...params })}`;
        const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json', Authorization: `Bearer ${t}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
        return res.json();
    }
    async function legacyDoc(path, params) {
        const url = `${HOST}/j/${path}?${new URLSearchParams({ embeddedInNewDashboard: 'true', cmslanguage: 'en', token: need(), ...params })}`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
        return new DOMParser().parseFromString(await res.text(), 'text/html');
    }
    const asList = (d) => Array.isArray(d) ? d : (Object.values(d || {}).find(Array.isArray) || []);

    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dmy = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
    const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
    const clean = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

    function num(s) {
        let t = String(s ?? '').replace(/[^\d.,-]/g, '');
        if (!t) return NaN;
        const dot = t.lastIndexOf('.'), comma = t.lastIndexOf(',');
        if (dot >= 0 && comma >= 0) t = dot > comma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
        else if (comma >= 0) t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
        else if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
        return parseFloat(t);
    }
    /** "29-09-2026 12:57:12 UTC" → Date (UTC yazıyorsa UTC, yoksa yerel) */
    function panelDate(s) {
        const m = String(s).match(/(\d{2})[-.](\d{2})[-.](\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return null;
        const [, d, mo, y, h, mi, se = '0'] = m;
        return /UTC/i.test(s) ? new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +se)) : new Date(+y, mo - 1, +d, +h, +mi, +se);
    }
    /** Date → "10.10.2026 05:07" (Türkiye saati, UTC+3) */
    function trTime(date) {
        const d = new Date(date.getTime() + CONFIG.TR_OFFSET_H * 3600e3);
        return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }

    /* ── Bekleyen liste ── */
    function headerMap(table) {
        const rows = [...table.rows];
        const up = (r) => clean(r).toUpperCase();
        const head = rows.find(r => { const t = up(r); return t.includes('DATE') && (t.includes('PARTY ID') || t.includes('PAYMENT ID')); });
        if (!head) return null;
        const cols = {};
        let p = 0;
        for (const c of head.cells) { cols[clean(c).toUpperCase()] = p; p += c.colSpan || 1; }
        const cellAt = (row, pos) => { let q = 0; for (const c of row.cells) { if (q === pos) return c; q += c.colSpan || 1; } return null; };
        return {
            col: (row, name) => cols[name] === undefined ? '' : clean(cellAt(row, cols[name])),
            cell: (row, name) => cols[name] === undefined ? null : cellAt(row, cols[name]),
            has: (n) => cols[n] !== undefined,
        };
    }

    function readRows(doc) {
        const table = doc.getElementById('pending_withdrawals');
        if (!table) return null;
        const map = headerMap(table);
        if (!map) return null;
        const out = [];
        for (const row of table.querySelectorAll('tr[id^="pending_withdrawals_row"]')) {
            const status = map.col(row, 'STATUS');
            if (status && status.toUpperCase() !== 'PENDING') continue;
            const link = row.querySelector('a[href*="ProcessWithdrawal.action"]');
            if (!link) continue;
            let q;
            try { q = new URL(link.getAttribute('href'), HOST).searchParams; } catch { continue; }
            const paymentid = q.get('paymentid'), partyId = q.get('partyId');
            if (!paymentid || !partyId) continue;
            out.push({
                paymentid, partyId,
                amount: num(map.col(row, 'AMOUNT')),
                currency: map.col(row, 'CURRENCY') || 'TRY',
                requestedAt: panelDate(map.col(row, 'REQUEST DATE')),
            });
        }
        return out;
    }

    /* ── Veri: KYC, yatırım geçmişi, son başarılı çekim ── */

    /** full-profile içinde adı "kyc" geçen ve değeri PASS/OPEN gibi bir durum olan alanı bulur. */
    async function kycStatus(pid) {
        const data = await ics(`players/${pid}/full-profile`);
        const hits = [];
        (function walk(o, path, depth) {
            if (!o || typeof o !== 'object' || depth > 4) return;
            for (const [k, v] of Object.entries(o)) {
                const p = path ? `${path}.${k}` : k;
                if (typeof v === 'string' && /kyc/i.test(k) && /^[A-Z_]{3,20}$/.test(v.trim().toUpperCase()) && !/date|time|age|system|provider|id$/i.test(k)) hits.push([p, v.trim().toUpperCase()]);
                else if (v && typeof v === 'object') walk(v, p, depth + 1);
            }
        })(data, '', 0);
        // En olası alan önce: kycStatus > kyc > diğerleri
        hits.sort((a, b) => score(b[0]) - score(a[0]));
        function score(p) { const k = p.split('.').pop().toLowerCase(); return k === 'kycstatus' ? 3 : k === 'kyc' ? 2 : /status/.test(k) ? 1 : 0; }
        return hits.length ? { value: hits[0][1], field: hits[0][0], all: hits } : { value: null, field: null, all: [] };
    }

    /** Hiç tamamlanmış yatırımı var mı? İki kaynak da "yok" demeli; biri okunamazsa null (bilinmiyor). */
    async function hasEverDeposited(pid) {
        let ltd = null;
        try {
            const list = asList(await ics(`players/${pid}/financial/deposits-and-withdrawals`));
            const rows = list.filter(r => String(r.period || '').toUpperCase() === 'LTD' && String(r.tranType || '').toLowerCase().startsWith('dep'));
            if (rows.length) ltd = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
            else if (!list.length) ltd = 0;
        } catch (e) { warn('LTD yatırım okunamadı:', e.message); }

        let completed = null;
        try {
            const list = asList(await ics('player-deposit/query', {
                partyId: pid, startDate: ymd(dayOffset(-730)), endDate: ymd(dayOffset(1)), currency: 'TRY',
            }));
            completed = list.filter(d => d.paymentStatus === 'COMPLETED').length;
        } catch (e) { warn('yatırım listesi okunamadı:', e.message); }

        if (ltd === null && completed === null) return { value: null, ltd, completed };
        const any = (ltd !== null && ltd > 0) || (completed !== null && completed > 0);
        if (any) return { value: true, ltd, completed };
        // "Hiç yok" demek için iki kaynak da okunmuş olmalı
        return { value: (ltd === null || completed === null) ? null : false, ltd, completed };
    }

    /** Oyuncu çekim geçmişinde (PlayerWithdrawals) bu talep dışındaki son başarılı çekimin Process Date'i. */
    async function lastSuccessfulWithdrawal(pid, exceptPaymentId) {
        const doc = await legacyDoc('player/PlayerWithdrawals.action', {
            partyId: pid, startDate: dmy(dayOffset(-3)), endDate: dmy(dayOffset(1)), execute: 'Go',
        });
        const table = doc.querySelector('#withdrawals');
        if (!table) throw new Error('#withdrawals tablosu yok');
        const map = headerMap(table);
        if (!map || !map.has('PROCESS DATE') || !map.has('PAYMENT STATUS')) throw new Error('çekim geçmişi başlıkları okunamadı');
        let best = null;
        for (const row of table.querySelectorAll('tr')) {
            if (row.querySelector('th')) continue;
            const id = map.col(row, 'PAYMENT ID');
            if (!id || id === String(exceptPaymentId)) continue;
            // Hücrede gizli "xxx_yyy" kodları da var (bazen asıl durumla bitişik): sadece kod olmayan metin parçaları
            const cell = map.cell(row, 'PAYMENT STATUS');
            const walker = cell ? doc.createTreeWalker(cell, NodeFilter.SHOW_TEXT) : null;
            const parts = [];
            for (let n = walker?.nextNode(); n; n = walker.nextNode()) {
                for (const w of n.nodeValue.split(/\s+/)) if (w && !w.includes('_')) parts.push(w);
            }
            const status = parts.join(' ');
            if (!/complet|approv|success|paid/i.test(status)) continue;
            const at = panelDate(map.col(row, 'PROCESS DATE'));
            if (at && (!best || at > best.at)) best = { at, id, status };
        }
        return best;
    }

    /* ── Karar ── */
    async function evaluate(it) {
        const facts = {};
        // Kural 1: hiç yatırım yok + KYC PASS değil
        try {
            const dep = await hasEverDeposited(it.partyId);
            facts.deposit = dep;
            if (dep.value === false) {
                const kyc = await kycStatus(it.partyId);
                facts.kyc = kyc;
                if (kyc.value && kyc.value !== 'PASS') return { rule: 'KYC', reason: REASON_KYC, facts };
                if (!kyc.value) facts.note = 'KYC alanı bulunamadı → kural 1 uygulanmadı';
            }
        } catch (e) { facts.kural1Hata = e.message; }

        // Kural 2: son başarılı çekimden bu yana 8 saat
        try {
            const last = await lastSuccessfulWithdrawal(it.partyId, it.paymentid);
            facts.lastWithdrawal = last && { id: last.id, processDateUtc: last.at.toISOString(), status: last.status };
            if (last) {
                const allowed = new Date(last.at.getTime() + CONFIG.GAP_HOURS * 3600e3);
                const reqAt = it.requestedAt || new Date();
                facts.allowedAtTr = trTime(allowed);
                if (reqAt < allowed) return { rule: '8 Saat Kuralı', reason: REASON_GAP(trTime(allowed)), facts };
            }
        } catch (e) { facts.kural2Hata = e.message; }

        return { rule: null, facts };
    }

    /* ── Red (GT Withdrawals'taki reject() ile aynı akış) ── */
    async function reject(paymentid, partyId, reasonText) {
        const url = `${HOST}/j/ProcessWithdrawal.action?embeddedInNewDashboard=true`
            + `&paymentid=${encodeURIComponent(paymentid)}&partyId=${encodeURIComponent(partyId)}`;
        const page = await fetch(url, { credentials: 'same-origin' });
        if (!page.ok) throw new Error('GET başarısız (HTTP ' + page.status + ')');
        const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
        // Başka biri (ya da diğer bot) bu arada işlediyse dokunma. Hücreler bitişik olabilir: yaprakları boşlukla birleştir.
        const leaves = [...doc.body.querySelectorAll('*')].filter(el => !el.children.length).map(el => el.textContent.trim()).filter(Boolean).join(' ');
        const st = leaves.match(/Payment Status\s+([A-Za-z_]+)/i)?.[1];
        if (st && !/pending/i.test(st)) throw new Error(`talep artık bekleyen değil (${st})`);
        const sourcePage = doc.querySelector('input[name="_sourcePage"]')?.value;
        const fp = doc.querySelector('input[name="__fp"]')?.value;
        if (!sourcePage || !fp) throw new Error('_sourcePage / __fp yok (sayfa yapısı değişmiş olabilir)');
        const body = new URLSearchParams({
            partyId, paymentid, embeddedInNewDashboard: 'true',
            reject_reason: reasonText, reject: 'Reject Unprocessed',
            _sourcePage: sourcePage, __fp: fp,
        });
        const res = await fetch(`${HOST}/j/ProcessWithdrawal.action`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        });
        if (!res.ok) throw new Error('POST başarısız (HTTP ' + res.status + ')');
        // Slack Çekim Bildirimi'nin yedek sebep kaynağı
        try { window.dispatchEvent(new CustomEvent('gt-wd-rejected', { detail: JSON.stringify({ paymentid, partyId, reason: reasonText }) })); } catch { /* yok say */ }
    }

    /* ── Slack mesajı ── */
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    function slackText(it, d, note) {
        const amt = Number.isFinite(it.amount) ? it.amount.toFixed(2) : '?';
        return [
            `:no_entry: Otomatik Red (${d.rule})${note ? ` — _${note}_` : ''}`,
            `Sebep: ${esc(d.reason)}`,
            `ID: ${it.partyId}`,
            `Talep: ${amt} ${esc(it.currency || 'TRY')}`,
            `PaymentID: ${it.paymentid}`,
        ].join('\n');
    }
    function enqueue(key, text) {
        GM_setValue('q:' + key, { text, at: Date.now() });
        GM_setValue('ping', Date.now());
    }

    /* ── Değerlendirme defteri (her talep bir kez) ── */
    function claim(pid) {
        const done = GM_getValue('done', {});
        const cur = done[pid];
        if (cur && (cur.final || Date.now() - cur.at < 60000)) return false;   // bitti ya da başka sekmede sürüyor
        done[pid] = { at: Date.now(), tries: (cur?.tries || 0) + 1, final: false };
        const week = Date.now() - 7 * 864e5;
        for (const k of Object.keys(done)) if (done[k].at < week) delete done[k];
        GM_setValue('done', done);
        return true;
    }
    function finish(pid, result) {
        const done = GM_getValue('done', {});
        done[pid] = { ...(done[pid] || {}), at: Date.now(), final: true, result };
        GM_setValue('done', done);
    }
    function release(pid) {   // geçici hata: bir sonraki turda yeniden dene (en fazla 5 kez)
        const done = GM_getValue('done', {});
        if ((done[pid]?.tries || 0) >= 5) { done[pid].final = true; done[pid].result = 'hata: deneme sınırı'; }
        GM_setValue('done', done);
    }

    async function runOne(it) {
        const m = mode();
        if (m === 'off' || !claim(it.paymentid)) return;
        let d;
        try { d = await evaluate(it); }
        catch (e) { warn('değerlendirilemedi:', it.paymentid, e.message); release(it.paymentid); return; }

        if (!d.rule) { finish(it.paymentid, 'kural yok'); log(`${it.paymentid}: kural tutmadı`, d.facts); return; }

        if (mode() !== 'live') {
            enqueue(it.paymentid, slackText(it, d, 'DENEME, reddedilmedi'));
            finish(it.paymentid, `deneme: ${d.rule}`);
            log(`${it.paymentid}: DENEME → ${d.rule}`, d.facts);
            return;
        }
        try {
            await reject(it.paymentid, it.partyId, d.reason);
            enqueue(it.paymentid, slackText(it, d));
            finish(it.paymentid, `reddedildi: ${d.rule}`);
            log(`${it.paymentid}: REDDEDİLDİ → ${d.rule}`, d.facts);
        } catch (e) {
            finish(it.paymentid, `red başarısız: ${e.message}`);
            if (/artık bekleyen değil/.test(e.message)) { log(`${it.paymentid}: başkası önce işlemiş, atlandı`); return; }
            enqueue(it.paymentid + '-err', `:warning: Otomatik red uygulanamadı (${d.rule}) — ${esc(e.message)}\nID: ${it.partyId}\nPaymentID: ${it.paymentid}`);
            warn(`${it.paymentid}: red başarısız`, e);
        }
    }

    function handle(items) {
        if (!items || mode() === 'off') return;
        const limit = Date.now() - CONFIG.MAX_AGE_MIN * 60000;
        for (const it of items) {
            if (it.requestedAt && it.requestedAt.getTime() < limit) continue;
            runOne(it);
        }
    }

    async function poll() {
        if (mode() === 'off') return;
        const form = document.querySelector('input[name="execute"][value="Go"]')?.form;
        if (!form) return;
        const params = new URLSearchParams();
        for (const [k, v] of new FormData(form)) if (typeof v === 'string') params.append(k, v);
        params.set('execute', 'Go');
        const url = new URL(form.getAttribute('action') || location.pathname, location.href);
        const post = (form.method || 'get').toLowerCase() === 'post';
        if (!post) for (const [k, v] of params) url.searchParams.append(k, v);
        try {
            const res = await fetch(url, post
                ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
                : { credentials: 'same-origin' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const items = readRows(new DOMParser().parseFromString(await res.text(), 'text/html'));
            if (items) handle(items);
        } catch (e) { warn('yoklama başarısız:', e.message); }
    }

    /* ── Çalıştır ── */
    let started = false, queued = false;
    function scan() {
        queued = false;
        if (!onPendingPage()) return;
        const items = readRows(document);
        if (!items) return;
        if (!started) start();
        handle(items);
    }
    function start() {
        started = true;
        log(`Pending Withdrawals izleniyor. Mod: ${MODES[mode()]}`);
        setInterval(poll, CONFIG.POLL_SEC * 1000);

        GM_registerMenuCommand('Mod: Kapalı', () => { GM_setValue('mode', 'off'); alert('Otomatik Red KAPALI.'); });
        GM_registerMenuCommand('Mod: Deneme (reddetmez, Slack\'e yazar)', () => { GM_setValue('mode', 'dry'); alert('Otomatik Red DENEME modunda: hiçbir talep reddedilmez.'); });
        GM_registerMenuCommand('Mod: Canlı (gerçekten reddeder)', () => {
            if (!confirm('CANLI mod: kurala uyan talepler GERÇEKTEN reddedilecek.\n\nDiğer otomatik red botu kapalı mı? Devam edilsin mi?')) return;
            GM_setValue('mode', 'live'); alert('Otomatik Red CANLI.');
        });
        GM_registerMenuCommand('Durum', () => {
            const done = GM_getValue('done', {});
            const last = Object.entries(done).sort((a, b) => b[1].at - a[1].at).slice(0, 8)
                .map(([pid, v]) => `${pid}: ${v.result || 'sürüyor'}`).join('\n');
            const s = GM_getValue('slackStatus', null);
            alert(`Mod: ${MODES[mode()]}\nSlack: ${s ? s.msg : 'hiç bağlanmadı'}\nKuyruk: ${GM_listValues().filter(k => k.startsWith('q:')).length}\n\nSon kararlar:\n${last || '—'}`);
        });
        GM_registerMenuCommand('Teşhis: ilk bekleyeni değerlendir', async () => {
            const [first] = readRows(document) || [];
            if (!first) { alert('Listede bekleyen talep yok.'); return; }
            const d = await evaluate(first);
            const f = d.facts;
            alert([
                `PaymentID ${first.paymentid} · Party ${first.partyId}`,
                `Karar: ${d.rule ? `${d.rule} → RED` : 'kural tutmadı'}`,
                d.reason ? `Sebep: ${d.reason}` : '',
                '',
                `Yatırım: ${f.deposit ? `hiç yatırdı mı=${f.deposit.value} (LTD=${f.deposit.ltd}, tamamlanan=${f.deposit.completed})` : '—'}`,
                `KYC: ${f.kyc ? `${f.kyc.value} [${f.kyc.field}]` : '(bakılmadı: yatırımı var ya da bilinmiyor)'}${f.note ? ' · ' + f.note : ''}`,
                `Son başarılı çekim: ${f.lastWithdrawal ? `${f.lastWithdrawal.id} · ${f.lastWithdrawal.processDateUtc} · ${f.lastWithdrawal.status}` : 'yok'}`,
                f.allowedAtTr ? `8 saat dolumu (TR): ${f.allowedAtTr}` : '',
                f.kural1Hata ? `Kural 1 hata: ${f.kural1Hata}` : '', f.kural2Hata ? `Kural 2 hata: ${f.kural2Hata}` : '',
                '', 'Reddedilmedi, Slack\'e yazılmadı.',
            ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'));
            log('teşhis', first, d);
        });
    }
    new MutationObserver(() => { if (!queued && onPendingPage()) { queued = true; setTimeout(scan, 500); } })
        .observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, 15000);
    scan();
}

/* ════════════════════════════════════════════════════════════
   SLACK TARAFI (Slack Çekim Bildirimi ile aynı yöntem)
   ════════════════════════════════════════════════════════════ */
function slackSide() {
    let token = null, busy = false;
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
    async function send(text) {
        for (let i = 0; i < 4; i++) {
            const r = await call('chat.postMessage', { channel: CONFIG.CHANNEL, text, unfurl_links: 'false', unfurl_media: 'false' });
            if (r.ok) return r;
            if (r.error === 'ratelimited') { await sleep(r.retry); continue; }
            if (/invalid_auth|not_authed|token_revoked/.test(r.error)) { token = null; await resolveToken(); continue; }
            throw new Error(r.error || 'bilinmeyen hata');
        }
        throw new Error('4 denemede gönderilemedi');
    }
    async function flush() {
        if (busy) return;
        const keys = GM_listValues().filter(k => k.startsWith('q:'));
        if (!keys.length) return;
        const lock = GM_getValue('slackLock', null);
        if (lock && lock.owner !== ME && Date.now() - lock.at < 30000) return;
        GM_setValue('slackLock', { owner: ME, at: Date.now() });
        await sleep(300);
        if (GM_getValue('slackLock', null)?.owner !== ME) return;
        busy = true;
        try {
            if (!token) await resolveToken();
            const items = keys.map(k => [k, GM_getValue(k, null)]).filter(([, v]) => v).sort((a, b) => a[1].at - b[1].at);
            for (const [k, v] of items) {
                if (Date.now() - v.at > 24 * 3600e3) { GM_deleteValue(k); continue; }
                GM_setValue('slackLock', { owner: ME, at: Date.now() });
                await send(v.text);
                GM_deleteValue(k);
                status(`son gönderim ${k.slice(2)}`);
                await sleep(1200);
            }
        } catch (e) { warn('gönderilemedi:', e.message); status(`HATA: ${e.message}`); }
        finally { busy = false; GM_deleteValue('slackLock'); }
    }
    GM_addValueChangeListener('ping', () => flush());
    setInterval(flush, 20000);
    setTimeout(flush, 3000);
    status('bağlı, bekliyor');
}

})();
