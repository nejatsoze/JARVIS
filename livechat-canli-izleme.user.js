// ==UserScript==
// @name         LiveChat — Canlı Chat İzleme Paneli
// @namespace    livechat-canli-izleme
// @version      2.2.0
// @description  O an yürüyen tüm chatleri duruma göre gruplayan, sürüklenip boyutlandırılabilen bir panelde listeler; konuşmayı canlı okursun, üyenin IP/konum/cihaz/site bilgilerini görürsün, tek tıkla supervise edersin.
// @author       —
// @match        https://my.livechatinc.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.livechatinc.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 0. SABİTLER
  // ============================================================
  const VERSION = '2.2.0';
  const API = 'https://api.livechatinc.com/v3.5/agent/action/';
  const LIST_INTERVAL = 5000;     // aktif chat listesi yenileme (ms)
  const CHAT_INTERVAL = 3000;     // açık konuşma yenileme (ms)
  const CUSTOMER_TTL = 60000;     // müşteri detayı önbellek süresi (ms)
  const MAX_PAGES = 5;            // list_chats için azami sayfa
  const WAIT_WARN = 60;           // müşteri bu kadar sn cevapsız kalırsa ⏳ uyarısı
  const GROUP_GAP = 5 * 60000;    // aynı kişinin mesajları bu süre içindeyse tek balon grubunda
  const HOME_COUNTRY = 'TR';      // bunun dışındaki ülke IP'leri işaretlenir
  const BOT_NAMES = ['zumabet chatbot'];   // küçük harf; bu adlı agentlar "Chatbot" kategorisine düşer

  // Sıra ekrandaki sıradır. Chatbot varsayılan olarak kapalı başlar.
  const CATS = [
    { k: 'bot', t: 'Chatbot', color: 'var(--bot)', closed: true },
    { k: 'active', t: 'Aktif chat', color: 'var(--ok)' },
    { k: 'queue', t: 'Bekleyenler', color: 'var(--warn)' },
  ];

  // Sitenin gönderdiği alanların ekrandaki adları (anahtarlar küçük harf, _ ve - atılmış hâliyle eşlenir).
  const FIELD_LABELS = {
    playerid: 'Oyuncu ID', userid: 'Kullanıcı ID', memberid: 'Üye ID', customerid: 'Müşteri ID', id: 'ID',
    username: 'Kullanıcı adı', login: 'Kullanıcı adı', email: 'E-posta', phone: 'Telefon', name: 'Ad',
    vipgroup: 'VIP grubu', vipstatus: 'VIP durumu', viplevel: 'VIP seviyesi', kycstatus: 'KYC',
    emailverification: 'E-posta doğrulama', isemailverified: 'E-posta doğrulandı', isphoneverified: 'Telefon doğrulandı',
    regdate: 'Kayıt tarihi', registrationdate: 'Kayıt tarihi', balance: 'Bakiye', currency: 'Para birimi', country: 'Ülke',
  };
  const ID_KEY = /^(playerid|userid|memberid|customerid|id|username|login|uye.*|oyuncu.*|kullanici.*)$/;

  const DPIP = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).documentPictureInPicture;

  const S = {
    get: (k, d) => GM_getValue(k, d),
    set: (k, v) => GM_setValue(k, v),
  };

  const state = {
    chats: [],            // aktif chat özetleri (list_chats)
    selected: null,       // seçili chat id
    ended: false,         // seçili chat bu arada bitti mi
    detail: null,         // seçili chatin get_chat cevabı
    customers: {},        // customerId -> { at, data } (get_customer önbelleği)
    seen: {},             // chatId -> görülen son mesaj zamanı
    closed: Object.assign(Object.fromEntries(CATS.map((c) => [c.k, !!c.closed])), S.get('closedCats', {})),
    filter: '',
    error: '',
    chatTimer: null,
    listTimer: null,
    pip: null,            // sabitlenmişse Picture-in-Picture penceresi
    open: S.get('open', false),
    info: S.get('infoOpen', true),
    sig: { msgs: '', info: '' },   // gereksiz yeniden çizimi önlemek için son içerik imzaları
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
    if (!c.account || !c.pat) return Promise.reject(new Error('Ayarlar eksik: Account ID ve PAT girin.'));
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
      // Sıralama son thread'in açılışına göre; aktif chat içermeyen sayfadan sonrası eski kayıttır.
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
    if (!email) return Promise.reject(new Error('Supervise için ayarlara kendi agent e-postanızı girin.'));
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
  const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9ğüşöçı]/g, '');

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + ' sn';
    if (s < 3600) return Math.floor(s / 60) + ' dk';
    if (s < 86400) return Math.floor(s / 3600) + ' sa ' + Math.floor((s % 3600) / 60) + ' dk';
    return Math.floor(s / 86400) + ' gün';
  }

  const hhmm = (iso) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const dmy = (iso) => new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
  const flag = (cc) => (/^[A-Za-z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

  function initials(name) {
    return String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  }
  function avatarBg(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 131 + ch.charCodeAt(0) * 17) % 360;
    return `linear-gradient(135deg, hsl(${h} 70% 62%), hsl(${(h + 30) % 360} 65% 46%))`;
  }

  function parseUA(ua) {
    if (!ua) return '';
    const os = /Windows NT 10/.test(ua) ? 'Windows' : /Windows/.test(ua) ? 'Windows'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android ([\d.]+)/.test(ua) ? 'Android ' + RegExp.$1
        : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Bilinmeyen';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung'
      : /YaBrowser/.test(ua) ? 'Yandex' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı';
    const mob = /Mobi|Android|iPhone|iPod/.test(ua);
    return { text: `${br} · ${os}`, mobile: mob };
  }

  function urlParts(u) {
    try { const x = new URL(u); return { host: x.hostname.replace(/^www\./, ''), path: decodeURIComponent(x.pathname + x.search) || '/' }; } catch (_) { return { host: u, path: u }; }
  }

  // session_fields LiveChat'te [{anahtar: değer}, ...] biçiminde gelir.
  function sessionFields(sf) {
    const out = [];
    (Array.isArray(sf) ? sf : [sf || {}]).forEach((o) => Object.entries(o || {}).forEach(([k, v]) => out.push([k, v])));
    return out;
  }

  function fieldLabel(k) {
    const n = normKey(k);
    if (FIELD_LABELS[n]) return FIELD_LABELS[n];
    const words = String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // Değeri tipine göre biçimlendirir: tarih, evet/hayır, durum rozeti.
  function fieldValue(v) {
    const s = String(v == null ? '' : v).trim();
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s) ? '<span class="tag good">Evet</span>' : '<span class="tag bad">Hayır</span>';
    if (/^(pass|passed|verified|approved|active|onaylı|onaylandı)$/i.test(s)) return `<span class="tag good">${esc(s)}</span>`;
    if (/^(fail|failed|rejected|blocked|banned|unverified|not_verified)$/i.test(s)) return `<span class="tag bad">${esc(s)}</span>`;
    if (/^(pending|waiting|review|in_review)$/i.test(s)) return `<span class="tag warn">${esc(s)}</span>`;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `${dmy(s)} <span class="dim">· ${ago(ts(s))} önce</span>`;
    return esc(s);
  }

  function customerOf(users) {
    return (users || []).find((u) => u.type === 'customer') || {};
  }

  function idFieldOf(cust) {
    const f = sessionFields(cust.session_fields).find(([k]) => ID_KEY.test(normKey(k)));
    return f ? f[1] : '';
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
      playerId: idFieldOf(customer),
      email: customer.email || '',
      ip: lv.ip || '',
      agents: (humans.length ? humans : agents).map((a) => a.name || a.id).join(', '),
      started: ts(c.last_thread_summary.created_at),
      preview: lastMsg ? (lastMsg.text || (lastMsg.type === 'file' ? '📎 Dosya' : '[' + lastMsg.type + ']')) : '',
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

  function answer(f) {
    const a = f.answer != null ? f.answer : f.answers;
    if (Array.isArray(a)) return a.map((x) => (x && x.label) || x).join(', ');
    if (a && typeof a === 'object') return a.label || a.id || '';
    return a == null ? '' : a;
  }
  const cleanLabel = (l) => String(l || '').replace(/[:：\s]+$/, '');

  // ============================================================
  // 3. KONUŞMA
  // ============================================================
  function fileHtml(ev) {
    const img = /^image\//.test(ev.content_type || '') || /\.(png|jpe?g|gif|webp)$/i.test(ev.name || ev.url || '');
    if (img) {
      const src = ev.thumbnail2x_url || ev.thumbnail_url || ev.url;
      return `<a class="img" href="${esc(ev.url)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(ev.name || 'görsel')}"></a>`;
    }
    return `<a class="file" href="${esc(ev.url)}" target="_blank" rel="noopener"><span class="fi">📄</span><span>${esc(ev.name || 'Dosya')}</span></a>`;
  }

  function messagesHtml(events, users) {
    let html = '';
    let prev = null;
    for (const ev of events) {
      if (ev.type === 'system_message') {
        html += `<div class="sys"><span>${esc(ev.text)} · ${hhmm(ev.created_at)}</span></div>`;
        prev = null;
        continue;
      }
      if (ev.type === 'filled_form') {
        const rows = (ev.fields || []).map((f) => `<div><span>${esc(cleanLabel(f.label || f.type))}</span><b>${esc(answer(f))}</b></div>`).join('');
        html += `<div class="form"><div class="fh">${ev.form_type === 'postchat' ? 'Chat sonrası anket' : 'Ön form'} · ${hhmm(ev.created_at)}</div>${rows}</div>`;
        prev = null;
        continue;
      }
      const u = users.find((x) => x.id === ev.author_id) || {};
      const side = u.type === 'customer' ? 'in' : 'out';
      const kind = u.type === 'customer' ? 'cust' : isBot(u) ? 'bot' : 'agent';
      const internal = ev.visibility === 'agents';
      const key = ev.author_id + (internal ? ':n' : '');
      const t = ts(ev.created_at);
      const first = !prev || prev.key !== key || t - prev.t > GROUP_GAP;
      let body;
      switch (ev.type) {
        case 'message': body = esc(ev.text).replace(/\n/g, '<br>'); break;
        case 'file': body = fileHtml(ev); break;
        case 'rich_message': body = esc((ev.elements || []).map((e) => e.title || e.subtitle || '').join(' / ') || 'Zengin mesaj'); break;
        default: body = esc(ev.type);
      }
      if (first) {
        const name = esc(u.name || u.email || 'Bilinmeyen');
        html += `<div class="who ${side}">${name}${internal ? ' · <span class="lock">iç not</span>' : ''} <span>${hhmm(ev.created_at)}</span></div>`;
      }
      const media = ev.type === 'file' && /class="img"/.test(body) ? ' media' : '';
      html += `<div class="row ${side}"><div class="b ${kind}${internal ? ' note' : ''}${first ? ' first' : ''}${media}" title="${hhmm(ev.created_at)}">${body}</div></div>`;
      prev = { key, t };
    }
    return html;
  }

  // ============================================================
  // 4. ÜYE BİLGİSİ
  // ============================================================
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
    const events = (state.detail && state.detail.thread && state.detail.thread.events) || [];
    const dup = duplicates();
    const ipCount = lv.ip ? dup.ip[lv.ip] || 0 : 0;
    const mailCount = full.email ? dup.mail[full.email.toLowerCase()] || 0 : 0;
    const pages = lv.last_pages || [];
    const cur = pages[pages.length - 1];
    const ua = parseUA(lv.user_agent);

    // Site alanlarını rollerine ayır: kimlik, rozet (VIP/KYC/doğrulama), geri kalanlar.
    const used = new Set();
    const pick = (re) => fields.filter(([k], i) => !used.has(i) && re.test(normKey(k)) && used.add(i));
    const idFields = pick(ID_KEY);
    const vip = pick(/^vip/);
    const kyc = pick(/kyc/);
    const verif = pick(/verif/);
    fields.forEach(([k, v], i) => { if (normKey(k) === 'email' && String(v).toLowerCase() === String(full.email || '').toLowerCase()) used.add(i); });
    const rest = fields.filter((_, i) => !used.has(i));

    const chips = [];
    const vipVals = [...new Set(vip.map(([, v]) => String(v)).filter(Boolean))];
    vipVals.forEach((v) => chips.push(`<span class="chip vip">VIP ${esc(v)}</span>`));
    kyc.forEach(([, v]) => chips.push(`<span class="chip ${/pass|verified|approved/i.test(v) ? 'good' : /fail|reject/i.test(v) ? 'bad' : 'warn'}">KYC ${esc(v)}</span>`));
    verif.forEach(([k, v]) => {
      const ok = /^(true|verified|pass|yes|1)$/i.test(String(v));
      const what = /phone|tel/i.test(k) ? 'Telefon' : /mail/i.test(k) ? 'E-posta' : fieldLabel(k);
      chips.push(`<span class="chip ${ok ? 'good' : 'bad'}">${ok ? '✓' : '✕'} ${esc(what)}</span>`);
    });

    const row = (k, v, opts = {}) => (v === '' || v == null ? ''
      : `<div class="kv"><span class="k">${esc(k)}</span><span class="v${opts.mono ? ' mono' : ''}${opts.copy ? ' copy' : ''}"${opts.copy ? ` data-copy="${esc(opts.copy)}" title="Kopyalamak için tıklayın"` : ''}>${opts.html ? v : esc(v)}</span></div>`);
    const group = (title, inner) => (inner.trim() ? `<div class="grp"><h4>${title}</h4><div class="card">${inner}</div></div>` : '');

    const warns = [];
    if (ipCount > 1) warns.push(`Aynı IP'den ${ipCount} aktif chat var`);
    if (mailCount > 1) warns.push(`Aynı e-postayla ${mailCount} aktif chat var`);
    if (geo.country_code && geo.country_code.toUpperCase() !== HOME_COUNTRY) warns.push(`Yurt dışı IP · ${esc(geo.country || geo.country_code)}`);
    if (full.present === false) warns.push('Müşteri sayfadan ayrılmış');

    // Ön formda ad/e-posta zaten yukarıda görünüyor; yalnızca ek cevaplar kalsın.
    const known = [full.name, full.email].filter(Boolean).map((x) => String(x).toLowerCase());
    const forms = events.filter((e) => e.type === 'filled_form' && e.form_type !== 'postchat').flatMap((e) => e.fields || [])
      .filter((f) => answer(f) !== '' && !known.includes(String(answer(f)).toLowerCase()));

    const stat = (n, l) => (n == null ? '' : `<div class="stat"><b>${esc(n)}</b><span>${l}</span></div>`);
    const stats = [stat(st.chats_count, 'chat'), stat(st.visits_count, 'ziyaret'), stat(pages.length || null, 'sayfa')].join('');

    const html = [
      `<div class="profile">
        <span class="av lg" style="background:${avatarBg(full.id || chat.id)}">${esc(initials(full.name || full.email))}</span>
        <div class="pn">${esc(full.name || 'Ziyaretçi')}</div>
        ${full.email ? `<div class="pe copy" data-copy="${esc(full.email)}" title="Kopyalamak için tıklayın">${esc(full.email)}</div>` : ''}
        ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
      </div>`,
      warns.length ? `<div class="warns">${warns.map((w) => `<div>${w}</div>`).join('')}</div>` : '',
      group('Hesap', [
        ...idFields.map(([k, v]) => row(fieldLabel(k), v, { copy: v, mono: true })),
        ...rest.map(([k, v]) => row(fieldLabel(k), fieldValue(v), { html: true })),
      ].join('')),
      stats ? `<div class="stats">${stats}</div>` : '',
      group('Bağlantı', [
        row('IP', lv.ip, { mono: true, copy: lv.ip }),
        row('Konum', [flag(geo.country_code), [geo.city, geo.country].filter(Boolean).join(', ')].join(' ').trim()),
        ua ? row('Cihaz', `${esc(ua.text)} <span class="dim">· ${ua.mobile ? 'Mobil' : 'Masaüstü'}</span>`, { html: true }) : '',
        geo.timezone && geo.timezone !== 'Europe/Istanbul' ? row('Saat dilimi', geo.timezone) : '',
      ].join('')),
      group('Ziyaret', [
        cur ? row('Şu an', `<a href="${esc(cur.url)}" target="_blank" rel="noopener" title="${esc(cur.title || '')}">${esc(urlParts(cur.url).path)}</a>`, { html: true }) : '',
        row('Sitede', lv.started_at ? ago(ts(lv.started_at)) : ''),
        row('Geldiği yer', lv.referrer ? urlParts(lv.referrer).host : ''),
        row('İlk görülme', full.created_at ? dmy(full.created_at) : ''),
        pages.length > 1 ? `<details><summary>Son ${pages.length} sayfa</summary>${pages.slice().reverse().map((p) => `<div class="pg"><span>${hhmm(p.opened_at)}</span><a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.title || '')}">${esc(urlParts(p.url).path)}</a></div>`).join('')}</details>` : '',
      ].join('')),
      group('Ön form', forms.map((f) => row(cleanLabel(f.label || f.type), answer(f))).join('')),
    ].join('');
    return html;
  }

  // ============================================================
  // 5. ARAYÜZ
  // ============================================================
  const ICON = {
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    theme: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    min: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    max: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
    ext: '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v6"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  };

  const css = `
  :host{all:initial}
  .lci{
    --win:#ffffff;--side:#f5f5f7;--pane:#ffffff;--card:#ffffff;--grouped:#f2f2f7;--fg:#1d1d1f;--fg-2:#3a3a3c;--muted:#86868b;
    --line:rgba(0,0,0,.08);--line-2:rgba(0,0,0,.05);--hover:rgba(0,0,0,.04);--sel:rgba(0,122,255,.12);
    --accent:#007aff;--ok:#34c759;--warn:#ffcc00;--warn-fg:#a07800;--bot:#af52de;--crit:#ff3b30;
    --b-in:#e9e9eb;--b-in-fg:#1d1d1f;--b-out:#007aff;--b-out-fg:#fff;--b-bot:#af52de;--b-note:#fff4c2;--b-note-fg:#5c4a00;
    --bar:rgba(246,246,248,.86);--shadow:0 30px 80px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.12);
    --font:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,"Segoe UI Variable Text","Segoe UI",Roboto,sans-serif;
    --mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace;
    font:14px/1.45 var(--font);color:var(--fg);-webkit-font-smoothing:antialiased;letter-spacing:-.006em}
  @media (prefers-color-scheme:dark){.lci:not([data-theme=light]){
    --win:#1e1e20;--side:#262628;--pane:#1c1c1e;--card:#2c2c2e;--grouped:#1c1c1e;--fg:#f5f5f7;--fg-2:#d1d1d6;--muted:#8e8e93;
    --line:rgba(255,255,255,.1);--line-2:rgba(255,255,255,.06);--hover:rgba(255,255,255,.05);--sel:rgba(10,132,255,.24);
    --accent:#0a84ff;--ok:#30d158;--warn:#ffd60a;--warn-fg:#ffd60a;--bot:#bf5af2;--crit:#ff453a;
    --b-in:#3a3a3c;--b-in-fg:#f5f5f7;--b-out:#0a84ff;--b-out-fg:#fff;--b-bot:#8e44c9;--b-note:#4a3f12;--b-note-fg:#ffe58a;
    --bar:rgba(40,40,42,.86);--shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 .5px rgba(255,255,255,.12);color-scheme:dark}}
  .lci[data-theme=dark]{
    --win:#1e1e20;--side:#262628;--pane:#1c1c1e;--card:#2c2c2e;--grouped:#1c1c1e;--fg:#f5f5f7;--fg-2:#d1d1d6;--muted:#8e8e93;
    --line:rgba(255,255,255,.1);--line-2:rgba(255,255,255,.06);--hover:rgba(255,255,255,.05);--sel:rgba(10,132,255,.24);
    --accent:#0a84ff;--ok:#30d158;--warn:#ffd60a;--warn-fg:#ffd60a;--bot:#bf5af2;--crit:#ff453a;
    --b-in:#3a3a3c;--b-in-fg:#f5f5f7;--b-out:#0a84ff;--b-out-fg:#fff;--b-bot:#8e44c9;--b-note:#4a3f12;--b-note-fg:#ffe58a;
    --bar:rgba(40,40,42,.86);--shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 .5px rgba(255,255,255,.12);color-scheme:dark}
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  button{font:inherit;color:inherit}
  button:focus-visible,input:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:1px}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--muted) 40%,transparent);border-radius:10px;border:3px solid transparent;background-clip:content-box}

  .mini{position:fixed;right:20px;bottom:20px;z-index:2147483646;display:flex;align-items:center;gap:10px;background:var(--bar);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:var(--fg);border:0;border-radius:999px;padding:10px 16px 10px 14px;font-weight:600;font-size:14px;box-shadow:var(--shadow);cursor:pointer}
  .mini .dot{width:8px;height:8px;border-radius:50%;background:var(--ok)}
  .mini .n{color:var(--muted);font-variant-numeric:tabular-nums}
  .mini .c{background:var(--crit);color:#fff;border-radius:999px;min-width:22px;padding:1px 7px;text-align:center;font-size:12.5px;font-variant-numeric:tabular-nums}
  .mini.alert .c{animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.45}}

  .win{position:fixed;z-index:2147483647;display:flex;flex-direction:column;background:var(--win);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;min-width:620px;min-height:360px}
  .win.drag{user-select:none}
  .bar{display:flex;align-items:center;gap:12px;height:48px;padding:0 10px 0 16px;background:var(--bar);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--line);cursor:grab;flex:none}
  .win.drag .bar{cursor:grabbing}
  .bar .name{font-weight:600;font-size:15px;letter-spacing:-.01em}
  .bar .live{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}
  .bar .live i{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent)}
  .bar .live.err i{background:var(--crit);box-shadow:0 0 0 3px color-mix(in srgb,var(--crit) 25%,transparent)}
  .bar .sp{flex:1}
  .seg{display:flex;background:var(--hover);border-radius:9px;padding:2px}
  .seg span{font-size:12.5px;font-weight:500;padding:3px 10px;border-radius:7px;color:var(--fg-2);font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:6px}
  .seg i{width:7px;height:7px;border-radius:50%}
  .tb{display:flex;gap:2px}
  .tb button{width:32px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;display:grid;place-items:center}
  .tb button:hover{background:var(--hover);color:var(--fg)}
  .tb button.on{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
  .tb button[disabled]{opacity:.35;cursor:not-allowed}
  .pinned .win{left:0!important;top:0!important;right:0;bottom:0;width:auto!important;height:auto!important;border-radius:0;box-shadow:none;min-width:0;min-height:0}
  .pinned .bar{cursor:default}
  .pinned .h,.pinned [data-a=max]{display:none}
  .win{container-type:inline-size}
  @container (max-width:900px){.info{display:none}}
  @container (max-width:640px){.body{grid-template-columns:220px 1px 1fr!important}.vh .btn.pri{padding:7px 10px}}
  .err{background:color-mix(in srgb,var(--crit) 12%,transparent);color:var(--crit);padding:7px 16px;font-size:13px;flex:none}

  .body{flex:1;display:grid;grid-template-columns:var(--side-w,340px) 1px 1fr;min-height:0}
  .split{cursor:col-resize;background:var(--line);position:relative}
  .split::after{content:"";position:absolute;inset:0 -4px}
  .side{display:flex;flex-direction:column;min-height:0;background:var(--side)}
  .tools{padding:12px 12px 8px}
  .search{display:flex;align-items:center;gap:8px;background:var(--hover);border-radius:10px;padding:0 10px;color:var(--muted)}
  .search input{flex:1;min-width:0;font:inherit;font-size:14px;padding:8px 0;border:0;background:none;color:var(--fg);outline:none}
  .list{overflow:auto;flex:1;padding:0 8px 12px}
  .cat{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;width:100%;padding:12px 8px 6px;border:0;background:var(--side);font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em;text-transform:uppercase;cursor:pointer;text-align:left}
  .cat .dot{width:8px;height:8px;border-radius:50%}
  .cat .n{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums}
  .cat .car{width:12px;height:12px;transition:transform .2s ease;transform:rotate(90deg)}
  .cat[aria-expanded=false] .car{transform:rotate(0)}
  .item{display:grid;grid-template-columns:auto 1fr auto;gap:1px 12px;padding:10px;border-radius:10px;cursor:pointer;align-items:center}
  .item:hover{background:var(--hover)}
  .item.sel{background:var(--sel)}
  .av{grid-row:span 3;align-self:start;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:14px;color:#fff;letter-spacing:0;flex:none}
  .av.lg{width:64px;height:64px;font-size:22px}
  .item .nm{font-weight:600;font-size:14.5px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .item .tm{font-size:12.5px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
  .item .meta{grid-column:2/4;display:flex;gap:6px;align-items:center;min-width:0;font-size:12.5px;color:var(--muted);overflow:hidden;white-space:nowrap}
  .item .meta .ag{overflow:hidden;text-overflow:ellipsis}
  .item .pv{grid-column:2/4;color:var(--fg-2);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
  .item.unread .pv{font-weight:600;opacity:1}
  .pill{font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap;flex:none}
  .p-crit{background:color-mix(in srgb,var(--crit) 14%,transparent);color:var(--crit)}
  .p-warn{background:color-mix(in srgb,var(--warn) 22%,transparent);color:var(--warn-fg)}
  .p-dup{background:var(--crit);color:#fff}
  .udot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none}
  .empty{padding:32px 20px;color:var(--muted);text-align:center;font-size:14px}

  .view{display:grid;grid-template-columns:1fr auto;min-width:0;min-height:0;background:var(--pane)}
  .conv{display:flex;flex-direction:column;min-width:0;min-height:0}
  .vh{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  .vh .av{grid-row:auto;width:36px;height:36px;font-size:13px}
  .vh .who2{flex:1;min-width:140px}
  .vh .who2 b{display:block;font-size:15.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vh .who2 span{font-size:12.5px;color:var(--muted)}
  .btn{display:inline-flex;align-items:center;gap:6px;font-weight:500;font-size:13.5px;border:0;background:var(--hover);border-radius:999px;padding:7px 14px;cursor:pointer;color:var(--fg);text-decoration:none!important;white-space:nowrap}
  .btn:hover{background:color-mix(in srgb,var(--fg) 10%,transparent)}
  .btn.icon{padding:7px}
  .btn.on{color:var(--accent)}
  .btn.pri{background:var(--accent);color:#fff}
  .btn.pri:hover{background:color-mix(in srgb,var(--accent) 88%,#000)}
  .btn[disabled]{opacity:.65;cursor:default}

  .msgs{flex:1;overflow:auto;padding:18px 22px 24px;display:flex;flex-direction:column}
  .who{font-size:12px;color:var(--muted);margin:14px 12px 4px;font-weight:500}
  .who span{font-weight:400;opacity:.8}
  .who.out{text-align:right}
  .who .lock{color:var(--warn-fg);font-weight:600}
  .row{display:flex;margin-top:3px}
  .row.out{justify-content:flex-end}
  .b{max-width:min(68%,560px);padding:9px 14px;border-radius:20px;font-size:14.5px;line-height:1.42;overflow-wrap:anywhere}
  .b.cust{background:var(--b-in);color:var(--b-in-fg);border-bottom-left-radius:6px}
  .b.agent{background:var(--b-out);color:var(--b-out-fg);border-bottom-right-radius:6px}
  .b.bot{background:var(--b-bot);color:#fff;border-bottom-right-radius:6px}
  .b.note{background:var(--b-note);color:var(--b-note-fg);border-bottom-right-radius:6px}
  .b.cust:not(.first){border-top-left-radius:6px}
  .b.agent:not(.first),.b.bot:not(.first),.b.note:not(.first){border-top-right-radius:6px}
  .b a{color:inherit;text-decoration:underline}
  .b.media{padding:3px;background:transparent!important}
  .b .img img{display:block;max-width:240px;max-height:260px;border-radius:17px}
  .b .file{display:flex;align-items:center;gap:8px;text-decoration:none}
  .sys{display:flex;justify-content:center;margin:16px 0 6px}
  .sys span{font-size:12px;color:var(--muted);text-align:center;max-width:80%}
  .sys.end span{background:var(--hover);padding:4px 12px;border-radius:999px;font-weight:500}
  .form{align-self:center;margin:12px 0 4px;background:var(--grouped);border-radius:14px;padding:10px 14px;min-width:240px;max-width:80%;font-size:13.5px}
  .form .fh{font-size:11.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px}
  .form div:not(.fh){display:flex;justify-content:space-between;gap:16px;padding:2px 0}
  .form span{color:var(--muted)}
  .form b{font-weight:500;text-align:right;overflow-wrap:anywhere}

  .info{width:var(--info-w,320px);border-left:1px solid var(--line);overflow:auto;background:var(--grouped);padding-bottom:16px}
  .info:empty{display:none}
  .profile{display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px;padding:22px 16px 14px}
  .profile .av{margin-bottom:6px;align-self:center}
  .pn{font-size:18px;font-weight:600;letter-spacing:-.015em;overflow-wrap:anywhere}
  .pe{font-size:13.5px;color:var(--muted);overflow-wrap:anywhere}
  .chips{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-top:8px}
  .chip{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--card);color:var(--fg-2);box-shadow:0 0 0 .5px var(--line)}
  .chip.vip{background:linear-gradient(135deg,#f7d774,#d4a528);color:#3d2e00;box-shadow:none}
  .chip.good{color:var(--ok)}.chip.bad{color:var(--crit)}.chip.warn{color:var(--warn-fg)}
  .warns{margin:4px 14px 6px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--crit) 12%,transparent);color:var(--crit);font-size:13px;font-weight:500;display:grid;gap:4px}
  .warns div::before{content:"⚠︎ "}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:8px;margin:12px 14px 0}
  .stat{background:var(--card);border-radius:12px;padding:10px;text-align:center}
  .stat b{display:block;font-size:19px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .stat span{font-size:12px;color:var(--muted)}
  .grp{margin:14px 14px 0}
  .grp h4{margin:0 0 6px 12px;font-size:12px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
  .card{background:var(--card);border-radius:12px;padding:0 12px}
  .kv{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:9px 0;border-bottom:.5px solid var(--line);font-size:13.5px}
  .kv:last-child{border-bottom:0}
  .kv .k{color:var(--fg);flex:0 1 auto;min-width:72px;max-width:48%;overflow-wrap:anywhere}
  .kv .v{color:var(--muted);text-align:right;min-width:0;overflow-wrap:anywhere}
  .kv .v.mono{font-family:var(--mono);font-size:13px;color:var(--fg)}
  .copy{cursor:copy;border-radius:5px;transition:background .15s}
  .copy:hover{background:var(--hover)}
  .copy.done{background:color-mix(in srgb,var(--ok) 20%,transparent)}
  .dim{color:var(--muted);opacity:.8}
  .tag{font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--hover)}
  .tag.good{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent)}
  .tag.bad{color:var(--crit);background:color-mix(in srgb,var(--crit) 12%,transparent)}
  .tag.warn{color:var(--warn-fg);background:color-mix(in srgb,var(--warn) 20%,transparent)}
  details{padding:8px 0;font-size:13px;border-top:.5px solid var(--line)}
  summary{cursor:pointer;color:var(--accent);list-style:none}
  summary::-webkit-details-marker{display:none}
  .pg{display:flex;gap:10px;padding:4px 0;min-width:0}
  .pg span{color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
  .pg a{overflow-wrap:anywhere}

  .h{position:absolute;z-index:3}
  .h.r{top:0;right:-3px;width:8px;height:100%;cursor:ew-resize}
  .h.l{top:0;left:-3px;width:8px;height:100%;cursor:ew-resize}
  .h.b{left:0;bottom:-3px;height:8px;width:100%;cursor:ns-resize}
  .h.br{right:-2px;bottom:-2px;width:18px;height:18px;cursor:nwse-resize}
  .h.bl{left:-2px;bottom:-2px;width:18px;height:18px;cursor:nesw-resize}

  .settings{padding:28px;display:grid;gap:14px;max-width:560px}
  .settings h3{margin:0;font-size:20px;letter-spacing:-.015em}
  .settings p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.5}
  .settings label{display:grid;gap:5px;font-size:13px;font-weight:500}
  .settings input{font:inherit;padding:9px 12px;border:0;border-radius:10px;background:var(--hover);color:var(--fg)}
  code{font-family:var(--mono);font-size:12.5px;background:var(--hover);padding:1px 5px;border-radius:5px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  `;

  let host, root, win, mini, listEl, viewEl, convEl, infoEl, errEl, kpiEl, liveEl, bodyEl;

  function loadFont() {
    // macOS'ta SF Pro zaten var; diğer sistemlerde en yakın karşılık Inter. CSP engellerse sistem fontu kalır.
    if (document.getElementById('lci-font')) return;
    const l = document.createElement('link');
    l.id = 'lci-font';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(l);
  }

  function build() {
    loadFont();
    host = document.createElement('div');
    host.id = 'lci-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${css}</style>
      <div class="lci">
        <button class="mini" title="Canlı Chatler (Alt+L)"><span class="dot"></span>Canlı Chatler <span class="n">0</span><span class="c" hidden>0</span></button>
        <section class="win" hidden aria-label="Canlı chatler">
          <div class="bar">
            <span class="name">Canlı Chatler</span>
            <span class="live" title="v${VERSION}"><i></i><span>Canlı</span></span>
            <span class="sp"></span><span class="seg"></span>
            <span class="tb">
              <button data-a="settings" title="Ayarlar" aria-label="Ayarlar">${ICON.gear}</button>
              <button data-a="pin" title="Sabitle: diğer sekmelerde ve programlarda da üstte kalsın" aria-label="Sabitle">${ICON.pin}</button>
              <button data-a="theme" title="Açık / koyu tema" aria-label="Tema">${ICON.theme}</button>
              <button data-a="min" title="Küçült (Esc)" aria-label="Küçült">${ICON.min}</button>
              <button data-a="max" title="Büyüt / geri al" aria-label="Büyüt">${ICON.max}</button>
            </span>
          </div>
          <div class="err" hidden></div>
          <div class="body">
            <aside class="side">
              <div class="tools"><label class="search">${ICON.search}<input type="search" placeholder="Ara: isim, e-posta, IP, mesaj" aria-label="Ara"></label></div>
              <div class="list"></div>
            </aside>
            <div class="split" title="Sürükleyerek genişliği değiştirin"></div>
            <div class="view">
              <div class="conv"><div class="empty" style="margin:auto">Soldan bir chat seçin.</div></div>
              <aside class="info" ${state.info ? '' : 'hidden'}></aside>
            </div>
          </div>
          <span class="h r" data-d="r"></span><span class="h l" data-d="l"></span><span class="h b" data-d="b"></span>
          <span class="h br" data-d="br"></span><span class="h bl" data-d="bl"></span>
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
    kpiEl = shadow.querySelector('.seg');
    liveEl = shadow.querySelector('.live');

    const theme = S.get('theme', '');
    if (theme) root.dataset.theme = theme;
    bodyEl.style.setProperty('--side-w', S.get('sideW', 340) + 'px');
    applyGeo(S.get('geo', null));

    mini.onclick = () => setOpen(true);
    shadow.querySelector('[data-a=min]').onclick = () => setOpen(false);
    shadow.querySelector('[data-a=max]').onclick = toggleMax;
    const pinBtn = shadow.querySelector('[data-a=pin]');
    if (DPIP) pinBtn.onclick = togglePin;
    else { pinBtn.disabled = true; pinBtn.title = 'Sabitleme bu tarayıcıda desteklenmiyor (Chrome / Edge 116+ gerekir)'; }
    shadow.querySelector('[data-a=settings]').onclick = renderSettings;
    shadow.querySelector('[data-a=theme]').onclick = () => {
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      S.set('theme', root.dataset.theme);
    };
    shadow.querySelector('.search input').oninput = (e) => { state.filter = e.target.value.toLowerCase(); renderList(); };

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
      if (!cp || e.target.closest('a')) return;
      (state.pip || window).navigator.clipboard.writeText(cp.dataset.copy).then(() => {
        cp.classList.add('done');
        setTimeout(() => cp.classList.remove('done'), 700);
      }, () => {});
    });

    // Sürükleme ve boyutlandırma
    shadow.querySelector('.bar').addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) startDrag(e, 'move'); });
    shadow.querySelector('.bar').addEventListener('dblclick', (e) => { if (!e.target.closest('button') && !state.pip) toggleMax(); });
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
    const w = Math.min(1180, innerWidth - 80), h = Math.min(720, innerHeight - 100);
    return { x: innerWidth - w - 30, y: 60, w, h };
  }
  function currentGeo() {
    const r = win.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  function applyGeo(g) {
    g = g || defaultGeo();
    const w = clamp(g.w, 620, innerWidth - 16), h = clamp(g.h, 360, innerHeight - 16);
    Object.assign(win.style, {
      width: w + 'px', height: h + 'px',
      left: clamp(g.x, 8 - w + 160, innerWidth - 160) + 'px',
      top: clamp(g.y, 0, innerHeight - 48) + 'px',
    });
  }
  function saveGeo() { if (!maxSaved) S.set('geo', currentGeo()); }

  function startDrag(e, mode) {
    if (state.pip) return;   // sabitliyken pencereyi işletim sistemi taşır/boyutlar
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
      if (mode.includes('l')) { g.w = Math.max(620, r.w - dx); g.x = r.x + r.w - g.w; }
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
    const sx = e.clientX;
    const w = e.target.ownerDocument.defaultView;   // sabitliyken olaylar PiP penceresinde akar
    const w0 = parseInt(w.getComputedStyle(bodyEl).getPropertyValue('--side-w'), 10) || 340;
    const move = (ev) => bodyEl.style.setProperty('--side-w', clamp(w0 + ev.clientX - sx, 260, win.offsetWidth - 360) + 'px');
    const up = () => {
      w.removeEventListener('pointermove', move);
      w.removeEventListener('pointerup', up);
      S.set('sideW', parseInt(bodyEl.style.getPropertyValue('--side-w'), 10));
    };
    w.addEventListener('pointermove', move);
    w.addEventListener('pointerup', up);
  }

  function toggleMax() {
    if (maxSaved) { applyGeo(maxSaved); maxSaved = null; return; }
    maxSaved = currentGeo();
    applyGeo({ x: 8, y: 8, w: innerWidth - 16, h: innerHeight - 16 });
  }

  // ---------- Sabitleme (Document Picture-in-Picture) ----------
  // Panel, tarayıcının her zaman üstte duran ayrı penceresine taşınır; sekme veya program
  // değiştirilse de ekranda kalır. LiveChat sekmesi açık kaldığı sürece çalışır.
  async function togglePin() {
    if (state.pip) { state.pip.close(); return; }
    const g = currentGeo();
    let pip;
    try {
      pip = await DPIP.requestWindow({ width: Math.round(g.w), height: Math.round(g.h) });
    } catch (err) {
      state.error = 'Sabitlenemedi: ' + err.message;
      renderList();
      return;
    }
    state.pip = pip;
    pip.document.title = 'Canlı Chatler';
    pip.document.body.style.cssText = 'margin:0;overflow:hidden';
    const font = document.getElementById('lci-font');
    if (font) pip.document.head.appendChild(font.cloneNode());
    root.classList.add('pinned');
    pip.document.body.appendChild(host);
    pip.addEventListener('pagehide', unpin, { once: true });
    setPinUi();
    startTimers();
  }

  function unpin() {
    state.pip = null;
    root.classList.remove('pinned');
    document.body.appendChild(host);
    applyGeo(S.get('geo', null));
    setPinUi();
    startTimers();
  }

  function setPinUi() {
    const b = root.querySelector('[data-a=pin]');
    b.classList.toggle('on', !!state.pip);
    b.title = state.pip ? 'Sabitlemeyi kaldır (panel sayfaya geri döner)' : 'Sabitle: diğer sekmelerde ve programlarda da üstte kalsın';
  }

  // ---------- Zamanlayıcılar ----------
  // Sabitliyken zamanlayıcılar görünür olan PiP penceresinde kurulur: arka plandaki
  // LiveChat sekmesinin zamanlayıcıları tarayıcı tarafından yavaşlatılır.
  const isVisible = () => !!state.pip || !document.hidden;
  function every(fn, ms) { const w = state.pip || window; return { w, id: w.setInterval(fn, ms) }; }
  function stop(t) { if (t) t.w.clearInterval(t.id); }
  function startChatTimer() {
    stop(state.chatTimer);
    state.chatTimer = every(() => { if (state.open && isVisible()) refreshDetail(false); }, CHAT_INTERVAL);
  }
  function startTimers() {
    stop(state.listTimer);
    // Panel kapalıyken de liste yenilenir: küçük düğmedeki sayaç ve uyarı canlı kalsın.
    state.listTimer = every(() => { if (isVisible()) refreshList(); }, LIST_INTERVAL);
    if (state.selected && !state.ended) startChatTimer();
  }

  function setOpen(open) {
    if (!open && state.pip) state.pip.close();
    state.open = open;
    S.set('open', open);
    win.hidden = !open;
    mini.hidden = open;
    if (open && !creds().pat) renderSettings();
    if (open && state.selected && !state.ended) refreshDetail(false);
  }

  // ---------- Liste ----------
  function itemHtml(c, dup) {
    const now = Date.now();
    const unread = c.lastAt > (state.seen[c.id] || 0) && c.id !== state.selected && c.lastFromCustomer;
    const late = c.waiting && now - c.waiting > WAIT_WARN * 1000;
    const pills = [
      late && c.cat !== 'queue' ? `<span class="pill p-crit">${ago(c.waiting)}</span>` : '',
      c.cat === 'queue' ? `<span class="pill p-warn">${ago(c.waiting || c.started)}</span>` : '',
      c.ip && dup.ip[c.ip] > 1 ? `<span class="pill p-dup" title="Aynı IP'den birden fazla aktif chat">IP ×${dup.ip[c.ip]}</span>` : '',
    ].join('');
    const who = [c.playerId ? `#${c.playerId}` : '', c.agents].filter(Boolean).join(' · ');
    return `<div class="item${c.id === state.selected ? ' sel' : ''}${unread ? ' unread' : ''}" data-id="${esc(c.id)}" tabindex="0">
      <span class="av" style="background:${avatarBg(c.customerId || c.id)}">${esc(initials(c.customer))}</span>
      <span class="nm">${esc(c.customer)}</span>
      <span class="tm">${unread ? '<span class="udot" style="display:inline-block;margin-right:6px;vertical-align:middle"></span>' : ''}${ago(c.started)}</span>
      <span class="meta">${pills}<span class="ag">${esc(who)}</span></span>
      <span class="pv">${c.lastFromCustomer ? '' : esc((c.agents || 'Agent').split(',')[0]) + ': '}${esc(c.preview)}</span>
    </div>`;
  }

  function renderList() {
    const dup = duplicates();
    const all = state.chats.map(summarize);
    const items = all.filter((c) => !state.filter || [c.customer, c.agents, c.email, c.ip, c.playerId, c.preview].join(' ').toLowerCase().includes(state.filter));
    // Cevap bekleyenler (en uzun bekleyen) üstte, ardından son aktiviteye göre.
    const order = (a, b) => (a.waiting && b.waiting ? a.waiting - b.waiting : (b.waiting ? 1 : 0) - (a.waiting ? 1 : 0) || b.lastAt - a.lastAt);
    const chev = '<svg class="car" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

    const html = CATS.map((ct) => {
      const xs = items.filter((c) => c.cat === ct.k).sort(order);
      if (!xs.length) return '';
      const open = !state.closed[ct.k];
      return `<button class="cat" data-cat="${ct.k}" aria-expanded="${open}">${chev}<span class="dot" style="background:${ct.color}"></span>${ct.t}<span class="n">${xs.length}</span></button>
        ${open ? xs.map((c) => itemHtml(c, dup)).join('') : ''}`;
    }).join('');
    const scroll = listEl.scrollTop;
    listEl.innerHTML = html || `<div class="empty">${creds().pat ? (state.filter ? 'Eşleşen chat yok.' : 'Şu an aktif chat yok.') : 'Önce ayarları doldurun.'}</div>`;
    listEl.scrollTop = scroll;

    const count = (k) => all.filter((c) => c.cat === k).length;
    const late = all.filter((c) => c.cat === 'active' && c.waiting && Date.now() - c.waiting > WAIT_WARN * 1000).length;
    kpiEl.innerHTML = CATS.map((ct) => `<span title="${ct.t}"><i style="background:${ct.color}"></i>${count(ct.k)}</span>`).join('');
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
    const chat = state.chats.find((c) => c.id === state.selected) || (state.detail && state.detail.__chat);
    if (!chat || !state.detail) return;
    const s = summarize(chat);
    const users = state.detail.users || [];
    const events = (state.detail.thread && state.detail.thread.events) || [];

    if (!convEl.querySelector('.msgs') || !keepScroll) {
      convEl.innerHTML = `
        <div class="vh"><span class="av" style="background:${avatarBg(s.customerId || s.id)}">${esc(initials(s.customer))}</span>
          <span class="who2"><b>${esc(s.customer)}</b><span class="sub"></span></span>
          <button class="btn icon${state.info ? ' on' : ''}" data-a="info" title="Üye bilgilerini aç / kapat" aria-label="Üye bilgileri">${ICON.info}</button>
          <button class="btn pri" data-a="sup">Supervise et</button>
          <a class="btn icon" href="https://my.livechatinc.com/chats/${encodeURIComponent(s.id)}" target="_blank" rel="noopener" title="LiveChat'te aç" aria-label="LiveChat'te aç">${ICON.ext}</a></div>
        <div class="msgs"></div>`;
      state.sig = { msgs: '', info: '' };
      convEl.querySelector('[data-a=info]').onclick = (e) => {
        state.info = !state.info;
        S.set('infoOpen', state.info);
        infoEl.hidden = !state.info;
        e.currentTarget.classList.toggle('on', state.info);
      };
      convEl.querySelector('[data-a=sup]').onclick = (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        supervise(s.id)
          .then(() => { b.textContent = '✓ Supervise ediliyor'; })
          .catch((err) => { b.disabled = false; state.error = err.message; renderList(); });
      };
    }
    convEl.querySelector('.sub').textContent = `${s.agents || 'Agent atanmadı'} · ${ago(s.started)} önce başladı`;

    // Mesajlar yalnızca değiştiğinde yeniden çizilir; seçili metin ve görseller korunur.
    const last = events[events.length - 1];
    const sig = events.length + ':' + (last ? last.id || last.created_at : '') + ':' + state.ended;
    if (sig !== state.sig.msgs) {
      state.sig.msgs = sig;
      const box = convEl.querySelector('.msgs');
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      const prevTop = box.scrollTop;
      box.innerHTML = (messagesHtml(events, users) || '<div class="empty">Henüz mesaj yok.</div>')
        + (state.ended ? '<div class="sys end"><span>Chat sona erdi</span></div>' : '');
      const stick = !(keepScroll && !atBottom);
      box.scrollTop = stick ? box.scrollHeight : prevTop;
      // Görseller yüklenince yükseklik değişir; alttaysak altta kal.
      if (stick) box.querySelectorAll('img').forEach((img) => img.addEventListener('load', () => { box.scrollTop = box.scrollHeight; }, { once: true }));
    }

    const info = infoHtml(chat);
    if (info !== state.sig.info) {
      state.sig.info = info;
      const top = infoEl.scrollTop;
      const wasOpen = !!infoEl.querySelector('details[open]');
      infoEl.innerHTML = info;
      infoEl.scrollTop = keepScroll ? top : 0;
      if (wasOpen && keepScroll) { const d = infoEl.querySelector('details'); if (d) d.open = true; }
    }
  }

  function renderSettings() {
    state.selected = null;
    stop(state.chatTimer);
    infoEl.innerHTML = '';
    const c = creds();
    convEl.innerHTML = `
      <div class="settings">
        <h3>Bağlantı</h3>
        <p>platform.text.com → Console → <b>Personal Access Tokens</b> bölümünden yeni bir token oluşturun.
        Gereken yetkiler: <code>chats--all:ro</code>, <code>chats--access:ro</code>, üye bilgileri için <code>customers:ro</code>,
        supervise için ayrıca <code>chats--all:rw</code>. Account ID aynı ekranda görünür.
        Bilgiler yalnızca bu tarayıcıdaki Tampermonkey deposunda saklanır.</p>
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
  // 6. AKIŞ
  // ============================================================
  async function refreshList() {
    if (!creds().pat) { renderList(); return; }
    try {
      state.chats = await fetchActiveChats();
      state.error = '';
      if (state.selected && !state.ended && !state.chats.some((c) => c.id === state.selected)) {
        // Chat bitti: konuşma ekranda kalır, sonuna "sona erdi" notu düşer, yenileme durur.
        state.ended = true;
        stop(state.chatTimer);
        renderView(true);
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
      detail.__chat = chat;
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
    state.ended = false;
    state.detail = null;
    convEl.innerHTML = '<div class="empty" style="margin:auto">Yükleniyor…</div>';
    infoEl.innerHTML = '';
    renderList();
    stop(state.chatTimer);
    refreshDetail(true);
    startChatTimer();
  }

  build();
  refreshList();
  startTimers();
})();
