// ==UserScript==
// @name         Telegram Alarm
// @namespace    palentis-telegram-alarm
// @version      1.0
// @description  Telegram Web'de okunmamış mesaj sayısı artınca ses çalar (sessize alınmış sohbetler sayılmaz). Tarayıcı kuralı gereği ses, sayfaya ilk tıklamadan sonra açılır.
// @match        https://web.telegram.org/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
    'use strict';

    const ARALIK_MS = 1500;       // tarama sıklığı
    const TEKRAR_MS = 10000;      // aynı yeni mesaj için ikinci çalış (okunmadıysa)

    /** Okunmamış sayısı: sohbet listesindeki sessize alınmamış rozetlerin toplamı;
     *  liste görünmüyorsa sekme başlığındaki sayı. (WebK /k/ ve WebA /a/ sürümleri.) */
    function okunmamis() {
        let toplam = 0;
        for (const b of document.querySelectorAll('.ChatBadge, .dialog-subtitle-badge-unread, .badge-unread')) {
            const cls = `${b.className} ${b.parentElement?.className || ''}`;
            if (/muted|gray|grey|is-muted|mention-muted/i.test(cls)) continue;
            if (b.closest('.ChatBadge') && b.closest('.ChatBadge') !== b) continue;   // iç içe rozet iki kez sayılmasın
            const n = parseInt((b.textContent || '').replace(/\D/g, ''), 10);
            if (n > 0) toplam += n;
        }
        const baslik = parseInt((document.title.match(/\((\d+)\)|^(\d+)\s/) || []).slice(1).find(Boolean), 10) || 0;
        return Math.max(toplam, baslik);
    }

    // ============ SES ============
    let ctx = null;
    const sesAcik = () => ctx && ctx.state === 'running';
    function context() {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }
    ['pointerdown', 'keydown'].forEach((o) => window.addEventListener(o, () => { context(); rozet(); }, { capture: true, passive: true }));

    function cal() {
        try {
            const c = context(), t0 = c.currentTime;
            // Slack alarmından ayrışsın: yükselen iki yumuşak ton, iki kez
            [0, 0.42].forEach((d) => [[880, 0], [1320, 0.14]].forEach(([f, o]) => {
                const osc = c.createOscillator(), g = c.createGain();
                osc.type = 'triangle'; osc.frequency.value = f;
                osc.connect(g); g.connect(c.destination);
                const s = t0 + d + o;
                g.gain.setValueAtTime(0, s);
                g.gain.linearRampToValueAtTime(0.35, s + 0.02);
                g.gain.exponentialRampToValueAtTime(0.001, s + 0.26);
                osc.start(s); osc.stop(s + 0.3);
            }));
        } catch (e) { console.log('[Telegram Alarm] ses hatası:', e); }
    }

    // ============ SES KAPALI UYARISI ============
    // Tarayıcı, sayfaya bir kez tıklanmadan ses çalmaya izin vermez; o sürece küçük bir uyarı görünür.
    let uyari = null;
    function rozet() {
        const gerek = !sesAcik();
        if (gerek && !uyari) {
            uyari = document.createElement('div');
            uyari.textContent = '🔇 Telegram alarmı: sesi açmak için sayfaya bir kez tıkla';
            uyari.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;padding:8px 12px;background:#fff;color:#b42318;'
                + 'border:1px solid #fda29b;border-radius:10px;box-shadow:0 4px 12px rgba(16,24,40,.12);font:600 12px system-ui,sans-serif;cursor:pointer';
            document.body.append(uyari);
        } else if (!gerek && uyari) { uyari.remove(); uyari = null; }
    }

    // ============ DÖNGÜ ============
    let son = null, tekrar = null;
    setInterval(() => {
        const n = okunmamis();
        if (son !== null && n > son) {
            cal();
            clearTimeout(tekrar);
            const bekleyen = n;
            tekrar = setTimeout(() => { if (okunmamis() >= bekleyen) cal(); }, TEKRAR_MS);
        }
        if (n === 0) clearTimeout(tekrar);
        son = n;
        rozet();
    }, ARALIK_MS);

    console.log('[Telegram Alarm] aktif.');
})();
