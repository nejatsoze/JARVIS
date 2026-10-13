// ==UserScript==
// @name         Bonus İptal — 25.000 TL altı freespin kazancı
// @namespace    palentis.bonus-iptal
// @version      1.3.2
// @description  Transaction Report'taki yeni Platform Bonus (PLTFRM_BON) kayıtlarını izler; kazanç 25.000 TL'nin altındaysa Zumabet Hosgeldin Freesin'den gelen kazanç bonusunu (ör. Freespin Zuma) iptal eder; 25.000 TL ve üzerindeyse ayrıca tüm sağlayıcıları kısıtlar ve 2.000 TL çekilebilir bakiye ekler. Slack kanalına bildirir. Tampermonkey menüsünden Açık / Kapalı seçilir.
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
 *   2. Yeni PLTFRM_BON satırı (Transaction ID ile) için oyuncunun bonus listesinde
 *      (GET /ics/player-bonus/{party}) işlem saatinde açılmış kazanç bonusu (ör. "Freespin Zuma",
 *      tutarı = kazanç) aranır. Yalnızca oyuncunun ondan önceki LOOKBACK_H saat içinde bir
 *      TARGET_PLANS (deneme) bonusu varsa (durumu fark etmez, genelde "Spent") ve kazanç bonusu
 *      iptal edilebilir durumdaysa (Active / Queued / Spent Active / Pending) iptal edilir.
 *      Deneme bonusu yoksa hiçbir mesaj gitmez, sadece Durum/konsola yazılır.
 *   3. DELETE /ics/player-bonus/{bonusId} (panelin Cancel butonunun isteği),
 *      ardından listeden durumunun Canceled olduğu doğrulanır ve Slack'e mesaj gider.
 *   4. Credit >= LIMIT (25.000) ise ayrıca: GET/PUT /ics/player-lock-provider/{party} ile tüm
 *      sağlayıcılar kısıtlanır, POST /ics/accounts/adjustments ile "Çekilebilir Deneme Bonusu"
 *      notuyla 2.000 TL MAN_ADJUST eklenir (staffId oturum JWT'sinden). Çift ödeme kalkanı:
 *      bot kaydı + son 30 günde aynı tutarda MAN_ADJUST kontrolü.
 *
 * GÜVENLİK
 *   · Eşleşen bonus tek ve kesin değilse iptal yok.
 *   · Bonus zaten iptal edilmişse (diğer bot) sessizce geçilir.
 *   · İlk çalışmada listede zaten olan kayıtlar "görüldü" sayılır, işlenmez.
 *   · Birden fazla GT sekmesi açıksa yalnızca biri çalışır.
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0C0N8PP37U',
    POLL_SEC: 30,
    LIMIT: 25000,                         // altı: iptal + mesaj · üstü (dahil): iptal + tüm sağlayıcı kısıtı + 2.000 TL
    PAYOUT: 2000,                         // limit üstünde eklenen çekilebilir tutar
    PAYOUT_NOTE: 'Çekilebilir Deneme Bonusu',
    TARGET_PLANS: ['Zumabet Hosgeldin Freesin'],   // deneme bonusu planı (kazancından açılan bonus iptal edilir)
    LOOKBACK_H: 24,                       // bonus, platform bonusundan en fazla bu kadar saat önce açılmış olmalı
    MATCH_MIN: 5,                         // saat farkı payı (dk)
    FIND_RETRY: 4,                        // bonus henüz görünmüyorsa kaç tur daha aransın
};

const CANCELLABLE = ['ACTIVE', 'QUEUED', 'SPENT ACTIVE', 'PENDING'];   // panelin isCancellableBonus listesi
const MESSAGE_WIN = (x) => `Deneme Bonusu freespinleri ile bakiyenizi 25.000 TL ve üzerine ulaştırdığınız için 2.000 TL çekilebilir bakiye hesabınıza eklenmiştir. Bonus kazancınız: ${x} TL`;
const MESSAGE = (x) => `Deneme Bonusu freespinleri ile bakiyenizi 25.000 TL ve üzerine ulaştırabilirseniz 2.000 TL çekim yapabilirsiniz. Bonus kazancınız: ${x} TL olduğu için bonus iptal edilmiştir.`;

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Bonus İptal]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MODES = { off: 'Kapalı', live: 'Açık' };
const mode = () => GM_getValue('mode', 'live') === 'off' ? 'off' : 'live';   // deneme modu kaldırıldı: eski 'dry' kaydı = Açık

// Mod ve Durum her iki sitede de menüde (Teşhis yalnız GT'de)
GM_registerMenuCommand('Mod: Kapalı', () => { GM_setValue('mode', 'off'); alert('Bonus İptal KAPALI.'); });
GM_registerMenuCommand('Mod: Açık', () => { GM_setValue('mode', 'live'); alert('Bonus İptal AÇIK.'); });
GM_registerMenuCommand('Durum', () => {
    const rows = Object.entries(GM_getValue('book', {})).filter(([, v]) => v.result !== 'kurulumda mevcuttu').sort((a, b) => b[1].at - a[1].at);
    const party = (v) => ` · party ${v.party || '?'}`;
    const last = rows.slice(0, 10).map(([id, v]) => `${id}${party(v)}: ${v.result || `aranıyor (${v.tries || 0})`}`).join('\n');
    // Deneme bonusu var ama kazanç bonusu iptal edilebilir durumda değil (panelde Cancel çıkmıyor, ör. Spent)
    const spent = rows.filter(([, v]) => v.spent).slice(0, 15).map(([id, v]) => `${v.party} (işlem ${id}): ${v.spent}`).join('\n');
    const s = GM_getValue('slackStatus', null);
    alert(`Mod: ${MODES[mode()]}\nSlack: ${s ? s.msg : 'hiç bağlanmadı'}\n\nSon kayıtlar:\n${last || '—'}\n\nİptal edilemeyen (Spent vb.) — party ID:\n${spent || '—'}`);
});

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
    async function ics(path, params = {}, method = 'GET', body) {
        const t = need();
        const url = `${HOST}/ics/${path}?${new URLSearchParams({ sessionKey: t, uType: 'staff', ...params })}`;
        const headers = { Accept: 'application/json', Authorization: `Bearer ${t}` };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(url, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
    /** Kural: freespin kazancı (PLTFRM_BON) oyuncuya ayrı bir bonus olarak düşer (ör. "Freespin Zuma"; açılış saati =
     *  işlem saati, tutar = kazanç). İptal edilen bu kazanç bonusudur — yalnızca oyuncunun ondan önce LOOKBACK_H içinde
     *  açılmış bir TARGET_PLANS (deneme) bonusu varsa (durumu fark etmez, genelde "Spent").
     *  { pick, already, ambiguous, candidates (deneme bonusları), wins (kazanç bonusu adayları) } */
    function matchBonus(list, tx) {
        const t = stamp(tx.at);
        const pad = CONFIG.MATCH_MIN * 60000;
        const plan = (b) => CONFIG.TARGET_PLANS.some(p => String(b.planName || '').trim().toLowerCase() === p.toLowerCase());
        const bt = (b) => stamp(b.triggerDate);
        const amt = (b) => { for (const k of ['amount', 'bonusAmount', 'initialAmount']) { const v = num(b[k]); if (Number.isFinite(v) && v > 0) return v; } return NaN; };
        const trial = list.filter(b => plan(b) && Number.isFinite(t) && bt(b) <= t + pad && bt(b) >= t - CONFIG.LOOKBACK_H * 3600e3 - pad);
        let wins = list.filter(b => !plan(b) && Number.isFinite(t) && Math.abs(bt(b) - t) <= pad);
        // Tutar okunabiliyorsa kazançla aynı olanlar (aynı dakikada başka bonus açılmışsa ayırt eder)
        const same = wins.filter(b => Math.abs(amt(b) - tx.credit) < 0.01);
        if (same.length) wins = same;
        const open = trial.length ? wins.filter(b => CANCELLABLE.includes(String(b.status || '').toUpperCase())) : [];
        return {
            pick: open.length === 1 ? open[0] : null,
            ambiguous: open.length > 1,
            already: !!trial.length && !open.length && wins.some(b => /cancel/i.test(b.status)),
            candidates: trial,
            wins,
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

    /* ── Limit üstü: sağlayıcı kısıtı ve 2.000 TL (panelin kendi istekleri, konsol kaydıyla doğrulandı) ── */

    /** Oturumdaki personel no (JWT içindeki staffid) — düzeltme kaydı bu kişi adına düşer. */
    function staffId() {
        try {
            const b64 = String(need()).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const p = JSON.parse(decodeURIComponent(escape(atob(b64))));
            const id = Number(p.staffid ?? p.staffId ?? p.id);
            return Number.isFinite(id) && id > 0 ? id : null;
        } catch { return null; }
    }

    /** Tüm sağlayıcıları kısıtla: GET kilit kaydı (kısıtlı + açık), PUT ile hepsini kısıtlı yap, sonra doğrula. */
    async function lockAllProviders(pid) {
        const cur = await ics(`player-lock-provider/${pid}`);
        const all = [...(cur?.lockedProviders || []), ...(cur?.nonLockedProviders || [])]
            .map(p => ({ providerId: p.providerId, providerName: p.providerName }))
            .filter((p, i, a) => p.providerId != null && a.findIndex(q => q.providerId === p.providerId) === i);
        if (!all.length) throw new Error('sağlayıcı listesi boş geldi');
        if (!(cur.nonLockedProviders || []).length) return { count: all.length, already: true };
        await ics(`player-lock-provider/${pid}`, {}, 'PUT', { lockedProviders: all });
        const after = await ics(`player-lock-provider/${pid}`);
        if ((after?.nonLockedProviders || []).length) throw new Error(`kısıt sonrası ${after.nonLockedProviders.length} sağlayıcı hâlâ açık`);
        return { count: all.length, already: false };
    }

    /** Bu oyuncuya son 30 günde aynı tutarda manuel düzeltme yapılmış mı? (çift ödeme kalkanı) */
    async function alreadyPaid(pid) {
        const pad2 = (n) => String(n).padStart(2, '0');
        const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        const from = new Date(Date.now() - 30 * 864e5), to = new Date(Date.now() + 864e5);
        const rows = asList(await ics('player-transactions/page', {
            partyid: pid, startDate: `${ymd(from)} 0:0:0.000`, endDate: `${ymd(to)} 23:59:0.000`,
            pageSize: 200, pageNum: 1, tranTypes: 'MAN_ADJUST', currency: 'TRY',
        }));
        return rows.some(r => r.tranType === 'MAN_ADJUST' && Math.abs((+r.credit || +r.amount || 0) - CONFIG.PAYOUT) < 0.01);
    }

    async function addPayout(pid) {
        const sid = staffId();
        if (!sid) throw new Error('personel no (staffid) oturumdan okunamadı');
        const r = await ics('accounts/adjustments', {}, 'POST', {
            partyId: Number(pid), staffId: sid, tranType: 'MAN_ADJUST', amount: CONFIG.PAYOUT.toFixed(2),
            comment: CONFIG.PAYOUT_NOTE, tranTag: 0, tranMethod: null, subType: null, triggerBonus: null,
        });
        if (r && typeof r === 'object' && r.status && !/^(OK|SUCCESS)$/i.test(r.status)) throw new Error(`panel yanıtı: ${r.status}${r.message ? ' — ' + r.message : ''}`);
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
        if (!entry?.party) setBook(tx.tranId, { party: tx.partyId });
        if (!Number.isFinite(tx.credit)) { setBook(tx.tranId, { final: true, result: 'tutar okunamadı' }); return; }
        const over = tx.credit >= CONFIG.LIMIT;   // limit üstü: iptal + kısıt + 2.000 TL

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
            const seen = `deneme: ${m.candidates.map(b => `#${b.id} ${b.status}`).join(', ') || 'yok'} · kazanç bonusu: ${m.wins.map(b => `#${b.id} ${b.status}`).join(', ') || 'yok'}`;
            const spent = m.candidates.length && m.wins.length ? m.wins.map(b => `${b.planName} #${b.id} ${b.status}`).join(', ') : undefined;
            setBook(tx.tranId, { final: true, result: `iptal edilebilir bonus yok (${seen})`, spent });
            // Deneme bonusu değil (ya da artık iptal edilemez): Slack'e bir şey gitmez, sadece defter + konsol
            log(`${tx.tranId}: iptal edilebilir bonus bulunamadı`, m.candidates);
            return;
        }

        const x = money(tx.credit);
        const info = `${m.pick.planName} #${m.pick.id}`;
        if (over) return payoutFlow(tx, m.pick, x, info);
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

    /** Limit üstü akış. Sıra: çift ödeme kontrolü → bonus iptali → tüm sağlayıcı kısıtı → 2.000 TL.
     *  Bir adım başarısız olursa sonrakiler yapılmaz, Slack'e hangi adımların yapıldığı yazılır. */
    async function payoutFlow(tx, bonus, x, info) {
        const pid = tx.partyId;
        const paidBook = GM_getValue('paid', {});
        const done = [];
        try {
            if (paidBook[pid]) throw new Error('bu oyuncuya daha önce ödeme yapılmış (bot kaydı)');
            if (await alreadyPaid(pid)) throw new Error(`son 30 günde ${money(CONFIG.PAYOUT)} TL manuel düzeltme zaten var`);

            await cancelBonus(pid, bonus.id);
            done.push('bonus iptal');

            const lock = await lockAllProviders(pid);
            done.push(lock.already ? 'sağlayıcılar zaten kısıtlı' : `${lock.count} sağlayıcı kısıtlandı`);

            // Kayıt POST'tan ÖNCE: istek gidip yanıt kaybolsa bile ikinci kez ödeme yapılmaz
            paidBook[pid] = Date.now();
            GM_setValue('paid', paidBook);
            await addPayout(pid);
            done.push(`+${money(CONFIG.PAYOUT)} TL eklendi`);

            enqueue(tx.tranId, `${MESSAGE_WIN(x)}
ID: ${pid}`);
            setBook(tx.tranId, { final: true, result: `limit üstü: ${done.join(', ')}` });
            log(`${tx.tranId}: limit üstü tamam → ${done.join(', ')}`);
        } catch (e) {
            setBook(tx.tranId, { final: true, result: `limit üstü yarım kaldı (${done.join(', ') || 'hiçbir adım'}): ${e.message}` });
            enqueue(tx.tranId + '-err', `:warning: Deneme bonusu (limit üstü) işlemi tamamlanamadı — ${esc(e.message)}
Yapılanlar: ${esc(done.join(', ') || 'hiçbiri')}
Kazanç: ${x} TL
ID: ${pid}`);
            warn(`${tx.tranId}: limit üstü akış durdu`, done, e);
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
            // Party ID'si kaydedilmemiş eski kayıtları rapordan tamamla (Durum listesi için)
            const bk = book(); let fill = false;
            for (const tx of txs) if (bk[tx.tranId] && !bk[tx.tranId].party) { bk[tx.tranId].party = tx.partyId; fill = true; }
            if (fill) GM_setValue('book', bk);
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

    GM_registerMenuCommand('Teşhis: son platform bonusunu değerlendir / işle', async () => {
        try {
            const [tx] = await fetchPlatformBonuses();
            if (!tx) { alert('Bugün platform bonus kaydı yok.'); return; }
            const m = matchBonus(await playerBonuses(tx.partyId), tx);
            const rec = book()[tx.tranId];
            const lines = [
                `Transaction ${tx.tranId} · Party ${tx.partyId} · ${tx.at} · ${money(tx.credit)} TL`,
                tx.credit < CONFIG.LIMIT ? 'Limit altı → bonus iptali + mesaj' : `Limit üstü → bonus iptali + tüm sağlayıcı kısıtı + ${money(CONFIG.PAYOUT)} TL`,
                `Personel no (oturum): ${staffId() ?? 'OKUNAMADI'}`,
                `Eşleşen bonus: ${m.pick ? `${m.pick.planName} #${m.pick.id} (${m.pick.status})` : m.already ? 'zaten iptal edilmiş' : m.ambiguous ? 'birden fazla!' : 'yok'}`,
                `Son ${CONFIG.LOOKBACK_H} saatteki ${CONFIG.TARGET_PLANS.join('/')} bonusları: ${m.candidates.map(b => `${b.planName} #${b.id} ${b.status}`).join(', ') || '—'}`,
                `İşlem saatinde açılan kazanç bonusu: ${m.wins.map(b => `${b.planName} #${b.id} ${b.status}`).join(', ') || '—'}`,
                `Bot kaydı: ${rec ? (rec.result || `aranıyor (${rec.tries || 0})`) : 'henüz işlenmedi'}`,
                `Mod: ${MODES[mode()]}`,
            ];
            if (!m.pick || mode() === 'off') { alert([...lines, '', 'Teşhis yalnızca değerlendirir: iptal edilmedi, Slack\'e yazılmadı.'].join('\n')); return; }
            const what = `${m.pick.planName} #${m.pick.id} iptal edilip Slack'e yazılsın mı?`;
            if (!confirm([...lines, '', `Bu işlem şimdi işlensin mi? ${what}`].join('\n'))) return;
            while (busy) await sleep(500);
            busy = true;
            try {
                const b = book(); delete b[tx.tranId]; GM_setValue('book', b);
                await handle(tx);
            } finally { busy = false; }
            alert(`Sonuç: ${book()[tx.tranId]?.result || 'işlenemedi'}`);
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
    /** Aynı işlem için daha önce mesaj gittiyse (ör. Teşhis'ten yeniden işlenince) yenisi atılmaz, eskisi güncellenir. */
    async function send(text, prev) {
        for (let i = 0; i < 4; i++) {
            const r = prev
                ? await call('chat.update', { channel: CONFIG.CHANNEL, ts: prev, text })
                : await call('chat.postMessage', { channel: CONFIG.CHANNEL, text, unfurl_links: 'false', unfurl_media: 'false' });
            if (!r.ok && prev && /message_not_found|cant_update_message|edit_window_closed/.test(r.error)) { prev = null; continue; }
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
                const sent = GM_getValue('sent', {});
                const id = k.slice(2);
                const r = await send(v.text, sent[id]?.ts);
                const week = Date.now() - 7 * 864e5;
                for (const x of Object.keys(sent)) if (sent[x].at < week) delete sent[x];
                sent[id] = { ts: r.ts || sent[id]?.ts, at: Date.now() };
                GM_setValue('sent', sent);
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
