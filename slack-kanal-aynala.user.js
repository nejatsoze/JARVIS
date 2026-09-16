// ==UserScript==
// @name         Slack Kanal Aynalama (C08TKRJQ96G → C0BMBT1A6KX)
// @namespace    slack-kanal-aynala
// @version      1.1.0
// @description  Kaynak kanala düşen her mesajı ve her thread cevabını hedef kanala BİREBİR aktarır: ekleme yok, çıkarma yok. WebSocket kancası ile anlık, periyodik yoklama ile kayıpsız; düzenleme ve silmeleri de aynalar.
// @author       —
// @match        https://app.slack.com/*
// @match        https://*.slack.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 0. AYARLAR
  // ============================================================
  const CONFIG = {
    SRC: 'C08TKRJQ96G',          // kaynak kanal (dinlenen)
    DST: 'C0BMBT1A6KX',          // hedef kanal (yazılan)

    // BİREBİR KOPYA: metne hiç dokunulmaz, hiçbir şey eklenmez.
    // Zengin biçimlendirme (kalın, liste, kod, alıntı, emoji) `blocks` olarak
    // olduğu gibi taşınır. Aşağıdaki INCLUDE_* / KEEP_* ayarları yalnız
    // EXACT_COPY:false iken devreye girer.
    EXACT_COPY: true,

    // Deneysel: mesajı orijinal yazarın adı ve avatarıyla göndermeyi dener.
    // Çoğu workspace bunu kullanıcı oturumuna kapatır; kapalıysa script
    // kendiliğinden normal gönderime döner. Kapalıyken mesajlar SENİN
    // adınla görünür (tarayıcı oturumuyla çalışmanın kaçınılmaz sonucu).
    IMPERSONATE_AUTHOR: false,

    MIRROR_THREADS: true,        // thread cevaplarını hedefte de thread olarak tut
    MIRROR_EDITS: true,          // kaynakta düzenlenen mesajı hedefte güncelle
    MIRROR_DELETES: true,        // kaynakta silinen mesajı hedefte de sil
    UNFURL: true,                // hedefte bağlantı önizlemeleri açılsın mı

    // --- yalnız EXACT_COPY:false iken --------------------------------
    INCLUDE_AUTHOR: true,        // mesajın başına "*Yazar*" satırı ekle
    INCLUDE_PERMALINK: true,     // yazar satırına orijinal mesajın bağlantısını ekle
    KEEP_USER_MENTIONS: false,   // false → <@U123> düz "@ad" metnine çevrilir

    BACKFILL_MINUTES: 0,         // ilk açılışta kaç dakikalık geçmiş aktarılsın (0 = yok)
    POLL_SECONDS: 20,            // WebSocket'in kaçırdıklarını toplayan yoklama aralığı
    POST_INTERVAL_MS: 1200,      // iki gönderim arası asgari bekleme (Slack hız sınırı)
    MAX_SEEN: 800,               // hatırlanan mesaj sayısı (tekrar göndermeyi önler)

    // aktarılmayan sistem mesajları
    SKIP_SUBTYPES: [
      'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
      'channel_name', 'channel_archive', 'channel_unarchive',
      'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name',
      'message_replied', 'tombstone', 'bot_add', 'bot_remove', 'pinned_item',
    ],

    DEBUG: false,
  };

  const VERSION = '1.1.0';
  const PREFIX = '[SLACK AYNA]';
  const STATE_KEY = `slackMirror.state.${CONFIG.SRC}.${CONFIG.DST}.v1`;
  const USERS_KEY = 'slackMirror.users.v1';

  const log = (...a) => console.log(PREFIX, ...a);
  const dbg = (...a) => { if (CONFIG.DEBUG) console.log(PREFIX, ...a); };
  const warn = (...a) => console.warn(PREFIX, ...a);
  const fail = (...a) => console.error(PREFIX, ...a);

  // ============================================================
  // 1. YARDIMCILAR
  // ============================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* kota */ }
  }

  // Slack ts değerleri "1712345678.001200" biçiminde; string karşılaştırma yanıltır.
  const tsNum = (ts) => Number(ts) || 0;
  const tsGreater = (a, b) => tsNum(a) > tsNum(b);
  const nowTs = () => (Date.now() / 1000).toFixed(6);

  // ============================================================
  // 2. DURUM (kalıcı)
  // ============================================================
  const state = Object.assign(
    { seen: [], map: {}, threads: {}, lastTs: '', paused: false, count: 0 },
    readJSON(STATE_KEY, {})
  );
  const seenSet = new Set(state.seen);
  const inFlight = new Set();
  const userCache = readJSON(USERS_KEY, {});

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.seen = state.seen.slice(-CONFIG.MAX_SEEN);
      writeJSON(STATE_KEY, state);
    }, 400);
  }

  function markSeen(ts) {
    if (seenSet.has(ts)) return;
    seenSet.add(ts);
    state.seen.push(ts);
    if (state.seen.length > CONFIG.MAX_SEEN) {
      const drop = state.seen.splice(0, state.seen.length - CONFIG.MAX_SEEN);
      drop.forEach((t) => seenSet.delete(t));
    }
    save();
  }

  // ============================================================
  // 3. SLACK API
  // ============================================================
  // Not: istek tarayıcının kendi oturumuyla, sayfa kaynağından atılır.
  // Token localStorage'daki istemci yapılandırmasından okunur, `d` çerezi
  // tarayıcı tarafından otomatik eklenir. Hiçbir veri dışarı çıkmaz.
  const apiBase = `${location.origin}/api`;
  let token = null;

  function collectTokens() {
    const out = [];
    const cfg = readJSON('localConfig_v2', null);
    if (cfg && cfg.teams) {
      const last = cfg.lastActiveTeamId;
      const ids = Object.keys(cfg.teams).sort((a, b) => (a === last ? -1 : b === last ? 1 : 0));
      for (const id of ids) {
        const t = cfg.teams[id] && cfg.teams[id].token;
        if (t && !out.includes(t)) out.push(t);
      }
    }
    if (!out.length) { // eski istemci / farklı anahtar biçimleri için son çare
      for (let i = 0; i < localStorage.length; i++) {
        const raw = localStorage.getItem(localStorage.key(i)) || '';
        const m = raw.match(/xox[cse]-[\w-]+/g);
        if (m) m.forEach((t) => { if (!out.includes(t)) out.push(t); });
      }
    }
    return out;
  }

  async function rawApi(method, params, tokenOverride) {
    const fd = new FormData();
    fd.append('token', tokenOverride || token);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const res = await fetch(`${apiBase}/${method}`, {
      method: 'POST', body: fd, credentials: 'include',
    });
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 5) * 1000;
      return { ok: false, error: 'ratelimited', _retryAfter: wait };
    }
    return res.json();
  }

  async function api(method, params, tries = 0) {
    const json = await rawApi(method, params);
    if (!json.ok) {
      if (json.error === 'ratelimited' && tries < 5) {
        await sleep(json._retryAfter || 2000 * (tries + 1));
        return api(method, params, tries + 1);
      }
      const err = new Error(`${method}: ${json.error || 'bilinmeyen hata'}`);
      err.slackError = json.error;
      throw err;
    }
    return json;
  }

  // Doğru takımın token'ını seç: kaynak kanalı görebilen ilk token kazanır.
  async function resolveToken() {
    const candidates = collectTokens();
    if (!candidates.length) throw new Error('Slack token bulunamadı — Slack web istemcisinde oturum açık mı?');
    for (const cand of candidates) {
      try {
        const info = await rawApi('conversations.info', { channel: CONFIG.SRC }, cand);
        if (info.ok) { token = cand; return info.channel; }
        dbg('token elendi:', info.error);
      } catch (e) { dbg('token denemesi başarısız', e); }
    }
    throw new Error(`Hiçbir oturum ${CONFIG.SRC} kanalını göremiyor (kanalın üyesi misiniz?)`);
  }

  // { n: görünen ad, i: avatar url }
  async function getUserProfile(id) {
    if (!id) return { n: 'bilinmeyen', i: '' };
    const hit = userCache[id];
    if (hit && typeof hit === 'object') return hit;
    if (typeof hit === 'string' && !CONFIG.IMPERSONATE_AUTHOR) return { n: hit, i: '' };
    let out = { n: id, i: '' };
    try {
      const r = await api('users.info', { user: id });
      const p = r.user.profile || {};
      out = {
        n: p.display_name || p.real_name || r.user.real_name || r.user.name || id,
        i: p.image_72 || p.image_48 || p.image_192 || '',
      };
    } catch (_) { /* ad yerine id ile devam */ }
    userCache[id] = out;
    writeJSON(USERS_KEY, userCache);
    return out;
  }

  const getUserName = async (id) => (await getUserProfile(id)).n;

  // ============================================================
  // 4. METİN DÖNÜŞÜMÜ
  // ============================================================
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // @channel / @here / @everyone / @grup çağrılarını düz metne indirger:
  // ayna kanalı her aktarımda tüm üyeleri uyandırmasın.
  function neutralizeBroadcasts(text) {
    return String(text)
      .replace(/<!(channel|here|everyone)(\|[^>]*)?>/g, (_m, kind) => `@${kind}`)
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label) => label || '@grup');
  }

  function mentionIds(text) {
    const ids = [];
    String(text).replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id) => { ids.push(id); return _m; });
    return [...new Set(ids)];
  }

  function plainMentions(text, names) {
    return String(text).replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g,
      (_m, id, label) => `@${label || names[id] || id}`);
  }

  // Mesaj metnini hedefe uygun hâle getirir. Slack'in kendi kodlaması
  // (bağlantı, kanal, emoji) olduğu gibi korunur.
  async function transformText(raw) {
    let text = neutralizeBroadcasts(raw || '');
    if (!CONFIG.KEEP_USER_MENTIONS) {
      const ids = mentionIds(text);
      const names = {};
      await Promise.all(ids.map(async (id) => { names[id] = await getUserName(id); }));
      text = plainMentions(text, names);
    }
    return text;
  }

  // Dosyalar hedef kanala yeniden yüklenemez; Slack'in kendi kalıcı bağlantısı
  // gönderildiğinde önizleme hedefte de olduğu gibi açılır.
  function fileLinks(msg) {
    if (!Array.isArray(msg.files) || !msg.files.length) return '';
    return msg.files.map((f) => f.permalink || f.url_private || '').filter(Boolean).join('\n');
  }

  function fileLines(msg) {
    if (!Array.isArray(msg.files) || !msg.files.length) return '';
    return '\n' + msg.files.map((f) => {
      const name = esc(f.name || f.title || 'dosya');
      return f.permalink ? `📎 <${f.permalink}|${name}>` : `📎 ${name}`;
    }).join('\n');
  }

  async function authorInfo(msg) {
    if (msg.user) {
      const p = await getUserProfile(msg.user);
      return { name: p.n, icon: p.i };
    }
    const icons = (msg.bot_profile && msg.bot_profile.icons) || msg.icons || {};
    const name = (msg.bot_profile && msg.bot_profile.name) || msg.username ||
      (msg.bot_id ? `bot ${msg.bot_id}` : 'bilinmeyen');
    return { name, icon: icons.image_72 || icons.image_48 || '' };
  }

  const authorOf = async (msg) => (await authorInfo(msg)).name;

  async function permalinkOf(ts) {
    if (!CONFIG.INCLUDE_PERMALINK) return '';
    try {
      const r = await api('chat.getPermalink', { channel: CONFIG.SRC, message_ts: ts });
      return r.permalink || '';
    } catch (_) { return ''; }
  }

  // Gönderilecek payload'u kurar.
  async function buildPayload(msg) {
    const payload = {
      channel: CONFIG.DST,
      unfurl_links: CONFIG.UNFURL,
      unfurl_media: CONFIG.UNFURL,
      mrkdwn: true,
    };

    if (CONFIG.IMPERSONATE_AUTHOR) {
      const a = await authorInfo(msg);
      payload.username = a.name;
      if (a.icon) payload.icon_url = a.icon;
      payload.as_user = false;
    }

    // ---- BİREBİR KOPYA ----------------------------------------------
    // Metin ham hâliyle gider: biçimlendirme, emoji, bahsetmeler, kanal
    // bağlantıları — hepsi kaynaktaki kodlamasıyla. Zengin içerik `blocks`
    // olarak birebir taşınır, böylece hedefte aynı görünür.
    if (CONFIG.EXACT_COPY) {
      const links = fileLinks(msg);
      payload.text = [msg.text || '', links].filter(Boolean).join('\n');
      if (Array.isArray(msg.blocks) && msg.blocks.length) {
        payload.blocks = links
          ? [...msg.blocks, { type: 'section', text: { type: 'mrkdwn', text: links } }]
          : msg.blocks;
      }
      if (Array.isArray(msg.attachments) && msg.attachments.length) {
        payload.attachments = msg.attachments;
      }
      return payload;
    }

    // ---- AÇIKLAMALI KİP (yazar satırı + kalıcı bağlantı) -------------
    const [author, body, link] = await Promise.all([
      authorOf(msg),
      transformText(msg.text),
      permalinkOf(msg.ts),
    ]);

    const header = CONFIG.INCLUDE_AUTHOR
      ? `*${esc(author)}*${link ? ` <${link}|↗>` : ''}`
      : '';

    const files = fileLines(msg);
    const hasText = Boolean((msg.text || '').trim());

    if (!hasText && Array.isArray(msg.blocks) && msg.blocks.length) {
      const blocks = header
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: header }] }, ...msg.blocks]
        : msg.blocks.slice();
      payload.blocks = blocks;
      payload.text = `${author}: (blok mesaj)`;
      if (Array.isArray(msg.attachments) && msg.attachments.length) payload.attachments = msg.attachments;
    } else {
      payload.text = [header, body + files].filter(Boolean).join('\n');
      if (!hasText && Array.isArray(msg.attachments) && msg.attachments.length) {
        payload.attachments = msg.attachments;
      }
    }
    return payload;
  }

  // ============================================================
  // 5. AKTARMA ÇEKİRDEĞİ
  // ============================================================
  const queue = [];
  let draining = false;

  function enqueue(job) {
    queue.push(job);
    drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const job = queue.shift();
      try { await job(); } catch (e) { fail('iş başarısız:', e.message || e); }
      if (queue.length) await sleep(CONFIG.POST_INTERVAL_MS);
    }
    draining = false;
  }

  function isMirrorable(msg) {
    if (!msg || !msg.ts) return false;
    if (msg.subtype && CONFIG.SKIP_SUBTYPES.includes(msg.subtype)) return false;
    if (msg.hidden) return false;
    const hasBody = (msg.text || '').trim() ||
      (Array.isArray(msg.files) && msg.files.length) ||
      (Array.isArray(msg.blocks) && msg.blocks.length) ||
      (Array.isArray(msg.attachments) && msg.attachments.length);
    return Boolean(hasBody);
  }

  // Thread cevabının hedefte de thread altında durabilmesi için üst mesajın
  // aktarılmış olması gerekir; değilse önce o aktarılır.
  async function ensureParent(parentTs) {
    if (state.map[parentTs]) return state.map[parentTs];
    try {
      const r = await api('conversations.history', {
        channel: CONFIG.SRC, latest: parentTs, oldest: parentTs, inclusive: true, limit: 1,
      });
      const parent = (r.messages || [])[0];
      if (parent && isMirrorable(parent)) {
        await postMessage(parent, null);
        return state.map[parentTs] || null;
      }
    } catch (e) { dbg('üst mesaj alınamadı:', e.message); }
    return null;
  }

  // Kullanıcı oturumuyla yazar taklidi çoğu workspace'te kapalıdır.
  const IMPERSONATE_ERRORS = [
    'not_allowed_token_type', 'as_user_not_supported', 'invalid_arguments', 'cannot_post_as_user',
  ];

  async function postMessage(msg, parentDstTs) {
    const payload = await buildPayload(msg);
    if (parentDstTs) payload.thread_ts = parentDstTs;
    let r;
    try {
      r = await api('chat.postMessage', payload);
    } catch (e) {
      if (!CONFIG.IMPERSONATE_AUTHOR || !IMPERSONATE_ERRORS.includes(e.slackError)) throw e;
      warn(`yazar taklidi bu oturumda desteklenmiyor (${e.slackError}), kapatıldı`);
      CONFIG.IMPERSONATE_AUTHOR = false;
      delete payload.username; delete payload.icon_url; delete payload.as_user;
      r = await api('chat.postMessage', payload);
    }
    state.map[msg.ts] = r.ts;
    state.count++;
    markSeen(msg.ts);
    if (tsGreater(msg.ts, state.lastTs)) state.lastTs = msg.ts;
    save();
    updateBadge();
    dbg('aktarıldı', msg.ts, '→', r.ts);
    return r.ts;
  }

  function forward(msg) {
    if (state.paused) return;
    if (!isMirrorable(msg)) return;
    const ts = msg.ts;
    if (seenSet.has(ts) || inFlight.has(ts)) return;
    if (state.map[ts]) { markSeen(ts); return; }
    inFlight.add(ts);

    enqueue(async () => {
      try {
        const isReply = msg.thread_ts && msg.thread_ts !== msg.ts;
        let parentDstTs = null;
        if (isReply && CONFIG.MIRROR_THREADS) {
          parentDstTs = state.map[msg.thread_ts] || await ensureParent(msg.thread_ts);
        }
        await postMessage(msg, parentDstTs);
        if (isReply && tsGreater(ts, state.threads[msg.thread_ts] || '')) {
          state.threads[msg.thread_ts] = ts;
          save();
        }
      } finally {
        inFlight.delete(ts);
      }
    });
  }

  function forwardEdit(msg) {
    if (state.paused || !CONFIG.MIRROR_EDITS) return;
    const dstTs = state.map[msg.ts];
    if (!dstTs) return;                       // aynalanmamış mesajın düzenlemesi ilgilendirmez
    enqueue(async () => {
      const payload = await buildPayload(msg);
      delete payload.thread_ts;
      await api('chat.update', {
        channel: CONFIG.DST, ts: dstTs,
        text: payload.text, blocks: payload.blocks, attachments: payload.attachments,
      });
      dbg('güncellendi', msg.ts);
    });
  }

  function forwardDelete(srcTs) {
    if (state.paused || !CONFIG.MIRROR_DELETES) return;
    const dstTs = state.map[srcTs];
    if (!dstTs) return;
    enqueue(async () => {
      try { await api('chat.delete', { channel: CONFIG.DST, ts: dstTs }); }
      catch (e) { dbg('silinemedi:', e.message); }
      delete state.map[srcTs];
      save();
    });
  }

  // ============================================================
  // 6. WEBSOCKET KANCASI (anlık aktarım)
  // ============================================================
  function handleEvent(ev) {
    if (!ev || ev.type !== 'message') return;
    if (ev.channel !== CONFIG.SRC) return;

    if (ev.subtype === 'message_changed') {
      const m = ev.message;
      if (!m) return;
      if (m.subtype === 'tombstone') { forwardDelete(m.ts); return; }
      forwardEdit(m);
      return;
    }
    if (ev.subtype === 'message_deleted') {
      forwardDelete(ev.deleted_ts);
      return;
    }
    forward(ev);
  }

  function tapFrame(data) {
    if (typeof data === 'string') {
      if (data.indexOf(CONFIG.SRC) === -1) return;   // ucuz ön eleme
      let parsed;
      try { parsed = JSON.parse(data); } catch (_) { return; }
      handleEvent(parsed);
    } else if (data instanceof Blob) {
      data.text().then(tapFrame).catch(() => {});
    } else if (data instanceof ArrayBuffer) {
      try { tapFrame(new TextDecoder().decode(data)); } catch (_) { /* ikili çerçeve */ }
    }
  }

  function hookWebSocket() {
    const Native = window.WebSocket;
    if (!Native || Native.__slackMirrorHooked) return;
    const Hooked = new Proxy(Native, {
      construct(target, args) {
        const ws = new target(...args);
        try {
          ws.addEventListener('message', (e) => {
            try { tapFrame(e.data); } catch (err) { dbg('çerçeve okunamadı', err); }
          });
        } catch (_) { /* yoklama yedeği var */ }
        return ws;
      },
    });
    Hooked.__slackMirrorHooked = true;
    try {
      window.WebSocket = Hooked;
      dbg('WebSocket kancası kuruldu');
    } catch (e) {
      warn('WebSocket kancası kurulamadı, yalnız yoklama çalışacak:', e.message);
    }
  }

  // ============================================================
  // 7. YOKLAMA (kayıpsızlık yedeği)
  // ============================================================
  let polling = false;

  async function pollThread(parent) {
    const seenReply = state.threads[parent.ts] || '';
    if (parent.latest_reply && !tsGreater(parent.latest_reply, seenReply)) return;
    const r = await api('conversations.replies', {
      channel: CONFIG.SRC, ts: parent.ts, oldest: seenReply || parent.ts, limit: 100,
    });
    for (const m of r.messages || []) {
      if (m.ts === parent.ts) continue;
      forward(m);
    }
    if (parent.latest_reply && tsGreater(parent.latest_reply, seenReply)) {
      state.threads[parent.ts] = parent.latest_reply;
      save();
    }
  }

  async function poll() {
    if (polling || state.paused || !token) return;
    polling = true;
    try {
      const r = await api('conversations.history', {
        channel: CONFIG.SRC, oldest: state.lastTs || nowTs(), limit: 100,
      });
      const msgs = (r.messages || []).slice().reverse();   // eskiden yeniye
      for (const m of msgs) {
        forward(m);
        if (CONFIG.MIRROR_THREADS && m.reply_count) {
          try { await pollThread(m); } catch (e) { dbg('thread yoklaması:', e.message); }
        }
        if (tsGreater(m.ts, state.lastTs)) state.lastTs = m.ts;
      }
      save();
      if (statusText === 'hata') setStatus('dinleniyor');
    } catch (e) {
      warn('yoklama başarısız:', e.message);
      setStatus('hata', e.message);
    } finally {
      polling = false;
    }
  }

  // ============================================================
  // 8. ARAYÜZ (durum rozeti)
  // ============================================================
  let badge = null;
  let statusText = 'başlatılıyor';
  let statusDetail = '';

  function setStatus(text, detail) {
    statusText = text;
    if (detail !== undefined) statusDetail = detail;
    updateBadge();
  }

  function updateBadge() {
    if (!badge) return;
    const dot = state.paused ? '⏸' : statusText === 'hata' ? '⚠️' : '🔁';
    badge.textContent = `${dot} ayna ${state.count}`;
    badge.title = `${PREFIX} v${VERSION}\n${CONFIG.SRC} → ${CONFIG.DST}\n` +
      `durum: ${state.paused ? 'duraklatıldı' : statusText}${statusDetail ? ' — ' + statusDetail : ''}\n` +
      `aktarılan: ${state.count}\ntıkla: duraklat/devam`;
    badge.style.opacity = state.paused ? '0.45' : '0.85';
  }

  function mountBadge() {
    if (!document.body || badge) return;
    badge = document.createElement('div');
    badge.id = 'slack-mirror-badge';
    Object.assign(badge.style, {
      position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483000',
      padding: '4px 10px', borderRadius: '999px', font: '12px/1.6 system-ui, sans-serif',
      background: 'rgba(26,29,33,.9)', color: '#fff', cursor: 'pointer',
      userSelect: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.3)', opacity: '.85',
    });
    badge.addEventListener('click', () => {
      state.paused = !state.paused;
      save();
      log(state.paused ? 'duraklatıldı' : 'devam ediyor');
      updateBadge();
    });
    document.body.appendChild(badge);
    updateBadge();
  }

  // ============================================================
  // 9. BAŞLATMA
  // ============================================================
  hookWebSocket();   // document-start: Slack kendi soketini açmadan önce

  async function start() {
    mountBadge();
    try {
      const src = await resolveToken();
      const dst = await api('conversations.info', { channel: CONFIG.DST });
      log(`hazır: #${src.name || CONFIG.SRC} → #${(dst.channel && dst.channel.name) || CONFIG.DST}`);
      setStatus('dinleniyor', `#${src.name || CONFIG.SRC} → #${(dst.channel && dst.channel.name) || CONFIG.DST}`);
    } catch (e) {
      fail(e.message);
      setStatus('hata', e.message);
      return;
    }

    if (!state.lastTs) {
      const back = CONFIG.BACKFILL_MINUTES > 0
        ? ((Date.now() - CONFIG.BACKFILL_MINUTES * 60000) / 1000).toFixed(6)
        : nowTs();
      state.lastTs = back;
      save();
      log(CONFIG.BACKFILL_MINUTES > 0
        ? `ilk çalıştırma: son ${CONFIG.BACKFILL_MINUTES} dk aktarılacak`
        : 'ilk çalıştırma: yalnız bundan sonraki mesajlar aktarılacak');
    }

    poll();
    setInterval(poll, Math.max(5, CONFIG.POLL_SECONDS) * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // ============================================================
  // 10. KONSOL API'Sİ
  // ============================================================
  window.SlackMirror = {
    version: VERSION,
    config: CONFIG,
    state,
    status: () => ({ status: statusText, detail: statusDetail, paused: state.paused, queued: queue.length, count: state.count }),
    pause() { state.paused = true; save(); updateBadge(); },
    resume() { state.paused = false; save(); updateBadge(); poll(); },
    poll,
    /** Son N dakikayı yeniden tarar (aktarılmışlar tekrar gönderilmez). */
    resync(minutes = 60) {
      state.lastTs = ((Date.now() - minutes * 60000) / 1000).toFixed(6);
      save();
      return poll();
    },
    /** Hatırlanan mesaj/eşleşme kayıtlarını siler. */
    reset() {
      state.seen.length = 0; seenSet.clear();
      state.map = {}; state.threads = {}; state.lastTs = nowTs(); state.count = 0;
      save(); updateBadge();
    },
    // testler için saf yardımcılar
    _: { neutralizeBroadcasts, plainMentions, mentionIds, isMirrorable, fileLinks, fileLines, tsGreater },
  };

  log(`v${VERSION} yüklendi — ${CONFIG.SRC} → ${CONFIG.DST}`);
})();
