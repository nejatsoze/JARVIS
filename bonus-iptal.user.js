// ==UserScript==
// @name         Bonus İptal — 25.000 TL altı freespin kazancı
// @namespace    palentis.bonus-iptal
// @version      1.0.0
// @description  Transaction Report'taki yeni Platform Bonus (PLTFRM_BON) kayıtlarını izler; kazanç 25.000 TL'nin altındaysa oyuncunun bu kazançla açılan freespin bonusunu iptal eder ve Slack kanalına bildirir. VARSAYILAN DENEME MODU: hiçbir bonusu iptal etmez, sadece kararı Slack'e yazar. Tampermonkey menüsünden Kapalı / Deneme / Canlı seçilir.
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
 *   1. POLL_SEC'te bir /j/reports/TransactionReport.action formu arka planda
 *      Transaction Type = Platform Bonus, bugünün tarihiyle gönderilir (sayfayı açık
 *      tutmak gerekmez; herhangi bir GT sekmesi yeter).
 *   2. Yeni PLTFRM_BON satırı (Transaction ID ile) ve Credit < LIMIT ise:
 *      oyuncunun bonus listesinde (GET /ics/player-bonus/{party}) adı TARGET_PLANS'ta
 *      olan, iptal edilebilir durumda (Active / Queued / Spent Active / Pending),
 *      tutarı bu kazanca eşit ve aynı dakikalarda açılmış bonus aranır.
 *   3. Canlı: DELETE /ics/player-bonus/{bonusId} (panelin Cancel butonunun isteği),
 *      ardından listeden durumunun Canceled olduğu doğrulanır ve Slack'e mesaj gider.
 *
 * GÜVENLİK
 *   · Varsayılan DENEME: iptal yok, Slack'e "DENEME — iptal edilmedi" notuyla ve
 *     bulunan bonusun adı/ID'siyle yazar (doğru bonusu seçtiğini görebilirsin).
 *   · Eşleşen bonus tek ve kesin değilse iptal yok.
 *   · Bonus zaten iptal edilmişse (diğer bot) sessizce geçilir.
 *   · İlk çalışmada listede zaten olan kayıtlar "görüldü" sayılır, işlenmez.
 *   · Birden fazla GT sekmesi açıksa yalnızca biri çalışır.
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0C80H6L4CD',
    POLL_SEC: 30,
    LIMIT: 25000,                         // bu tutarın ALTINDAKİ kazançlarda iptal
    TARGET_PLANS: ['Freespin Zuma'],      // iptal edilecek bonus planı (freespin kazancıyla açılan)
    MATCH_MIN: 5,                         // bonus açılışı ile PLTFRM_BON arasındaki en fazla fark (dk)
    FIND_RETRY: 4,                        // bonus henüz görünmüyorsa kaç tur daha aransın
};

const CANCELLABLE = ['ACTIVE', 'QUEUED', 'SPENT ACTIVE', 'PENDING'];   // panelin isCancellableBonus listesi
const MESSAGE = (x) => `Deneme Bonusu freespinleri ile bakiyenizi 25.000 TL ve üzerine ulaştırabilirseniz 2.000 TL çekim yapabilirsiniz. Bonus kazancınız: ${x} TL olduğu için bonus iptal edilmiştir.`;

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Bonus İptal]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MODES = { off: 'Kapalı', dry: 'Deneme', live: 'Canlı' };
const mode = () => GM_getValue('mode', 'dry');

if (location.hostname === 'app.slack.com') slackSide();
else gtSide();

/* ════════════════════════════════════════════════════════════
   GT TARAFI
   ════════════════════════════════════════════════════════════ */
function gtSide() {
    const ME = Math.random().toString(36).slice(2);

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
    async function ics(path, params = {}, method = 'GET') {
        const t = need();
        const url = `${HOST}/ics/${path}?${new URLSearchParams({ sessionKey: t, uType: 'staff', ...params })}`;
        const res = await fetch(url, { method, credentials: 'include', headers: { Accept: 'application/json', Authorization: `Bearer ${t}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${method} ${path.split('?')[0]}`);
        const text = await res.text();
        try { return JSON.parse(text); } catch { return text; }
    }
    const asList = (d) => Array.isArray(d) ? d : (Object.values(d || {}).find(Array.isArray) || []);
    const clean = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const pad = (n) => String(n).padStart(2, '0');
    const dmy = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const money = (n) => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    function num(s) {
        let t = String(s ?? '').replace(/[^\d.,-]/g, '');
        if (!t) return NaN;
        const dot = t.lastIndexOf('.'), comma = t.lastIndexOf(',');
        if (dot >= 0 && comma >= 0) t = dot > comma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
        else if (comma >= 0) t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
        return parseFloat(t);
    }
    /** "2026-10-09 21:05:55.37" → dakika cinsinden karşılaştırma için ms (saat dilimi iki tarafta aynı kabul edilir) */
    const stamp = (s) => { const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN; };

    /* ── Transaction Report: formu panelden al, PLTFRM_BON + bugün ile gönder ── */
    async function fetchPlatformBonuses() {
        const t = need();
        const base = `${HOST}/j/reports/TransactionReport.action`;
        const page = await fetch(`${base}?${new URLSearchParams({ embeddedInCore4: 'true', cmslanguage: 'en', token: t })}`, { credentials: 'include' });
        if (!page.ok) throw new Error('rapor formu HTTP ' + page.status);
        const fdoc = new DOMParser().parseFromString(await page.text(), 'text/html');
        const form = fdoc.querySelector('#tranType')?.form;
        if (!form) throw new Error('rapor formu bulunamadı (oturum düşmüş olabilir)');

        const now = new Date();
        const from = new Date(now.getTime() - 2 * 3600e3);   // gece yarısı geçişinde dünü de kapsa
        const body = new URLSearchParams();
        for (const [k, v] of new FormData(form)) if (typeof v === 'string') body.append(k, v);
        body.set('tranType', 'PLTFRM_BON');
        body.set('startDate', dmy(from)); body.set('startHour', '00');
        body.set('endDate', dmy(now));    body.set('endHour', '23');
        body.set('currency', 'TRY');
        body.set('execute', 'Go');

        const res = await fetch(new URL(form.getAttribute('action') || base, HOST), {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        });
        if (!res.ok) throw new Error('rapor HTTP ' + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const table = doc.getElementById('transaction_report');
        if (!table) throw new Error('transaction_report tablosu yok');

        const rows = [...table.rows];
        const head = rows.find(r => /PARTY ID/i.test(clean(r)) && /TRANSACTION ID/i.test(clean(r)));
        if (!head) throw new Error('rapor başlıkları okunamadı');
        const cols = {};
        [...head.cells].forEach((c, i) => { cols[clean(c).toUpperCase()] = i; });
        const col = (r, n) => clean(r.cells[cols[n]]);
        const out = [];
        for (const r of rows) {
            if (r === head || r.cells.length < head.cells.length) continue;
            if (col(r, 'TRANSACTION TYPE') !== 'PLTFRM_BON') continue;
            const tranId = col(r, 'TRANSACTION ID'), partyId = col(r, 'PARTY ID');
            if (!/^\d+$/.test(tranId) || !/^\d+$/.test(partyId)) continue;
            out.push({ tranId, partyId, at: col(r, 'TRANSACTION DATE'), credit: num(col(r, 'CREDIT')) });
        }
        return out;
    }

    /* ── Bonus eşleştirme ve iptal ── */
    async function playerBonuses(pid) {
        return asList(await ics(`player-bonus/${pid}`, { currency: 'undefined' }));
    }
    /** { pick, already, candidates } — pick: iptal edilecek tek bonus; already: aynı kazancın bonusu zaten iptal */
    function matchBonus(list, tx) {
        const t = stamp(tx.at);
        const near = (b) => Number.isFinite(t) && Math.abs(stamp(b.triggerDate) - t) <= CONFIG.MATCH_MIN * 60000;
        const same = (b) => Math.abs((Number(b.amount) || 0) - tx.credit) < 0.01 || Math.abs((Number(b.playableBonus) || 0) - tx.credit) < 0.01;
        const plan = (b) => CONFIG.TARGET_PLANS.some(p => String(b.planName || '').trim().toLowerCase() === p.toLowerCase());
        const mine = list.filter(b => plan(b) && same(b) && near(b));
        const open = mine.filter(b => CANCELLABLE.includes(String(b.status || '').toUpperCase()));
        return {
            pick: open.length === 1 ? open[0] : null,
            ambiguous: open.length > 1,
            already: !open.length && mine.some(b => /cancel/i.test(b.status)),
            candidates: mine,
        };
    }
    async function cancelBonus(pid, bonusId) {
        const r = await ics(`player-bonus/${bonusId}`, {}, 'DELETE');
        if (r && typeof r === 'object' && r.status && r.status !== 'OK') throw new Error(`panel yanıtı: ${r.status}${r.message ? ' — ' + r.message : ''}`);
        // Doğrula: listede artık Canceled olmalı
        await sleep(1500);
        const b = (await playerBonuses(pid)).find(x => String(x.id) === String(bonusId));
        if (b && !/cancel/i.test(b.status)) throw new Error(`iptal sonrası durum hâlâ ${b.status}`);
    }

    /* ── Slack ── */
    function enqueue(key, text) {
        GM_setValue('q:' + key, { text, at: Date.now() });
        GM_setValue('ping', Date.now());
    }

    /* ── Defter ── */
    const book = () => GM_getValue('book', {});
    function setBook(id, v) {
        const b = book();
        b[id] = { ...(b[id] || {}), ...v, at: Date.now() };
        const week = Date.now() - 7 * 864e5;
        for (const k of Object.keys(b)) if (b[k].at < week) delete b[k];
        GM_setValue('book', b);
    }

    async function handle(tx) {
        const entry = book()[tx.tranId];
        if (entry?.final) return;
        if (!(tx.credit < CONFIG.LIMIT)) { setBook(tx.tranId, { final: true, result: `limit üstü (${tx.credit})` }); return; }

        const list = await playerBonuses(tx.partyId);
        const m = matchBonus(list, tx);
        const tries = (entry?.tries || 0) + 1;
        if (m.already) { setBook(tx.tranId, { final: true, result: 'zaten iptal (başkası)' }); log(`${tx.tranId}: bonus zaten iptal edilmiş`); return; }
        if (m.ambiguous) {
            setBook(tx.tranId, { final: true, result: 'birden fazla eşleşen bonus — dokunulmadı' });
            enqueue(tx.tranId + '-amb', `:warning: Bonus iptal: ${tx.partyId} için birden fazla eşleşen bonus var, dokunulmadı (Transaction ID ${tx.tranId}).`);
            return;
        }
        if (!m.pick) {
            if (tries < CONFIG.FIND_RETRY) { setBook(tx.tranId, { tries }); return; }   // bonus henüz oluşmamış olabilir
            setBook(tx.tranId, { final: true, result: 'eşleşen bonus yok' });
            log(`${tx.tranId}: eşleşen bonus bulunamadı`, m.candidates);
            return;
        }

        const x = money(tx.credit);
        const info = `${m.pick.planName} #${m.pick.id}`;
        if (mode() !== 'live') {
            enqueue(tx.tranId, `:test_tube: _DENEME — iptal edilmedi (bulunan bonus: ${esc(info)})_\n${MESSAGE(x)}\nID: ${tx.partyId}`);
            setBook(tx.tranId, { final: true, result: `deneme: ${info}` });
            log(`${tx.tranId}: DENEME → ${info}, kazanç ${x}`);
            return;
        }
        try {
            await cancelBonus(tx.partyId, m.pick.id);
            enqueue(tx.tranId, `${MESSAGE(x)}\nID: ${tx.partyId}`);
            setBook(tx.tranId, { final: true, result: `iptal: ${info}` });
            log(`${tx.tranId}: İPTAL → ${info}, kazanç ${x}`);
        } catch (e) {
            setBook(tx.tranId, { final: true, result: `iptal başarısız: ${e.message}` });
            enqueue(tx.tranId + '-err', `:warning: Bonus iptal edilemedi — ${esc(e.message)}\nID: ${tx.partyId}\nBonus: ${esc(info)}`);
            warn(`${tx.tranId}: iptal başarısız`, e);
        }
    }

    let busy = false;
    async function tick() {
        if (busy || mode() === 'off') return;
        // Birden fazla GT sekmesi: tek lider çalışsın
        const lead = GM_getValue('leader', null);
        if (lead && lead.owner !== ME && Date.now() - lead.at < 3 * CONFIG.POLL_SEC * 1000) return;
        GM_setValue('leader', { owner: ME, at: Date.now() });
        if (!token()) return;   // giriş yapılmamış sekme

        busy = true;
        try {
            const txs = await fetchPlatformBonuses();
            if (!GM_getValue('seeded', false)) {
                for (const tx of txs) setBook(tx.tranId, { final: true, result: 'kurulumda mevcuttu' });
                GM_setValue('seeded', true);
                log(`ilk kurulum: ${txs.length} kayıt görüldü sayıldı, işlenmedi.`);
                return;
            }
            for (const tx of txs) {
                try { await handle(tx); }
                catch (e) {
                    const tries = (book()[tx.tranId]?.tries || 0) + 1;
                    warn(`${tx.tranId}: işlenemedi`, e.message);
                    setBook(tx.tranId, tries >= 10 ? { tries, final: true, result: `hata: ${e.message}` } : { tries });
                }
            }
        } catch (e) { warn('rapor okunamadı:', e.message); }
        finally { busy = false; }
    }

    GM_registerMenuCommand('Mod: Kapalı', () => { GM_setValue('mode', 'off'); alert('Bonus İptal KAPALI.'); });
    GM_registerMenuCommand('Mod: Deneme (iptal etmez, Slack\'e yazar)', () => { GM_setValue('mode', 'dry'); alert('Bonus İptal DENEME modunda: hiçbir bonus iptal edilmez.'); });
    GM_registerMenuCommand('Mod: Canlı (gerçekten iptal eder)', () => {
        if (!confirm('CANLI mod: 25.000 TL altı freespin kazançlarının bonusu GERÇEKTEN iptal edilecek.\n\nDiğer bot kapalı mı? Devam edilsin mi?')) return;
        GM_setValue('mode', 'live'); alert('Bonus İptal CANLI.');
    });
    GM_registerMenuCommand('Durum', () => {
        const last = Object.entries(book()).filter(([, v]) => v.result !== 'kurulumda mevcuttu')
            .sort((a, b) => b[1].at - a[1].at).slice(0, 10).map(([id, v]) => `${id}: ${v.result || `aranıyor (${v.tries || 0})`}`).join('\n');
        const s = GM_getValue('slackStatus', null);
        alert(`Mod: ${MODES[mode()]}\nSlack: ${s ? s.msg : 'hiç bağlanmadı'}\n\nSon kayıtlar:\n${last || '—'}`);
    });
    GM_registerMenuCommand('Teşhis: son platform bonusunu değerlendir', async () => {
        try {
            const [tx] = await fetchPlatformBonuses();
            if (!tx) { alert('Bugün platform bonus kaydı yok.'); return; }
            const m = matchBonus(await playerBonuses(tx.partyId), tx);
            alert([
                `Transaction ${tx.tranId} · Party ${tx.partyId} · ${tx.at} · ${money(tx.credit)} TL`,
                tx.credit < CONFIG.LIMIT ? 'Limit altı → iptal adayı' : 'Limit üstü → dokunulmaz',
                `Eşleşen bonus: ${m.pick ? `${m.pick.planName} #${m.pick.id} (${m.pick.status})` : m.already ? 'zaten iptal edilmiş' : m.ambiguous ? 'birden fazla!' : 'yok'}`,
                `Aynı kazançla açılmış adaylar: ${m.candidates.map(b => `${b.planName} #${b.id} ${b.status}`).join(', ') || '—'}`,
                '', 'İptal edilmedi, Slack\'e yazılmadı.',
            ].join('\n'));
        } catch (e) { alert('Teşhis hatası: ' + e.message); }
    });

    setInterval(tick, CONFIG.POLL_SEC * 1000);
    setTimeout(tick, 4000);
    log(`hazır. Mod: ${MODES[mode()]}`);
}

/* ════════════════════════════════════════════════════════════
   SLACK TARAFI (Otomatik Red ile aynı yöntem)
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
