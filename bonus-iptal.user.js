// ==UserScript==
// @name         Bonus İptal — 25.000 TL altı freespin kazancı
// @namespace    palentis.bonus-iptal
// @version      2.2.0
// @description  Transaction Report'taki yeni Platform Bonus (PLTFRM_BON) kayıtlarını izler; Zumabet Hosgeldin Freesin (limit 25.000 TL / 2.000 TL) ya da Zumabet-RiskTop (limit 10.000 TL / 1.000 TL) kaynaklı kazanç bonusunu (ör. Freespin Zuma) limit altındaysa iptal eder; limit ve üzerindeyse ayrıca tüm sağlayıcıları kısıtlar ve programın çekilebilir tutarını ekler. Slack kanalına bildirir. Tampermonkey menüsünden Açık / Kapalı seçilir.
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
 *   1. POLL_SEC'te bir, oturumu açık GT sekmelerinden YALNIZ BİRİ (lider) Transaction Report'u
 *      (Transaction Type = Platform Bonus, bugün) arka planda çeker.
 *   2. Yeni PLTFRM_BON satırı için oyuncunun bonus listesinde işlem saatinde açılmış kazanç bonusu
 *      (ör. "Freespin Zuma", tutar = kazanç) aranır ve hangi programdan geldiğine bakılır (PROGRAMS):
 *        · Etkinlik: kazanç bonusunun hemen altındaki (ondan hemen önce açılan) bonusun adında
 *          "Zumabet-RiskTop" geçiyor → limit 10.000 TL, ödeme 1.000 TL "Çekilebilir Etkinlik Bonusu".
 *        · Deneme: son LOOKBACK_H saatte "Zumabet Hosgeldin Freesin" var → limit 25.000 TL,
 *          ödeme 2.000 TL "Çekilebilir Deneme Bonusu".
 *      İkisi de yoksa ya da kazanç bonusu iptal edilebilir durumda değilse hiçbir şey olmaz.
 *   3. Kazanç < limit: DELETE /ics/player-bonus/{id} (panelin Cancel isteği) → durum Canceled
 *      olana kadar birkaç kez doğrulanır → Slack'e iptal mesajı.
 *   4. Kazanç ≥ limit: çift ödeme kontrolü → bonus iptali → tüm sağlayıcı kısıtı → programın tutarı
 *      MAN_ADJUST → Slack'e 💰 mesajı. Bir adım başarısız olursa sonrakiler yapılmaz, Slack'e yazılır.
 *   5. Kısıt geri açma: botun kısıtladığı oyuncu takibe alınır (o an çekim listesindeki talepler not
 *      edilir). WATCH_MIN'de bir çekim listesine bakılır; listede YENİ ve Completed bir çekim görülünce
 *      yalnızca botun kapattığı sağlayıcılar açılır (önceden kapalı olanlara dokunulmaz) ve 💰 mesajının
 *      altına "🔓 Çekim tamamlandı, sağlayıcılar açıldı." yazılır.
 *
 * DAYANIKLILIK (2.0.0'da baştan yazıldı)
 *   · Her panel / Slack isteğinin zaman aşımı var: takılan bir istek botu dondurmaz.
 *   · Oturumu olmayan (giriş yapılmamış / oturumu düşmüş) sekme liderliği almaz; hata alan lider
 *     liderliği bırakır, sağlıklı başka sekme devralır.
 *   · Defter tur başında bir kez okunur: gün içinde kayıt arttıkça bot yavaşlamaz.
 *   · Botun gönderdiği iptal isteği panelde geç görünse bile iptal bizim sayılır ve mesaj gider.
 *   · Slack'te bir mesaj gönderilemezse diğerlerini bekletmez; 5 denemeden sonra Durum'a düşer.
 *   · Durum: sürüm, GT tarafının son çalışması (oturum / rapor hatası), Slack, kuyruk, son kayıtlar.
 *
 * GÜVENLİK
 *   · Eşleşen bonus tek ve kesin değilse iptal yok (Slack'e uyarı).
 *   · Bonusu bot dışında biri iptal ettiyse sessizce geçilir.
 *   · İlk kurulumda listede zaten olan kayıtlar işlenmez.
 *   · Güncellemeden sonra yenilenmemiş eski sürüm sekmesi hiçbir şey yapmaz.
 */

(() => {
'use strict';

const CONFIG = {
    CHANNEL: 'C0C0N8PP37U',
    POLL_SEC: 30,
    LOOKBACK_H: 24,                       // program bonusu, kazançtan en fazla bu kadar saat önce açılmış olmalı
    MATCH_MIN: 5,                         // kazanç bonusu ile işlem saati arasındaki pay (dk)
    FIND_RETRY: 4,                        // bonus henüz görünmüyorsa kaç tur daha aransın
    CANCEL_RETRY: 3,                      // iptal isteği hata verirse kaç tur denensin (sonra Slack'e uyarı)
    VERIFY_TRIES: 4, VERIFY_GAP_MS: 1500, // iptal sonrası "Canceled" doğrulaması (panel birkaç sn gecikebilir)
    HTTP_TIMEOUT_MS: 20000,               // hiçbir istek bundan uzun bekletemez
    INFO_TIMEOUT_MS: 10000,               // mesajdaki ad / kullanıcı adı sorgusu
    LEADER_TTL_MS: 90000,                 // lider bu süre sessiz kalırsa başka sekme devralır
    SLACK_MAX_FAILS: 5,                   // bir Slack mesajı en fazla kaç kez denensin
    WATCH_MIN: 5,                         // kısıt açılacak oyuncuların çekim listesine kaç dakikada bir bakılsın
    WATCH_DAYS: 60,                       // bu kadar gün çekim yapmayan oyuncu takipten düşer (Durum'a yazılır)
};

const CANCELLABLE = ['ACTIVE', 'QUEUED', 'SPENT ACTIVE', 'PENDING'];   // panelin isCancellableBonus listesi
/** Kazancın geldiği programa göre limit / ödeme / açıklama / mesaj adı.
 *  prev: kazanç bonusunun hemen altındaki (ondan hemen önce açılan) bonus bu programınsa seçilir.
 *  window: son LOOKBACK_H saatte bu programın bonusu varsa seçilir. Sıra önemli: önce Etkinlik. */
const PROGRAMS = [
    { id: 'etkinlik', title: 'Etkinlik', how: 'prev', is: (n) => n.includes('zumabet-risktop'),
      limit: 10000, payout: 1000, note: 'Çekilebilir Etkinlik Bonusu' },
    { id: 'deneme', title: 'Deneme', how: 'window', is: (n) => n === 'zumabet hosgeldin freesin',
      limit: 25000, payout: 2000, note: 'Çekilebilir Deneme Bonusu' },
];
const isProgramBonus = (b) => PROGRAMS.some(p => p.is(String(b.planName || '').trim().toLowerCase()));
const tl = (n) => `${Number(n).toLocaleString('tr-TR')} TL`;
const MESSAGE_WIN = (P, x) => `${P.title} Bonusu freespinleri ile bakiyenizi ${tl(P.limit)} ve üzerine ulaştırdığınız için ${tl(P.payout)} çekilebilir bakiye hesabınıza eklenmiştir. Bonus kazancınız: *${x} TL*`;
const MESSAGE = (P, x) => `${P.title} Bonusu freespinleri ile bakiyenizi ${tl(P.limit)} ve üzerine ulaştırabilirseniz ${tl(P.payout)} çekim yapabilirsiniz. Bonus kazancınız: *${x} TL* olduğu için bonus iptal edilmiştir.`;

const HOST = 'https://core-secundus.gmntc.com';
const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const TAG = '[Bonus İptal]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clock = (t) => new Date(t).toLocaleTimeString('tr-TR');

/* ── sürüm: güncellemeden sonra yenilenmemiş eski sekmeler çalışmasın ── */
const VER = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
if (newer(VER, GM_getValue('ver', '0'))) GM_setValue('ver', VER);
const stale = () => newer(GM_getValue('ver', '0'), VER);

const MODES = { off: 'Kapalı', live: 'Açık' };
const mode = () => GM_getValue('mode', 'live') === 'off' ? 'off' : 'live';

/* ── menü (her iki sitede) ── */
GM_registerMenuCommand('Mod: Kapalı', () => { GM_setValue('mode', 'off'); alert('Bonus İptal KAPALI.'); });
GM_registerMenuCommand('Mod: Açık', () => { GM_setValue('mode', 'live'); alert('Bonus İptal AÇIK.'); });
GM_registerMenuCommand('Durum', () => {
    const rows = Object.entries(GM_getValue('book', {})).filter(([, v]) => v.result !== 'kurulumda mevcuttu').sort((a, b) => b[1].at - a[1].at);
    const last = rows.slice(0, 10).map(([id, v]) => `${id} · party ${v.party || '?'}: ${v.result || `aranıyor (${v.tries || 0})`}`).join('\n');
    const spent = rows.filter(([, v]) => v.spent).slice(0, 10).map(([id, v]) => `${v.party} (işlem ${id}): ${v.spent}`).join('\n');
    const g = GM_getValue('gtStatus', null);
    const gAge = g ? Math.round((Date.now() - g.at) / 60000) : null;
    const gLine = g ? `${g.msg} (${clock(g.at)}${gAge >= 3 ? ` — ${gAge} dk'dır çalışan GT sekmesi yok!` : ''})` : 'hiç çalışmadı — oturumu açık GT sekmesi yok';
    const s = GM_getValue('slackStatus', null);
    const q = GM_listValues().filter(k => k.startsWith('q:')).map(k => GM_getValue(k, null)).filter(Boolean);
    const qLine = q.length ? `${q.length} mesaj (en eskisi ${Math.round((Date.now() - Math.min(...q.map(x => x.at))) / 60000)} dk önce)` : 'boş';
    const failed = GM_getValue('failed', []).slice(-5).map(f => `${f.id} (${clock(f.at)}): ${f.err}`).join('\n');
    const watch = Object.values(GM_getValue('watch', {}));
    const opened = GM_getValue('watchDone', []).slice(-5).map(d => `${d.pid} (${d.program}, ${clock(d.at)}): ${d.result}`).join('\n');
    alert([
        `Sürüm: ${VER}${stale() ? ' — ESKİ SEKME, F5 ile yenileyin!' : ''}`,
        `Mod: ${MODES[mode()]}`,
        `GT: ${gLine}`,
        `Slack: ${s ? `${s.msg} (${clock(s.at)})` : 'hiç bağlanmadı — açık Slack sekmesi yok'}`,
        `Slack kuyruğu: ${qLine}`,
        ...(failed ? ['', 'Gönderilemeyen mesajlar:', failed] : []),
        '', `Çekim bekleyen, kısıtı açılacak: ${watch.length ? watch.map(e => `${e.pid} (${e.program})`).join(', ') : '—'}`,
        ...(opened ? ['Son açılanlar:', opened] : []),
        '', 'Son kayıtlar:', last || '—',
        '', 'İptal edilemeyen (Spent vb.) — party ID:', spent || '—',
    ].join('\n'));
});

if (location.hostname === 'app.slack.com') slackSide();
else gtSide();

/* ════════════════════════════════════════════════════════════
   GT TARAFI
   ════════════════════════════════════════════════════════════ */
function gtSide() {
    const ME = Math.random().toString(36).slice(2);

    /* ── oturum ve istekler ── */
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

    /** Zaman aşımlı fetch: panel bir isteğe hiç cevap vermezse bot o noktada sonsuza kadar beklemez. */
    async function http(url, init = {}) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), CONFIG.HTTP_TIMEOUT_MS);
        try { return await fetch(url, { credentials: 'include', ...init, signal: ac.signal }); }
        catch (e) { throw e.name === 'AbortError' ? new Error(`panel ${CONFIG.HTTP_TIMEOUT_MS / 1000} sn içinde cevap vermedi`) : e; }
        finally { clearTimeout(timer); }
    }
    async function ics(path, params = {}, method = 'GET', body) {
        const t = need();
        const url = `${HOST}/ics/${path}?${new URLSearchParams({ sessionKey: t, uType: 'staff', ...params })}`;
        const headers = { Accept: 'application/json', Authorization: `Bearer ${t}` };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await http(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${method} ${path.split('?')[0]}`);
        const text = await res.text();
        try { return JSON.parse(text); } catch { return text; }
    }

    /* ── yardımcılar ── */
    const asList = (d) => Array.isArray(d) ? d : (Object.values(d || {}).find(Array.isArray) || []);
    const clean = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const pad = (n) => String(n).padStart(2, '0');
    const dmy = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    /** "2026-10-09 21:05:55.37" → karşılaştırma için ms (saat dilimi iki tarafta aynı kabul edilir) */
    const stamp = (s) => { const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN; };
    const isCancelled = (b) => /cancel/i.test(String(b?.status || ''));

    /* ── Transaction Report: formu panelden al, PLTFRM_BON + bugün ile gönder ── */
    async function fetchPlatformBonuses() {
        const t = need();
        const base = `${HOST}/j/reports/TransactionReport.action`;
        const page = await http(`${base}?${new URLSearchParams({ embeddedInCore4: 'true', cmslanguage: 'en', token: t })}`);
        if (!page.ok) throw new Error('rapor formu HTTP ' + page.status);
        const form = new DOMParser().parseFromString(await page.text(), 'text/html').querySelector('#tranType')?.form;
        if (!form) throw new Error('rapor formu gelmedi — panel oturumu düşmüş olabilir, panele yeniden giriş yapın');

        const now = new Date();
        const from = new Date(now.getTime() - 2 * 3600e3);   // gece yarısı geçişinde dünü de kapsa
        const body = new URLSearchParams();
        for (const [k, v] of new FormData(form)) if (typeof v === 'string') body.append(k, v);
        body.set('tranType', 'PLTFRM_BON');
        body.set('startDate', dmy(from)); body.set('startHour', '00');
        body.set('endDate', dmy(now));    body.set('endHour', '23');
        body.set('currency', 'TRY');
        body.set('execute', 'Go');

        const res = await http(new URL(form.getAttribute('action') || base, HOST), {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        });
        if (!res.ok) throw new Error('rapor HTTP ' + res.status);
        const table = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById('transaction_report');
        if (!table) throw new Error('rapor tablosu gelmedi');

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
            const credit = num(col(r, 'CREDIT'));
            if (Number.isFinite(credit) && credit <= 0) continue;   // iptalin ters kaydı (borç) kazanç değildir
            out.push({ tranId, partyId, at: col(r, 'TRANSACTION DATE'), credit });
        }
        return out;
    }

    /* ── bonus eşleştirme ── */
    const playerBonuses = async (pid) => asList(await ics(`player-bonus/${pid}`, { currency: 'undefined' }));

    /** Kural: freespin kazancı (PLTFRM_BON) oyuncuya ayrı bir bonus olarak düşer (ör. "Freespin Zuma"; açılış saati =
     *  işlem saati, tutar = kazanç). İptal edilen bu kazanç bonusudur — yalnızca bir programdan (PROGRAMS) geliyorsa.
     *  { program, pick, already, ambiguous, candidates (program bonusları), wins (kazanç bonusu adayları) } */
    function matchBonus(list, tx) {
        const t = stamp(tx.at);
        const padMs = CONFIG.MATCH_MIN * 60000;
        const bt = (b) => stamp(b.triggerDate);
        const name = (b) => String(b.planName || '').trim().toLowerCase();
        const amt = (b) => { for (const k of ['amount', 'bonusAmount', 'initialAmount']) { const v = num(b[k]); if (Number.isFinite(v) && v > 0) return v; } return NaN; };
        const none = { program: null, pick: null, already: false, ambiguous: false, candidates: [], wins: [] };
        if (!Number.isFinite(t)) return none;
        let wins = list.filter(b => !isProgramBonus(b) && Math.abs(bt(b) - t) <= padMs);
        const same = wins.filter(b => Math.abs(amt(b) - tx.credit) < 0.01);   // tutar okunabiliyorsa aynı dakikadaki başka bonusu ayırır
        if (same.length) wins = same;
        const winIds = new Set(wins.map(b => String(b.id)));
        const inWindow = (b) => bt(b) <= t + padMs && bt(b) >= t - CONFIG.LOOKBACK_H * 3600e3 - padMs;
        // Kazancın hemen altındaki bonus: kazanç bonuslarından önce açılmış en yeni bonus
        const prev = list.filter(b => !winIds.has(String(b.id)) && inWindow(b) && bt(b) <= t + padMs)
            .sort((a, b) => bt(b) - bt(a) || Number(b.id) - Number(a.id))[0];
        let program = null, candidates = [];
        for (const P of PROGRAMS) {
            const c = P.how === 'prev' ? (prev && P.is(name(prev)) ? [prev] : []) : list.filter(b => P.is(name(b)) && inWindow(b));
            if (c.length) { program = P; candidates = c; break; }
        }
        const open = program ? wins.filter(b => CANCELLABLE.includes(String(b.status || '').toUpperCase())) : [];
        return {
            program,
            pick: open.length === 1 ? open[0] : null,
            ambiguous: open.length > 1,
            already: !!program && !open.length && wins.some(isCancelled),
            candidates,
            wins,
        };
    }

    /* ── Slack mesajları ── */
    const USER_KEYS = ['userName', 'username', 'login', 'loginName', 'nickName', 'nickname', 'alias', 'screenName'];
    /** Ad soyad + kullanıcı adı. Asla hata fırlatmaz, en fazla INFO_TIMEOUT_MS bekler (okunamayan '—'). */
    async function playerInfo(pid) {
        const capped = (pr) => Promise.race([pr.catch(() => null), sleep(CONFIG.INFO_TIMEOUT_MS).then(() => null)]);
        const [prof, det] = await Promise.all([`players/${pid}/full-profile`, `players/${pid}/detail`].map(u => capped(ics(u))));
        const full = (o) => [o?.firstName, o?.lastName].filter(Boolean).join(' ').trim();
        const src = { ...(det || {}), ...(prof || {}) };
        const user = USER_KEYS.map(k => src[k]).find(v => typeof v === 'string' && v.trim());
        return { name: full(prof) || full(det) || '—', user: user ? user.trim() : '—' };
    }
    /** Ortak düzen: emoji + kalın başlık, ad soyad, gövde, ID ve kullanıcı adı, varsa en altta italik not. */
    const card = (head, p, body, pid, note) => `${head}

*Adı Soyadı:* ${esc(p.name)}

${body}

*ID:* ${pid}
*Kullanıcı Adı:* ${esc(p.user)}${note ? `\n\n_${esc(note)}_` : ''}`;

    function enqueue(key, text, extra = {}) {
        GM_setValue('q:' + key, { text, at: Date.now(), v: VER, ...extra });
        GM_setValue('ping', Date.now());
    }
    /** Mesaj işlem kaydını bekletmez: önce defter kapanır, mesaj arkadan kuyruğa girer. */
    const notify = (key, head, pid, body, note) => playerInfo(pid).then(p => enqueue(key, card(head, p, body, pid, note)));

    /* ── defter: tur başında bir kez okunur, değişince yazılır ── */
    const Book = {
        d: {}, dirty: false,
        load() { this.d = GM_getValue('book', {}); this.dirty = false; },
        get(id) { return this.d[id]; },
        set(id, v) { this.d[id] = { ...(this.d[id] || {}), ...v, at: Date.now() }; this.dirty = true; },
        save() {
            if (!this.dirty) return;
            const week = Date.now() - 7 * 864e5;
            for (const k of Object.keys(this.d)) if (this.d[k].at < week) delete this.d[k];
            GM_setValue('book', this.d);
            this.dirty = false;
        },
    };
    const finish = (id, result, extra = {}) => { Book.set(id, { final: true, result, ...extra }); Book.save(); };

    /** Bu botun iptal isteği gönderdiği bonuslar (panelde geç görünse de, tekrar karşılaşınca da "bizim" sayılır). */
    const ours = () => GM_getValue('cancelled', {});
    function markOurs(bonusId) {
        const c = ours(), week = Date.now() - 7 * 864e5;
        for (const k of Object.keys(c)) if (c[k] < week) delete c[k];
        c[bonusId] = Date.now();
        GM_setValue('cancelled', c);
    }

    /* ── panel işlemleri ── */
    /** İptal + doğrulama. Panel durumu geç güncelleyebildiği için VERIFY_TRIES kez bakılır. */
    async function cancelBonus(pid, bonusId) {
        markOurs(bonusId);   // istekten ÖNCE: yanıt kaybolsa bile kendi iptalimiz sayılır
        const r = await ics(`player-bonus/${bonusId}`, {}, 'DELETE');
        if (r && typeof r === 'object' && r.status && r.status !== 'OK') throw new Error(`panel yanıtı: ${r.status}${r.message ? ' — ' + r.message : ''}`);
        let b = null;
        for (let i = 0; i < CONFIG.VERIFY_TRIES; i++) {
            await sleep(CONFIG.VERIFY_GAP_MS);
            b = (await playerBonuses(pid)).find(x => String(x.id) === String(bonusId));
            if (!b || isCancelled(b)) return;
        }
        throw new Error(`iptal sonrası durum hâlâ ${b.status}`);
    }

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
        const closed = (cur.nonLockedProviders || []).map(p => p.providerId).filter(id => id != null);   // botun kapatacakları
        if (!closed.length) return { count: all.length, already: true, closed };
        await ics(`player-lock-provider/${pid}`, {}, 'PUT', { lockedProviders: all });
        const after = await ics(`player-lock-provider/${pid}`);
        if ((after?.nonLockedProviders || []).length) throw new Error(`kısıt sonrası ${after.nonLockedProviders.length} sağlayıcı hâlâ açık`);
        return { count: all.length, already: false, closed };
    }

    /** Bu oyuncuya son 30 günde aynı tutarda manuel düzeltme yapılmış mı? (çift ödeme kalkanı) */
    /** Yalnız botun kapattığı sağlayıcıları açar: güncel kısıtlı listeden onlar çıkarılır, kalanlar kısıtlı kalır. */
    async function unlockProviders(pid, closed) {
        const ids = new Set(closed.map(String));
        const cur = await ics(`player-lock-provider/${pid}`);
        const keep = (cur?.lockedProviders || []).filter(p => !ids.has(String(p.providerId)))
            .map(p => ({ providerId: p.providerId, providerName: p.providerName }));
        await ics(`player-lock-provider/${pid}`, {}, 'PUT', { lockedProviders: keep });
        const after = await ics(`player-lock-provider/${pid}`);
        const still = (after?.lockedProviders || []).filter(p => ids.has(String(p.providerId))).length;
        if (still) throw new Error(`açma sonrası ${still} sağlayıcı hâlâ kısıtlı`);
    }

    /** Oyuncunun çekim talepleri (PlayerWithdrawals sayfası): durum değişince değişmeyen bir anahtar + durum. */
    async function withdrawals(pid) {
        const now = new Date();
        const url = `${HOST}/j/player/PlayerWithdrawals.action?${new URLSearchParams({ embeddedInNewDashboard: 'true', cmslanguage: 'en', token: need(),
            partyId: pid, startDate: dmy(new Date(now.getTime() - 90 * 864e5)), endDate: dmy(new Date(now.getTime() + 864e5)), execute: 'Go' })}`;
        const res = await http(url);
        if (!res.ok) throw new Error('çekim listesi HTTP ' + res.status);
        const table = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('#withdrawals');
        if (!table) throw new Error('çekim listesi gelmedi — panel oturumu düşmüş olabilir');
        const out = [];
        for (const row of table.querySelectorAll('tbody tr')) {
            const c = row.cells;
            if (c.length < 7) continue;
            // 2 = işlem tarihi, 4 = durum: ikisi de sonuçlanınca değişir, anahtara girmez
            out.push({ key: [0, 1, 3, 5, 6].map(i => clean(c[i])).join('|'), completed: /completed/i.test(clean(c[4])) });
        }
        return out;
    }

    async function alreadyPaid(pid, P) {
        const from = new Date(Date.now() - 30 * 864e5), to = new Date(Date.now() + 864e5);
        const rows = asList(await ics('player-transactions/page', {
            partyid: pid, startDate: `${ymd(from)} 0:0:0.000`, endDate: `${ymd(to)} 23:59:0.000`,
            pageSize: 200, pageNum: 1, tranTypes: 'MAN_ADJUST', currency: 'TRY',
        }));
        return rows.some(r => r.tranType === 'MAN_ADJUST' && Math.abs((+r.credit || +r.amount || 0) - P.payout) < 0.01);
    }

    async function addPayout(pid, P) {
        const sid = staffId();
        if (!sid) throw new Error('personel no (staffid) oturumdan okunamadı');
        const r = await ics('accounts/adjustments', {}, 'POST', {
            partyId: Number(pid), staffId: sid, tranType: 'MAN_ADJUST', amount: P.payout.toFixed(2),
            comment: P.note, tranTag: 0, tranMethod: null, subType: null, triggerBonus: null,
        });
        if (r && typeof r === 'object' && r.status && !/^(OK|SUCCESS)$/i.test(r.status)) throw new Error(`panel yanıtı: ${r.status}${r.message ? ' — ' + r.message : ''}`);
    }

    /* ── bir işlem ── */
    async function handle(tx) {
        const entry = Book.get(tx.tranId);
        if (entry?.final) return false;
        if (!entry?.party) Book.set(tx.tranId, { party: tx.partyId });
        if (!Number.isFinite(tx.credit)) { finish(tx.tranId, 'tutar okunamadı'); return true; }

        const m = matchBonus(await playerBonuses(tx.partyId), tx);
        const x = money(tx.credit);
        const P = m.program || PROGRAMS[PROGRAMS.length - 1];

        if (m.already) {
            const done = m.wins.find(b => isCancelled(b) && String(b.id) === String(entry?.attempt));
            if (done) {   // bu işlem için iptal isteğini biz gönderdik, panel sonradan Canceled gösterdi: başarılı iptal
                finish(tx.tranId, `iptal (${P.title}): ${done.planName} #${done.id} (panel geç doğruladı)`);
                notify(tx.tranId, `:no_entry: *${P.title} Bonusu İptal*`, tx.partyId, MESSAGE(P, x));
                return true;
            }
            const mine = m.wins.some(b => isCancelled(b) && ours()[b.id]);
            finish(tx.tranId, mine ? 'bizim iptal ettiğimiz bonus — tekrar kayıt, atlandı' : 'zaten iptal (bot dışında) — dokunulmadı');
            return true;
        }
        if (m.ambiguous) {
            finish(tx.tranId, 'birden fazla eşleşen bonus — dokunulmadı');
            notify(tx.tranId + '-amb', `:warning: *${P.title} Bonusu İptal Edilemedi*`, tx.partyId,
                `Birden fazla eşleşen bonus bulundu, hiçbirine dokunulmadı. Bonus kazancı: *${x} TL*`, `İşlem ${tx.tranId}`);
            return true;
        }
        if (!m.pick) {
            const tries = (entry?.tries || 0) + 1;
            if (tries < CONFIG.FIND_RETRY) { Book.set(tx.tranId, { tries }); Book.save(); return true; }   // bonus henüz oluşmamış olabilir
            const seen = `program: ${m.program ? `${m.program.title} ` : ''}${m.candidates.map(b => `#${b.id} ${b.status}`).join(', ') || 'yok'} · kazanç bonusu: ${m.wins.map(b => `#${b.id} ${b.status}`).join(', ') || 'yok'}`;
            const spent = m.candidates.length && m.wins.length ? m.wins.map(b => `${b.planName} #${b.id} ${b.status}`).join(', ') : undefined;
            finish(tx.tranId, `iptal edilebilir bonus yok (${seen})`, { spent });   // deneme bonusu değil ya da iptal edilemez: mesaj yok
            return true;
        }

        const info = `${m.pick.planName} #${m.pick.id}`;
        if (tx.credit >= P.limit) { await payoutFlow(tx, P, m.pick, x, info); return true; }

        Book.set(tx.tranId, { attempt: m.pick.id }); Book.save();   // sonraki turda "geç doğrulanan bizim iptalimiz" diye tanınsın
        try {
            await cancelBonus(tx.partyId, m.pick.id);
        } catch (e) {
            // İsteği biz gönderdik ve bonus artık iptal görünüyor: iptal bizimdir, mesaj normal gider
            const now = await playerBonuses(tx.partyId).then(l => l.find(b => String(b.id) === String(m.pick.id))).catch(() => null);
            if (!(now && isCancelled(now) && ours()[m.pick.id])) {
                const ct = (entry?.cancelTries || 0) + 1;
                if (ct < CONFIG.CANCEL_RETRY) { Book.set(tx.tranId, { cancelTries: ct, result: `iptal denemesi ${ct}: ${e.message}` }); Book.save(); warn(`${tx.tranId}: iptal denemesi ${ct}`, e.message); return true; }
                finish(tx.tranId, `iptal başarısız: ${e.message}`);
                notify(tx.tranId + '-err', `:warning: *${P.title} Bonusu İptal Edilemedi*`, tx.partyId,
                    `Bonus kazancı: *${x} TL* — bonus elle iptal edilmeli.`, `Hata: ${e.message} · ${info}`);
                return true;
            }
            warn(`${tx.tranId}: doğrulama gecikti ama bonus iptal edilmiş`, e.message);
        }
        finish(tx.tranId, `iptal (${P.title}): ${info}`);
        notify(tx.tranId, `:no_entry: *${P.title} Bonusu İptal*`, tx.partyId, MESSAGE(P, x));
        log(`${tx.tranId}: İPTAL → ${info}, kazanç ${x}`);
        return true;
    }

    /** Limit üstü: çift ödeme kontrolü → bonus iptali → tüm sağlayıcı kısıtı → 2.000 TL. Adım başarısızsa durur. */
    async function payoutFlow(tx, P, bonus, x, info) {
        const pid = tx.partyId;
        const paid = GM_getValue('paid', {});
        const paidKey = P.id === 'deneme' ? pid : `${pid}:${P.id}`;   // her program ayrı (deneme eski kayıtla uyumlu)
        const done = [];
        try {
            if (paid[paidKey]) throw new Error(`bu oyuncuya ${P.title} ödemesi daha önce yapılmış (bot kaydı)`);
            if (await alreadyPaid(pid, P)) throw new Error(`son 30 günde ${money(P.payout)} TL manuel düzeltme zaten var`);

            try { await cancelBonus(pid, bonus.id); }
            catch (e) {   // doğrulama gecikmesi: bir süre daha bak, iptal görünürse devam
                let ok = false;
                for (let i = 0; i < CONFIG.VERIFY_TRIES * 2 && !ok; i++) {
                    await sleep(CONFIG.VERIFY_GAP_MS * 2);
                    const now = await playerBonuses(pid).then(l => l.find(b => String(b.id) === String(bonus.id))).catch(() => null);
                    ok = !!now && isCancelled(now);
                }
                if (!ok) throw e;
            }
            done.push(`bonus iptal (${info})`);

            const lock = await lockAllProviders(pid);
            done.push(lock.already ? 'sağlayıcılar zaten kısıtlı' : `${lock.count} sağlayıcı kısıtlandı`);
            // Çekim takibi için o anki talepler (sonradan gelen ve Completed olan çekim kısıtı açar)
            const before = lock.closed.length ? await withdrawals(pid).then(l => l.map(w => w.key)).catch(() => null) : null;

            paid[paidKey] = Date.now();   // POST'tan ÖNCE: istek gidip yanıt kaybolsa bile ikinci kez ödeme yapılmaz
            GM_setValue('paid', paid);
            await addPayout(pid, P);
            done.push(`+${money(P.payout)} TL eklendi`);

            if (lock.closed.length) {   // bot kapattıysa takibe al; zaten kapalıysa bot sorumlu değil
                const w = GM_getValue('watch', {});
                w[`${pid}:${P.id}`] = { pid, tx: tx.tranId, program: P.title, at: Date.now(), closed: lock.closed, before };
                GM_setValue('watch', w);
            }
            finish(tx.tranId, `limit üstü (${P.title}): ${done.join(', ')}`);
            notify(tx.tranId, `:moneybag: *${P.title} Bonusu Çekilebilir Bakiye*`, pid, MESSAGE_WIN(P, x));
            log(`${tx.tranId}: limit üstü tamam → ${done.join(', ')}`);
        } catch (e) {
            finish(tx.tranId, `limit üstü (${P.title}) yarım kaldı (${done.join(', ') || 'hiçbir adım'}): ${e.message}`);
            notify(tx.tranId + '-err', `:warning: *${P.title} Bonusu Çekilebilir Bakiye — Tamamlanamadı*`, pid,
                `Bonus kazancı: *${x} TL*\n*Yapılanlar:* ${esc(done.join(', ') || 'hiçbiri')} — kalan adımlar elle yapılmalı.`, `Hata: ${e.message}`);
            warn(`${tx.tranId}: limit üstü akış durdu`, done, e);
        }
    }

    /* ── kısıt geri açma: botun kısıtladığı oyuncuların çekimini izle ── */
    async function checkWatch() {
        const w = GM_getValue('watch', {});
        const keys = Object.keys(w);
        if (!keys.length) return;
        for (const k of keys) {
            const e = w[k];
            try {
                if (Date.now() - e.at > CONFIG.WATCH_DAYS * 864e5) { e.done = `takipten düştü (${CONFIG.WATCH_DAYS} gün çekim yok)`; continue; }
                const list = await withdrawals(e.pid);
                if (!e.before) { e.before = list.map(x => x.key); continue; }   // ilk bakış: o anki talepler not edilir
                const seen = new Set(e.before);
                if (!list.some(x => x.completed && !seen.has(x.key))) continue;
                await unlockProviders(e.pid, e.closed);
                e.done = 'sağlayıcılar açıldı';
                enqueue(`${e.tx}-open`, ':unlock: Çekim tamamlandı, sağlayıcılar açıldı.', { thread: e.tx, pid: e.pid });
                log(`${e.pid}: çekim tamamlandı, sağlayıcılar açıldı`);
            } catch (err) {
                e.fails = (e.fails || 0) + 1;
                warn(`${e.pid}: kısıt açma kontrolü`, err.message);
                if (e.fails >= 3 && /açma sonrası|HTTP 4/.test(err.message)) {
                    e.done = `açılamadı: ${err.message}`;
                    enqueue(`${e.tx}-open-err`, `:warning: Çekim tamamlandı ama sağlayıcılar açılamadı — elle açılmalı.\n_Hata: ${esc(err.message)}_`, { thread: e.tx, pid: e.pid });
                }
            }
        }
        const fresh = GM_getValue('watch', {});   // bu arada eklenen olduysa koru
        for (const k of keys) { if (w[k].done) { const d = GM_getValue('watchDone', []); d.push({ pid: w[k].pid, program: w[k].program, at: Date.now(), result: w[k].done }); GM_setValue('watchDone', d.slice(-20)); delete fresh[k]; } else fresh[k] = w[k]; }
        GM_setValue('watch', fresh);
    }
    let lastWatch = 0;

    /* ── döngü: tek lider sekme ── */
    const gtStatus = (msg) => GM_setValue('gtStatus', { msg, at: Date.now() });
    const isLeader = () => GM_getValue('leader', null)?.owner === ME;
    function claimLeader() {
        const lead = GM_getValue('leader', null);
        if (lead && lead.owner !== ME && Date.now() - lead.at < CONFIG.LEADER_TTL_MS) return false;
        GM_setValue('leader', { owner: ME, at: Date.now() });
        return true;
    }
    const releaseLeader = () => { if (isLeader()) GM_deleteValue('leader'); };

    let busy = false, busySince = 0;
    async function tick() {
        if (busy) {
            if (Date.now() - busySince < 5 * 60000) return;
            warn('5 dakikadır biten tur yok — sıfırlanıyor');   // her istek zaman aşımlı; yine de son emniyet
            busy = false;
        }
        if (mode() === 'off' || stale()) return;
        // Oturumu olmayan sekme liderliği almaz (alırsa sağlıklı sekmeyi de bekletirdi)
        if (!token()) { if (isLeader()) { releaseLeader(); gtStatus('GT oturumu yok — panele giriş yapılmamış ya da oturum düşmüş'); } return; }
        if (!claimLeader()) return;

        busy = true; busySince = Date.now();
        try {
            const txs = await fetchPlatformBonuses();
            Book.load();
            if (!GM_getValue('seeded', false)) {
                for (const tx of txs) Book.set(tx.tranId, { final: true, result: 'kurulumda mevcuttu', party: tx.partyId });
                Book.save();
                GM_setValue('seeded', true);
                gtStatus(`ilk kurulum: ${txs.length} kayıt görüldü sayıldı`);
                return;
            }
            for (const tx of txs) if (Book.get(tx.tranId) && !Book.get(tx.tranId).party) Book.set(tx.tranId, { party: tx.partyId });
            let worked = 0;
            for (const tx of txs) {
                GM_setValue('leader', { owner: ME, at: Date.now() });   // uzun turda liderlik düşmesin
                try { if (await handle(tx)) worked++; }
                catch (e) {
                    const tries = (Book.get(tx.tranId)?.tries || 0) + 1;
                    warn(`${tx.tranId}: işlenemedi`, e.message);
                    Book.set(tx.tranId, tries >= 10 ? { tries, final: true, result: `hata: ${e.message}` } : { tries, result: `hata (${tries}): ${e.message}` });
                    Book.save();
                }
            }
            Book.save();
            if (Date.now() - lastWatch > CONFIG.WATCH_MIN * 60000) { lastWatch = Date.now(); await checkWatch(); }
            gtStatus(`çalışıyor — bugün ${txs.length} platform bonusu${worked ? `, bu tur ${worked} işlem` : ''}`);
        } catch (e) {
            warn('tur başarısız:', e.message);
            gtStatus(`HATA: ${e.message}`);
            releaseLeader();   // sağlıklı başka sekme varsa o devralsın
        } finally { busy = false; }
    }

    /* ── teşhis menüleri ── */
    GM_registerMenuCommand('Test: örnek iptal mesajı gönder (iptal yapmaz)', async () => {
        try {
            const [tx] = await fetchPlatformBonuses();
            if (!tx) { alert('Bugün platform bonus kaydı yok; örnek için bir oyuncu bulunamadı.'); return; }
            const p = await playerInfo(tx.partyId);
            enqueue('test-' + Date.now(), `:test_tube: _TEST — bu betiğin (${VER}) mesaj biçimi, hiçbir bonus iptal edilmedi_\n\n` +
                card(':no_entry: *Deneme Bonusu İptal*', p, MESSAGE(PROGRAMS[PROGRAMS.length - 1], money(tx.credit)), tx.partyId));
            alert(`Örnek mesaj kuyruğa alındı (oyuncu ${tx.partyId}: ${p.name} / ${p.user}). Birkaç saniye içinde Slack kanalında görünmeli.`);
        } catch (e) { alert('Test hatası: ' + e.message); }
    });
    GM_registerMenuCommand('Teşhis: son platform bonusunu değerlendir / işle', async () => {
        try {
            const [tx] = await fetchPlatformBonuses();
            if (!tx) { alert('Bugün platform bonus kaydı yok.'); return; }
            const m = matchBonus(await playerBonuses(tx.partyId), tx);
            const rec = GM_getValue('book', {})[tx.tranId];
            const lines = [
                `Transaction ${tx.tranId} · Party ${tx.partyId} · ${tx.at} · ${money(tx.credit)} TL`,
                m.program ? `Program: ${m.program.title} (limit ${tl(m.program.limit)}, ödeme ${tl(m.program.payout)})` : 'Program: yok (Hosgeldin / RiskTop bulunamadı)',
                m.program ? (tx.credit < m.program.limit ? 'Limit altı → bonus iptali + mesaj' : `Limit üstü → bonus iptali + tüm sağlayıcı kısıtı + ${tl(m.program.payout)}`) : '—',
                `Personel no (oturum): ${staffId() ?? 'OKUNAMADI'}`,
                `Eşleşen bonus: ${m.pick ? `${m.pick.planName} #${m.pick.id} (${m.pick.status})` : m.already ? 'zaten iptal edilmiş' : m.ambiguous ? 'birden fazla!' : 'yok'}`,
                `Program bonusu: ${m.candidates.map(b => `${b.planName} #${b.id} ${b.status}`).join(', ') || '—'}`,
                `İşlem saatinde açılan kazanç bonusu: ${m.wins.map(b => `${b.planName} #${b.id} ${b.status}`).join(', ') || '—'}`,
                `Bot kaydı: ${rec ? (rec.result || `aranıyor (${rec.tries || 0})`) : 'henüz işlenmedi'}`,
                `Mod: ${MODES[mode()]}`,
            ];
            if (!m.pick || mode() === 'off') { alert([...lines, '', 'Teşhis yalnızca değerlendirir: iptal edilmedi, Slack\'e yazılmadı.'].join('\n')); return; }
            if (!confirm([...lines, '', `Bu işlem şimdi işlensin mi? ${m.pick.planName} #${m.pick.id} iptal edilip Slack'e yazılsın mı?`].join('\n'))) return;
            while (busy) await sleep(500);
            busy = true; busySince = Date.now();
            try {
                Book.load();
                delete Book.d[tx.tranId]; Book.dirty = true;
                await handle(tx);
                Book.save();
            } finally { busy = false; }
            alert(`Sonuç: ${GM_getValue('book', {})[tx.tranId]?.result || 'işlenemedi'}`);
        } catch (e) { alert('Teşhis hatası: ' + e.message); }
    });

    setInterval(tick, CONFIG.POLL_SEC * 1000);
    setTimeout(tick, 4000);
    log(`hazır (${VER}). Mod: ${MODES[mode()]}`);
}

/* ════════════════════════════════════════════════════════════
   SLACK TARAFI
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
        const go = async () => {
            try { return await W.fetch(url, typeof cloneInto === 'function' ? cloneInto(init, W) : init); }
            catch { return fetch(url, init); }
        };
        const res = await Promise.race([go(), sleep(CONFIG.HTTP_TIMEOUT_MS).then(() => { throw new Error(`Slack ${CONFIG.HTTP_TIMEOUT_MS / 1000} sn içinde cevap vermedi`); })]);
        if (res.status === 429) return { ok: false, error: 'ratelimited', retry: (+res.headers.get('retry-after') || 5) * 1000 };
        return JSON.parse(await res.text());
    }
    async function resolveToken() {
        const cands = collectTokens();
        if (!cands.length) throw new Error('Slack oturum anahtarı bulunamadı');
        const errs = [];
        for (const t of cands) {
            try { const r = await call('conversations.info', { channel: CONFIG.CHANNEL }, t); if (r.ok) { token = t; return; } errs.push(r.error); }
            catch (e) { errs.push(e.message); }
        }
        throw new Error(`hiçbir oturum ${CONFIG.CHANNEL} kanalını göremiyor [${[...new Set(errs)].join(', ')}]`);
    }
    const PERMANENT = /channel_not_found|not_in_channel|is_archived|msg_too_long|no_text|restricted_action|invalid_blocks/;
    /** Aynı işlem için daha önce mesaj gittiyse (ör. Teşhis'ten yeniden işlenince) yenisi atılmaz, eskisi güncellenir. */
    async function send(text, prev, thread) {
        for (let i = 0; i < 4; i++) {
            const r = prev
                ? await call('chat.update', { channel: CONFIG.CHANNEL, ts: prev, text })
                : await call('chat.postMessage', { channel: CONFIG.CHANNEL, text, unfurl_links: 'false', unfurl_media: 'false', ...(thread ? { thread_ts: thread } : {}) });
            if (r.ok) return r;
            if (prev && /message_not_found|cant_update_message|edit_window_closed/.test(r.error)) { prev = null; continue; }
            if (r.error === 'ratelimited') { await sleep(r.retry); continue; }
            if (/invalid_auth|not_authed|token_revoked/.test(r.error)) { token = null; await resolveToken(); continue; }
            throw new Error(r.error || 'bilinmeyen hata');
        }
        throw new Error('4 denemede gönderilemedi');
    }
    function giveUp(id, v, err) {
        const f = GM_getValue('failed', []);
        f.push({ id, at: Date.now(), err, text: String(v.text).slice(0, 300) });
        GM_setValue('failed', f.slice(-20));
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
                const id = k.slice(2);
                if (Date.now() - v.at > 24 * 3600e3) { giveUp(id, v, '24 saat gönderilemedi'); GM_deleteValue(k); continue; }
                if (!v.v || v.adopt) { GM_deleteValue(k); continue; }   // eski sürümlerden kalan kayıtlar
                GM_setValue('slackLock', { owner: ME, at: Date.now() });
                try {
                    const sent = GM_getValue('sent', {});
                    // Kısıt açma notu 💰 mesajının altına (thread) gider; o mesaj bulunamazsa ID ile ayrı mesaj olur
                    const parent = v.thread ? sent[v.thread]?.ts : null;
                    const text = v.thread && !parent ? `${v.text}\n*ID:* ${v.pid}` : v.text;
                    const r = await send(text, sent[id]?.ts, parent);
                    const week = Date.now() - 7 * 864e5;
                    for (const x of Object.keys(sent)) if (sent[x].at < week) delete sent[x];
                    sent[id] = { ts: r.ts || sent[id]?.ts, at: Date.now() };
                    GM_setValue('sent', sent);
                    GM_deleteValue(k);
                    status(`son gönderim ${id}`);
                } catch (e) {
                    // Bu mesaj diğerlerini bekletmez: sayılır, kalıcı hatada ya da SLACK_MAX_FAILS'te bırakılır
                    const fails = (v.fails || 0) + 1;
                    warn(`${id} gönderilemedi (${fails}):`, e.message);
                    status(`HATA (${id}): ${e.message}`);
                    if (PERMANENT.test(e.message) || fails >= CONFIG.SLACK_MAX_FAILS) { giveUp(id, v, e.message); GM_deleteValue(k); }
                    else GM_setValue(k, { ...v, fails });
                    if (!token) break;   // oturum yoksa diğerlerini de deneme
                }
                await sleep(1200);
            }
        } catch (e) { warn('Slack:', e.message); status(`HATA: ${e.message}`); }
        finally { busy = false; GM_deleteValue('slackLock'); }
    }
    GM_addValueChangeListener('ping', () => flush());
    setInterval(flush, 20000);
    setTimeout(flush, 3000);
    status('bağlı, bekliyor');

    /** Kanaldaki son mesajları kim attı? Bu betiğin attıkları 'sent' kaydından tanınır. */
    GM_registerMenuCommand('Teşhis: kanaldaki son mesajlar kimden?', async () => {
        try {
            if (!token) await resolveToken();
            const h = await call('conversations.history', { channel: CONFIG.CHANNEL, limit: '12' });
            if (!h.ok) throw new Error(h.error);
            const mine = new Set(Object.values(GM_getValue('sent', {})).map(x => x.ts));
            const names = {};
            const who = async (m) => {
                if (m.bot_id || m.bot_profile) return `BOT/uygulama: ${m.bot_profile?.name || m.username || m.bot_id}`;
                if (!m.user) return '?';
                if (!(m.user in names)) { const u = await call('users.info', { user: m.user }); names[m.user] = u.ok ? (u.user.real_name || u.user.name) : m.user; }
                return names[m.user];
            };
            const lines = [];
            for (const m of h.messages || []) {
                const t = new Date(+m.ts * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                lines.push(`${t} · ${await who(m)}${mine.has(m.ts) ? ' · ✅ BU BETİK' : ''}${m.subtype ? ' · ' + m.subtype : ''}\n   ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 60)}`);
            }
            alert(`Sürüm ${VER} · kanal ${CONFIG.CHANNEL}\n\n${lines.join('\n') || '—'}`);
        } catch (e) { alert('Teşhis hatası: ' + e.message); }
    });
}

})();
