// ==UserScript==
// @name         GT Transactions — işlem geçmişi
// @namespace    palentis.gt
// @version      1.1.2
// @description  Transaction History sayfası: 1. Aşama / 2. Aşama / CRE filtre otomasyonu (Alt+X / Alt+D / Alt+C), "Show Transactions From" yanına bir gün geri (<<) butonu, listenin başı/sonu arasında gidip gelen kaydırma butonu ve CRE'nin yanında Ratio Checker (sabit oran eşiği + GT Sports/Betby oran rozetleri). GT Core üzerine kurulur.
// @match        https://core-secundus.gmntc.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
'use strict';

const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

(W.__GT__ = W.__GT__ || []).push((GT) => {

const { h, $, $$, txt, esc, css, log, warn, oops, at, ui, api, parseMoney } = GT;

/* ════════════════════════════════════════════════════════════
   YARDIMCILAR
   ════════════════════════════════════════════════════════════ */
function setInputValue(el, value) {
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

const DATE_RE = /\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}/;

/** "24-09-2026 07:59:11" → Date (yerel saat) */
function parseStamp(stamp) {
    const [datePart, timePart] = stamp.split(' ');
    const [day, month, year] = datePart.split('-');
    return new Date(`${year}-${month}-${day}T${timePart}`);
}

/** Anahtar kelimeyi içeren satırlar arasında tarihi en yeni olanın tarih hücresi. */
function newestRowDateCell(keyword) {
    let best = null;
    for (const td of $$('td')) {
        if (!td.textContent.includes(keyword)) continue;
        const row = td.closest('tr');
        if (!row) continue;
        for (const cell of row.querySelectorAll('td')) {
            const m = cell.textContent.trim().match(DATE_RE);
            if (!m) continue;
            const ts = parseStamp(m[0]).getTime();
            if (!best || ts > best.ts) best = { td: cell, ts };
            break;
        }
    }
    return best?.td || null;
}

function clickGo() {
    const go = $$('button.btn-success').find(btn => btn.textContent.trim() === 'Go');
    go ? go.click() : warn('[Transactions] Go butonu bulunamadı.');
}

/* ════════════════════════════════════════════════════════════
   1. AŞAMA — GAME_BET / GAME_WIN / RESERVE / RSV_COMMIT /
   RSV_CANCEL / BONUS_REL seç, sayfa başı 99999, Go
   ════════════════════════════════════════════════════════════ */
const STAGE1_TYPES = [
    { idx: 17, text: 'GAME_BET' },
    { idx: 19, text: 'GAME_WIN' },
    { idx: 46, text: 'RESERVE' },
    { idx: 47, text: 'RSV_COMMIT' },
    { idx: 48, text: 'RSV_CANCEL' },
    { idx: 6,  text: 'BONUS_REL' },
];

function stage1() {
    const dropdown = $('button.dropdown-toggle.filter-dropdown');
    if (!dropdown) return warn('[1. Aşama] Dropdown menüsünü açan buton bulunamadı!');
    dropdown.click();

    let polls = 0;
    const timer = setInterval(() => {
        polls++;
        if ($$('ss-multiselect-dropdown ul li').length >= 4) { clearInterval(timer); setTimeout(pick, 400); }
        else if (polls >= 15) { clearInterval(timer); warn('[1. Aşama] 3 saniye içinde liste gelmedi, iptal.'); }
    }, 200);

    function pick() {
        const lis = $$('ss-multiselect-dropdown ul li');
        const byText = new Map(lis.map(li => [li.textContent.trim(), li]));
        for (const { idx, text } of STAGE1_TYPES) {
            // Önce bilinen sıradan dene; liste değiştiyse metinden bul.
            const li = lis[idx]?.textContent.trim() === text ? lis[idx] : byText.get(text);
            li?.querySelector('a')?.click();
        }
        setTimeout(() => {
            setInputValue($('#numPerPage'), '99999');
            setTimeout(clickGo, 150);
        }, 400);
    }
}

/* ════════════════════════════════════════════════════════════
   2. AŞAMA / CRE — başlangıç: en yeni DEPOSIT (ya da CRE_BONUS)
   satırının zamanı; bitiş: en yeni WITHDRAWAL + 1 dk; sadece
   GAME_BET + GAME_WIN, sayfa başı 99000, Go
   ════════════════════════════════════════════════════════════ */
function autoFill(keyword, tag) {
    const startTd = newestRowDateCell(keyword);
    if (!startTd) { alert(`${keyword} satırı veya geçerli Tarih/Saat hücresi bulunamadı!`); return; }

    const [datePart, timePart] = startTd.textContent.trim().match(DATE_RE)[0].split(' ');
    const [hour, minute] = timePart.split(':');
    const hours = $$('input[type="number"][max="23"]');
    const minutes = $$('input[type="number"][max="59"]');

    setInputValue($('#q-datepicker_9'), datePart);
    setInputValue(hours[0], hour);
    setInputValue(minutes[0], minute);

    const wdTd = newestRowDateCell('WITHDRAWAL');
    if (wdTd) {
        const end = parseStamp(wdTd.textContent.trim().match(DATE_RE)[0]);
        end.setMinutes(end.getMinutes() + 1);
        const p2 = (n) => String(n).padStart(2, '0');
        setInputValue($('#q-datepicker_7'), `${p2(end.getDate())}-${p2(end.getMonth() + 1)}-${end.getFullYear()}`);
        setInputValue(hours[1], p2(end.getHours()));
        setInputValue(minutes[1], p2(end.getMinutes()));
    }

    const dropdown = $('button.dropdown-toggle.filter-dropdown');
    if (!dropdown) return oops(`[${tag}] Dropdown ana butonu bulunamadı.`);
    dropdown.click();
    setTimeout(() => {
        $('li.check-control-uncheck a')?.click();
        setTimeout(() => {
            for (const li of $$('li.dropdown-item')) {
                const text = li.textContent.trim();
                if (text === 'GAME_BET' || text === 'GAME_WIN') li.querySelector('a')?.click();
            }
            setTimeout(() => {
                setInputValue($('#numPerPage'), '99000');
                setTimeout(clickGo, 150);
            }, 400);
        }, 400);
    }, 500);
}

const stage2 = () => setTimeout(() => autoFill('DEPOSIT', '2. Aşama'), 1000);
const stageCre = () => setTimeout(() => autoFill('CRE_BONUS', '3. Aşama (CRE)'), 1000);

/* ════════════════════════════════════════════════════════════
   << — "From" tarihini bir gün geri al
   ════════════════════════════════════════════════════════════ */
function fromDateInput(ref) {
    let box = ref.closest('div') || ref.parentElement;
    for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
        const input = box.querySelector('input[id^="q-datepicker_"]');
        if (input) return input;
    }
    return null;
}

function prevDay(btn) {
    const input = fromDateInput(btn);
    if (!input) return warn('[<<] "From" tarih kutucuğu bulunamadı.');

    const m = input.value.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) return warn('[<<] Tarih formatı beklenmedik:', input.value);
    const target = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00`);
    target.setDate(target.getDate() - 1);

    // Sayfanın kendi bootstrap-datepicker'ı varsa doğrudan onun API'si.
    const jq = W.jQuery || W.$;
    if (jq && typeof jq.fn?.datepicker === 'function') {
        try {
            const $input = jq(input);
            $input.datepicker('setDate', target);
            $input.trigger('changeDate').trigger('change');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        } catch (e) {
            warn('[<<] datepicker API başarısız, takvime tıklayarak denenecek:', e);
        }
    }

    // Yedek: takvimi aç, doğru aya gel, güne tıkla.
    input.focus();
    const day = target.getDate();
    const monthYear = target.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    let polls = 0;
    const timer = setInterval(() => {
        polls++;
        if ($('.datepicker-switch')) { clearInterval(timer); pickDay(day, monthYear); }
        else if (polls >= 20) { clearInterval(timer); warn('[<<] Takvim açılmadı.'); }
    }, 100);
}

function pickDay(day, monthYear, safety = 0) {
    if (txt($('.datepicker-switch')) === monthYear) {
        const cell = $$('td.day').find(td => !td.classList.contains('old') && !td.classList.contains('new') && txt(td) === String(day));
        return cell ? cell.click() : warn(`[<<] Takvimde ${day}. gün bulunamadı.`);
    }
    if (safety >= 24) return warn('[<<] Doğru ay/yıla ulaşılamadı.');
    const prev = $('.prev');
    if (!prev) return warn('[<<] "Önceki ay" butonu bulunamadı.');
    prev.click();
    setTimeout(() => pickDay(day, monthYear, safety + 1), 80);
}

/* ════════════════════════════════════════════════════════════
   STİL
   ════════════════════════════════════════════════════════════ */
css('gt-transactions-style', `
#gt-asama-buttons{margin-left:14px}
#gt-prev-day-button{margin:0 6px; vertical-align:middle}

#gt-scroll-toggle-btn{all:unset; box-sizing:border-box; position:fixed; left:50%; bottom:20px; z-index:999999;
  width:44px; height:44px; border-radius:50%; display:none; align-items:center; justify-content:center;
  background:rgba(29,29,31,.82); color:#fff; cursor:pointer;
  backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  box-shadow:0 4px 16px rgba(0,0,0,.22); transform:translateX(-50%);
  transition:background .15s, transform .15s}
#gt-scroll-toggle-btn.on{display:flex}
#gt-scroll-toggle-btn:hover{background:rgba(29,29,31,.95)}
#gt-scroll-toggle-btn:active{transform:translateX(-50%) scale(.92)}
#gt-scroll-toggle-btn svg{transition:transform .3s ease}
#gt-scroll-toggle-btn.at-bottom svg{transform:rotate(180deg)}
`);

/* ════════════════════════════════════════════════════════════
   1 · AŞAMA BUTONLARI + KISAYOLLAR + << BUTONU
   ════════════════════════════════════════════════════════════ */
GT.define({
    id: 'tx-stages',
    match: at.txHistory,
    scope: 'both',
    source: 'transactions',
    setup(ctx) {
        ctx.hotkey('alt+x', stage1);
        ctx.hotkey('alt+d', stage2);
        ctx.hotkey('alt+c', stageCre);

        const label = (text) => $$('label').find(el => txt(el) === text);

        ctx.mount(() => {
            const loyalty = label('Show Loyalty');
            return loyalty ? (loyalty.closest('div[style*="inline-block"]') || loyalty.parentElement) : null;
        }, 'gt-asama-buttons', () => h('span', { class: 'gt-group' },
            ui.button({ label: '1. Aşama', small: true, key: 'alt+x', onClick: stage1 }),
            ui.button({ label: '2. Aşama', small: true, key: 'alt+d', onClick: stage2 }),
            ui.button({ label: 'CRE', small: true, key: 'alt+c', id: 'gt-cre-btn', onClick: stageCre })), 'after');

        ctx.mount(() => label('Show Transactions From'), 'gt-prev-day-button', () =>
            ui.button({ label: '<<', small: true, title: '1 gün geri git', onClick: (e) => prevDay(e.currentTarget) }), 'after');
    },
});

/* ════════════════════════════════════════════════════════════
   2 · KAYDIRMA BUTONU — listenin sonuna in / başına çık
   ════════════════════════════════════════════════════════════ */
const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

GT.define({
    id: 'tx-scroll-toggle',
    match: at.txHistory,
    scope: 'both',
    source: 'transactions',
    setup(ctx) {
        const DURATION = 900;
        const list = () => $('.fixed-header-table');
        let atBottom = false;
        let anim = null;

        const btn = ctx.own(h('button', {
            type: 'button', id: 'gt-scroll-toggle-btn', title: 'Listenin en altına in',
            html: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                     stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="19"></line>
                     <polyline points="6 13 12 19 18 13"></polyline></svg>`,
            onclick: () => {
                const box = list();
                if (box) scrollTo(box, atBottom ? 0 : box.scrollHeight);
            },
        }));
        document.body.append(btn);

        function check() {
            const box = list();
            if (!box) return;
            atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 5;
            btn.classList.toggle('at-bottom', atBottom);
            btn.title = atBottom ? 'Listenin başına çık' : 'Listenin en altına in';
        }

        function scrollTo(box, target) {
            if (anim) cancelAnimationFrame(anim);
            const start = box.scrollTop;
            const distance = target - start;
            if (!distance) return;
            const t0 = performance.now();
            const step = (now) => {
                const p = Math.min((now - t0) / DURATION, 1);
                box.scrollTop = start + distance * easeInOutCubic(p);
                if (p < 1) anim = requestAnimationFrame(step);
                else { anim = null; check(); }
            };
            anim = requestAnimationFrame(step);
        }

        // Liste Angular tarafından yeniden çizilebilir: her yeni kutuya bir kez dinleyici.
        const watched = new WeakSet();
        function update() {
            const box = list();
            if (box && !watched.has(box)) { watched.add(box); ctx.on(box, 'scroll', check, { passive: true }); }
            const needed = !!box && box.scrollHeight > box.clientHeight + 5;
            btn.classList.toggle('on', needed);
            if (needed) check();
        }

        ctx.tick(update, { lazy: true });
        ctx.on(window, 'resize', update);
        ctx.interval(update, 1500);
        update();
    },
});

/* ════════════════════════════════════════════════════════════
   3 · RATIO CHECKER — CRE butonunun yanında oran denetimi
   (sabit oran eşikleri + GT Sports/Betby oran rozetleri).
   Eski bağımsız "ratioChecker" IIFE'inin çekirdek üzerine
   oturtulmuş hâli: kendi observer/popup/CSS'i yerine GT.bus
   (ctx.tick), GT.ui.popover ve gt-btn/gt-chip tasarım kitini
   kullanır — modül route/oyuncu değişince (key: partyId) veya
   sayfadan çıkılınca ctx.destroy() ile buton grubu, popover ve
   auto-scan zamanlayıcısı kendiliğinden temizlenir.
   ════════════════════════════════════════════════════════════ */
const RATIO_OPTIONS = [1.30, 1.50];
const RATIO_AUTO_SCAN = false;
const RATIO_AUTO_SCAN_DELAY = 1800;
const RATIO_COL = { type: 2, debit: 4, credit: 5, tranId: 8 };
const RATIO_CRE_BTN_SELECTOR = '#gt-cre-btn';
const RATIO_TONE = {
    danger:  { bg: 'rgba(255,59,48,.07)', line: 'var(--gt-danger)' },
    success: { bg: 'rgba(52,199,89,.07)', line: 'var(--gt-success)' },
};

css('gt-ratio-checker-style', `
#gt-ratio-group{margin-left:8px}
.gt-ratio-badge.is-clickable{ cursor:pointer; pointer-events:auto; }
.gt-ratio-badge.is-clickable:hover{ filter:brightness(.95); }
.gt-ratio-card{ cursor:pointer; }
.gt-ratio-card:hover{ background:#e9e9ee; }
@keyframes gtRatioFlash{ 0%{ background-color:rgba(0,122,255,.20); } 100%{ background-color:transparent; } }
.gt-row-flash td{ animation: gtRatioFlash 1.9s ease-out; }
`);

function ratioFindTable() {
    const tables = $$('table');
    return tables.find(t => $$('th, thead td', t).some(c => txt(c).toUpperCase() === 'TYPE')) || tables[0] || null;
}

function ratioHeaderCells(table) {
    let cells = $$('thead th, thead td', table);
    if (!cells.length) {
        const firstRow = $('tr', table);
        if (firstRow) cells = $$('th, td', firstRow);
    }
    return cells;
}

function ratioJumpToPartner(partnerCell) {
    const row = partnerCell?.closest('tr');
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('gt-row-flash');
    setTimeout(() => row.classList.remove('gt-row-flash'), 1300);
}

async function ratioRunWithConcurrency(items, limit, worker) {
    const out = new Array(items.length);
    let i = 0;
    async function next() {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await worker(items[idx], idx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
    return out;
}

/** Betby/GT Sports oyun detayından oran çeker — GT.api'nin token/cache/dedup katmanını paylaşır. */
async function ratioFetchBetDetail(gameTranId, gameId) {
    const partyId = api.partyId();
    if (!partyId) return null;
    try {
        const url = api.ics('player-transactions/game-detail', {
            platformCode: 'BETTECH', gameTranId, gameId: gameId || 'Single', partyId,
        });
        const data = await api.json(url, { ttl: 5 * 60 * 1000 });
        const slip = data?.bettechBetslip;
        if (!slip || slip.status !== 'OK') return null;
        return { odds: parseFloat(slip.odds) || null, betStatus: slip.betStatus || null, isWon: slip.isWon || null };
    } catch {
        return null;
    }
}

GT.define({
    id: 'tx-ratio-checker',
    match: at.txHistory,
    scope: 'both',
    source: 'transactions',
    key: () => api.partyId(),
    setup(ctx) {
        let results = { invalid: [], valid: [], unpairedBets: [], skipped: 0, total: 0, ratio: RATIO_OPTIONS[0] };
        let status = { msg: 'Henüz taranmadı.', color: '' };
        let activeMode = null; // sayı (oran eşiği) ya da 'CHK'
        let autoScan = RATIO_AUTO_SCAN;
        let lastUrl = '', lastRowCount = 0, scanTimer = null;

        const pop = ui.popover({ anchorId: 'gt-ratio-group', title: 'Ratio Checker', width: 300 });

        function setActive(mode) {
            const group = document.getElementById('gt-ratio-group');
            if (!group) return;
            for (const btn of $$('.gt-btn', group)) {
                const r = btn.dataset.ratio;
                const match = r !== undefined ? (typeof mode === 'number' && parseFloat(r) === mode) : (mode === 'CHK');
                btn.classList.toggle('is-active', match);
            }
        }

        function clearHighlights() {
            for (const row of $$('[data-rtp-tagged]')) {
                row.style.removeProperty('background-color');
                row.style.removeProperty('outline');
                row.style.removeProperty('outline-offset');
                delete row.dataset.rtpTagged;
            }
            for (const cell of $$('[data-rtp-chk-tagged]')) {
                cell.querySelector('.gt-chip')?.remove();
                delete cell.dataset.rtpChkTagged;
            }
        }

        function applyHighlight(row, tone) {
            const t = RATIO_TONE[tone];
            row.style.setProperty('background-color', t.bg, 'important');
            row.style.setProperty('outline', `1.5px solid ${t.line}`, 'important');
            row.style.setProperty('outline-offset', '-1px', 'important');
            row.dataset.rtpTagged = '1';
        }

        function insertRatioBadge(cell, ratio, pairNum, partnerCell) {
            if (!cell) return;
            cell.querySelector('.gt-chip')?.remove();
            const badge = h('span', {
                class: 'gt-chip gt-chip--warn gt-ratio-badge' + (partnerCell ? ' is-clickable' : ''),
                title: partnerCell ? 'Eşine git' : null,
                onclick: partnerCell ? (e) => { e.stopPropagation(); ratioJumpToPartner(partnerCell); } : null,
            }, pairNum ? `#${pairNum} · ${ratio.toFixed(2)}x` : `${ratio.toFixed(2)}x`);
            cell.append(badge);
            cell.dataset.rtpChkTagged = '1';
        }

        function insertOddsBadge(cell, { odds, betStatus }) {
            if (!cell) return;
            cell.querySelector('.gt-chip')?.remove();
            const tone = betStatus === 'Lost' ? 'danger' : betStatus === 'New' ? 'accent' : 'muted';
            const label = betStatus === 'New' ? 'New' : betStatus === 'Lost' ? 'Lost' : (betStatus || '?');
            cell.append(ui.chip(`${odds ? odds.toFixed(2) + 'x' : '?'} · ${label}`, tone));
            cell.dataset.rtpChkTagged = '1';
        }

        function insertPendingBadge(cell) {
            if (!cell) return;
            cell.querySelector('.gt-chip')?.remove();
            cell.append(ui.chip('…', 'muted'));
            cell.dataset.rtpChkTagged = '1';
        }

        function renderAll() {
            const { invalid, valid, unpairedBets, skipped, total, ratio } = results;
            const parts = [];
            parts.push(`<button type="button" id="gt-ratio-clear" class="gt-btn gt-btn--quiet gt-btn--sm" style="width:100%;margin-bottom:9px;">✕ Temizle</button>`);
            parts.push(`<label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--gt-muted);font-size:11px;margin-bottom:10px;">
                <input type="checkbox" id="gt-ratio-auto" ${autoScan ? 'checked' : ''} style="accent-color:var(--gt-accent);width:13px;height:13px;">
                Sayfa değişince otomatik tara</label>`);

            if (activeMode !== 'CHK' && total > 0) {
                parts.push(`<div class="gt-box gt-kv" style="margin-bottom:8px;">
                    <span>Sınır oran</span><span style="color:var(--gt-accent)">${ratio.toFixed(2)}x</span>
                    <span>Taranan satır</span><span>${total}</span>
                    <span>Eşleşen pair</span><span>${invalid.length + valid.length}</span>
                    <span style="color:var(--gt-danger)">❌ Geçersiz</span><span style="color:var(--gt-danger)">${invalid.length}</span>
                    <span style="color:var(--gt-success)">✅ Geçerli</span><span style="color:var(--gt-success)">${valid.length}</span>
                    <span style="color:var(--gt-muted)">⏭ Atlanan</span><span style="color:var(--gt-muted)">${skipped}</span>
                </div>`);

                parts.push(invalid.length
                    ? `<div style="color:var(--gt-danger);font-weight:600;margin-bottom:6px;font-size:11px;">❌ Geçersiz Pairlar (${invalid.length}) — detay için tıkla</div>`
                        + invalid.map(p => `
                            <div class="gt-card gt-ratio-card">
                                <div class="gt-card__id">${esc(p.tranId)}</div>
                                <div class="gt-card__row">
                                    <span>BET <b>TRY ${p.betAmount.toFixed(2)}</b> → WIN <b>TRY ${p.winAmount.toFixed(2)}</b></span>
                                    <span class="gt-chip gt-chip--danger">${p.ratio.toFixed(2)}x</span>
                                </div>
                                <div class="gt-ratio-detail" style="display:none;margin-top:5px;color:var(--gt-muted);font-size:11px;">Gerekli: ${ratio.toFixed(2)}x | Eksik: TRY ${((ratio * p.betAmount) - p.winAmount).toFixed(2)}</div>
                            </div>`).join('')
                    : `<div style="color:var(--gt-success);text-align:center;padding:10px;font-weight:600;">✅ Bu sayfada tüm pairlar geçerli!</div>`);

                if (invalid.length) {
                    const sum = invalid.reduce((s, p) => s + p.betAmount, 0);
                    parts.push(`<div class="gt-stat" style="margin-top:8px;">
                        <div class="gt-stat__label">Geçersiz Bet Toplamı</div>
                        <div class="gt-stat__value" style="color:var(--gt-accent)">TRY ${sum.toLocaleString('tr-TR', { minimumFractionDigits: 2 })}</div>
                    </div>`);
                }
                if (valid.length || unpairedBets.length) {
                    const pairedTotal = valid.reduce((s, p) => s + p.betAmount, 0);
                    const unpairedTotal = unpairedBets.reduce((s, b) => s + b.debit, 0);
                    parts.push(`<div class="gt-stat" style="margin-top:6px;border-color:var(--gt-success);">
                        <div class="gt-stat__label">Geçerli Bet Toplamı</div>
                        <div class="gt-stat__value" style="color:var(--gt-success)">TRY ${(pairedTotal + unpairedTotal).toLocaleString('tr-TR', { minimumFractionDigits: 2 })}</div>
                        <div style="font-size:10px;color:var(--gt-muted);margin-top:3px;">${valid.length} eşleşmiş + ${unpairedBets.length} eşleşmemiş BET</div>
                    </div>`);
                }
            }

            parts.push(`<div class="gt-status" style="${status.color ? `color:${status.color}` : ''}">${esc(status.msg)}</div>`);
            pop.setTitle(activeMode === 'CHK' ? 'GT Sports Oranları' : 'Ratio Checker');
            pop.html = parts.join('');
        }

        function runScan(minRatio) {
            clearHighlights();
            activeMode = minRatio;
            setActive(minRatio);
            results = { invalid: [], valid: [], unpairedBets: [], skipped: 0, total: 0, ratio: minRatio };
            status = { msg: '🔍 Taranıyor...', color: 'var(--gt-accent)' };
            renderAll();

            const table = ratioFindTable();
            if (!table) { status = { msg: '⚠️ Tablo bulunamadı.', color: 'var(--gt-warn)' }; renderAll(); return; }

            const entries = [];
            let skipped = 0;
            for (const row of $$('tbody tr', table)) {
                const cells = row.querySelectorAll('td');
                if (cells.length < 9) { skipped++; continue; }
                const typeRaw = txt(cells[RATIO_COL.type]).toUpperCase();
                const isBet = typeRaw.includes('GAME_BET');
                const isWin = typeRaw.includes('GAME_WIN');
                if (!isBet && !isWin) { skipped++; continue; }
                const tranId = txt(cells[RATIO_COL.tranId]);
                if (!tranId) { skipped++; continue; }
                entries.push({
                    type: isBet ? 'BET' : 'WIN',
                    debit: Math.abs(parseMoney(txt(cells[RATIO_COL.debit]))),
                    credit: parseMoney(txt(cells[RATIO_COL.credit])),
                    tranId, row,
                });
            }

            const groups = new Map();
            for (const e of entries) {
                if (!groups.has(e.tranId)) groups.set(e.tranId, []);
                groups.get(e.tranId).push(e);
            }

            const invalid = [], valid = [], unpairedBets = [];
            for (const group of groups.values()) {
                const bet = group.find(g => g.type === 'BET');
                const win = group.find(g => g.type === 'WIN');
                if (bet && !win) { unpairedBets.push(bet); continue; }
                if (!bet || !win || bet.debit === 0) { skipped++; continue; }
                const ratio = win.credit / bet.debit;
                const entry = { tranId: bet.tranId, betAmount: bet.debit, winAmount: win.credit, ratio };
                if (ratio < minRatio) { invalid.push(entry); applyHighlight(bet.row, 'danger'); applyHighlight(win.row, 'danger'); }
                else { valid.push(entry); applyHighlight(bet.row, 'success'); applyHighlight(win.row, 'success'); }
            }

            results = { invalid, valid, unpairedBets, skipped, total: entries.length, ratio: minRatio };
            status = { msg: '', color: '' };
            renderAll();
            pop.place();
        }

        async function runGtSportsCheck() {
            clearHighlights();
            activeMode = 'CHK';
            setActive('CHK');
            log('[Ratio Checker] GT Sports (Betby) taranıyor...');

            const table = ratioFindTable();
            if (!table) { warn('[Ratio Checker] Tablo bulunamadı.'); return; }

            const headers = ratioHeaderCells(table).map(cell => txt(cell).toUpperCase());
            const productIdx = headers.findIndex(t => t === 'PRODUCT');
            const instanceIdx = headers.findIndex(t => t.includes('GAME INSTANCE') || t.includes('INSTANCE'));
            const gameIdIdx = headers.findIndex(t => t === 'GAME ID');

            if (productIdx === -1 || instanceIdx === -1) {
                warn('[Ratio Checker] PRODUCT veya Game Instance sütunu bulunamadı.');
                return;
            }

            const maxIdx = Math.max(RATIO_COL.type, RATIO_COL.debit, RATIO_COL.credit, RATIO_COL.tranId, productIdx, instanceIdx, gameIdIdx);
            const entries = [];
            for (const row of $$('tbody tr', table)) {
                const cells = row.querySelectorAll('td');
                if (cells.length <= maxIdx) continue;
                const typeRaw = txt(cells[RATIO_COL.type]).toUpperCase();
                const isBet = typeRaw.includes('GAME_BET');
                const isWin = typeRaw.includes('GAME_WIN');
                if (!isBet && !isWin) continue;

                const productRaw = txt(cells[productIdx]).toUpperCase();
                if (!productRaw.includes('GT SPORTS') && !productRaw.includes('BETBY')) continue;

                const tranId = txt(cells[RATIO_COL.tranId]);
                if (!tranId) continue;

                entries.push({
                    type: isBet ? 'BET' : 'WIN',
                    debit: Math.abs(parseMoney(txt(cells[RATIO_COL.debit]))),
                    credit: parseMoney(txt(cells[RATIO_COL.credit])),
                    tranId,
                    gameId: gameIdIdx !== -1 ? txt(cells[gameIdIdx]) : 'Single',
                    instanceCell: cells[instanceIdx],
                });
            }

            const groups = new Map();
            for (const e of entries) {
                if (!groups.has(e.tranId)) groups.set(e.tranId, []);
                groups.get(e.tranId).push(e);
            }

            let pairCounter = 0;
            const unpairedBets = [];
            for (const group of groups.values()) {
                const bet = group.find(g => g.type === 'BET');
                const win = group.find(g => g.type === 'WIN');
                if (bet && win && bet.debit !== 0) {
                    pairCounter++;
                    const ratio = win.credit / bet.debit;
                    insertRatioBadge(bet.instanceCell, ratio, pairCounter, win.instanceCell);
                    insertRatioBadge(win.instanceCell, ratio, pairCounter, bet.instanceCell);
                } else if (bet && !win) {
                    insertPendingBadge(bet.instanceCell);
                    unpairedBets.push(bet);
                }
            }

            log(`[Ratio Checker] ${pairCounter} eşleşmiş çift · ${unpairedBets.length} kayıp/beklemede oran çekiliyor...`);

            if (unpairedBets.length) {
                await ratioRunWithConcurrency(unpairedBets, 4, async (bet) => {
                    const detail = await ratioFetchBetDetail(bet.tranId, bet.gameId);
                    if (detail) insertOddsBadge(bet.instanceCell, detail);
                    else {
                        const span = bet.instanceCell?.querySelector('.gt-chip');
                        if (span) span.textContent = '?';
                    }
                });
            }

            log(pairCounter || unpairedBets.length
                ? `[Ratio Checker] ${pairCounter} eşleşmiş, ${unpairedBets.length} beklemede/kayıp bet işaretlendi.`
                : '[Ratio Checker] GT Sports (Betby) pair bulunamadı.');
        }

        function onClear() {
            clearHighlights();
            results = { invalid: [], valid: [], unpairedBets: [], skipped: 0, total: 0, ratio: results.ratio };
            activeMode = null;
            setActive(null);
            status = { msg: 'Temizlendi.', color: '' };
            renderAll();
        }

        function onRatioClick(r) {
            if (activeMode === r && pop.isOpen) { pop.close(); return; }
            pop.open();
            runScan(r);
        }

        // Popover açmadan doğrudan tabloya işler: tekrar tıklamak rozetleri temizler.
        function onChkClick() {
            if (activeMode === 'CHK') { onClear(); return; }
            runGtSportsCheck();
        }

        function schedule() {
            if (!autoScan) return;
            clearTimeout(scanTimer);
            scanTimer = setTimeout(
                () => (activeMode === 'CHK' ? runGtSportsCheck() : runScan(activeMode ?? RATIO_OPTIONS[0])),
                RATIO_AUTO_SCAN_DELAY,
            );
        }

        ctx.mount(() => $(RATIO_CRE_BTN_SELECTOR), 'gt-ratio-group', () => {
            const group = h('span', { class: 'gt-group' });
            for (const r of RATIO_OPTIONS) {
                group.append(h('button', {
                    type: 'button', class: 'gt-btn gt-btn--sm', dataset: { ratio: r },
                    onclick: (e) => { e.preventDefault(); e.stopPropagation(); onRatioClick(r); },
                }, `${r.toFixed(2)}x`));
            }
            group.append(h('button', {
                type: 'button', class: 'gt-btn gt-btn--sm gt-btn--warn', title: 'GT Sports (Betby) oran işaretleyici',
                onclick: (e) => { e.preventDefault(); e.stopPropagation(); onChkClick(); },
            }, 'CHK'));
            return group;
        }, 'after');

        ctx.on(pop.root, 'click', (e) => {
            if (e.target.id === 'gt-ratio-clear') return onClear();
            const card = e.target.closest('.gt-ratio-card');
            if (card) {
                const d = card.querySelector('.gt-ratio-detail');
                if (d) d.style.display = d.style.display === 'none' ? 'block' : 'none';
            }
        });
        ctx.on(pop.root, 'change', (e) => { if (e.target.id === 'gt-ratio-auto') autoScan = e.target.checked; });

        // Angular'ın tabloyu yeniden çizdiği anları yakalamak için: URL ya da
        // satır sayısı değiştiğinde (auto-scan açıksa) yeniden tara.
        ctx.tick(() => {
            if (!autoScan) return;
            if (location.href !== lastUrl) { lastUrl = location.href; lastRowCount = 0; schedule(); return; }
            const table = ratioFindTable();
            const rowCount = table ? $$('tbody tr', table).length : 0;
            if (rowCount > 0 && rowCount !== lastRowCount) { lastRowCount = rowCount; schedule(); }
        }, { lazy: true });

        ctx.onDestroy(() => { clearTimeout(scanTimer); clearHighlights(); pop.close(); });
    },
});

log('GT Transactions v1.1.2 kayıtlı.');

});
})();
