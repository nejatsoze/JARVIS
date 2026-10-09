// ==UserScript==
// @name         Slack Çekim Bildirimi
// @namespace    palentis.slack-cekim
// @version      1.0.0
// @description  Pending Withdrawals listesine yeni bir çekim düşünce Party ID, çekim tutarı/yöntemi, son yatırım tutarı/yöntemi ve son yatırımdan bu yana max bakiyeyi Slack kanalına (C0BMBT1A6KX) senin adınla gönderir. Mesajı açık Slack sekmesi atar; iki sekme Tampermonkey deposu üzerinden haberleşir. Webhook / n8n gerekmez.
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
 * AKIŞ
 * ────
 *  GT sekmesi (Pending Withdrawals)              Slack sekmesi (app.slack.com)
 *  ─────────────────────────────────             ─────────────────────────────
 *  listede görülmemiş paymentid  ──┐
 *  son yatırım  (player-deposit/query)           GM deposundaki "q:*" kayıtlarını
 *  max bakiye   (player-transactions/page)  ──►  chat.postMessage ile kanala atar,
 *  mesajı GM deposuna "q:<id>" yazar             başarılı olanı siler.
 *
 *  · Script iki siteye birden kurulu olduğu için GM deposu ikisinde ortak.
 *  · Slack sekmesi kapalıysa mesajlar kuyrukta bekler, sekme açılınca gider.
 *  · İlk kurulumda listede zaten olanlar "görüldü" sayılır, gönderilmez.
 *    Elle denemek için Tampermonkey menüsü → "Test: ilk bekleyeni gönder".
 *  · Liste iki yoldan izlenir: sayfadaki tablo (keep-alive Go'ya bastıkça
 *    yenilenir) + POLL_SEC'te bir sayfanın kendi filtre formuyla arka planda
 *    çekilen liste (sayfaya dokunmaz).
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0BMBT1A6KX',
    POLL_SEC: 60,              // arka plan liste yoklaması; 0 = kapalı (sadece sayfadaki tablo)
    MAX_AGE_MIN: 180,          // bundan eski talepler bildirilmez (tarayıcı uzun süre kapalı kaldıysa yığın gitmesin)
    DEPOSIT_DAYS: 90,          // son yatırım bu kadar gün geriye aranır
    TX_PAGE_SIZE: 1000,
    TX_MAX_PAGES: 30,
    QUEUE_TTL_H: 24,           // Slack'e bu kadar süre gidemeyen mesaj atılır
};

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Slack Çekim]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const topHref = () => { try { return window.top.location.href; } catch { return location.href; } };

if (location.hostname === 'app.slack.com') { if (window.top === window) slackSide(); }
else gtSide();

/* ════════════════════════════════════════════════════════════
   GT TARAFI
   ════════════════════════════════════════════════════════════ */
function gtSide() {
    // Sadece asıl Pending Withdrawals sayfası; oyuncu profilindeki çekim popup'ı aynı listeyi açıyor, orası hariç.
    const onPendingPage = () => /classic\/payment\/pendingWithdrawals/i.test(topHref()) && !topHref().includes('popup:');

    /* ── Panel API (GT Core ile aynı kurallar: token her istekte taze) ── */
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
    async function ics(path, params) {
        const t = token();
        if (!t) throw new Error('oturum token yok');
        const url = `${HOST}/ics/${path}?${new URLSearchParams({ sessionKey: t, uType: 'staff', ...params })}`;
        const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json', Authorization: `Bearer ${t}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
        return res.json();
    }
    const asList = (d) => Array.isArray(d) ? d : (Object.values(d || {}).find(Array.isArray) || []);

    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

    const money = (n) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cur = (c) => (!c || /^(TRY|TL)$/i.test(c)) ? 'TL' : c.toUpperCase();
    /** "164700.00", "164,700.00", "164.700,00" → 164700 */
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
    function reqDate(s) {
        const m = String(s).match(/(\d{2})[-.](\d{2})[-.](\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return null;
        const [, d, mo, y, h, mi, se = '0'] = m;
        return /UTC/i.test(s) ? new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +se)) : new Date(+y, mo - 1, +d, +h, +mi, +se);
    }
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const clean = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

    /* ── Listeyi oku (sayfadaki ya da arka planda çekilen belge) ── */
    function readRows(doc) {
        const table = doc.getElementById('pending_withdrawals');
        if (!table) return null;
        const rows = [...table.rows];
        const head = rows.find(r => { const t = clean(r).toUpperCase(); return t.includes('REQUEST DATE') && t.includes('PARTY ID'); });
        if (!head) return null;

        const cols = {};
        let p = 0;
        for (const c of head.cells) { cols[clean(c).toUpperCase()] = p; p += c.colSpan || 1; }
        const cellAt = (row, pos) => { let q = 0; for (const c of row.cells) { if (q === pos) return c; q += c.colSpan || 1; } return null; };
        const col = (row, name) => cols[name] === undefined ? '' : clean(cellAt(row, cols[name]));

        const out = [];
        for (const row of table.querySelectorAll('tr[id^="pending_withdrawals_row"]')) {
            const status = col(row, 'STATUS');
            if (status && status.toUpperCase() !== 'PENDING') continue;
            const link = row.querySelector('a[href*="ProcessWithdrawal.action"]');
            if (!link) continue;
            let q;
            try { q = new URL(link.getAttribute('href'), HOST).searchParams; } catch { continue; }
            const paymentid = q.get('paymentid'), partyId = q.get('partyId');
            if (!paymentid || !partyId) continue;
            out.push({
                paymentid, partyId,
                amount: num(col(row, 'AMOUNT')),
                currency: col(row, 'CURRENCY'),
                method: col(row, 'METHOD'),
                requestedAt: reqDate(col(row, 'REQUEST DATE')),
            });
        }
        return out;
    }

    /* ── Görüldü defteri (GM deposu: sekmeler ve iframe'ler arası ortak) ── */
    const SEEN = 'seen';
    function claim(id) {
        const seen = GM_getValue(SEEN, {});
        if (seen[id]) return false;
        seen[id] = Date.now();
        const week = Date.now() - 7 * 864e5;
        for (const k of Object.keys(seen)) if (seen[k] < week) delete seen[k];
        GM_setValue(SEEN, seen);
        return true;
    }
    function seedIfFirstRun(items) {
        if (GM_getValue('seeded', false)) return false;
        const seen = GM_getValue(SEEN, {});
        for (const it of items) seen[it.paymentid] = Date.now();
        GM_setValue(SEEN, seen);
        GM_setValue('seeded', true);
        log(`ilk kurulum: listedeki ${items.length} talep görüldü sayıldı, gönderilmedi.`);
        return true;
    }

    /* ── Oyuncu verisi ── */
    async function lastDeposit(pid) {
        const list = asList(await ics('player-deposit/query', {
            partyId: pid, startDate: ymd(dayOffset(-CONFIG.DEPOSIT_DAYS)), endDate: ymd(dayOffset(1)), currency: 'TRY',
        }));
        return list.filter(d => d.paymentStatus === 'COMPLETED')
            .sort((a, b) => (b.processDate || 0) - (a.processDate || 0))[0] || null;
    }
    const depositTime = (d) => {
        if (+d.processDate) return +d.processDate;
        const m = String(d.processDateStr || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/);
        return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
    };

    /** Son yatırımdan bu yana işlem sonrası toplam bakiyenin en yüksek olduğu işlem. */
    async function maxBalanceSince(pid, since) {
        const from = new Date(since); from.setDate(from.getDate() - 1);
        const SLACK_MS = 2 * 60000; // yatırım kaydı ile işlem kaydı saniyeler farkla düşebiliyor
        let best = null, pages = 0;
        for (let page = 1; page <= CONFIG.TX_MAX_PAGES; page++) {
            const rows = asList(await ics('player-transactions/page', {
                partyid: pid, startDate: `${ymd(from)} 0:0:0.000`, endDate: `${ymd(dayOffset(1))} 23:59:0.000`,
                pageSize: CONFIG.TX_PAGE_SIZE, pageNum: page, currency: 'TRY',
            }));
            pages = page;
            for (const r of rows) {
                if (r.datetime && r.datetime < since - SLACK_MS) continue;
                const bal = r.balance != null ? +r.balance : (+r.balanceReal || 0) + (+r.balancePlayableBonus || 0);
                if (!Number.isFinite(bal)) continue;
                if (!best || bal > best.bal) best = { bal, id: r.tranId ?? r.transactionId ?? r.id ?? r.gameTranId ?? '' };
            }
            if (rows.length < CONFIG.TX_PAGE_SIZE) break;
        }
        if (pages === CONFIG.TX_MAX_PAGES) warn(`max bakiye: ${pid} için ${pages} sayfa sınırına gelindi, sonuç eksik olabilir`);
        return best;
    }

    async function buildMessage(it) {
        const lines = ['*Yeni Çekim Talebi!*'];
        lines.push(`*Party ID:* <${HOST}/core/app/core/players/${it.partyId}/detail|${it.partyId}>`);
        const wAmt = Number.isFinite(it.amount) ? `${money(it.amount)} ${cur(it.currency)}` : '?';
        lines.push(`*Çekim Miktarı ve Yöntemi:* ${esc(wAmt)}${it.method ? ' - ' + esc(it.method) : ''}`);

        let dep = null;
        try { dep = await lastDeposit(it.partyId); }
        catch (e) { warn('son yatırım alınamadı:', e.message); dep = undefined; }
        if (dep) lines.push(`*Yatırım Miktarı ve Yöntemi:* ${money(dep.amount)} TL${dep.methodName ? ' - ' + esc(dep.methodName) : ''}`);
        else lines.push(`*Yatırım Miktarı ve Yöntemi:* _${dep === undefined ? 'alınamadı' : `son ${CONFIG.DEPOSIT_DAYS} günde tamamlanmış yatırım yok`}_`);

        let max = null;
        const since = dep ? depositTime(dep) : null;
        if (since) {
            try { max = await maxBalanceSince(it.partyId, since); }
            catch (e) { warn('max bakiye alınamadı:', e.message); }
        }
        lines.push(max
            ? `*Max Bakiye:* ${money(max.bal)} TL${max.id ? ` (\`${max.id}\`)` : ''}`
            : '*Max Bakiye:* _hesaplanamadı_');
        return lines.join('\n');
    }

    /** Mesajı kuyruğa koy; Slack sekmesi alıp gönderir. */
    function enqueue(key, text) {
        GM_setValue('q:' + key, { text, at: Date.now() });
        GM_setValue('ping', Date.now());
    }

    async function notify(it, { test = false } = {}) {
        try {
            const text = await buildMessage(it);
            enqueue(test ? `test-${it.paymentid}-${Date.now()}` : it.paymentid, text);
            log(`${test ? 'TEST ' : ''}kuyruğa alındı: ${it.paymentid} (party ${it.partyId})\n${text}`);
            return text;
        } catch (e) {
            warn('mesaj hazırlanamadı:', it.paymentid, e);
            return null;
        }
    }

    function handle(items) {
        if (!items || seedIfFirstRun(items)) return;
        const limit = Date.now() - CONFIG.MAX_AGE_MIN * 60000;
        for (const it of items) {
            if (!claim(it.paymentid)) continue;
            if (it.requestedAt && it.requestedAt.getTime() < limit) { log(`eski talep, bildirilmedi: ${it.paymentid}`); continue; }
            notify(it);
        }
    }

    /* ── Arka plan yoklaması: sayfanın kendi filtre formunu aynen gönder ── */
    async function poll() {
        const go = document.querySelector('input[name="execute"][value="Go"]');
        const form = go?.form;
        if (!form) return;
        const params = new URLSearchParams();
        for (const [k, v] of new FormData(form)) if (typeof v === 'string') params.append(k, v);
        params.set('execute', 'Go');
        const action = form.getAttribute('action') || location.pathname;
        const url = new URL(action, location.href);
        const post = (form.method || 'get').toLowerCase() === 'post';
        if (!post) for (const [k, v] of params) url.searchParams.append(k, v);
        try {
            const res = await fetch(url, post
                ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
                : { credentials: 'same-origin' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            const items = readRows(doc);
            if (items) handle(items);
            else warn('yoklama: yanıtta liste tablosu yok (oturum düşmüş olabilir)');
        } catch (e) { warn('yoklama başarısız:', e.message); }
    }

    /* ── Çalıştır: tabloyu barındıran belgede (iframe ya da üst pencere) ── */
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
        log('Pending Withdrawals izleniyor.');
        if (CONFIG.POLL_SEC > 0) setInterval(poll, CONFIG.POLL_SEC * 1000);
        GM_registerMenuCommand('Test: ilk bekleyeni gönder', async () => {
            const [first] = readRows(document) || [];
            if (!first) { alert('Listede bekleyen talep yok.'); return; }
            const text = await notify(first, { test: true });
            alert(text ? `Kuyruğa alındı, Slack sekmesi gönderecek:\n\n${text}` : 'Mesaj hazırlanamadı, konsola bak.');
        });
        GM_registerMenuCommand('Kuyruk durumu', () => {
            const q = GM_listValues().filter(k => k.startsWith('q:'));
            const s = GM_getValue('slackStatus', null);
            alert(`Kuyrukta bekleyen: ${q.length}\nSlack sekmesi: ${s ? `${s.msg} (${new Date(s.at).toLocaleTimeString('tr-TR')})` : 'hiç bağlanmadı'}`);
        });
    }
    new MutationObserver(() => { if (!queued) { queued = true; setTimeout(scan, 500); } })
        .observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, 15000);
    scan();
}

/* ════════════════════════════════════════════════════════════
   SLACK TARAFI
   ════════════════════════════════════════════════════════════ */
function slackSide() {
    let token = null;
    let busy = false;
    const ME = Math.random().toString(36).slice(2);

    const status = (msg) => GM_setValue('slackStatus', { msg, at: Date.now() });

    /** Slack web istemcisinin kendi oturum anahtarları (localStorage). Hiçbir yere yazılmaz, sadece bu sekmede kullanılır. */
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

    /** İstek sayfanın kendi fetch'iyle atılır (Slack web istemcisi ne yapıyorsa o); olmazsa script'in fetch'i. */
    async function call(method, params, tok = token) {
        const body = new URLSearchParams({ token: tok, ...params }).toString();
        const init = { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body };
        const url = `${location.origin}/api/${method}`;
        let text;
        try {
            const opts = typeof cloneInto === 'function' ? cloneInto(init, W) : init;
            const res = await W.fetch(url, opts);
            if (res.status === 429) return { ok: false, error: 'ratelimited', retry: (+res.headers.get('retry-after') || 5) * 1000 };
            text = await res.text();
        } catch (e) {
            const res = await fetch(url, init);
            if (res.status === 429) return { ok: false, error: 'ratelimited', retry: (+res.headers.get('retry-after') || 5) * 1000 };
            text = await res.text();
        }
        return JSON.parse(text);
    }

    async function resolveToken() {
        const cands = collectTokens();
        if (!cands.length) throw new Error('Slack oturum anahtarı bulunamadı (Slack web istemcisinde oturum açık mı?)');
        for (const t of cands) {
            try {
                const r = await call('conversations.info', { channel: CONFIG.CHANNEL }, t);
                if (r.ok) { token = t; log(`kanal bulundu: #${r.channel?.name}`); return; }
            } catch { /* sonraki */ }
        }
        throw new Error(`hiçbir oturum ${CONFIG.CHANNEL} kanalını göremiyor (kanalın üyesi misin?)`);
    }

    async function send(text) {
        for (let i = 0; i < 4; i++) {
            const r = await call('chat.postMessage', { channel: CONFIG.CHANNEL, text, unfurl_links: 'false', unfurl_media: 'false' });
            if (r.ok) return;
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

        // Birden fazla Slack sekmesi açıksa yalnızca biri göndersin
        const lock = GM_getValue('slackLock', null);
        if (lock && lock.owner !== ME && Date.now() - lock.at < 30000) return;
        GM_setValue('slackLock', { owner: ME, at: Date.now() });
        await sleep(300);
        if (GM_getValue('slackLock', null)?.owner !== ME) return;

        busy = true;
        try {
            if (!token) await resolveToken();
            const items = keys.map(k => [k, GM_getValue(k, null)]).filter(([, v]) => v)
                .sort((a, b) => a[1].at - b[1].at);
            for (const [k, v] of items) {
                if (Date.now() - v.at > CONFIG.QUEUE_TTL_H * 3600e3) { GM_deleteValue(k); warn('çok eski, atıldı:', k); continue; }
                GM_setValue('slackLock', { owner: ME, at: Date.now() });
                await send(v.text);
                GM_deleteValue(k);
                log('gönderildi:', k);
                status(`son gönderim ${k.slice(2)}`);
                await sleep(1200);
            }
        } catch (e) {
            warn('gönderilemedi:', e.message);
            status(`HATA: ${e.message}`);
        } finally {
            busy = false;
            GM_deleteValue('slackLock');
        }
    }

    GM_addValueChangeListener('ping', () => flush());
    setInterval(flush, 20000);
    setTimeout(flush, 3000); // Slack istemcisi localStorage'ı doldursun
    status('bağlı, bekliyor');
    log('Slack tarafı hazır, kuyruk izleniyor.');
}

})();
