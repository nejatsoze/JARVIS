// ==UserScript==
// @name         Slack Çekim Bildirimi
// @namespace    palentis.slack-cekim
// @version      1.1.0
// @description  Pending Withdrawals listesine yeni bir çekim düşünce Party ID, çekim tutarı/yöntemi, son yatırım tutarı/yöntemi ve son yatırımdan bu yana max bakiyeyi Slack kanalına (şu an test kanalı C0C80H6L4CD) senin adınla gönderir; talep onaylanınca mesaja ✅, reddedilince ❌ tepkisi ve red sebebini thread cevabı olarak ekler. Mesajı açık Slack sekmesi atar; iki sekme Tampermonkey deposu üzerinden haberleşir. Webhook / n8n gerekmez.
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
    CHANNEL: 'C0C80H6L4CD',     // test kanalı; asıl kanal C0BMBT1A6KX şimdilik kapalı (geri almak için buraya yaz)
    POLL_SEC: 30,              // arka plan liste yoklaması; 0 = kapalı (sadece sayfadaki tablo)
    MAX_AGE_MIN: 180,          // bundan eski talepler bildirilmez (tarayıcı uzun süre kapalı kaldıysa yığın gitmesin)
    DEPOSIT_DAYS: 90,          // son yatırım bu kadar gün geriye aranır
    TX_PAGE_SIZE: 500,        // GT Player kartında doğrulanmış boyut
    TX_MAX_PAGES: 40,
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
                userId: col(row, 'USER ID'),
                vip: col(row, 'VIP LEVEL'),
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

    /** player-transactions/page tür listesi olmadan 400 döner; Transaction History sayfasının gönderdiği tam liste. */
    const ALL_TRAN_TYPES = ['AUTO_CHAR', 'BONUS_REL', 'CANC_BONUS', 'CASH_OUT', 'CHARGE_BCK', 'CHAT_BONUS', 'COMMISSION',
        'CRE_BONUS', 'DEPOSIT', 'END_GAME', 'EXP_BONUS', 'GAME_ADJ', 'GAME_BET', 'GAME_PLAY', 'GAME_WIN', 'GAME_TAX',
        'LOYALTY_AD', 'LP_BUY', 'LP_CONVERT', 'MAN_ADJUST', 'MAN_BONUS', 'P_DEPOSIT', 'P_WITHDRAW', 'PAYMNT_FEE',
        'PRODUC_BON', 'PLTFRM_BON', 'REFUND', 'ROLLBACK', 'STAKE_DEC', 'TIPS', 'TOURN_WIN', 'TRANSF_IN', 'TXFER_IN2',
        'TRANSF_OUT', 'TXFER_OUT2', 'TRANSF_RB', 'WD_CANCEL', 'WD_REJECT', 'WITHDRAWAL', 'MACHIN_EFT', 'SYSTEM_EFT',
        'RESERVE', 'RSV_COMMIT', 'RSV_CANCEL', 'FRBET_STK', 'DP_RBACK', 'WD_RBACK', 'CORRECTION', 'DP_FAIL',
        'DP_CANCEL', 'CASHBACK', 'CRE_CB'].join(', ');

    /** Son PLTFRM_BON işleminin zamanı (yatırımı olmayan oyuncuda max bakiye buradan başlar). */
    async function lastPlatformBonus(pid) {
        const rows = asList(await ics('player-transactions/page', {
            partyid: pid, startDate: `${ymd(dayOffset(-CONFIG.DEPOSIT_DAYS))} 0:0:0.000`, endDate: `${ymd(dayOffset(1))} 23:59:0.000`,
            pageSize: 500, pageNum: 1, tranTypes: 'PLTFRM_BON', currency: 'TRY',
        }));
        const t = rows.filter(r => r.tranType === 'PLTFRM_BON' && r.datetime).map(r => +r.datetime);
        return t.length ? Math.max(...t) : null;
    }

    /** Son yatırımdan (yoksa son PLTFRM_BON'dan) bu yana işlem sonrası toplam bakiyenin en yüksek olduğu işlem. */
    async function maxBalanceSince(pid, since) {
        const from = new Date(since); from.setDate(from.getDate() - 1);
        const SLACK_MS = 2 * 60000; // yatırım kaydı ile işlem kaydı saniyeler farkla düşebiliyor
        let best = null, pages = 0, turnover = 0, bigWin = null;
        for (let page = 1; page <= CONFIG.TX_MAX_PAGES; page++) {
            const rows = asList(await ics('player-transactions/page', {
                partyid: pid, startDate: `${ymd(from)} 0:0:0.000`, endDate: `${ymd(dayOffset(1))} 23:59:0.000`,
                pageSize: CONFIG.TX_PAGE_SIZE, pageNum: page, tranTypes: ALL_TRAN_TYPES, currency: 'TRY',
            }));
            pages = page;
            for (const r of rows) {
                if (r.datetime && r.datetime < since - SLACK_MS) continue;
                if (r.tranType === 'GAME_BET') turnover += Math.abs(+r.debit || +r.amount || 0);
                if (r.tranType === 'GAME_WIN') {
                    const w = Math.abs(+r.credit || +r.amount || 0);
                    if (w && (!bigWin || w > bigWin.amount)) bigWin = { amount: w, game: r.gameName || r.gameDescription || r.game || r.platformName || '' };
                }
                const bal = r.balance != null ? +r.balance : (+r.balanceReal || 0) + (+r.balancePlayableBonus || 0);
                if (!Number.isFinite(bal)) continue;
                if (!best || bal > best.bal) best = { bal, id: r.tranId ?? r.transactionId ?? r.id ?? r.gameTranId ?? '' };
            }
            if (rows.length < CONFIG.TX_PAGE_SIZE) break;
        }
        if (pages === CONFIG.TX_MAX_PAGES) warn(`max bakiye: ${pid} için ${pages} sayfa sınırına gelindi, sonuç eksik olabilir`);
        return best && { ...best, turnover, bigWin };
    }

    /* ── Kart için ek oyuncu verisi (hepsi isteğe bağlı: okunamazsa alan "—" olur) ── */
    async function playerName(pid) {
        const d = await ics(`players/${pid}/full-profile`);
        return [d?.firstName, d?.lastName].filter(Boolean).join(' ').trim() || null;
    }
    async function kycOf(pid) {
        const v = (await ics(`players/${pid}/detail`))?.kycStatus;
        return typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : null;
    }
    /** Ömür boyu (LTD) yatırım / çekim toplamı — GT Player Accounting panelinin kaynağı. */
    async function lifetime(pid) {
        const list = asList(await ics(`players/${pid}/financial/deposits-and-withdrawals`));
        let dep = 0, wd = 0, seen = false;
        for (const r of list) {
            if (String(r.period || '').toUpperCase() !== 'LTD') continue;
            seen = true;
            const t = String(r.tranType || '').toLowerCase();
            if (t.startsWith('dep')) dep += Number(r.amount) || 0;
            else if (t.startsWith('with')) wd += Number(r.amount) || 0;
        }
        return seen || !list.length ? { dep, wd } : null;
    }
    /** Bu talep dışındaki son başarılı çekim (oyuncu çekim geçmişi, son 60 gün). */
    async function lastWithdrawal(pid, exceptId) {
        const t = token();
        if (!t) throw new Error('oturum token yok');
        const pad2 = (n) => String(n).padStart(2, '0');
        const dmy = (d) => `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
        const url = `${HOST}/j/player/PlayerWithdrawals.action?${new URLSearchParams({ embeddedInNewDashboard: 'true', cmslanguage: 'en', token: t,
            partyId: pid, startDate: dmy(dayOffset(-60)), endDate: dmy(dayOffset(1)), execute: 'Go' })}`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const table = doc.querySelector('#withdrawals');
        if (!table) return null;
        const rows = [...table.rows];
        const head = rows.find(r => /PROCESS DATE/i.test(clean(r)) && /PAYMENT STATUS/i.test(clean(r)));
        if (!head) return null;
        const cols = {};
        [...head.cells].forEach((c, i) => { cols[clean(c).toUpperCase()] = i; });
        let best = null;
        for (const r of rows) {
            if (r === head || r.cells.length < head.cells.length) continue;
            if (clean(r.cells[cols['PAYMENT ID']]) === String(exceptId)) continue;
            // Durum hücresinde gizli "xxx_yyy" kodları var: sadece kod olmayan parçalar
            const words = [];
            const w = doc.createTreeWalker(r.cells[cols['PAYMENT STATUS']], NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n; n = w.nextNode()) for (const x of n.nodeValue.split(/\s+/)) if (x && !x.includes('_')) words.push(x);
            if (!/complet|approv|success|paid/i.test(words.join(' '))) continue;
            const at = reqDate(clean(r.cells[cols['PROCESS DATE']]));
            if (at && (!best || at > best.at)) best = { at, amount: num(clean(r.cells[cols['AMOUNT']])) };
        }
        return best;
    }

    /** "iSettle V2 Havale 55 (HMN PAYS)" → "HMN PAYS" */
    const shortMethod = (m) => (String(m || '').match(/\(([^()]+)\)\s*$/)?.[1] || String(m || '')).trim();
    function since(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '';
        const min = Math.round(ms / 60000);
        if (min < 60) return `${min} dk`;
        if (min < 24 * 60) return `${Math.floor(min / 60)} sa ${min % 60} dk`;
        return `${Math.floor(min / 1440)} gün`;
    }
    const tl = (n) => `${money(n)} TL`;
    const short = (n) => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: 0 });
    const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${short(Math.abs(n))}`;
    const warnIf = (n) => (n > 0 ? ' ⚠️' : '');

    /** Mesaj kartı (Block Kit, "B · iki sütunlu kart"). Son blok durum satırıdır; sonuç gelince chat.update ile değişir. */
    async function buildMessage(it) {
        const settle = (p) => p.then(v => v, e => { warn(e.message); return undefined; });
        const pid = it.partyId;
        const [name, kyc, life, lastWd, dupes, dep0] = await Promise.all([
            settle(playerName(pid)), settle(kycOf(pid)), settle(lifetime(pid)),
            settle(lastWithdrawal(pid, it.paymentid)), duplicateCounts(pid), settle(lastDeposit(pid)),
        ]);
        let dep = dep0;   // undefined = okunamadı, null = yok

        let start = dep ? depositTime(dep) : null;
        if (!start && dep === null) {
            try { start = await lastPlatformBonus(pid); }
            catch (e) { warn('PLTFRM_BON alınamadı:', e.message); }
        }
        let max = null;
        if (start) {
            try { max = await maxBalanceSince(pid, start); }
            catch (e) { warn('max bakiye alınamadı:', e.message); }
        }

        const amount = Number.isFinite(it.amount) ? it.amount : null;
        const reqAt = it.requestedAt ? it.requestedAt.getTime() : Date.now();
        const head = `${amount > 100000 ? '🔴🔴' : '🟡'} Yeni Çekim Talebi · ${amount !== null ? `${money(amount)} ${cur(it.currency)}` : '?'}`;
        const link = `${HOST}/core/app/core/players/${pid}/detail`;
        const kycTxt = kyc === 'PASS' ? 'KYC *PASS* ✅' : kyc ? `KYC *${esc(kyc)}* ⛔` : 'KYC _?_';
        const [ip, nm] = dupes;
        const field = (label, body) => ({ type: 'mrkdwn', text: `*${label}*\n${body}` });

        const depBody = dep
            ? `${tl(dep.amount)}${dep.methodName ? ` · _${esc(shortMethod(dep.methodName))}_` : ''}`
                + (depositTime(dep) ? `\n${since(reqAt - depositTime(dep))} önce` : '')
            : `_${dep === undefined ? 'alınamadı' : `son ${CONFIG.DEPOSIT_DAYS} günde yok`}_`;
        const depAmt = dep ? Number(dep.amount) || 0 : 0;
        const turnBody = max && depAmt ? `${short(max.turnover)} TL · *${(max.turnover / depAmt).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}x*`
            : max ? `${short(max.turnover)} TL` : '_—_';
        const winBody = max?.bigWin ? `${short(max.bigWin.amount)} TL${max.bigWin.game ? `\n_${esc(max.bigWin.game)}_` : ''}` : '_—_';
        const lastBody = lastWd ? `${since(Date.now() - lastWd.at.getTime())} önce${Number.isFinite(lastWd.amount) ? ` · ${short(lastWd.amount)} TL` : ''}` : '_yok_';
        const lifeBody = life ? `Yatırım ${short(life.dep)} · Çekim ${short(life.wd)}\nNet *${signed(life.dep - life.wd)}*` : '_—_';
        const matchBody = `IP ${ip ?? '?'}${warnIf(ip)} · Ad-Soyad ${nm ?? '?'}${warnIf(nm)}`;

        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: head, emoji: true } },
            { type: 'section', text: { type: 'mrkdwn', text: `👤 *<${link}|${esc(name || 'İsim alınamadı')}>* · \`${pid}\`\n${it.vip ? `VIP ${esc(it.vip)} · ` : ''}${kycTxt}` } },
            { type: 'divider' },
            { type: 'section', fields: [
                field('💸 Çekim', `${amount !== null ? tl(amount) : '?'}${it.method ? ` · _${esc(shortMethod(it.method))}_` : ''}`),
                field('💰 Son yatırım', depBody),
                field('📈 Max bakiye', max ? `${tl(max.bal)}${max.id ? `\n\`${max.id}\`` : ''}` : '_hesaplanamadı_'),
                field('🎰 Çevrim', turnBody),
                field('🏆 En büyük kazanç', winBody),
                field('⏮️ Son çekim', lastBody),
                field('🧾 Toplam', lifeBody),
                field('🔎 Eşleşmeler', matchBody),
            ] },
            { type: 'divider' },
            { type: 'section', text: { type: 'mrkdwn', text: '⏳ _Bekliyor_' } },
        ];
        const text = `${head} — ${name || pid}`;   // bildirim / arama için düz metin
        return { text, blocks };
    }

    /* ── IP / NAME taraması: GT Player'daki IP rozeti ve NAME butonuyla aynı arama ── */
    async function duplicateRows(pid, criteria) {
        const t = token();
        if (!t) throw new Error('oturum token yok');
        const url = `${HOST}/j/player/PlayerDuplicates.action?${new URLSearchParams({
            embeddedInNewDashboard: 'true', cmslanguage: 'en', token: t,
            partyId: pid, matchingItems: '1', execute: 'Search Duplicates', ...criteria })}`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const seen = new Set(), out = [];
        for (const row of doc.querySelectorAll('tbody tr')) {
            const c = row.querySelectorAll('td');
            if (c.length < 5) continue;
            const id = clean(c[2]);
            if (!/^\d{8}$/.test(id) || seen.has(id)) continue;
            seen.add(id);
            out.push({ id, first: clean(c[3]), last: clean(c[4]) });
        }
        return out;
    }
    /** "İbrahim Çağlar" ile "ibrahim caglar" aynı isim sayılsın. */
    const normName = (s) => String(s || '').toLocaleLowerCase('tr-TR')
        .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

    /** Oyuncunun kendisi hariç (n-1): aynı IP'deki ve aynı ad-soyadlı hesap sayısı. Hata → null. */
    async function duplicateCounts(pid) {
        const me = String(pid);
        const ip = duplicateRows(pid, { checkIp: 'true' })
            .then(rows => rows.filter(r => r.id !== me).length)
            .catch(e => { warn('IP taraması alınamadı:', e.message); return null; });
        const name = duplicateRows(pid, { checkFirstName: 'true', checkLastName: 'true' })
            .then(all => {
                const self = all.find(r => r.id === me);
                if (!self) return 0;   // kendisi bile listede yoksa eşleşen başka hesap da yok
                const [f, l] = [normName(self.first), normName(self.last)];
                return all.filter(r => r.id !== me && normName(r.first) === f && normName(r.last) === l).length;
            })
            .catch(e => { warn('NAME taraması alınamadı:', e.message); return null; });
        return Promise.all([ip, name]);
    }

    /** Mesajı kuyruğa koy; Slack sekmesi alıp gönderir. pid: hangi talebin mesajı (red cevabı bu mesaja thread olur). */
    function enqueue(key, text, extra = {}) {
        GM_setValue('q:' + key, { text, at: Date.now(), ...extra });
        GM_setValue('ping', Date.now());
    }

    /* ── Red sebebi → talebin Slack mesajına thread cevabı ──
       Gruba mesajı atılan her talep izlenir (watch:<id>). Talep bekleyen listeden
       düşünce — kim işlemiş olursa olsun — durumu sunucudan okunur:
         · ProcessWithdrawal.action           → "Payment Status Rejected"
         · ProcessWithdrawal.action&details=1 → red sebebi (GT Withdrawals'taki
           Details ipucunun okuduğu "KOD: mesaj | … | status=…&message=…" satırı)
       Reddedildiyse sebep thread cevabı olarak gider; onaylandıysa bir şey gitmez.
       Sunucuda sebep okunamazsa bu tarayıcıda yakalanan sebep (hızlı red / OTORED
       olayı ya da formdaki Reject) yedek olarak kullanılır. */
    const WATCH_TTL = 24 * 3600e3;

    function watch(it) {
        GM_setValue('watch:' + it.paymentid, { partyId: it.partyId, at: Date.now(), req: it.requestedAt ? it.requestedAt.getTime() : Date.now(), checked: 0 });
    }

    window.addEventListener('gt-wd-rejected', (e) => {
        let d; try { d = JSON.parse(e.detail); } catch { return; }
        if (d?.paymentid && d.reason) GM_setValue('rj:' + d.paymentid, { reason: String(d.reason), at: Date.now() });
    });
    document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('input[type="submit"], button');
        const form = btn?.form;
        const pid = form?.querySelector('[name="paymentid"]')?.value;
        if (!pid || !form.querySelector('[name="reject_reason"]')) return;
        if (btn.name !== 'reject') { GM_deleteValue('rj:' + pid); return; }
        const reason = form.querySelector('[name="reject_reason"]').value.trim();
        if (reason) GM_setValue('rj:' + pid, { reason, at: Date.now() });
    }, true);

    async function page(pid, partyId, details) {
        const url = `${HOST}/j/ProcessWithdrawal.action?embeddedInNewDashboard=true&paymentid=${encodeURIComponent(pid)}`
            + `&partyId=${encodeURIComponent(partyId)}${details ? '&details=1' : ''}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const html = await res.text();
        return { html, doc: new DOMParser().parseFromString(html, 'text/html') };
    }

    /** "Payment Status Rejected" → "REJECTED" */
    async function paymentStatus(pid, partyId) {
        const { doc } = await page(pid, partyId, false);
        // Hücreler arasında boşluk olmayabilir ("Payment StatusRejected"): yaprak düğümleri boşlukla birleştir
        const text = [...doc.body.querySelectorAll('*')].filter(el => !el.children.length)
            .map(el => el.textContent.trim()).filter(Boolean).join(' ');
        const m = text.match(/Payment Status\s+([A-Za-z_]+)/i);
        if (!m) warn(`durum satırı bulunamadı: ${pid}`);
        return m ? m[1].toUpperCase() : null;
    }

    /** Details sayfasındaki "KOD: mesaj | … | status=…&message=…" satırından insan mesajı. */
    async function rejectReason(pid, partyId) {
        const { html, doc } = await page(pid, partyId, true);
        const has = (t) => /status=\w+/i.test(t) && /message=/i.test(t);
        let raw = [...doc.querySelectorAll('td')].map(td => td.textContent.trim()).find(has)
            || [...doc.querySelectorAll('body *')].filter(el => !el.children.length).map(el => el.textContent.trim()).find(has);
        if (!raw) raw = html.match(/[^<]*status=[^<]*message=[^<\n]*/i)?.[0].replace(/&amp;/g, '&').trim();
        if (!raw) return null;
        const parts = raw.split('|').map(p => p.trim()).filter(Boolean);
        const first = (parts[0] || '').replace(/^\S+:\s*/, '').trim();
        if (first && !/status=/i.test(first)) return first;
        const msg = (parts.at(-1) || '').split('&').find(p => /^message=/i.test(p.trim()))?.trim().slice(8);
        if (!msg) return null;
        try { return decodeURIComponent(msg.replace(/\+/g, ' ')).trim() || null; } catch { return msg.trim() || null; }
    }

    /** Talep sonuçlandı: ana mesaja tepki + mesajın durum satırını düzenle (chat.update).
     *  Ana mesaj kart değilse (eski sürümden kalma) durum satırı thread cevabı olarak gider. */
    async function checkWatched(pid, w) {
        const status = await paymentStatus(pid, w.partyId);
        if (!status || /PENDING|PROCESS|NEW|HOLD|WAIT/.test(status)) return false;   // henüz sonuçlanmamış
        GM_deleteValue('watch:' + pid);
        const local = GM_getValue('rj:' + pid, null);
        GM_deleteValue('rj:' + pid);
        const took = since(Date.now() - (w.req || w.at));

        if (/APPROV|COMPLET|SUCCESS|PAID|SETTLED|PROCESSED/.test(status)) {
            enqueue('a-' + pid, '', { pid, react: 'white_check_mark' });
            enqueue('u-' + pid, `✅ *Onaylandı* · ${took}`, { pid, update: true });
            log(`talep ${pid} onaylandı (${status})`);
            return true;
        }
        if (!/REJECT|DECLIN/.test(status)) {
            enqueue('u-' + pid, `⚪ *${esc(status.charAt(0) + status.slice(1).toLowerCase())}* · ${took}`, { pid, update: true });
            log(`talep ${pid} sonuçlandı (${status}), ne onay ne red`);
            return true;
        }
        enqueue('x-' + pid, '', { pid, react: 'x' });
        let reason = null;
        try { reason = await rejectReason(pid, w.partyId); }
        catch (e) { warn('red sebebi okunamadı:', pid, e.message); }
        reason = reason || local?.reason || null;
        enqueue('u-' + pid, `❌ *Reddedildi* · ${took}\n_${reason ? esc(reason) : 'red sebebi okunamadı'}_`, { pid, update: true });
        log(`talep ${pid} reddedildi${reason ? '' : ' (sebepsiz)'}`);
        return true;
    }

    /** İzlenen talep bekleyen listeden düştüyse durumuna bak (talep başına en fazla 30 sn'de bir). */
    let checking = false;
    async function checkGone(items) {
        if (checking) return;
        checking = true;
        try {
            const pending = new Set(items.map(it => it.paymentid));
            for (const k of GM_listValues()) {
                if (!k.startsWith('watch:')) continue;
                const pid = k.slice(6), w = GM_getValue(k, null);
                if (!w) continue;
                if (Date.now() - w.at > WATCH_TTL) { GM_deleteValue(k); continue; }
                if (pending.has(pid) || Date.now() - (w.checked || 0) < 30000) continue;
                GM_setValue(k, { ...w, checked: Date.now() });
                try { await checkWatched(pid, w); }
                catch (e) { warn('durum okunamadı:', pid, e.message); }
            }
            const old = Date.now() - 2 * 3600e3;
            for (const k of GM_listValues()) if (k.startsWith('rj:') && (GM_getValue(k, null)?.at || 0) < old) GM_deleteValue(k);
        } finally { checking = false; }
    }

    async function notify(it, { test = false } = {}) {
        try {
            const { text, blocks } = await buildMessage(it);
            enqueue(test ? `test-${it.paymentid}-${Date.now()}` : it.paymentid, text, { pid: it.paymentid, blocks });
            watch(it);
            log(`${test ? 'TEST ' : ''}kuyruğa alındı: ${it.paymentid} (party ${it.partyId})\n${text}`);
            return text;
        } catch (e) {
            warn('mesaj hazırlanamadı:', it.paymentid, e);
            return null;
        }
    }

    function handle(items) {
        if (!items) return;
        checkGone(items);
        if (seedIfFirstRun(items)) return;
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
    let busy = false, again = false;
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

    async function send(text, threadTs, blocks) {
        const params = { channel: CONFIG.CHANNEL, text, unfurl_links: 'false', unfurl_media: 'false' };
        if (threadTs) params.thread_ts = threadTs;
        if (blocks) params.blocks = JSON.stringify(blocks);
        return api('chat.postMessage', params);
    }

    /** Kartın son bloğunu (durum satırı) değiştirir; kendi mesajımız olduğu için düzenleyebiliyoruz. */
    function updateStatus(thread, line) {
        const blocks = thread.blocks.slice(0, -1).concat({ type: 'section', text: { type: 'mrkdwn', text: line } });
        return api('chat.update', { channel: CONFIG.CHANNEL, ts: thread.ts, text: thread.text || 'Çekim talebi', blocks: JSON.stringify(blocks) });
    }

    /** Ana mesaja emoji tepkisi; zaten eklenmişse sorun değil. */
    const react = (name, ts) => api('reactions.add', { channel: CONFIG.CHANNEL, name, timestamp: ts }, ['already_reacted']);

    async function api(method, params, okErrors = []) {
        for (let i = 0; i < 4; i++) {
            const r = await call(method, params);
            if (r.ok || okErrors.includes(r.error)) return r;
            if (r.error === 'ratelimited') { await sleep(r.retry); continue; }
            if (/invalid_auth|not_authed|token_revoked/.test(r.error)) { token = null; await resolveToken(); continue; }
            throw new Error(r.error || 'bilinmeyen hata');
        }
        throw new Error(`${method}: 4 denemede olmadı`);
    }

    async function flush() {
        // busy, ilk await'ten ÖNCE alınır: arka arkaya gelen iki sinyal aynı kuyruğu iki kez göndermesin
        if (busy) { again = true; return; }
        busy = true;
        again = false;
        let owned = false;
        try {
            if (!GM_listValues().some(k => k.startsWith('q:'))) return;
            // Birden fazla Slack sekmesi açıksa yalnızca biri göndersin
            const lock = GM_getValue('slackLock', null);
            if (lock && lock.owner !== ME && Date.now() - lock.at < 30000) return;
            GM_setValue('slackLock', { owner: ME, at: Date.now() });
            await sleep(300);
            if (GM_getValue('slackLock', null)?.owner !== ME) return;
            owned = true;
            const keys = GM_listValues().filter(k => k.startsWith('q:'));
            const week = Date.now() - 7 * 864e5;
            for (const k of GM_listValues()) if (k.startsWith('ts:') && (GM_getValue(k, null)?.at || 0) < week) GM_deleteValue(k);
            if (!token) await resolveToken();
            const items = keys.map(k => [k, GM_getValue(k, null)]).filter(([, v]) => v)
                .sort((a, b) => a[1].at - b[1].at);
            for (const [k, v] of items) {
                if (Date.now() - v.at > CONFIG.QUEUE_TTL_H * 3600e3) { GM_deleteValue(k); warn('çok eski, atıldı:', k); continue; }
                let thread = null;
                if (v.reply || v.react || v.update) {
                    thread = GM_getValue('ts:' + v.pid, null);
                    if (!thread || thread.ch !== CONFIG.CHANNEL) {
                        // Ana mesaj henüz hazırlanıyor/kuyrukta olabilir: biraz bekle, gelmezse bırak
                        const parentQueued = GM_listValues().some(q => q === 'q:' + v.pid || q.startsWith(`q:test-${v.pid}-`));
                        if (parentQueued || Date.now() - v.at < 15 * 60000) continue;
                        GM_deleteValue(k); warn('ana mesajı yok, atıldı:', k); continue;
                    }
                }
                GM_setValue('slackLock', { owner: ME, at: Date.now() });
                // Tepki ve durum, ana mesaj zaten gittikten sonraki ekler: biri başarısız olursa kuyruk kilitlenmesin
                if (v.react) {
                    try { await react(v.react, thread.ts); log(`tepki eklendi :${v.react}:`, v.pid); }
                    catch (e) { warn(`tepki eklenemedi (${v.pid}), atlandı:`, e.message); }
                    GM_deleteValue(k);
                    continue;
                }
                if (v.update) {
                    let done = false;
                    if (thread.blocks?.length) {
                        try {
                            await updateStatus(thread, v.text);
                            GM_setValue('ts:' + v.pid, { ...thread, blocks: thread.blocks.slice(0, -1).concat({ type: 'section', text: { type: 'mrkdwn', text: v.text } }) });
                            log('durum güncellendi:', v.pid);
                            done = true;
                        } catch (e) { warn(`mesaj düzenlenemedi (${v.pid}), thread cevabına geçiliyor:`, e.message); }
                    }
                    if (!done) {
                        try { await send(v.text, thread.ts); log('durum thread cevabı olarak gönderildi:', v.pid); }
                        catch (e) { warn(`durum gönderilemedi (${v.pid}), atlandı:`, e.message); }
                    }
                    GM_deleteValue(k);
                    await sleep(1200);
                    continue;
                }
                const r = await send(v.text, thread?.ts, v.blocks);
                if (!v.reply && v.pid && r.ts) GM_setValue('ts:' + v.pid, { ts: r.ts, ch: CONFIG.CHANNEL, at: Date.now(), text: v.text, blocks: v.blocks || null });
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
            if (owned) GM_deleteValue('slackLock');
            if (again) setTimeout(flush, 200);   // meşgulken gelen sinyal kaybolmasın
        }
    }

    GM_addValueChangeListener('ping', () => flush());
    setInterval(flush, 20000);
    setTimeout(flush, 3000); // Slack istemcisi localStorage'ı doldursun
    status('bağlı, bekliyor');
    log('Slack tarafı hazır, kuyruk izleniyor.');
}

})();
