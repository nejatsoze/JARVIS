// ==UserScript==
// @name         LiveChat — Canlı Chat İzleme Paneli
// @namespace    livechat-canli-izleme
// @version      2.0.0
// @description  O an yürüyen tüm chatleri duruma göre gruplayan, sürüklenip boyutlandırılabilen bir panelde listeler; konuşmayı canlı okursun, üyenin IP/konum/cihaz/site bilgilerini görürsün, tek tıkla supervise edersin.
// @author       —
// @match        https://my.livechatinc.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.livechatinc.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 0. SABİTLER
  // ============================================================
  const VERSION = '2.0.0';
  const API = 'https://api.livechatinc.com/v3.5/agent/action/';
  const LIST_INTERVAL = 5000;     // aktif chat listesi yenileme (ms)
  const CHAT_INTERVAL = 3000;     // açık konuşma yenileme (ms)
  const CUSTOMER_TTL = 60000;     // müşteri detayı önbellek süresi (ms)
  const MAX_PAGES = 5;            // list_chats için azami sayfa
  const WAIT_WARN = 60;           // müşteri bu kadar sn cevapsız kalırsa ⏳ uyarısı
  const HOME_COUNTRY = 'TR';      // bunun dışındaki ülke IP'leri işaretlenir
  const BOT_NAMES = ['zumabet chatbot'];   // küçük harf; bu adlı agentlar "Chatbot" kategorisine düşer

  // Sıra ekrandaki sıradır. Chatbot varsayılan olarak kapalı başlar.
  const CATS = [
    { k: 'bot', t: 'Chatbot', color: 'var(--bot)', closed: true },
    { k: 'active', t: 'Aktif chat', color: 'var(--ok)' },
    { k: 'queue', t: 'Bekleyenler', color: 'var(--warn)' },
  ];

  const S = {
    get: (k, d) => GM_getValue(k, d),
    set: (k, v) => GM_setValue(k, v),
  };

  const state = {
    chats: [],            // aktif chat özetleri (list_chats)
    selected: null,       // seçili chat id
    detail: null,         // seçili chatin get_chat cevabı
    customers: {},        // customerId -> { at, data } (get_customer önbelleği)
    seen: {},             // chatId -> görülen son mesaj zamanı
    closed: Object.assign(Object.fromEntries(CATS.map((c) => [c.k, !!c.closed])), S.get('closedCats', {})),
    filter: '',
    error: '',
    chatTimer: null,
    open: S.get('open', false),
    info: S.get('infoOpen', true),
  };

  // ============================================================
  // 1. API
  // ============================================================
  function creds() {
    return {
      account: S.get('accountId', ''),
      pat: S.get('pat', ''),
      email: S.get('email', ''),
    };
  }

  function call(action, payload) {
    const c = creds();
    if (!c.account || !c.pat) return Promise.reject(new Error('Ayarlar eksik: Account ID ve PAT girin (⚙).'));
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + btoa(c.account + ':' + c.pat),
    };
    // PAT "fra:..." / "dal:..." önekiyle geliyorsa bölge başlığı gerekir.
    const m = /^(dal|fra)[:-]/.exec(c.pat);
    if (m) headers['X-Region'] = m[1];
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: API + action,
        headers,
        data: JSON.stringify(payload || {}),
        timeout: 15000,
        onload: (r) => {
          let body = null;
          try { body = JSON.parse(r.responseText); } catch (_) { /* boş gövde */ }
          if (r.status >= 200 && r.status < 300) return resolve(body || {});
          const msg = (body && body.error && body.error.message) || ('HTTP ' + r.status);
          reject(new Error(action + ': ' + msg));
        },
        onerror: () => reject(new Error(action + ': ağ hatası')),
        ontimeout: () => reject(new Error(action + ': zaman aşımı')),
      });
    });
  }

  async function fetchActiveChats() {
    const out = [];
    let pageId = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const payload = pageId ? { page_id: pageId } : { filters: { include_active: true }, limit: 100, sort_order: 'desc' };
      const res = await call('list_chats', payload);
      const page = res.chats_summary || [];
      const active = page.filter((c) => c.last_thread_summary && c.last_thread_summary.active);
      out.push(...active);
      // Sıralama son aktiviteye göre; aktif chat içermeyen sayfadan sonrası eski kayıttır.
      if (!active.length || !res.next_page_id) break;
      pageId = res.next_page_id;
    }
    return out;
  }

  function fetchDetail(chat) {
    return call('get_chat', { chat_id: chat.id, thread_id: chat.last_thread_summary.id });
  }

  // Chat içindeki müşteri nesnesinde ziyaret bilgisi yoksa müşteri kaydından tamamlanır
  // (token'da customers:ro yetkisi gerekir; yoksa sessizce atlanır).
  async function fetchCustomer(id) {
    const hit = state.customers[id];
    if (hit && Date.now() - hit.at < CUSTOMER_TTL) return hit.data;
    try {
      const data = await call('get_customer', { id });
      state.customers[id] = { at: Date.now(), data };
      return data;
    } catch (_) {
      state.customers[id] = { at: Date.now(), data: null };
      return null;
    }
  }

  function supervise(chatId) {
    const { email } = creds();
    if (!email) return Promise.reject(new Error('Supervise için ⚙ ayarlarına kendi agent e-postanızı girin.'));
    return call('add_user_to_chat', {
      chat_id: chatId,
      user_id: email,
      user_type: 'agent',
      visibility: 'agents',
    });
  }

  // ============================================================
  // 2. YARDIMCILAR
  // ============================================================
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const ts = (iso) => (iso ? new Date(iso).getTime() : 0);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isBot = (u) => u && BOT_NAMES.includes(String(u.name || '').trim().toLowerCase());

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + ' sn';
    if (s < 3600) return Math.floor(s / 60) + ' dk';
    return Math.floor(s / 3600) + ' sa ' + Math.floor((s % 3600) / 60) + ' dk';
  }

  const hhmm = (iso) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dmy = (iso) => new Date(iso).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const flag = (cc) => (/^[A-Za-z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

  function initials(name) {
    return String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  }
  function hue(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 42%)`;
  }

  function parseUA(ua) {
    if (!ua) return '';
    const os = /Windows NT 10/.test(ua) ? 'Windows 10/11' : /Windows/.test(ua) ? 'Windows'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android ([\d.]+)/.test(ua) ? 'Android ' + RegExp.$1
        : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Bilinmeyen OS';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung'
      : /YaBrowser/.test(ua) ? 'Yandex' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı';
    const mob = /Mobi|Android|iPhone|iPod/.test(ua);
    return `${br} · ${os} · ${mob ? 'Mobil' : 'Masaüstü'}`;
  }

  // session_fields LiveChat'te [{anahtar: değer}, ...] biçiminde gelir.
  function sessionFields(sf) {
    const out = [];
    (Array.isArray(sf) ? sf : [sf || {}]).forEach((o) => Object.entries(o || {}).forEach(([k, v]) => out.push([k, v])));
    return out;
  }

  function customerOf(users) {
    return (users || []).find((u) => u.type === 'customer') || {};
  }

  function summarize(c) {
    const users = c.users || [];
    const customer = customerOf(users);
    const agents = users.filter((u) => u.type === 'agent' && u.present !== false);
    const humans = agents.filter((a) => !isBot(a));
    const lastMsg = c.last_event_per_type && c.last_event_per_type.message && c.last_event_per_type.message.event;
    const lastAuthor = lastMsg && users.find((u) => u.id === lastMsg.author_id);
    const waiting = lastMsg && lastAuthor && lastAuthor.type === 'customer' ? ts(lastMsg.created_at) : 0;
    const cat = humans.length ? 'active' : agents.length ? 'bot' : 'queue';
    const lv = customer.last_visit || {};
    return {
      id: c.id,
      customer: customer.name || customer.email || 'Ziyaretçi',
      customerId: customer.id,
      email: customer.email || '',
      ip: lv.ip || '',
      agents: (humans.length ? humans : agents).map((a) => a.name || a.id).join(', '),
      started: ts(c.last_thread_summary.created_at),
      preview: lastMsg ? (lastMsg.text || '[' + lastMsg.type + ']') : '',
      lastFromCustomer: !!waiting,
      lastAt: lastMsg ? ts(lastMsg.created_at) : 0,
      waiting,
      cat,
    };
  }

  // Aynı IP / e-posta ile açık birden fazla chat: çoklu hesap şüphesi için sayılır.
  function duplicates() {
    const ip = {}, mail = {};
    state.chats.forEach((c) => {
      const s = summarize(c);
      const cached = s.customerId && state.customers[s.customerId] && state.customers[s.customerId].data;
      const theIp = s.ip || (cached && cached.last_visit && cached.last_visit.ip) || '';
      if (theIp) ip[theIp] = (ip[theIp] || 0) + 1;
      if (s.email) mail[s.email.toLowerCase()] = (mail[s.email.toLowerCase()] || 0) + 1;
    });
    return { ip, mail };
  }

  function eventHtml(ev, users) {
    const u = users.find((x) => x.id === ev.author_id) || {};
    const cls = u.type === 'customer' ? '' : isBot(u) ? ' bot' : ' agent';
    const name = esc(u.name || u.email || ev.author_id || 'Sistem');
    const internal = ev.visibility === 'agents';
    let body;
    switch (ev.type) {
      case 'message': body = esc(ev.text).replace(/\n/g, '<br>'); break;
      case 'system_message': return `<div class="sys">${esc(ev.text)} · ${hhmm(ev.created_at)}</div>`;
      case 'file': body = `📎 <a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.name || 'dosya')}</a>`; break;
      case 'rich_message': body = esc((ev.elements || []).map((e) => e.title || e.subtitle || '').join(' / ') || '[zengin mesaj]'); break;
      case 'filled_form': body = (ev.fields || []).map((f) => `<b>${esc(f.label)}:</b> ${esc(answer(f))}`).join('<br>'); break;
      default: body = esc('[' + ev.type + ']');
    }
    return `<div class="m${cls}${internal ? ' note' : ''}"><div class="mt">${name}${internal ? ' · 🔒 iç not' : ''} · ${hhmm(ev.created_at)}</div>${body}</div>`;
  }

  function answer(f) {
    const a = f.answer != null ? f.answer : f.answers;
    if (Array.isArray(a)) return a.map((x) => (x && x.label) || x).join(', ');
    if (a && typeof a === 'object') return a.label || a.id || '';
    return a == null ? '' : a;
  }

  // ============================================================
  // 3. ÜYE BİLGİSİ
  // ============================================================
  // Site entegrasyonunun gönderdiği alanlardan üye kimliğine benzeyenler en üste alınır.
  const ID_KEY = /user|kullan|member|uye|üye|login|username|player|oyuncu|customer|account|hesap|^id$/i;

  function infoHtml(chat) {
    const users = (state.detail && state.detail.users) || chat.users || [];
    const cust = customerOf(users);
    const cached = cust.id && state.customers[cust.id] && state.customers[cust.id].data;
    const full = Object.assign({}, cached || {}, cust, {
      last_visit: cust.last_visit || (cached && cached.last_visit),
      statistics: cust.statistics || (cached && cached.statistics),
      session_fields: (cust.session_fields && cust.session_fields.length ? cust.session_fields : cached && cached.session_fields),
    });
    const lv = full.last_visit || {};
    const geo = lv.geolocation || {};
    const st = full.statistics || {};
    const fields = sessionFields(full.session_fields);
    const idFields = fields.filter(([k]) => ID_KEY.test(k));
    const otherFields = fields.filter(([k]) => !ID_KEY.test(k));
    const events = (state.detail && state.detail.thread && state.detail.thread.events) || [];
    const forms = events.filter((e) => e.type === 'filled_form' && e.form_type !== 'postchat').flatMap((e) => e.fields || []);
    const dup = duplicates();
    const ipCount = lv.ip ? dup.ip[lv.ip] || 0 : 0;
    const mailCount = full.email ? dup.mail[full.email.toLowerCase()] || 0 : 0;
    const pages = lv.last_pages || [];
    const cur = pages[pages.length - 1];

    const row = (k, v, opts = {}) => (v === '' || v == null ? '' : `<div class="kv"><span>${esc(k)}</span><span class="${opts.cls || ''}">${opts.html ? v : esc(v)}${opts.copy ? ` <button class="cp" data-copy="${esc(opts.copy)}" title="Kopyala">⧉</button>` : ''}</span></div>`);
    const sec = (title, inner) => (inner.trim() ? `<div class="sec"><h4>${title}</h4>${inner}</div>` : '');

    const warns = [];
    if (ipCount > 1) warns.push(`Aynı IP'den <b>${ipCount}</b> aktif chat var`);
    if (mailCount > 1) warns.push(`Aynı e-postayla <b>${mailCount}</b> aktif chat var`);
    if (geo.country_code && geo.country_code.toUpperCase() !== HOME_COUNTRY) warns.push(`Yurt dışı IP: ${esc(geo.country || geo.country_code)}`);
    if (full.present === false) warns.push('Müşteri sayfadan ayrılmış');

    const html = [
      warns.length ? `<div class="warns">${warns.map((w) => `<div>⚠ ${w}</div>`).join('')}</div>` : '',
      sec('Üye', [
        ...idFields.map(([k, v]) => row(k, v, { cls: 'strong', copy: v })),
        row('Ad', full.name),
        row('E-posta', full.email, { copy: full.email }),
        full.email ? row('E-posta doğrulandı', full.email_verified ? 'Evet' : 'Hayır') : '',
      ].join('')),
      sec('Bağlantı', [
        row('IP', lv.ip, { cls: 'mono', copy: lv.ip }),
        row('Konum', [flag(geo.country_code), [geo.city, geo.region, geo.country].filter(Boolean).join(', ')].join(' ').trim()),
        row('Saat dilimi', geo.timezone),
        row('Cihaz', parseUA(lv.user_agent)),
      ].join('')),
      sec('Ziyaret', [
        cur ? row('Şu anki sayfa', `<a href="${esc(cur.url)}" target="_blank" rel="noopener">${esc(cur.title || cur.url)}</a>`, { html: true }) : '',
        row('Sitede', lv.started_at ? ago(ts(lv.started_at)) : ''),
        row('Gezilen sayfa', pages.length || ''),
        row('Geldiği yer', lv.referrer),
        pages.length > 1 ? `<details><summary>Son sayfalar</summary>${pages.slice().reverse().map((p) => `<div class="pg">${hhmm(p.opened_at)} · <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title || p.url)}</a></div>`).join('')}</details>` : '',
      ].join('')),
      sec('Geçmiş', [
        row('Toplam chat', st.chats_count),
        row('Toplam ziyaret', st.visits_count),
        row('İlk görülme', full.created_at ? dmy(full.created_at) : ''),
      ].join('')),
      sec('Ön form', forms.map((f) => row(f.label || f.type, answer(f))).join('')),
      sec('Diğer site alanları', otherFields.map(([k, v]) => row(k, v)).join('')),
    ].join('');
    return html || '<div class="empty">Bu müşteri için ek bilgi gelmedi. Token\'a <code>customers:ro</code> yetkisi eklemek daha fazla bilgi getirebilir.</div>';
  }

  // ============================================================
  // 4. ARAYÜZ
  // ============================================================
  const css = `
  :host{all:initial}
  .lci{
    --bg:#f7f8fa;--surface:#fff;--surface-2:#f4f5f8;--fg:#1d2030;--muted:#6b7086;--line:#e2e4eb;
    --accent:#ff5a1f;--accent-soft:#fff0e8;--head:#1d2030;--head-fg:#f4f5f8;
    --ok:#1f9d63;--ok-soft:#e3f5ec;--warn:#d9a400;--warn-soft:#fff6d6;--bot:#7c4ddf;--bot-soft:#efeaff;--crit:#d92d3a;--crit-soft:#fde8ea;
    --agent-msg:#e9efff;--bot-msg:#f1ecff;--note:#fff6d6;--shadow:0 18px 50px rgba(20,22,40,.25),0 2px 6px rgba(20,22,40,.08);
    --font:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font:13px/1.45 var(--font);color:var(--fg)}
  @media (prefers-color-scheme:dark){.lci:not([data-theme=light]){
    --bg:#171922;--surface:#1e2029;--surface-2:#252834;--fg:#e8e9f0;--muted:#9296ab;--line:#30333f;
    --accent:#ff7a45;--accent-soft:#3a2219;--head:#0d0e14;--head-fg:#e8e9f0;
    --ok:#4cc58c;--ok-soft:#163327;--warn:#f0c431;--warn-soft:#38301a;--bot:#a28bff;--bot-soft:#2a2442;--crit:#ff5c68;--crit-soft:#3b1a1e;
    --agent-msg:#232c45;--bot-msg:#2a2442;--note:#3a3317;--shadow:0 18px 50px rgba(0,0,0,.55);color-scheme:dark}}
  .lci[data-theme=dark]{
    --bg:#171922;--surface:#1e2029;--surface-2:#252834;--fg:#e8e9f0;--muted:#9296ab;--line:#30333f;
    --accent:#ff7a45;--accent-soft:#3a2219;--head:#0d0e14;--head-fg:#e8e9f0;
    --ok:#4cc58c;--ok-soft:#163327;--warn:#f0c431;--warn-soft:#38301a;--bot:#a28bff;--bot-soft:#2a2442;--crit:#ff5c68;--crit-soft:#3b1a1e;
    --agent-msg:#232c45;--bot-msg:#2a2442;--note:#3a3317;--shadow:0 18px 50px rgba(0,0,0,.55);color-scheme:dark}
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  button{font:inherit;color:inherit}
  button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  a{color:var(--accent)}

  .mini{position:fixed;right:18px;bottom:18px;z-index:2147483646;display:flex;align-items:center;gap:8px;background:var(--head);color:var(--head-fg);border:0;border-radius:24px;padding:9px 14px;font-weight:600;box-shadow:var(--shadow);cursor:pointer}
  .mini .n{font-family:var(--mono)}
  .mini .c{background:var(--crit);color:#fff;border-radius:12px;padding:0 7px;font-family:var(--mono)}
  .mini.alert .c{animation:pulse 1s infinite}
  @keyframes pulse{50%{opacity:.4}}

  .win{position:fixed;z-index:2147483647;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);overflow:hidden;min-width:560px;min-height:340px}
  .win.drag{user-select:none}
  .bar{display:flex;align-items:center;gap:10px;padding:7px 8px 7px 14px;background:var(--head);color:var(--head-fg);cursor:grab;flex:none}
  .win.drag .bar{cursor:grabbing}
  .bar .name{font-weight:600}
  .bar .ver{opacity:.5;font-size:11px}
  .bar .live{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.75}
  .bar .live i{width:7px;height:7px;border-radius:50%;background:var(--ok);animation:pulse 1.6s infinite}
  .bar .live.err i{background:var(--crit);animation:none}
  .bar .sp{flex:1}
  .kpi{display:flex;gap:6px}
  .kpi span{font:500 12px var(--mono);padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.08)}
  .tb{display:flex;gap:2px}
  .tb button{width:28px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--head-fg);cursor:pointer;font-size:14px;opacity:.8}
  .tb button:hover{background:rgba(255,255,255,.12);opacity:1}
  .err{background:var(--crit-soft);color:var(--crit);padding:5px 12px;font-size:12px;flex:none}

  .body{flex:1;display:grid;grid-template-columns:var(--side,330px) 6px 1fr;min-height:0}
  .split{cursor:col-resize;background:var(--line);opacity:0;transition:opacity .15s}
  .split:hover,.split.on{opacity:1}
  .side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
  .tools{padding:10px;border-bottom:1px solid var(--line)}
  .tools input{width:100%;font:inherit;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--fg)}
  .list{overflow:auto;flex:1}
  .cat{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;width:100%;padding:7px 12px;border:0;border-bottom:1px solid var(--line);background:var(--surface-2);font:600 12px var(--font);letter-spacing:.05em;text-transform:uppercase;cursor:pointer;text-align:left}
  .cat .dot{width:9px;height:9px;border-radius:50%}
  .cat .n{margin-left:auto;font:500 12px var(--mono);color:var(--muted)}
  .cat .car{color:var(--muted);transition:transform .15s}
  .cat[aria-expanded=false] .car{transform:rotate(-90deg)}
  .item{display:grid;grid-template-columns:auto 1fr auto;gap:2px 10px;padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;border-left:3px solid transparent}
  .item:hover{background:var(--surface-2)}
  .item.sel{background:var(--accent-soft);border-left-color:var(--accent)}
  .av{grid-row:span 2;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font:600 12px var(--font);color:#fff}
  .item .nm{font-weight:600;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .item .tm{font:500 12px var(--mono);color:var(--muted);text-align:right}
  .item .meta{grid-column:2/4;display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--muted)}
  .item .pv{grid-column:2/4;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pill{font:600 11px var(--font);padding:1px 7px;border-radius:20px;white-space:nowrap}
  .p-crit{background:var(--crit-soft);color:var(--crit)}.p-new{background:var(--accent);color:#fff}
  .p-warn{background:var(--warn-soft);color:var(--fg)}.p-dup{background:var(--crit);color:#fff}
  .empty{padding:24px;color:var(--muted);text-align:center}

  .view{display:grid;grid-template-columns:1fr auto;min-width:0;min-height:0}
  .conv{display:flex;flex-direction:column;min-width:0;min-height:0}
  .vh{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  .vh .who{flex:1;min-width:0}
  .vh .who b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vh .who span{font-size:12px;color:var(--muted)}
  .btn{font-weight:600;font-size:12.5px;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:6px 11px;cursor:pointer;text-decoration:none;color:var(--fg)}
  .btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn[disabled]{opacity:.7;cursor:default}
  .msgs{flex:1;overflow:auto;padding:14px;background:var(--bg);display:flex;flex-direction:column;gap:8px}
  .m{max-width:75%;padding:8px 11px;border-radius:10px;background:var(--surface);border:1px solid var(--line);word-wrap:break-word}
  .m.agent{align-self:flex-end;background:var(--agent-msg);border-color:transparent}
  .m.bot{align-self:flex-end;background:var(--bot-msg);border-color:transparent}
  .m.note{background:var(--note);border-style:dashed}
  .m .mt{font:11px var(--mono);color:var(--muted);margin-bottom:2px}
  .sys{align-self:center;font-size:11.5px;color:var(--muted);text-align:center}

  .info{width:290px;border-left:1px solid var(--line);overflow:auto;background:var(--surface)}
  .info[hidden],.info:empty{display:none}
  .sec{padding:10px 14px;border-bottom:1px solid var(--line)}
  .sec h4{margin:0 0 6px;font:600 11px var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .kv{display:grid;grid-template-columns:96px 1fr;gap:8px;padding:2px 0}
  .kv>span:first-child{color:var(--muted)}
  .kv>span:last-child{min-width:0;overflow-wrap:anywhere}
  .kv .strong{font-weight:700}
  .kv .mono{font-family:var(--mono)}
  .cp{border:0;background:none;color:var(--muted);cursor:pointer;padding:0 2px}
  .cp:hover{color:var(--accent)}
  .warns{padding:8px 14px;background:var(--crit-soft);color:var(--crit);border-bottom:1px solid var(--line);display:grid;gap:2px;font-size:12.5px}
  details{margin-top:4px}
  summary{cursor:pointer;color:var(--muted);font-size:12px}
  .pg{font-size:12px;padding:2px 0;overflow-wrap:anywhere}

  .h{position:absolute;z-index:3}
  .h.r{top:0;right:-3px;width:8px;height:100%;cursor:ew-resize}
  .h.l{top:0;left:-3px;width:8px;height:100%;cursor:ew-resize}
  .h.b{left:0;bottom:-3px;height:8px;width:100%;cursor:ns-resize}
  .h.br{right:-2px;bottom:-2px;width:16px;height:16px;cursor:nwse-resize}
  .h.bl{left:-2px;bottom:-2px;width:16px;height:16px;cursor:nesw-resize}
  .grip{position:absolute;right:4px;bottom:4px;width:10px;height:10px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);opacity:.5;pointer-events:none}

  .settings{padding:18px;display:grid;gap:10px;max-width:540px}
  .settings h3{margin:0}
  .settings label{display:grid;gap:3px}
  .settings input{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);color:var(--fg)}
  .settings small{color:var(--muted)}
  code{font-family:var(--mono);font-size:12px;background:var(--surface-2);padding:0 4px;border-radius:4px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  `;

  let root, win, mini, listEl, viewEl, convEl, infoEl, errEl, kpiEl, liveEl, bodyEl;

  function build() {
    const host = document.createElement('div');
    host.id = 'lci-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${css}</style>
      <div class="lci">
        <button class="mini" title="Canlı Chatler (Alt+L)">Canlı Chatler <span class="n">0</span><span class="c" hidden>0</span></button>
        <section class="win" hidden aria-label="Canlı chatler">
          <div class="bar">
            <span class="name">Canlı Chatler</span><span class="ver">v${VERSION}</span>
            <span class="live"><i></i><span>canlı</span></span>
            <span class="sp"></span><span class="kpi"></span>
            <span class="tb">
              <button data-a="settings" title="Ayarlar">⚙</button>
              <button data-a="theme" title="Tema">◐</button>
              <button data-a="min" title="Küçült (Esc)">–</button>
              <button data-a="max" title="Büyüt / geri al">▢</button>
            </span>
          </div>
          <div class="err" hidden></div>
          <div class="body">
            <aside class="side">
              <div class="tools"><input type="search" placeholder="Müşteri, agent, e-posta, IP veya mesaj ara"></div>
              <div class="list"></div>
            </aside>
            <div class="split"></div>
            <div class="view">
              <div class="conv"><div class="empty" style="margin:auto">Soldan bir chat seçin.</div></div>
              <aside class="info" ${state.info ? '' : 'hidden'}></aside>
            </div>
          </div>
          <span class="h r" data-d="r"></span><span class="h l" data-d="l"></span><span class="h b" data-d="b"></span>
          <span class="h br" data-d="br"></span><span class="h bl" data-d="bl"></span><span class="grip"></span>
        </section>
      </div>`;
    root = shadow.querySelector('.lci');
    win = shadow.querySelector('.win');
    mini = shadow.querySelector('.mini');
    bodyEl = shadow.querySelector('.body');
    listEl = shadow.querySelector('.list');
    viewEl = shadow.querySelector('.view');
    convEl = shadow.querySelector('.conv');
    infoEl = shadow.querySelector('.info');
    errEl = shadow.querySelector('.err');
    kpiEl = shadow.querySelector('.kpi');
    liveEl = shadow.querySelector('.live');

    const theme = S.get('theme', '');
    if (theme) root.dataset.theme = theme;
    bodyEl.style.setProperty('--side', S.get('sideW', 330) + 'px');
    applyGeo(S.get('geo', null));

    mini.onclick = () => setOpen(true);
    shadow.querySelector('[data-a=min]').onclick = () => setOpen(false);
    shadow.querySelector('[data-a=max]').onclick = toggleMax;
    shadow.querySelector('[data-a=settings]').onclick = renderSettings;
    shadow.querySelector('[data-a=theme]').onclick = () => {
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      S.set('theme', root.dataset.theme);
    };
    shadow.querySelector('.tools input').oninput = (e) => { state.filter = e.target.value.toLowerCase(); renderList(); };

    listEl.onclick = (e) => {
      const cat = e.target.closest('.cat');
      if (cat) {
        state.closed[cat.dataset.cat] = !state.closed[cat.dataset.cat];
        S.set('closedCats', state.closed);
        renderList();
        return;
      }
      const it = e.target.closest('.item');
      if (it) select(it.dataset.id);
    };
    listEl.onkeydown = (e) => { if (e.key === 'Enter' && e.target.closest('.item')) e.target.click(); };
    viewEl.addEventListener('click', (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp) {
        navigator.clipboard.writeText(cp.dataset.copy).then(() => { cp.textContent = '✓'; setTimeout(() => { cp.textContent = '⧉'; }, 900); }, () => {});
      }
    });

    // Sürükleme ve boyutlandırma
    shadow.querySelector('.bar').addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) startDrag(e, 'move'); });
    shadow.querySelector('.bar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMax(); });
    shadow.querySelectorAll('.h').forEach((h) => h.addEventListener('pointerdown', (e) => startDrag(e, h.dataset.d)));
    shadow.querySelector('.split').addEventListener('pointerdown', startSplit);
    window.addEventListener('resize', () => applyGeo(win.hidden ? S.get('geo', null) : currentGeo()));

    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyL') { e.preventDefault(); setOpen(!state.open); }
      if (e.key === 'Escape' && state.open && e.composedPath().includes(host)) setOpen(false);
    });

    setOpen(state.open);
  }

  // ---------- Pencere geometrisi ----------
  let maxSaved = null;

  function defaultGeo() {
    const w = Math.min(1100, innerWidth - 80), h = Math.min(640, innerHeight - 100);
    return { x: innerWidth - w - 30, y: 60, w, h };
  }
  function currentGeo() {
    const r = win.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  function applyGeo(g) {
    g = g || defaultGeo();
    const w = clamp(g.w, 560, innerWidth - 16), h = clamp(g.h, 340, innerHeight - 16);
    Object.assign(win.style, {
      width: w + 'px', height: h + 'px',
      left: clamp(g.x, 8 - w + 160, innerWidth - 160) + 'px',
      top: clamp(g.y, 0, innerHeight - 44) + 'px',
    });
  }
  function saveGeo() { if (!maxSaved) S.set('geo', currentGeo()); }

  function startDrag(e, mode) {
    e.preventDefault();
    const r = currentGeo(), sx = e.clientX, sy = e.clientY;
    maxSaved = null;
    win.classList.add('drag');
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      const g = Object.assign({}, r);
      if (mode === 'move') { g.x = r.x + dx; g.y = r.y + dy; }
      if (mode.includes('r')) g.w = r.w + dx;
      if (mode.includes('b')) g.h = r.h + dy;
      if (mode.includes('l')) { g.w = Math.max(560, r.w - dx); g.x = r.x + r.w - g.w; }
      applyGeo(g);
    };
    const up = () => {
      win.classList.remove('drag');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      saveGeo();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  function startSplit(e) {
    e.preventDefault();
    const bar = e.target, sx = e.clientX;
    const w0 = parseInt(getComputedStyle(bodyEl).getPropertyValue('--side'), 10) || 330;
    bar.classList.add('on');
    const move = (ev) => bodyEl.style.setProperty('--side', clamp(w0 + ev.clientX - sx, 240, win.offsetWidth - 320) + 'px');
    const up = () => {
      bar.classList.remove('on');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      S.set('sideW', parseInt(bodyEl.style.getPropertyValue('--side'), 10));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  function toggleMax() {
    if (maxSaved) { applyGeo(maxSaved); maxSaved = null; return; }
    maxSaved = currentGeo();
    applyGeo({ x: 8, y: 8, w: innerWidth - 16, h: innerHeight - 16 });
  }

  function setOpen(open) {
    state.open = open;
    S.set('open', open);
    win.hidden = !open;
    mini.hidden = open;
    if (open && !creds().pat) renderSettings();
    if (open && state.selected) refreshDetail(false);
  }

  // ---------- Liste ----------
  function itemHtml(c, dup) {
    const now = Date.now();
    const isNew = c.lastAt > (state.seen[c.id] || 0) && c.id !== state.selected && c.lastFromCustomer;
    const late = c.waiting && now - c.waiting > WAIT_WARN * 1000;
    const pills = [
      late && c.cat !== 'queue' ? `<span class="pill p-crit">⏳ ${ago(c.waiting)}</span>` : '',
      c.cat === 'queue' ? `<span class="pill p-warn">bekliyor ${ago(c.waiting || c.started)}</span>` : '',
      isNew ? '<span class="pill p-new">yeni</span>' : '',
      c.ip && dup.ip[c.ip] > 1 ? `<span class="pill p-dup" title="Aynı IP'den birden fazla aktif chat">aynı IP ×${dup.ip[c.ip]}</span>` : '',
    ].join('');
    return `<div class="item${c.id === state.selected ? ' sel' : ''}" data-id="${esc(c.id)}" tabindex="0">
      <span class="av" style="background:${hue(c.customerId || c.id)}">${esc(initials(c.customer))}</span>
      <span class="nm">${esc(c.customer)}</span><span class="tm">${ago(c.started)}</span>
      <span class="meta">${c.agents ? `<span>👤 ${esc(c.agents)}</span>` : ''}${pills}</span>
      <span class="pv">${c.lastFromCustomer ? '' : '↳ '}${esc(c.preview)}</span>
    </div>`;
  }

  function renderList() {
    const dup = duplicates();
    const all = state.chats.map(summarize);
    const items = all.filter((c) => !state.filter || [c.customer, c.agents, c.email, c.ip, c.preview].join(' ').toLowerCase().includes(state.filter));
    // Cevap bekleyenler (en uzun bekleyen) üstte, ardından son aktiviteye göre.
    const order = (a, b) => (a.waiting && b.waiting ? a.waiting - b.waiting : (b.waiting ? 1 : 0) - (a.waiting ? 1 : 0) || b.lastAt - a.lastAt);

    const html = CATS.map((ct) => {
      const xs = items.filter((c) => c.cat === ct.k).sort(order);
      if (!xs.length) return '';
      const open = !state.closed[ct.k];
      return `<button class="cat" data-cat="${ct.k}" aria-expanded="${open}"><span class="car">▾</span><span class="dot" style="background:${ct.color}"></span>${ct.t}<span class="n">${xs.length}</span></button>
        ${open ? xs.map((c) => itemHtml(c, dup)).join('') : ''}`;
    }).join('');
    const scroll = listEl.scrollTop;
    listEl.innerHTML = html || `<div class="empty">${creds().pat ? (state.filter ? 'Eşleşen chat yok.' : 'Şu an aktif chat yok.') : 'Önce ⚙ ayarlarını doldurun.'}</div>`;
    listEl.scrollTop = scroll;

    const count = (k) => all.filter((c) => c.cat === k).length;
    const late = all.filter((c) => c.cat === 'active' && c.waiting && Date.now() - c.waiting > WAIT_WARN * 1000).length;
    kpiEl.innerHTML = `<span>${count('active')} aktif</span><span>${count('queue')} bekleyen</span><span>${count('bot')} bot</span>`;
    mini.querySelector('.n').textContent = all.length;
    const alerts = late + count('queue');
    mini.querySelector('.c').hidden = !alerts;
    mini.querySelector('.c').textContent = alerts;
    mini.classList.toggle('alert', alerts > 0);
    mini.title = `Canlı Chatler (Alt+L) · ${late} cevapsız, ${count('queue')} bekleyen`;
    errEl.hidden = !state.error;
    errEl.textContent = state.error;
    liveEl.classList.toggle('err', !!state.error);
  }

  // ---------- Konuşma + üye bilgisi ----------
  function renderView(keepScroll) {
    const chat = state.chats.find((c) => c.id === state.selected);
    if (!chat || !state.detail) return;
    const s = summarize(chat);
    const old = convEl.querySelector('.msgs');
    const atBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 40;
    const prevTop = old ? old.scrollTop : 0;
    const users = state.detail.users || [];
    const events = (state.detail.thread && state.detail.thread.events) || [];

    convEl.innerHTML = `
      <div class="vh"><span class="av" style="background:${hue(s.customerId || s.id)}">${esc(initials(s.customer))}</span>
        <span class="who"><b>${esc(s.customer)}</b><span>${esc(s.agents || 'Agent atanmadı')} · ${ago(s.started)} önce başladı</span></span>
        <button class="btn" data-a="info" title="Üye bilgilerini aç/kapat">ℹ Üye</button>
        <button class="btn pri" data-a="sup">Supervise et</button>
        <a class="btn" href="https://my.livechatinc.com/chats/${encodeURIComponent(s.id)}" target="_blank" rel="noopener">LiveChat'te aç ↗</a></div>
      <div class="msgs">${events.map((ev) => eventHtml(ev, users)).join('') || '<div class="empty">Henüz mesaj yok.</div>'}</div>`;
    const box = convEl.querySelector('.msgs');
    box.scrollTop = keepScroll && !atBottom ? prevTop : box.scrollHeight;

    convEl.querySelector('[data-a=info]').onclick = () => {
      state.info = !state.info;
      S.set('infoOpen', state.info);
      infoEl.hidden = !state.info;
    };
    convEl.querySelector('[data-a=sup]').onclick = (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      supervise(s.id)
        .then(() => { b.textContent = '✓ Supervise ediliyor'; })
        .catch((err) => { b.disabled = false; state.error = err.message; renderList(); });
    };

    const infoTop = infoEl.scrollTop;
    const openDetails = infoEl.querySelector('details[open]');
    infoEl.innerHTML = infoHtml(chat);
    infoEl.scrollTop = keepScroll ? infoTop : 0;
    if (openDetails && keepScroll) { const d = infoEl.querySelector('details'); if (d) d.open = true; }
  }

  function renderSettings() {
    state.selected = null;
    clearInterval(state.chatTimer);
    infoEl.innerHTML = '';
    const c = creds();
    convEl.innerHTML = `
      <div class="settings">
        <h3>Bağlantı ayarları</h3>
        <small>platform.text.com → Console → <b>Personal Access Tokens</b> → yeni token oluşturun.
        Gereken yetkiler: <code>chats--all:ro</code>, <code>chats--access:ro</code>, üye bilgileri için <code>customers:ro</code>,
        supervise için ayrıca <code>chats--all:rw</code>. Token ekranında <b>Account ID</b> de görünür.
        Bilgiler yalnızca bu tarayıcıdaki Tampermonkey deposunda saklanır.</small>
        <label>Account ID<input name="accountId" value="${esc(c.account)}"></label>
        <label>Personal Access Token<input name="pat" type="password" value="${esc(c.pat)}"></label>
        <label>Agent e-postanız (supervise için)<input name="email" value="${esc(c.email)}"></label>
        <div><button class="btn pri" data-a="save">Kaydet ve bağlan</button></div>
      </div>`;
    convEl.querySelector('[data-a=save]').onclick = () => {
      convEl.querySelectorAll('input').forEach((i) => S.set(i.name, i.value.trim()));
      convEl.innerHTML = '<div class="empty" style="margin:auto">Kaydedildi. Soldan bir chat seçin.</div>';
      refreshList();
    };
    renderList();
  }

  // ============================================================
  // 5. AKIŞ
  // ============================================================
  async function refreshList() {
    if (!creds().pat) { renderList(); return; }
    try {
      state.chats = await fetchActiveChats();
      state.error = '';
      if (state.selected && !state.chats.some((c) => c.id === state.selected)) {
        convEl.insertAdjacentHTML('afterbegin', '<div class="err">Bu chat sona erdi.</div>');
        state.selected = null;
        clearInterval(state.chatTimer);
      }
    } catch (err) {
      state.error = err.message;
    }
    renderList();
  }

  async function refreshDetail(first) {
    const chat = state.chats.find((c) => c.id === state.selected);
    if (!chat) return;
    try {
      const detail = await fetchDetail(chat);
      if (state.selected !== chat.id) return;   // bu arada başka chate geçildi
      state.detail = detail;
      state.seen[chat.id] = Date.now();
      const cust = customerOf(detail.users);
      if (cust.id && !cust.last_visit) await fetchCustomer(cust.id);
      renderView(!first);
    } catch (err) {
      state.error = err.message;
      renderList();
    }
  }

  function select(id) {
    state.selected = id;
    state.detail = null;
    convEl.innerHTML = '<div class="empty" style="margin:auto">Yükleniyor…</div>';
    infoEl.innerHTML = '';
    renderList();
    clearInterval(state.chatTimer);
    refreshDetail(true);
    state.chatTimer = setInterval(() => { if (state.open && !document.hidden) refreshDetail(false); }, CHAT_INTERVAL);
  }

  build();
  refreshList();
  // Panel kapalıyken de liste yenilenir: küçük düğmedeki sayaç ve uyarı canlı kalsın.
  setInterval(() => { if (!document.hidden) refreshList(); }, LIST_INTERVAL);
})();
