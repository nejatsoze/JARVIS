// ==UserScript==
// @name         Finansal Rapor — 3 saatte bir Slack'e
// @namespace    palentis.finans-rapor
// @version      1.0.0
// @description  Panelin Overview rapor servisinden (reports-secundus) yatırım, çekim, net, GGR, NGR, oyun, oyuncu ve bekleyen çekim verilerini alıp TR saatiyle 00 (gün kapanışı), 06, 09, 12, 15, 18, 21'de Slack kanalına kart olarak gönderir. Tutarlar €, dolar karşılığı anlık kurla. Herhangi bir GT sekmesinin açık olması yeterli.
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
// @connect      api.coinbase.com
// @connect      open.er-api.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * VERİ
 *   POST https://reports-secundus.gmntc.com/api/v1/overview/{funds|activity|users|payments}
 *   Gövde {brandIds:[105], segmentIds:[0,1,2,3,6], fundIds:[1,2,3]} (Overview sayfasının varsayılanı),
 *   kimlik: Authorization: Bearer <GT oturum anahtarı> (konsol testiyle doğrulandı).
 *   Her metrik: TODAY, YESTERDAY, WTD, MTD, SPLM (geçen ayın aynı dönemi), MTD_TO_SPLM_PERCENT …
 *   Panelin günü UTC'dir (TR 03:00'te başlar); rakamlar paneldekiyle birebir aynı gösterilir.
 *
 * TAKVİM (TR saati, UTC+3): 00:00 gün kapanışı · 06 · 09 · 12 · 15 · 18 · 21.
 *   03:00 yok: panelin günü o saatte sıfırlandığı için rapor boş çıkardı.
 *   Saatinde tarayıcı kapalıysa GRACE_MIN içinde açılırsa gönderilir, daha geç ise o rapor atlanır.
 *
 * KUR: api.coinbase.com (anlık, anahtarsız); erişilemezse open.er-api.com (günlük).
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0C80H6L4CD',
    SLOTS_TR: [0, 6, 9, 12, 15, 18, 21],
    CLOSE_SLOT: 0,
    GRACE_MIN: 45,
    API: 'https://reports-secundus.gmntc.com/api/v1/overview',
    FILTER: { brandIds: [105], segmentIds: [0, 1, 2, 3, 6], fundIds: [1, 2, 3] },
};

const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Finansal Rapor]';
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

    /** GT oturum anahtarı: localStorage.sessionKey = {authType, key}; yedek service_auth_token. */
    function token() {
        try { const k = JSON.parse(localStorage.getItem('sessionKey') || 'null')?.key; if (k) return k; } catch { /* yok say */ }
        try {
            const raw = sessionStorage.getItem('service_auth_token');
            if (raw) { try { const p = JSON.parse(raw); return p?.external?.token || p?.token || (typeof p === 'string' ? p : null); } catch { return raw; } }
        } catch { /* yok say */ }
        return null;
    }

    async function report(path) {
        const t = token();
        if (!t) throw new Error('oturum anahtarı yok (GT\'ye giriş yapılmış mı?)');
        const res = await fetch(`${CONFIG.API}/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${t}` },
            body: JSON.stringify(CONFIG.FILTER),
        });
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return res.json();
    }

    function gmGet(url) {
        return new Promise((resolve, reject) => GM_xmlhttpRequest({
            method: 'GET', url, timeout: 10000, headers: { Accept: 'application/json' },
            onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
            onerror: () => reject(new Error('ağ hatası')), ontimeout: () => reject(new Error('zaman aşımı')),
        }));
    }
    /** EUR → USD. Önce Coinbase (anlık), olmazsa open.er-api (günlük). */
    async function eurUsd() {
        try {
            const j = await gmGet('https://api.coinbase.com/v2/exchange-rates?currency=EUR');
            const r = Number(j?.data?.rates?.USD);
            if (r > 0) return { rate: r, live: true };
        } catch (e) { warn('Coinbase kuru alınamadı:', e.message); }
        try {
            const j = await gmGet('https://open.er-api.com/v6/latest/EUR');
            const r = Number(j?.rates?.USD);
            if (r > 0) return { rate: r, live: false };
        } catch (e) { warn('yedek kur alınamadı:', e.message); }
        return null;
    }

    /* ── Biçim ── */
    const fmt = (n, d = 2) => Math.abs(Number(n) || 0).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
    const sign = (n) => (Number(n) < 0 ? '−' : '');
    const eur = (n) => `${sign(n)}${fmt(n)} €`;
    const usd = (n, fx) => `${sign(n)}${fmt((Number(n) || 0) * fx)} $`;
    const int = (n) => `${sign(n)}${Math.abs(Math.round(Number(n) || 0)).toLocaleString('tr-TR')}`;
    const pctOf = (p) => { const v = Number(p) || 0; return Math.abs(v) <= 1.5 ? v * 100 : v; };   // oran 0,02 ya da 2 gelebilir
    const pct = (p) => `%${pctOf(p).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;
    const delta = (p) => { const v = Math.round((Number(p) || 0) * 100); return `${v >= 0 ? '▲' : '▼'}${Math.abs(v)}%`; };
    const pad = (s, n) => String(s).padStart(n);

    /** TR saati (UTC+3, yaz saati yok). */
    const trNow = () => new Date(Date.now() + 3 * 3600e3);
    const trDate = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;

    async function buildReport(slotHour) {
        const [funds, activity, users, payments, fx] = await Promise.all([
            report('funds'), report('activity'),
            report('users').catch(e => { warn(e.message); return null; }),
            report('payments').catch(e => { warn(e.message); return null; }),
            eurUsd(),
        ]);
        const close = slotHour === CONFIG.CLOSE_SLOT;
        const now = trNow();
        // Kapanış 00:00'da gider ama biten günü anlatır → tarih bir gün geri
        const day = close ? new Date(now.getTime() - 3600e3) : now;
        const title = close ? `🌙 Gün Kapanışı · ${trDate(day)}`
            : `📊 Finansal Rapor · ${trDate(day)} · ${String(slotHour ?? now.getUTCHours()).padStart(2, '0')}:00`;
        const T = (o) => o?.TODAY;
        const f = (label, v, extra = '') => ({ type: 'mrkdwn', text: `*${label}*\n${eur(v)}${Number(v) < 0 ? ' 🔻' : ''}${extra}` });

        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: fx ? `1 € = ${fx.rate.toLocaleString('tr-TR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} $ (${fx.live ? 'anlık' : 'günlük kur'})` : 'Kur alınamadı — $ karşılıkları gösterilmiyor' }] },
            { type: 'divider' },
            { type: 'section', text: { type: 'mrkdwn', text: `*${close ? 'Günün sonucu' : 'Bugün'}*` } },
            { type: 'section', fields: [
                f('💰 Yatırım', T(funds.deposits)),
                f('💸 Çekim', T(funds.withdrawals)),
                f('⚖️ Net', T(funds.net)),
                f('🎰 GGR', T(activity.ggr), ` _(${pct(T(activity.ggrpercent))})_`),
                f('💎 NGR', T(activity.ngr)),
                { type: 'mrkdwn', text: `*🎲 Oyun*\n${int(T(activity.bets))} € bahis · ${int(T(activity.wins))} € kazanç\n${int(T(activity.games))} oyun` },
            ] },
        ];
        if (fx) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text:
            `💵 Yatırım ${usd(T(funds.deposits), fx.rate)} · Çekim ${usd(T(funds.withdrawals), fx.rate)} · Net ${usd(T(funds.net), fx.rate)} · GGR ${usd(T(activity.ggr), fx.rate)} · NGR ${usd(T(activity.ngr), fx.rate)}` }] });

        if (users || payments) {
            const fields = [];
            if (users) {
                fields.push({ type: 'mrkdwn', text: `*🆕 Yeni kayıt*\n${int(T(users.registrations))}\n_dün ${int(users.registrations?.YESTERDAY)}_` });
                fields.push({ type: 'mrkdwn', text: `*🥇 İlk yatırım (FTD)*\n${int(T(users.firstDepositors))}\n_dönüşüm ${pct(T(users.conversionRate))}_` });
                fields.push({ type: 'mrkdwn', text: `*🟢 Aktif oyuncu*\n${int(T(users.uniqueActiveUsers))}\n_dün ${int(users.uniqueActiveUsers?.YESTERDAY)}_` });
            }
            if (payments && payments.pendingWithdrawal != null) {
                fields.push({ type: 'mrkdwn', text: `*⏳ Bekleyen çekim*\n${eur(payments.pendingWithdrawal)}${fx ? `\n_${usd(payments.pendingWithdrawal, fx.rate)}_` : ''}` });
            }
            blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: '*Oyuncular ve kasa*' } }, { type: 'section', fields });
        }

        const rows = [['Yatırım', funds.deposits], ['Çekim', funds.withdrawals], ['Net', funds.net], ['GGR', activity.ggr], ['NGR', activity.ngr]];
        const table = [`${'(€)'.padEnd(9)}${pad('Dün', 9)}${pad('Hafta', 10)}${pad('Ay', 10)}${pad('Geçen ay*', 11)}${pad('Δ', 7)}`]
            .concat(rows.map(([n, r]) => `${n.padEnd(9)}${pad(int(r?.YESTERDAY), 9)}${pad(int(r?.WTD), 10)}${pad(int(r?.MTD), 10)}${pad(int(r?.SPLM), 11)}${pad(delta(r?.MTD_TO_SPLM_PERCENT), 7)}`))
            .join('\n');
        blocks.push(
            { type: 'divider' },
            { type: 'section', text: { type: 'mrkdwn', text: `*Dönemler*\n\`\`\`${table}\`\`\`` } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: '* geçen ayın aynı günlerine kadar · Δ: bu ay ile geçen ayın aynı dönemi' }] },
        );
        const text = `${title} — Yatırım ${eur(T(funds.deposits))} · Çekim ${eur(T(funds.withdrawals))} · Net ${eur(T(funds.net))}`;
        return { text, blocks };
    }

    function enqueue(key, payload) {
        GM_setValue('q:' + key, { ...payload, at: Date.now() });
        GM_setValue('ping', Date.now());
    }

    /* ── Takvim ── */
    /** Şu an hangi raporun zamanı? Saati geçmiş ve GRACE içinde olan, gönderilmemiş son dilim. */
    function dueSlot() {
        const now = trNow();
        const h = now.getUTCHours(), m = now.getUTCMinutes();
        const minutes = h * 60 + m;
        for (const s of [...CONFIG.SLOTS_TR].sort((a, b) => b - a)) {
            const diff = minutes - s * 60;
            if (diff >= 0 && diff <= CONFIG.GRACE_MIN) return { hour: s, key: `${trDate(now)}-${String(s).padStart(2, '0')}` };
        }
        return null;
    }

    let busy = false;
    async function tick() {
        if (busy || GM_getValue('enabled', true) === false) return;
        // Birden fazla GT sekmesi: tek lider
        const lead = GM_getValue('leader', null);
        if (lead && lead.owner !== ME && Date.now() - lead.at < 3 * 60000) return;
        GM_setValue('leader', { owner: ME, at: Date.now() });
        if (!token()) return;

        const slot = dueSlot();
        if (!slot) return;
        const sent = GM_getValue('sent', {});
        if (sent[slot.key]) return;
        busy = true;
        try {
            sent[slot.key] = Date.now();   // önce işaretle: iki sekme aynı raporu üretmesin
            for (const k of Object.keys(sent)) if (Date.now() - sent[k] > 7 * 864e5) delete sent[k];
            GM_setValue('sent', sent);
            const msg = await buildReport(slot.hour);
            enqueue(slot.key, msg);
            GM_setValue('lastReport', { key: slot.key, at: Date.now() });
            log('rapor kuyruğa alındı:', slot.key);
        } catch (e) {
            warn('rapor hazırlanamadı:', e.message);
            const s2 = GM_getValue('sent', {}); delete s2[slot.key]; GM_setValue('sent', s2);   // bir sonraki dakikada yeniden dene
            GM_setValue('lastError', { msg: e.message, at: Date.now() });
        } finally { busy = false; }
    }

    GM_registerMenuCommand('Raporu şimdi gönder', async () => {
        try {
            const msg = await buildReport(trNow().getUTCHours());
            enqueue('manual-' + Date.now(), msg);
            alert('Rapor kuyruğa alındı, Slack sekmesi gönderecek.');
        } catch (e) { alert('Rapor hazırlanamadı: ' + e.message); }
    });
    GM_registerMenuCommand('Otomatik raporu aç / kapat', () => {
        const on = GM_getValue('enabled', true) === false;
        GM_setValue('enabled', on);
        alert(`Otomatik rapor ${on ? 'AÇIK' : 'KAPALI'}.`);
    });
    GM_registerMenuCommand('Durum', () => {
        const last = GM_getValue('lastReport', null), err = GM_getValue('lastError', null), s = GM_getValue('slackStatus', null);
        const now = trNow(), minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
        const next = CONFIG.SLOTS_TR.find(h => h * 60 > minutes) ?? CONFIG.SLOTS_TR[0];
        alert([
            `Otomatik rapor: ${GM_getValue('enabled', true) === false ? 'KAPALI' : 'AÇIK'}`,
            `Sıradaki: ${String(next).padStart(2, '0')}:00 (TR)`,
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
    async function send(text, blocks) {
        const params = { channel: CONFIG.CHANNEL, text, unfurl_links: 'false', unfurl_media: 'false' };
        if (blocks) params.blocks = JSON.stringify(blocks);
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
            for (const [k, v] of items) {
                if (Date.now() - v.at > 6 * 3600e3) { GM_deleteValue(k); warn('eski rapor atıldı:', k); continue; }
                GM_setValue('slackLock', { owner: ME, at: Date.now() });
                await send(v.text, v.blocks);
                GM_deleteValue(k);
                status(`son gönderim ${k.slice(2)}`);
                await sleep(1200);
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
