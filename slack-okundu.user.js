// ==UserScript==
// @name         Slack Okundu Butonu
// @namespace    palentis-slack-okundu
// @version      1.0
// @description  Slack'te "Channels" başlığının yanına "Okundu" butonu ekler: sağ tık menüsündeki "Mark all as read"i tek tıkla çalıştırır (Slack'in kendi işlevi; okunmamış kanal listesini Slack hesaplar).
// @match        https://app.slack.com/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
    'use strict';

    // Konsol çıktısıyla doğrulanan yapı (2026-10): başlık satırı ve tıklanabilir etiket.
    const BASLIK = '.p-channel_sidebar__section_heading[data-qa="channels"]';
    const ETIKET = '[data-qa="channel_sidebar__section_heading_label__channels"]';
    const MENU_METNI = /^(mark all as read|tümünü okundu olarak işaretle|tümünü okundu say)/i;

    const CHK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5l4.5 4.5L15 8.5"/><path d="M9.5 16l1 1L22 6"/></svg>';

    const stil = document.createElement('style');
    stil.textContent = `
    #palentis-okundu{margin-left:auto; margin-right:6px; display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 8px; border-radius:6px;
      font:700 11px Lato, "Segoe UI", sans-serif; color:inherit; opacity:.7; background:transparent; border:1px solid transparent; cursor:pointer;
      flex:none; transition:background-color .12s, opacity .12s}
    #palentis-okundu svg{width:14px; height:14px}
    #palentis-okundu:hover{opacity:1; background:#fff; border-color:rgba(29,28,29,.13); color:#1d1c1d; box-shadow:0 1px 2px rgba(0,0,0,.06)}
    #palentis-okundu.done{opacity:1; color:#067647}
    #palentis-okundu.err{opacity:1; color:#b42318}
    ${BASLIK}:not(.p-channel_sidebar__section_heading--unreads) #palentis-okundu:not(.done){opacity:.35}
    /* İşlem sırasında açılan menü görünmesin */
    html.palentis-okundu-gizli .ReactModal__Overlay, html.palentis-okundu-gizli [data-qa="menu"], html.palentis-okundu-gizli .c-menu,
    html.palentis-okundu-gizli [role="menu"]{opacity:0 !important}`;
    document.head.append(stil);

    const bekle = (fn, ms = 1500) => new Promise((ok) => {
        const t0 = Date.now();
        (function dene() { const v = fn(); if (v || Date.now() - t0 > ms) return ok(v || null); setTimeout(dene, 40); })();
    });

    let mesgul = false;
    async function okunduYap(btn) {
        if (mesgul) return;
        const etiket = document.querySelector(ETIKET);
        if (!etiket) return durum(btn, 'err', 'Bulunamadı');
        mesgul = true;
        document.documentElement.classList.add('palentis-okundu-gizli');
        try {
            const r = etiket.getBoundingClientRect();
            etiket.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
            const madde = await bekle(() => [...document.querySelectorAll('[role="menuitem"], [data-qa*="menu_item"], button')]
                .find((e) => MENU_METNI.test((e.textContent || '').trim())));
            if (!madde) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                return durum(btn, 'err', 'Menü yok');
            }
            madde.click();
            durum(btn, 'done', 'Tamam');
        } finally {
            setTimeout(() => document.documentElement.classList.remove('palentis-okundu-gizli'), 250);
            mesgul = false;
        }
    }

    function durum(btn, cls, metin) {
        btn.classList.add(cls);
        btn.innerHTML = `${cls === 'done' ? CHK.replace(/<path d="M9.5[^>]*>/, '') : '!'} ${metin}`;
        setTimeout(() => { btn.classList.remove(cls); btn.innerHTML = `${CHK}Okundu`; }, 1200);
    }

    // Slack sidebar'ı sanal liste: satır yeniden çizilince buton gider → düzenli kontrol edip geri koy.
    function yerlestir() {
        const baslik = document.querySelector(BASLIK);
        if (!baslik || baslik.querySelector('#palentis-okundu')) return;
        const btn = document.createElement('span');
        btn.id = 'palentis-okundu';
        btn.setAttribute('role', 'button');
        btn.title = 'Tüm kanalları okundu yap (Mark all as read)';
        btn.innerHTML = `${CHK}Okundu`;
        // Başlığa tıklama bölümü açıp kapatıyor: butonun tıkı oraya gitmesin.
        for (const olay of ['mousedown', 'pointerdown', 'mouseup']) btn.addEventListener(olay, (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); okunduYap(btn); });
        const hedef = baslik.querySelector('[data-qa="channel_sidebar__section_heading_label__channels"]')?.parentElement || baslik;
        if (getComputedStyle(hedef).display.includes('flex')) hedef.append(btn);
        else { baslik.style.display = baslik.style.display || ''; baslik.append(btn); }
    }

    new MutationObserver(yerlestir).observe(document.body, { childList: true, subtree: true });
    setInterval(yerlestir, 2000);
    yerlestir();
})();
