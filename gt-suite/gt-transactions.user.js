// ==UserScript==
// @name         GT Transactions — işlem geçmişi
// @namespace    palentis.gt
// @version      1.0.0
// @description  Transaction History sayfası: 1. Aşama / 2. Aşama / CRE filtre otomasyonu (Alt+X / Alt+D / Alt+C), "Show Transactions From" yanına bir gün geri (<<) butonu ve listenin başı/sonu arasında gidip gelen kaydırma butonu. GT Core üzerine kurulur.
// @match        https://core-secundus.gmntc.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
'use strict';

const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

(W.__GT__ = W.__GT__ || []).push((GT) => {

const { h, $, $$, txt, css, log, warn, oops, at, ui } = GT;

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
#gt-asama-buttons{display:inline-flex; gap:4px; margin-left:14px; vertical-align:middle}
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
        }, 'gt-asama-buttons', () => h('span', {},
            ui.button({ label: '1. Aşama', small: true, title: 'Alt+X', onClick: stage1 }),
            ui.button({ label: '2. Aşama', small: true, title: 'Alt+D', onClick: stage2 }),
            ui.button({ label: 'CRE', small: true, title: 'Alt+C', onClick: stageCre })), 'after');

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

log('GT Transactions v1.0.0 kayıtlı.');

});
})();
