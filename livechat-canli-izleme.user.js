// ==UserScript==
// @name         LiveChat — Canlı Chat İzleme Paneli
// @namespace    livechat-canli-izleme
// @version      1.0.0
// @description  O an yürüyen tüm chatleri tek panelde listeler; tek tıkla konuşmayı canlı okursun, istersen tek tıkla supervise edersin. Comm100 tarzı süpervizör görünümü.
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
  const VERSION = '1.0.0';
  const API = 'https://api.livechatinc.com/v3.5/agent/action/';
  const LIST_INTERVAL = 5000;   // aktif chat listesi yenileme (ms)
  const CHAT_INTERVAL = 3000;   // açık konuşma yenileme (ms)
  const MAX_PAGES = 5;          // list_chats için azami sayfa
  const WAIT_WARN = 60;         // müşteri bu kadar sn cevapsız kalırsa uyarı

  const S = {
    get: (k, d) => GM_getValue(k, d),
    set: (k, v) => GM_setValue(k, v),
  };

  const state = {
    chats: [],            // aktif chat özetleri
    selected: null,       // seçili chat id
    thread: null,         // seçili chatin son thread'i
    seen: {},             // chatId -> görülen son mesaj zamanı
    filter: '',
    error: '',
    listTimer: null,
    chatTimer: null,
    open: false,
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

  function fetchThread(chat) {
    return call('get_chat', { chat_id: chat.id, thread_id: chat.last_thread_summary.id })
      .then((res) => ({ users: res.users || [], thread: res.thread || { events: [] } }));
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

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + ' sn';
    if (s < 3600) return Math.floor(s / 60) + ' dk';
    return Math.floor(s / 3600) + ' sa ' + Math.floor((s % 3600) / 60) + ' dk';
  }

  const hhmm = (iso) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function summarize(c) {
    const users = c.users || [];
    const customer = users.find((u) => u.type === 'customer') || {};
    const agents = users.filter((u) => u.type === 'agent' && u.present !== false);
    const lastMsg = c.last_event_per_type && c.last_event_per_type.message && c.last_event_per_type.message.event;
    const lastAuthor = lastMsg && users.find((u) => u.id === lastMsg.author_id);
    const waiting = lastMsg && lastAuthor && lastAuthor.type === 'customer' ? ts(lastMsg.created_at) : 0;
    return {
      id: c.id,
      customer: customer.name || customer.email || 'Ziyaretçi',
      agents: agents.map((a) => a.name || a.id).join(', ') || '— atanmamış —',
      started: ts(c.last_thread_summary.created_at),
      preview: lastMsg ? (lastMsg.text || '[' + lastMsg.type + ']') : '',
      lastAt: lastMsg ? ts(lastMsg.created_at) : 0,
      waiting,
      queued: !agents.length,
      raw: c,
    };
  }

  function eventHtml(ev, users) {
    const u = users.find((x) => x.id === ev.author_id) || {};
    const who = u.type === 'customer' ? 'cust' : u.type === 'agent' ? 'agent' : 'sys';
    const name = esc(u.name || u.email || ev.author_id || 'Sistem');
    const internal = ev.visibility === 'agents' ? ' lci-internal' : '';
    let body;
    switch (ev.type) {
      case 'message': body = esc(ev.text).replace(/\n/g, '<br>'); break;
      case 'system_message': return `<div class="lci-sys">${esc(ev.text)} · ${hhmm(ev.created_at)}</div>`;
      case 'file': body = `📎 <a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.name || 'dosya')}</a>`; break;
      case 'rich_message': body = esc((ev.elements || []).map((e) => e.title || e.subtitle || '').join(' / ') || '[zengin mesaj]'); break;
      case 'filled_form': body = (ev.fields || []).map((f) => `<b>${esc(f.label)}:</b> ${esc(f.answer && (f.answer.label || f.answer) || '')}`).join('<br>'); break;
      default: body = esc('[' + ev.type + ']');
    }
    return `<div class="lci-msg lci-${who}${internal}"><div class="lci-meta">${name} · ${hhmm(ev.created_at)}${internal ? ' · 🔒 iç not' : ''}</div><div>${body}</div></div>`;
  }

  // ============================================================
  // 3. ARAYÜZ
  // ============================================================
  const css = `
  #lci-fab{position:fixed;right:18px;bottom:18px;z-index:2147483646;background:#ff5100;color:#fff;border:0;border-radius:22px;padding:10px 16px;font:600 14px system-ui;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
  #lci-fab b{background:#fff;color:#ff5100;border-radius:10px;padding:0 7px;margin-left:6px}
  #lci-fab.alert b{background:#d00;color:#fff;animation:lci-pulse 1s infinite}
  @keyframes lci-pulse{50%{opacity:.4}}
  #lci-panel{position:fixed;inset:40px 40px 70px 40px;z-index:2147483647;background:#fff;color:#1b1b20;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.35);display:none;font:13px system-ui;overflow:hidden}
  #lci-panel.open{display:grid;grid-template-columns:360px 1fr;grid-template-rows:auto 1fr}
  .lci-head{grid-column:1/3;display:flex;gap:8px;align-items:center;padding:8px 12px;background:#1b1b20;color:#fff}
  .lci-head input{flex:0 0 220px;padding:5px 8px;border-radius:5px;border:0}
  .lci-head .sp{flex:1}
  .lci-head button{background:#333;color:#fff;border:0;border-radius:5px;padding:5px 10px;cursor:pointer}
  .lci-err{color:#ffb4b4;font-size:12px}
  .lci-list{overflow:auto;border-right:1px solid #e3e3e8}
  .lci-item{padding:9px 12px;border-bottom:1px solid #eee;cursor:pointer}
  .lci-item:hover{background:#f6f6f9}.lci-item.sel{background:#fff1e9;border-left:3px solid #ff5100}
  .lci-item .r1{display:flex;justify-content:space-between;font-weight:600}
  .lci-item .r2{color:#666;font-size:12px;margin-top:2px}
  .lci-item .r3{color:#333;font-size:12px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lci-badge{font-size:11px;border-radius:8px;padding:1px 6px;margin-left:4px;font-weight:600}
  .lci-new{background:#ff5100;color:#fff}.lci-wait{background:#d00;color:#fff}.lci-q{background:#7a4dff;color:#fff}
  .lci-view{display:flex;flex-direction:column;overflow:hidden}
  .lci-vhead{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #e3e3e8}
  .lci-vhead .t{flex:1;font-weight:600}
  .lci-vhead button,.lci-vhead a{background:#ff5100;color:#fff;border:0;border-radius:5px;padding:5px 10px;cursor:pointer;text-decoration:none;font-size:12px}
  .lci-vhead a{background:#555}
  .lci-msgs{flex:1;overflow:auto;padding:12px;background:#f7f7fa}
  .lci-msg{max-width:75%;margin:6px 0;padding:7px 10px;border-radius:8px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08);word-wrap:break-word}
  .lci-cust{margin-right:auto}.lci-agent{margin-left:auto;background:#e8f0ff}
  .lci-internal{background:#fff7d6!important}
  .lci-meta{font-size:11px;color:#888;margin-bottom:2px}
  .lci-sys{text-align:center;color:#999;font-size:11px;margin:6px 0}
  .lci-empty{padding:30px;color:#888;text-align:center}
  .lci-settings{padding:16px;display:grid;gap:8px;max-width:520px}
  .lci-settings input{padding:6px 8px;border:1px solid #ccc;border-radius:5px}
  .lci-settings small{color:#666}
  `;

  let fab, panel, listEl, viewEl, errEl;

  function build() {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    fab = document.createElement('button');
    fab.id = 'lci-fab';
    fab.innerHTML = '👁 Canlı Chatler <b>0</b>';
    fab.onclick = toggle;
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.id = 'lci-panel';
    panel.innerHTML = `
      <div class="lci-head">
        <b>Canlı Chatler</b><span style="opacity:.6">v${VERSION}</span>
        <input type="search" placeholder="Ara: müşteri, agent, mesaj…">
        <span class="lci-err"></span><span class="sp"></span>
        <button data-a="settings">⚙</button><button data-a="close">✕</button>
      </div>
      <div class="lci-list"></div>
      <div class="lci-view"><div class="lci-empty">Soldan bir chat seçin.</div></div>`;
    document.body.appendChild(panel);
    listEl = panel.querySelector('.lci-list');
    viewEl = panel.querySelector('.lci-view');
    errEl = panel.querySelector('.lci-err');

    panel.querySelector('input').oninput = (e) => { state.filter = e.target.value.toLowerCase(); renderList(); };
    panel.querySelector('[data-a=close]').onclick = toggle;
    panel.querySelector('[data-a=settings]').onclick = renderSettings;
    listEl.onclick = (e) => {
      const it = e.target.closest('.lci-item');
      if (it) select(it.dataset.id);
    };
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyL') { e.preventDefault(); toggle(); }
      if (e.key === 'Escape' && state.open) toggle();
    });
  }

  function toggle() {
    state.open = !state.open;
    panel.classList.toggle('open', state.open);
    if (state.open && !creds().pat) renderSettings();
  }

  function renderList() {
    const items = state.chats.map(summarize)
      .filter((c) => !state.filter || (c.customer + ' ' + c.agents + ' ' + c.preview).toLowerCase().includes(state.filter))
      // Önce cevap bekleyenler (en uzun bekleyen en üstte), sonra son aktiviteye göre.
      .sort((a, b) => (a.waiting && b.waiting ? a.waiting - b.waiting : (b.waiting ? 1 : 0) - (a.waiting ? 1 : 0) || b.lastAt - a.lastAt));

    const now = Date.now();
    let alerts = 0;
    listEl.innerHTML = items.length ? items.map((c) => {
      const isNew = c.lastAt > (state.seen[c.id] || 0) && c.id !== state.selected;
      const late = c.waiting && now - c.waiting > WAIT_WARN * 1000;
      if (late || c.queued) alerts++;
      return `<div class="lci-item${c.id === state.selected ? ' sel' : ''}" data-id="${esc(c.id)}">
        <div class="r1"><span>${esc(c.customer)}</span><span>
          ${c.queued ? '<span class="lci-badge lci-q">kuyrukta</span>' : ''}
          ${late ? `<span class="lci-badge lci-wait">⏳ ${ago(c.waiting)}</span>` : ''}
          ${isNew ? '<span class="lci-badge lci-new">yeni</span>' : ''}</span></div>
        <div class="r2">👤 ${esc(c.agents)} · ${ago(c.started)}</div>
        <div class="r3">${esc(c.preview)}</div></div>`;
    }).join('') : `<div class="lci-empty">${creds().pat ? 'Şu an aktif chat yok.' : 'Önce ⚙ ayarlarını doldurun.'}</div>`;

    fab.querySelector('b').textContent = state.chats.length;
    fab.classList.toggle('alert', alerts > 0);
    errEl.textContent = state.error;
  }

  function renderThread(keepScroll) {
    const chat = state.chats.find((c) => c.id === state.selected);
    if (!chat || !state.thread) return;
    const s = summarize(chat);
    const msgs = viewEl.querySelector('.lci-msgs');
    const atBottom = !msgs || msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
    const prevTop = msgs ? msgs.scrollTop : 0;

    viewEl.innerHTML = `
      <div class="lci-vhead"><span class="t">${esc(s.customer)} <span style="font-weight:400;color:#666">· ${esc(s.agents)}</span></span>
        <button data-a="sup">Supervise et</button>
        <a href="https://my.livechatinc.com/chats/${encodeURIComponent(s.id)}" target="_blank" rel="noopener">LiveChat'te aç ↗</a></div>
      <div class="lci-msgs">${(state.thread.thread.events || []).map((ev) => eventHtml(ev, state.thread.users)).join('') || '<div class="lci-empty">Henüz mesaj yok.</div>'}</div>`;

    const box = viewEl.querySelector('.lci-msgs');
    box.scrollTop = keepScroll && !atBottom ? prevTop : box.scrollHeight;
    viewEl.querySelector('[data-a=sup]').onclick = (e) => {
      e.target.disabled = true;
      supervise(s.id)
        .then(() => { e.target.textContent = '✓ Supervise ediliyor'; })
        .catch((err) => { e.target.disabled = false; state.error = err.message; renderList(); });
    };
  }

  function renderSettings() {
    state.selected = null;
    clearInterval(state.chatTimer);
    const c = creds();
    viewEl.innerHTML = `
      <div class="lci-settings">
        <h3 style="margin:0">Bağlantı ayarları</h3>
        <small>platform.text.com → Console → <b>Personal Access Tokens</b> → yeni token oluşturun.
        Gereken yetkiler (scope): <code>chats--all:ro</code>, <code>chats--access:ro</code>, supervise için ayrıca <code>chats--all:rw</code>.
        Token ekranında <b>Account ID</b> de görünür. Bilgiler yalnızca bu tarayıcıdaki Tampermonkey deposunda saklanır.</small>
        <label>Account ID<br><input name="accountId" style="width:100%" value="${esc(c.account)}"></label>
        <label>Personal Access Token<br><input name="pat" type="password" style="width:100%" value="${esc(c.pat)}"></label>
        <label>Agent e-postanız (supervise için)<br><input name="email" style="width:100%" value="${esc(c.email)}"></label>
        <div><button data-a="save" style="background:#ff5100;color:#fff;border:0;border-radius:5px;padding:7px 14px;cursor:pointer">Kaydet ve bağlan</button></div>
      </div>`;
    viewEl.querySelector('[data-a=save]').onclick = () => {
      viewEl.querySelectorAll('input').forEach((i) => S.set(i.name, i.value.trim()));
      viewEl.innerHTML = '<div class="lci-empty">Kaydedildi. Soldan bir chat seçin.</div>';
      refreshList();
    };
  }

  // ============================================================
  // 4. AKIŞ
  // ============================================================
  async function refreshList() {
    if (!creds().pat) { renderList(); return; }
    try {
      state.chats = await fetchActiveChats();
      state.error = '';
      if (state.selected && !state.chats.some((c) => c.id === state.selected)) {
        viewEl.insertAdjacentHTML('afterbegin', '<div class="lci-sys" style="background:#fee;padding:4px">Bu chat sona erdi.</div>');
        state.selected = null;
        clearInterval(state.chatTimer);
      }
    } catch (err) {
      state.error = err.message;
    }
    renderList();
  }

  async function refreshThread(first) {
    const chat = state.chats.find((c) => c.id === state.selected);
    if (!chat) return;
    try {
      state.thread = await fetchThread(chat);
      state.seen[chat.id] = Date.now();
      renderThread(!first);
    } catch (err) {
      state.error = err.message;
      renderList();
    }
  }

  function select(id) {
    state.selected = id;
    state.thread = null;
    viewEl.innerHTML = '<div class="lci-empty">Yükleniyor…</div>';
    renderList();
    clearInterval(state.chatTimer);
    refreshThread(true);
    state.chatTimer = setInterval(() => { if (state.open && !document.hidden) refreshThread(false); }, CHAT_INTERVAL);
  }

  build();
  refreshList();
  // Panel kapalıyken de liste yenilenir: düğmedeki sayaç ve ⏳ uyarısı canlı kalsın.
  state.listTimer = setInterval(() => { if (!document.hidden) refreshList(); }, LIST_INTERVAL);
})();
