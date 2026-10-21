// ==UserScript==
// @name         Slack Araçları (Okundu + Watcher + Ayna)
// @namespace    palentis.slack.tools
// @version      2.3.2
// @description  Dört aracı tek script'te toplar: tümünü okundu işaretle, kanal watcher (Mola bildirimi), kanal aynalama (şimdilik kapalı) ve C08TKRJQ96G'ye otomatik tepki (👀 ve 🔍 ayrı butonlar). Ortak, taşınabilir buton adası. Ayna yalnız ana mesajları aktarır (thread cevapları aktarılmaz); 2.1.0'a geçişte birikmiş kuyruk bir kez sıfırlanır.
// @match        https://app.slack.com/*
// @match        https://*.slack.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * NEDEN @grant none?
 * Ayna modülü, Slack'in WebSocket'ini dinleyebilmek için sayfanın kendi
 * bağlamında çalışmak zorunda. Bu yüzden tüm script sayfa bağlamında çalışır;
 * API istekleri Slack'in kendi adresine (location.origin/api) tarayıcı
 * oturumuyla atılır, ayarlar localStorage'da tutulur.
 */

(function () {
  'use strict';

  if (window.__slackToolsActive) {
    console.log('[SlackTools] Zaten aktif, bu enjeksiyon atlanıyor.');
    return;
  }
  window.__slackToolsActive = true;

  // ============================================================
  // ORTAK YARDIMCILAR
  // ============================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Slack API — sayfanın kendi oturumuyla, aynı adresten
  async function slackFetch(method, params, token) {
    const fd = new FormData();
    fd.append('token', token);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const res = await fetch(`${location.origin}/api/${method}`, {
      method: 'POST', body: fd, credentials: 'include',
    });
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 5) * 1000;
      return { ok: false, error: 'ratelimited', _retryAfter: wait };
    }
    return res.json();
  }

  function readLocalConfig() {
    try { return JSON.parse(localStorage.getItem('localConfig_v2') || '{}'); }
    catch (_) { return {}; }
  }

  // ============================================================
  // BUTON ADASI (ortak, taşınabilir)
  // ============================================================
  const Island = (() => {
    const POS_KEY = 'slackTools.islandPos';
    let el = null;
    let observer = null;

    function readPos() {
      try { return JSON.parse(localStorage.getItem(POS_KEY)) || { right: 16, bottom: 12 }; }
      catch (_) { return { right: 16, bottom: 12 }; }
    }

    function clampAndApply(right, bottom) {
      const maxR = Math.max(0, window.innerWidth - el.offsetWidth);
      const maxB = Math.max(0, window.innerHeight - el.offsetHeight);
      el.style.right = Math.min(maxR, Math.max(0, right)) + 'px';
      el.style.bottom = Math.min(maxB, Math.max(0, bottom)) + 'px';
    }

    function create() {
      const pos = readPos();
      el = document.createElement('div');
      el.id = 'slack-tools-island';
      Object.assign(el.style, {
        position: 'fixed', right: pos.right + 'px', bottom: pos.bottom + 'px',
        zIndex: '2147483000', display: 'flex', alignItems: 'center', gap: '6px',
        padding: '5px 6px', borderRadius: '14px', background: 'rgba(26,29,33,.92)',
        boxShadow: '0 4px 14px rgba(0,0,0,.35)', font: '600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        userSelect: 'none',
      });

      // Sürükleme tutamağı: tıklamalar butonlarda, sürükleme burada
      const handle = document.createElement('div');
      handle.textContent = '⠿';
      handle.title = 'Sürükle: adayı taşı';
      Object.assign(handle.style, {
        cursor: 'grab', color: '#9aa0a6', fontSize: '16px', padding: '0 3px', lineHeight: '1',
      });
      el.appendChild(handle);

      let dragging = false, sx, sy, sr, sb;
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        sr = parseInt(el.style.right); sb = parseInt(el.style.bottom);
        handle.style.cursor = 'grabbing';
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        clampAndApply(sr - (e.clientX - sx), sb - (e.clientY - sy));
      });
      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.style.cursor = 'grab';
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({
            right: parseInt(el.style.right), bottom: parseInt(el.style.bottom),
          }));
        } catch (_) {}
      });

      window.addEventListener('resize', () => clampAndApply(parseInt(el.style.right), parseInt(el.style.bottom)));
    }

    function mount() {
      if (!document.body) return;
      if (!el) create();
      if (!el.isConnected) document.body.appendChild(el);
      requestAnimationFrame(() => clampAndApply(parseInt(el.style.right), parseInt(el.style.bottom)));

      if (!observer) {
        // Slack arayüzü adayı silerse geri ekle
        observer = new MutationObserver(() => {
          if (el && !el.isConnected) document.body.appendChild(el);
        });
        observer.observe(document.body, { childList: true });
      }
    }

    function button() {
      const b = document.createElement('button');
      Object.assign(b.style, {
        border: 'none', borderRadius: '10px', padding: '6px 10px', color: '#fff',
        font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'background-color .2s ease, opacity .2s ease',
      });
      // Tıklama Slack'teki odağı (ör. mesaj kutusu) çalmasın
      b.addEventListener('mousedown', (e) => e.preventDefault());
      return b;
    }

    // order: adadaki soldan sağa sıra (modüller farklı zamanlarda eklenir)
    function add(btn, order) {
      btn.dataset.order = String(order);
      mount();
      const siblings = [...el.querySelectorAll('button[data-order]')];
      const next = siblings.find((s) => Number(s.dataset.order) > order);
      next ? el.insertBefore(btn, next) : el.appendChild(btn);
      requestAnimationFrame(() => clampAndApply(parseInt(el.style.right), parseInt(el.style.bottom)));
    }

    return { mount, button, add };
  })();

  // ============================================================
  // MODÜL 1: TÜMÜNÜ OKUNDU İŞARETLE
  // ============================================================
  const MarkRead = (() => {
    const DELAY_MS = 350; // rate limit'e takılmamak için çağrılar arası bekleme
    const LABEL = '✓ Tümü okundu';
    const log = (...a) => console.log('[MarkRead]', ...a);

    function getToken() {
      const cfg = readLocalConfig();
      const teams = cfg.teams || {};
      const m = location.pathname.match(/\/client\/([A-Z0-9]+)/);
      const teamId = (m && m[1]) || cfg.lastActiveTeamId || Object.keys(teams)[0];
      const team = teams[teamId];
      if (!team || !team.token) throw new Error('Token bulunamadı (localConfig_v2)');
      return team.token;
    }

    async function api(token, method, params) {
      const json = await slackFetch(method, params, token);
      if (!json.ok) throw new Error(`${method}: ${json.error}`);
      return json;
    }

    async function markAllRead(setStatus) {
      const token = getToken();
      const counts = await api(token, 'client.counts', { thread_counts_by_channel: 'true' });

      const unread = [...(counts.channels || []), ...(counts.mpims || []), ...(counts.ims || [])]
        .filter((c) => c.has_unreads && c.latest);

      log('Okunmamış:', unread.length, unread);
      if (!unread.length) return 0;

      let done = 0;
      for (const c of unread) {
        setStatus(`⏳ ${done}/${unread.length}`);
        try {
          await api(token, 'conversations.mark', { channel: c.id, ts: c.latest });
          done++;
        } catch (e) {
          console.warn('[MarkRead]', c.id, e.message);
          if (/ratelimited/.test(e.message)) await sleep(5000);
        }
        await sleep(DELAY_MS);
      }
      return done;
    }

    function init() {
      const btn = Island.button();
      btn.textContent = LABEL;
      btn.title = 'Tüm okunmamış kanal/DM\'leri okundu işaretle';
      btn.style.backgroundColor = '#4A154B';

      let busy = false;
      btn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const setStatus = (t) => (btn.textContent = t);
        try {
          const n = await markAllRead(setStatus);
          setStatus(n ? `✔ ${n} kanal okundu` : '✔ Okunmamış yok');
        } catch (e) {
          console.error('[MarkRead]', e);
          setStatus('✖ Hata (konsola bak)');
        }
        setTimeout(() => { btn.textContent = LABEL; busy = false; }, 2500);
      });

      Island.add(btn, 1);
      log('Hazır.');
    }

    return { init };
  })();

  // ============================================================
  // MODÜL 2: KANAL WATCHER → "Mola" BİLDİRİMİ
  // ============================================================
  const Watcher = (() => {
    const TEAM_ID = 'T07MA8JLR2R'; // yalnız bu workspace'te çalışır

    const WATCHED_CHANNELS = [
      'C08PN8ZJL2J', // casino-sorunları
      'C08PFJSK00P', // bonus-kontrol
      'C08TKRJQ96G', // finansal-sorunlar
      'C08PZGLQ3J6', // canlı-destek
      'C0A9YJRFY1L', // inisiyatif talepleri
      'C08SFHYL0CQ', // admin
      'C07LYJ4HK0F', // zumabet
      'C08Q00NMW5R', // kupon sorunları
      'C08QALM34FM', // çekim-iptal
      'D08R9AW6RK2', // joseph (DM)
      'C08QH2ZG7R7', // domain change
      'C08PUFTL869', // çevrim-kontrol
      'C08Q00L6WD9', // şifre yenileme 2fa
      'C0C81S6KVMK', // çekim talepleri
      'C0C86EMQRBK', // botyazılım
      'C0C8B1YR5SA', // shift takibi
      'C08PUFUTT3P', // canlı destek - call center
    ];

    const TARGET_CHANNEL = 'C08PZGND15G';
    const NOTIFY_TEXT = 'Mola';
    const POLL_INTERVAL_MS = 15000;
    const MANUAL_TOKEN_OVERRIDE = '';

    const ENABLED_KEY = 'enabled';

    // localStorage tabanlı ayar deposu (eski GM_getValue/GM_setValue yerine)
    const K = (k) => `slackTools.watcher.${k}`;
    function getVal(k, def) {
      try { const r = localStorage.getItem(K(k)); return r === null ? def : JSON.parse(r); }
      catch (_) { return def; }
    }
    function setVal(k, v) {
      try { localStorage.setItem(K(k), JSON.stringify(v)); } catch (_) {}
    }

    function log(...args) { console.log('[SlackWatcher]', ...args); }

    function applies() {
      return location.pathname.startsWith(`/client/${TEAM_ID}`);
    }

    function findApiToken() {
      if (MANUAL_TOKEN_OVERRIDE) return MANUAL_TOKEN_OVERRIDE;
      const w = window;

      try { if (w.boot_data && w.boot_data.api_token) return w.boot_data.api_token; } catch (e) {}
      try { if (w.TS && w.TS.boot_data && w.TS.boot_data.api_token) return w.TS.boot_data.api_token; } catch (e) {}

      try {
        const teams = readLocalConfig().teams || {};
        if (teams[TEAM_ID] && teams[TEAM_ID].token) return teams[TEAM_ID].token;
        for (const id in teams) {
          if (teams[id] && teams[id].token) {
            log(`⚠️ ${TEAM_ID} için token yok, ${id} workspace'inin token'ı kullanılıyor.`);
            return teams[id].token;
          }
        }
      } catch (e) {}

      try {
        const tokenPattern = /xoxc-[a-zA-Z0-9-]+/;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          const match = (localStorage.getItem(key) || '').match(tokenPattern);
          if (match) {
            log(`Token localStorage['${key}'] içinde brute-force ile bulundu.`);
            return match[0];
          }
        }
      } catch (e) {}

      return null;
    }

    const slackApi = (method, params, token) => slackFetch(method, params, token);

    // Başarısız DM çözümlemeleri sadece bu oturum boyunca hatırlanır
    const failedResolves = new Set();

    async function resolveChannel(channelId, token) {
      if (failedResolves.has(channelId)) return null;
      const cacheKey = `resolvedId_${channelId}`;
      const cached = getVal(cacheKey, null);
      if (cached) return cached;

      const data = await slackApi('conversations.open', { channel: channelId }, token);
      if (!data.ok || !data.channel) {
        log(`conversations.open başarısız (${channelId}):`, data.error, '- sayfa yenilenene kadar denenmeyecek');
        failedResolves.add(channelId);
        return null;
      }
      setVal(cacheKey, data.channel.id);
      log(`DM çözümlendi: ${channelId} -> ${data.channel.id}`);
      return data.channel.id;
    }

    async function getLastTs(channelId, token) {
      let data = await slackApi('conversations.history', { channel: channelId, limit: '1' }, token);

      if (!data.ok && data.error === 'channel_not_found') {
        const resolvedId = await resolveChannel(channelId, token);
        if (!resolvedId) return null;
        data = await slackApi('conversations.history', { channel: resolvedId, limit: '1' }, token);
      }

      if (!data.ok) {
        log(`conversations.history hata (${channelId}):`, data.error);
        return null;
      }
      return data.messages && data.messages.length ? data.messages[0].ts : null;
    }

    // Tek client.counts isteğiyle hepsi; olmayanlar için kanal başına yedek
    async function getAllLatest(token) {
      const result = {};
      let countsMap = null;

      try {
        const counts = await slackApi('client.counts', { thread_counts_by_channel: 'true' }, token);
        if (counts.ok) {
          countsMap = new Map();
          [...(counts.channels || []), ...(counts.mpims || []), ...(counts.ims || [])]
            .forEach((c) => { if (c.id && c.latest) countsMap.set(c.id, c.latest); });
        } else {
          log('client.counts hata, kanal kanal kontrole geçiliyor:', counts.error);
        }
      } catch (e) {
        log('client.counts isteği başarısız, kanal kanal kontrole geçiliyor:', e);
      }

      for (const channelId of WATCHED_CHANNELS) {
        if (countsMap && countsMap.has(channelId)) {
          result[channelId] = countsMap.get(channelId);
          continue;
        }
        try {
          const ts = await getLastTs(channelId, token);
          if (ts) result[channelId] = ts;
        } catch (err) {
          log(`Kanal kontrol hatası (${channelId}):`, err);
        }
      }
      return result;
    }

    async function postNotify(token) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const data = await slackApi('chat.postMessage', { channel: TARGET_CHANNEL, text: NOTIFY_TEXT }, token);
          if (data.ok) {
            log('Bildirim gönderildi ✅');
            return true;
          }
          log(`chat.postMessage hata (deneme ${attempt}):`, data.error);
        } catch (err) {
          log(`chat.postMessage istek hatası (deneme ${attempt}):`, err);
        }
        if (attempt < 2) await sleep(3000);
      }
      return false;
    }

    // ---------- Durum ----------
    const isEnabled = () => getVal(ENABLED_KEY, false);
    const setEnabled = (val) => setVal(ENABLED_KEY, val);

    let refreshToggleUI = () => {};
    let flashButton = () => {};
    let intervalHandle = null;
    let isChecking = false;
    let startGeneration = 0;

    function stopWatching() {
      startGeneration++;
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        log('Interval durduruldu, watcher artık hiçbir istek atmıyor.');
      }
    }

    async function resyncBaselines(token) {
      log('Baseline yenileniyor (mevcut son mesajlar "görüldü" olarak işaretleniyor)...');
      const latest = await getAllLatest(token);
      for (const [channelId, ts] of Object.entries(latest)) {
        setVal(`lastTs_${channelId}`, ts);
      }
      log('Baseline yenilendi. Artık sadece BUNDAN SONRA gelen mesajlar tetikleyecek.');
    }

    function startWatching(token) {
      if (intervalHandle !== null) return;
      const myGen = ++startGeneration;

      (async () => {
        await resyncBaselines(token);
        if (!isEnabled() || myGen !== startGeneration || intervalHandle !== null) return;
        intervalHandle = setInterval(() => checkChannels(token), POLL_INTERVAL_MS);
        log('Interval başlatıldı.');
      })();
    }

    async function checkChannels(token) {
      if (!isEnabled() || isChecking) return;
      isChecking = true;

      try {
        const latest = await getAllLatest(token);
        if (!isEnabled()) return;

        for (const channelId of WATCHED_CHANNELS) {
          const lastTs = latest[channelId];
          if (!lastTs) continue;

          const storedKey = `lastTs_${channelId}`;
          const storedTs = getVal(storedKey, null);

          if (storedTs === null) {
            setVal(storedKey, lastTs);
            continue;
          }

          if (parseFloat(lastTs) > parseFloat(storedTs)) {
            setVal(storedKey, lastTs);
            log(`Yeni mesaj tespit edildi: ${channelId}`);

            // One-shot: önce kapat, sonra gönder
            setEnabled(false);
            stopWatching();
            refreshToggleUI();
            log('Watcher otomatik olarak kapatıldı. Tekrar açmadan yeni tetikleme olmayacak.');

            const ok = await postNotify(token);
            flashButton(ok ? `✅ "${NOTIFY_TEXT}" gönderildi` : `✖ "${NOTIFY_TEXT}" gönderilemedi!`,
                        ok ? '#007AFF' : '#FF3B30', ok ? 4000 : 15000);
            return;
          }
        }
      } catch (err) {
        log('Kontrol döngüsü hatası:', err);
      } finally {
        isChecking = false;
      }
    }

    function createToggleButton(token) {
      const btn = Island.button();
      btn.title = 'Watcher aç/kapat';

      let flashTimer = null;

      function render() {
        if (flashTimer) return;
        const on = isEnabled();
        btn.textContent = on ? '🟢 Watcher: Açık' : '⚪️ Watcher: Kapalı';
        btn.style.backgroundColor = on ? '#34C759' : '#8E8E93';
      }

      flashButton = (text, color, ms) => {
        clearTimeout(flashTimer);
        btn.textContent = text;
        btn.style.backgroundColor = color;
        flashTimer = setTimeout(() => { flashTimer = null; render(); }, ms);
      };

      btn.addEventListener('click', () => {
        clearTimeout(flashTimer); flashTimer = null;
        const newState = !isEnabled();
        setEnabled(newState);
        render();
        if (newState) {
          startWatching(token);
          log('İzleme başlatıldı.');
        } else {
          stopWatching();
          log('İzleme durduruldu.');
        }
      });

      render();
      refreshToggleUI = render;
      Island.add(btn, 2);
    }

    function init() {
      const token = findApiToken();
      if (!token) {
        log('⚠️ API token otomatik bulunamadı. MANUAL_TOKEN_OVERRIDE değişkenine yapıştırman gerekebilir.');
        return;
      }
      log('Token bulundu. Kontrol aralığı:', POLL_INTERVAL_MS, 'ms.');
      createToggleButton(token);
      if (isEnabled()) startWatching(token);
    }

    return { init, applies };
  })();

  // ============================================================
  // MODÜL 3: KANAL AYNALAMA (C08TKRJQ96G → C0BMBT1A6KX)
  // ============================================================
  const Mirror = (() => {
    const CONFIG = {
      SRC: 'C08TKRJQ96G',          // kaynak kanal (dinlenen)
      DST: 'C0BMBT1A6KX',          // hedef kanal (yazılan)

      // BİREBİR KOPYA: metne hiç dokunulmaz, hiçbir şey eklenmez.
      EXACT_COPY: true,

      // Deneysel: mesajı orijinal yazarın adı ve avatarıyla göndermeyi dener.
      IMPERSONATE_AUTHOR: false,

      // Yalnız ana mesajlar aktarılır; thread cevapları (ve "kanala da gönder" cevapları) aktarılmaz.
      MIRROR_THREADS: false,
      MIRROR_EDITS: true,
      MIRROR_DELETES: true,
      UNFURL: true,

      // --- yalnız EXACT_COPY:false iken ---
      INCLUDE_AUTHOR: true,
      INCLUDE_PERMALINK: true,
      KEEP_USER_MENTIONS: false,

      BACKFILL_MINUTES: 0,
      POLL_SECONDS: 20,
      POST_INTERVAL_MS: 1200,
      MAX_SEEN: 800,

      THREAD_SWEEP_SECONDS: 120,
      THREAD_LOOKBACK_HOURS: 24,
      MAP_RETENTION_DAYS: 30,

      SKIP_SUBTYPES: [
        'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
        'channel_name', 'channel_archive', 'channel_unarchive',
        'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name',
        'message_replied', 'tombstone', 'bot_add', 'bot_remove', 'pinned_item',
      ],

      DEBUG: false,
    };

    const VERSION = '1.3.2';
    const PREFIX = '[SLACK AYNA]';
    const STATE_KEY = `slackMirror.state.${CONFIG.SRC}.${CONFIG.DST}.v1`;
    const PAUSE_KEY = `slackMirror.paused.${CONFIG.SRC}.${CONFIG.DST}`;
    const LOCK_NAME = `slackMirror.leader.${CONFIG.SRC}.${CONFIG.DST}`;
    const USERS_KEY = 'slackMirror.users.v1';
    // Bu değer değişince ilk lider sekme birikmiş kuyruğu bir kez atlar (yalnız bundan sonraki mesajlar aktarılır)
    const RESET_KEY = `slackMirror.reset.${CONFIG.SRC}.${CONFIG.DST}`;
    const RESET_ID = '2.1.0';

    const log = (...a) => console.log(PREFIX, ...a);
    const dbg = (...a) => { if (CONFIG.DEBUG) console.log(PREFIX, ...a); };
    const warn = (...a) => console.warn(PREFIX, ...a);
    const fail = (...a) => console.error(PREFIX, ...a);

    // ---------- yardımcılar ----------
    function readJSON(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (_) { return fallback; }
    }
    function writeJSON(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); }
      catch (e) { fail('localStorage yazılamadı (kota dolu olabilir):', e.message); }
    }

    const tsNum = (ts) => Number(ts) || 0;
    const tsGreater = (a, b) => tsNum(a) > tsNum(b);
    const nowTs = () => (Date.now() / 1000).toFixed(6);
    const retentionCutoff = () => Date.now() / 1000 - CONFIG.MAP_RETENTION_DAYS * 86400;
    const isReply = (msg) => Boolean(msg && msg.thread_ts && msg.thread_ts !== msg.ts);

    // ---------- durum ----------
    let isLeader = false;

    const state = Object.assign(
      { seen: [], map: {}, threads: {}, lastTs: '', count: 0 },
      readJSON(STATE_KEY, {})
    );
    if (state.paused) { try { localStorage.setItem(PAUSE_KEY, '1'); } catch (_) {} }
    delete state.paused;

    const seenSet = new Set(state.seen);
    const inFlight = new Set();
    const userCache = readJSON(USERS_KEY, {});

    const isPaused = () => { try { return localStorage.getItem(PAUSE_KEY) === '1'; } catch (_) { return false; } };
    function setPaused(v) {
      try { v ? localStorage.setItem(PAUSE_KEY, '1') : localStorage.removeItem(PAUSE_KEY); } catch (_) {}
      updateBadge();
    }

    function pruneState() {
      const cutoff = retentionCutoff();
      for (const k of Object.keys(state.map)) if (tsNum(k) < cutoff) delete state.map[k];
      for (const k of Object.keys(state.threads)) if (tsNum(k) < cutoff) delete state.threads[k];
    }

    let saveTimer = 0;
    function save() {
      if (!isLeader) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        state.seen = state.seen.slice(-CONFIG.MAX_SEEN);
        pruneState();
        writeJSON(STATE_KEY, state);
      }, 400);
    }

    function reloadStateFromStorage() {
      const fresh = readJSON(STATE_KEY, {});
      delete fresh.paused;
      Object.assign(state, { seen: [], map: {}, threads: {}, lastTs: '', count: 0 }, fresh);
      seenSet.clear();
      state.seen.forEach((t) => seenSet.add(t));
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

    // ---------- Slack API ----------
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
      if (!out.length) {
        for (let i = 0; i < localStorage.length; i++) {
          const raw = localStorage.getItem(localStorage.key(i)) || '';
          const m = raw.match(/xox[cse]-[\w-]+/g);
          if (m) m.forEach((t) => { if (!out.includes(t)) out.push(t); });
        }
      }
      return out;
    }

    const rawApi = (method, params, tokenOverride) => slackFetch(method, params, tokenOverride || token);

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

    async function resolveToken() {
      const candidates = collectTokens();
      if (!candidates.length) throw new Error('Slack token bulunamadı — Slack web istemcisinde oturum açık mı?');
      const errs = [];
      for (const cand of candidates) {
        try {
          const info = await rawApi('conversations.info', { channel: CONFIG.SRC }, cand);
          if (info.ok) { token = cand; return info.channel; }
          errs.push(info.error || '?');
          dbg('token elendi:', info.error);
        } catch (e) { errs.push(e.message || 'istek hatası'); dbg('token denemesi başarısız', e); }
      }
      // Slack'in döndürdüğü hata kodları da yazılır (ör. channel_not_found, invalid_auth)
      throw new Error(`Hiçbir oturum ${CONFIG.SRC} kanalını göremiyor [${candidates.length} oturum: ${[...new Set(errs)].join(', ')}]`);
    }

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

    // ---------- metin dönüşümü ----------
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

    // ---------- aktarma çekirdeği ----------
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

    const PERMANENT_ERRORS = [
      'channel_not_found', 'not_in_channel', 'is_archived', 'msg_too_long', 'no_text',
      'restricted_action', 'invalid_auth', 'not_authed', 'account_inactive', 'message_not_found',
      'cant_update_message', 'cant_delete_message', 'edit_window_closed',
    ];

    async function withRetry(fn, label) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await fn();
        } catch (e) {
          if (attempt >= 3 || PERMANENT_ERRORS.includes(e.slackError)) {
            setStatus('hata', `${label}: ${e.message}`);
            throw e;
          }
          warn(`${label} başarısız (deneme ${attempt}/3), tekrar denenecek:`, e.message);
          await sleep(3000 * attempt);
        }
      }
    }

    function isMirrorable(msg) {
      if (!msg || !msg.ts) return false;
      if (msg.subtype && CONFIG.SKIP_SUBTYPES.includes(msg.subtype)) return false;
      if (msg.hidden) return false;
      if (!CONFIG.MIRROR_THREADS && isReply(msg)) return false;   // yalnız ana mesajlar
      const hasBody = (msg.text || '').trim() ||
        (Array.isArray(msg.files) && msg.files.length) ||
        (Array.isArray(msg.blocks) && msg.blocks.length) ||
        (Array.isArray(msg.attachments) && msg.attachments.length);
      return Boolean(hasBody);
    }

    async function ensureParent(parentTs) {
      if (state.map[parentTs]) return state.map[parentTs];
      if (tsNum(parentTs) < retentionCutoff()) return null;
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

    const IMPERSONATE_ERRORS = [
      'not_allowed_token_type', 'as_user_not_supported', 'invalid_arguments', 'cannot_post_as_user',
    ];
    const BLOCK_ERRORS = ['invalid_blocks', 'invalid_blocks_format', 'invalid_attachments'];

    async function sendWithFallbacks(payload) {
      try {
        return await api('chat.postMessage', payload);
      } catch (e) {
        if (CONFIG.IMPERSONATE_AUTHOR && IMPERSONATE_ERRORS.includes(e.slackError)) {
          warn(`yazar taklidi bu oturumda desteklenmiyor (${e.slackError}), kapatıldı`);
          CONFIG.IMPERSONATE_AUTHOR = false;
          delete payload.username; delete payload.icon_url; delete payload.as_user;
          return sendWithFallbacks(payload);
        }
        if (BLOCK_ERRORS.includes(e.slackError) && (payload.blocks || payload.attachments)) {
          warn(`blocks kabul edilmedi (${e.slackError}), metin olarak gönderiliyor`);
          delete payload.blocks; delete payload.attachments;
          if (!payload.text) payload.text = '(içerik biçimi aktarılamadı)';
          return api('chat.postMessage', payload);
        }
        throw e;
      }
    }

    async function postMessage(msg, parentDstTs) {
      const payload = await buildPayload(msg);
      if (parentDstTs) payload.thread_ts = parentDstTs;
      const r = await sendWithFallbacks(payload);
      state.map[msg.ts] = r.ts;
      state.count++;
      markSeen(msg.ts);
      // lastTs burada İLERLETİLMEZ; yalnız yoklama ilerletir.
      save();
      updateBadge();
      dbg('aktarıldı', msg.ts, '→', r.ts);
      return r.ts;
    }

    const INSTANCE = Math.random().toString(36).slice(2);
    const CLAIM_PREFIX = `slackMirror.claim.${CONFIG.SRC}.`;
    async function claimMessage(ts) {
      const key = CLAIM_PREFIX + ts;
      try {
        const cur = localStorage.getItem(key);
        if (cur && cur !== INSTANCE) return false;
        localStorage.setItem(key, INSTANCE);
        await sleep(400 + Math.random() * 300);   // aynı anda yazan diğer kopya varsa son yazan kazanır
        if (localStorage.getItem(key) !== INSTANCE) return false;
        // eski sahiplenmeleri temizle (2 günden eski)
        const cutoff = Date.now() / 1000 - 2 * 86400;
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith(CLAIM_PREFIX) && tsNum(k.slice(CLAIM_PREFIX.length)) < cutoff) localStorage.removeItem(k);
        }
        return true;
      } catch (_) { return true; }
    }

    function forward(msg) {
      if (!isLeader || isPaused()) return;
      if (!isMirrorable(msg)) return;
      const ts = msg.ts;
      if (seenSet.has(ts) || inFlight.has(ts)) return;
      if (state.map[ts]) { markSeen(ts); return; }
      inFlight.add(ts);

      enqueue(async () => {
        try {
          if (seenSet.has(ts) || state.map[ts]) return;
          // Aynı mesajı başka bir kopya (ikinci kurulum / ikinci sekme) da aktarmasın: sayfanın ortak deposunda sahiplen
          if (!(await claimMessage(ts))) { markSeen(ts); dbg('başka bir kopya aktarıyor, atlandı', ts); return; }
          const reply = isReply(msg);
          let parentDstTs = null;
          if (reply && CONFIG.MIRROR_THREADS) {
            parentDstTs = state.map[msg.thread_ts] || await ensureParent(msg.thread_ts);
          }
          await withRetry(() => postMessage(msg, parentDstTs), `mesaj ${ts}`);
          if (reply && tsGreater(ts, state.threads[msg.thread_ts] || '')) {
            state.threads[msg.thread_ts] = ts;
            save();
          }
        } finally {
          inFlight.delete(ts);
        }
      });
    }

    function forwardEdit(msg) {
      if (!isLeader || isPaused() || !CONFIG.MIRROR_EDITS) return;
      const dstTs = state.map[msg.ts];
      if (!dstTs) return;
      enqueue(async () => {
        const payload = await buildPayload(msg);
        delete payload.thread_ts;
        const send = (p) => api('chat.update', {
          channel: CONFIG.DST, ts: dstTs, text: p.text, blocks: p.blocks, attachments: p.attachments,
        });
        await withRetry(async () => {
          try { await send(payload); }
          catch (e) {
            if (!BLOCK_ERRORS.includes(e.slackError)) throw e;
            delete payload.blocks; delete payload.attachments;
            await send(payload);
          }
        }, `düzenleme ${msg.ts}`);
        dbg('güncellendi', msg.ts);
      });
    }

    function forwardDelete(srcTs) {
      if (!isLeader || isPaused() || !CONFIG.MIRROR_DELETES) return;
      const dstTs = state.map[srcTs];
      if (!dstTs) return;
      enqueue(async () => {
        try { await api('chat.delete', { channel: CONFIG.DST, ts: dstTs }); }
        catch (e) { warn('hedefte silinemedi:', e.message); }
        delete state.map[srcTs];
        save();
      });
    }

    // ---------- WebSocket kancası ----------
    function handleEvent(ev) {
      if (!isLeader) return;
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
        if (data.indexOf(CONFIG.SRC) === -1) return;
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

    // ---------- yoklama ----------
    let polling = false;
    let sweeping = false;

    async function pollThread(parent) {
      const seenReply = state.threads[parent.ts] || '';
      if (parent.latest_reply && !tsGreater(parent.latest_reply, seenReply)) return;
      let cursor;
      do {
        const r = await api('conversations.replies', {
          channel: CONFIG.SRC, ts: parent.ts, oldest: seenReply || parent.ts, limit: 200, cursor,
        });
        for (const m of r.messages || []) {
          if (m.ts === parent.ts) continue;
          forward(m);
        }
        cursor = r.has_more && r.response_metadata && r.response_metadata.next_cursor;
      } while (cursor);
      if (parent.latest_reply && tsGreater(parent.latest_reply, seenReply)) {
        state.threads[parent.ts] = parent.latest_reply;
        save();
      }
    }

    async function fetchHistorySince(oldest, maxPages = 20) {
      const all = [];
      let cursor, pages = 0;
      do {
        const r = await api('conversations.history', {
          channel: CONFIG.SRC, oldest, limit: 200, cursor,
        });
        all.push(...(r.messages || []));
        cursor = r.has_more && r.response_metadata && r.response_metadata.next_cursor;
        pages++;
      } while (cursor && pages < maxPages);
      if (cursor) warn(`çok fazla mesaj var, ilk ${all.length} tanesi alındı`);
      return all.sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
    }

    async function poll() {
      if (polling || !isLeader || isPaused() || !token) return;
      polling = true;
      try {
        const msgs = await fetchHistorySince(state.lastTs || nowTs());
        for (const m of msgs) {
          forward(m);
          if (CONFIG.MIRROR_THREADS && m.reply_count) {
            try { await pollThread(m); } catch (e) { dbg('thread yoklaması:', e.message); }
          }
          if (tsGreater(m.ts, state.lastTs)) state.lastTs = m.ts;
        }
        save();
        if (statusText === 'hata') setStatus('dinleniyor', '');
      } catch (e) {
        warn('yoklama başarısız:', e.message);
        setStatus('hata', e.message);
      } finally {
        polling = false;
      }
    }

    async function sweepThreads() {
      if (sweeping || !isLeader || isPaused() || !token || !CONFIG.MIRROR_THREADS) return;
      sweeping = true;
      try {
        const oldest = ((Date.now() - CONFIG.THREAD_LOOKBACK_HOURS * 3600000) / 1000).toFixed(6);
        const msgs = await fetchHistorySince(oldest, 5);
        for (const m of msgs) {
          if (!m.reply_count || !m.latest_reply) continue;
          if (!state.map[m.ts]) continue;
          if (!tsGreater(m.latest_reply, state.threads[m.ts] || '')) continue;
          try { await pollThread(m); } catch (e) { dbg('thread taraması:', e.message); }
        }
      } catch (e) {
        dbg('thread taraması başarısız:', e.message);
      } finally {
        sweeping = false;
      }
    }

    // ---------- adadaki buton ----------
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
      const paused = isPaused();
      const dot = !isLeader && statusText !== 'hata' ? '👥'
        : paused ? '⏸' : statusText === 'hata' ? '⚠️' : '🔁';
      badge.textContent = isLeader ? `${dot} Ayna ${state.count}`
        : statusText === 'hata' ? `${dot} Ayna` : `${dot} Ayna (yedek)`;
      badge.title = `${PREFIX} v${VERSION}\n${CONFIG.SRC} → ${CONFIG.DST}\n` +
        (isLeader
          ? `durum: ${paused ? 'duraklatıldı' : statusText}${statusDetail ? ' — ' + statusDetail : ''}\n` +
            `aktarılan: ${state.count}\n`
          : statusText === 'hata'
            ? `durum: hata — ${statusDetail}\n`
            : 'Bu sekme yedekte: aktarımı başka bir Slack sekmesi yapıyor.\nO sekme kapanınca bu devralır.\n') +
        'yalnız ana mesajlar aktarılır (thread cevapları hariç)\n' +
        'tıkla: duraklat/devam (tüm sekmeler)';
      badge.style.backgroundColor = statusText === 'hata' ? '#B3261E' : '#3A3F45';
      badge.style.opacity = paused ? '0.5' : '1';
    }

    function mountBadge() {
      if (badge) return;
      badge = Island.button();
      badge.addEventListener('click', () => {
        const next = !isPaused();
        setPaused(next);
        log(next ? 'duraklatıldı' : 'devam ediyor');
        if (!next) poll();
      });
      Island.add(badge, 3);
      updateBadge();
    }

    window.addEventListener('storage', (e) => {
      if (e.key === STATE_KEY && !isLeader) {
        try { const s = JSON.parse(e.newValue || '{}'); state.count = s.count || 0; } catch (_) {}
      }
      if (e.key === PAUSE_KEY || e.key === STATE_KEY) {
        updateBadge();
        if (e.key === PAUSE_KEY && !isPaused()) poll();
      }
    });

    // ---------- başlatma ----------
    function becomeLeader() {
      reloadStateFromStorage();
      isLeader = true;

      // Sürüm geçişinde birikmiş kuyruk bir kez atlanır: aradaki mesajlar aktarılmaz
      let resetDone = null;
      try { resetDone = localStorage.getItem(RESET_KEY); } catch (_) {}
      if (resetDone !== RESET_ID) {
        state.lastTs = nowTs();
        try { localStorage.setItem(RESET_KEY, RESET_ID); } catch (_) {}
        log('birikmiş kuyruk sıfırlandı: yalnız bundan sonraki ana mesajlar aktarılacak');
      }

      if (!state.lastTs) {
        state.lastTs = CONFIG.BACKFILL_MINUTES > 0
          ? ((Date.now() - CONFIG.BACKFILL_MINUTES * 60000) / 1000).toFixed(6)
          : nowTs();
        log(CONFIG.BACKFILL_MINUTES > 0
          ? `ilk çalıştırma: son ${CONFIG.BACKFILL_MINUTES} dk aktarılacak`
          : 'ilk çalıştırma: yalnız bundan sonraki mesajlar aktarılacak');
      }
      save();
      updateBadge();
      log('bu sekme aktarımı üstlendi');

      poll();
      setInterval(poll, Math.max(5, CONFIG.POLL_SECONDS) * 1000);
      setInterval(sweepThreads, Math.max(30, CONFIG.THREAD_SWEEP_SECONDS) * 1000);
    }

    function acquireLeadership() {
      if (!navigator.locks || !navigator.locks.request) {
        warn('Web Locks desteklenmiyor; birden fazla sekme açıksa çift aktarım olabilir');
        becomeLeader();
        return;
      }
      navigator.locks.request(LOCK_NAME, () => new Promise(() => { becomeLeader(); }));
      setTimeout(() => {
        if (!isLeader) { log('başka bir sekme aktarım yapıyor, bu sekme yedekte'); updateBadge(); }
      }, 1500);
    }

    async function start() {
      mountBadge();
      try {
        const src = await resolveToken();
        const dst = await api('conversations.info', { channel: CONFIG.DST });
        const route = `#${src.name || CONFIG.SRC} → #${(dst.channel && dst.channel.name) || CONFIG.DST}`;
        log(`hazır: ${route}`);
        setStatus('dinleniyor', route);
      } catch (e) {
        fail(e.message);
        setStatus('hata', `${e.message} — 1 dk sonra tekrar denenecek`);
        setTimeout(start, 60000);   // oturum/yetki değişiminden sonra sayfa yenilemeden toparlansın
        return;
      }
      acquireLeadership();
    }

    // konsol API'si
    window.SlackMirror = {
      version: VERSION,
      config: CONFIG,
      state,
      status: () => ({
        status: statusText, detail: statusDetail, leader: isLeader,
        paused: isPaused(), queued: queue.length, count: state.count,
      }),
      pause() { setPaused(true); },
      resume() { setPaused(false); poll(); },
      poll,
      sweepThreads,
      resync(minutes = 60) {
        if (!isLeader) { warn('bu sekme yedekte; lider sekmede çalıştırın'); return; }
        state.lastTs = ((Date.now() - minutes * 60000) / 1000).toFixed(6);
        save();
        return poll();
      },
      // Kuyruktaki bekleyen işleri de boşaltır: birikmiş aktarım anında durur
      reset() {
        if (!isLeader) { warn('bu sekme yedekte; lider sekmede çalıştırın'); return; }
        queue.length = 0;
        state.seen.length = 0; seenSet.clear();
        state.map = {}; state.threads = {}; state.lastTs = nowTs(); state.count = 0;
        save(); updateBadge();
        log('sıfırlandı: kuyruk boşaltıldı, yalnız bundan sonraki mesajlar aktarılacak');
      },
      _: { neutralizeBroadcasts, plainMentions, mentionIds, isMirrorable, fileLinks, fileLines, tsGreater },
    };

    return { hookWebSocket, start };
  })();

  // ============================================================
  // MODÜL 4: OTOMATİK TEPKİ (C08TKRJQ96G'ye gelen ana mesajlara emoji)
  // ============================================================
  const AutoReact = (() => {
    const CHANNEL = 'C08TKRJQ96G';
    const POLL_MS = 8000;
    // Adada iki ayrı buton: 👀 ve 🔍. Biri açıkken diğerine basmak ona geçirir; açık olana basmak kapatır.
    const MODES = [
      { id: 'off', emoji: null },
      { id: 'eyes', emoji: 'eyes', icon: '👀', name: 'Göz' },
      { id: 'mag_right', emoji: 'mag_right', icon: '🔍', name: 'Büyüteç' },
    ];
    const ON = '#007AFF', OFF = '#3A3F45';
    const MODE_KEY = 'slackTools.react.mode';
    const LOCK_NAME = `slackTools.react.leader.${CHANNEL}`;
    const log = (...a) => console.log('[OtoTepki]', ...a);

    const modeId = () => { try { return localStorage.getItem(MODE_KEY) || 'off'; } catch (_) { return 'off'; } };
    const mode = () => MODES.find((m) => m.id === modeId()) || MODES[0];

    let token = null, me = null, lastTs = null, busy = false, isLeader = false;
    const btns = {};

    async function resolve() {
      const cfg = readLocalConfig();
      const toks = Object.values(cfg.teams || {}).map((t) => t && t.token).filter(Boolean);
      for (const t of toks) {
        const r = await slackFetch('conversations.info', { channel: CHANNEL }, t).catch(() => null);
        if (r && r.ok) {
          token = t;
          const a = await slackFetch('auth.test', {}, t).catch(() => null);
          me = a && a.ok ? a.user_id : null;
          return true;
        }
      }
      return false;
    }

    async function poll() {
      const m = mode();
      if (!isLeader || busy || !m.emoji) return;
      busy = true;
      try {
        if (!token && !(await resolve())) { log(`${CHANNEL} kanalı görülemiyor`); return; }
        if (!lastTs) { lastTs = (Date.now() / 1000).toFixed(6); return; }   // yalnız açıldıktan sonra gelenler
        const r = await slackFetch('conversations.history', { channel: CHANNEL, oldest: lastTs, limit: 50 }, token);
        if (!r.ok) { if (/invalid_auth|not_authed|token_revoked/.test(r.error)) token = null; log('history:', r.error); return; }
        const msgs = (r.messages || []).sort((a, b) => Number(a.ts) - Number(b.ts));
        for (const msg of msgs) {
          lastTs = msg.ts;
          if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;              // thread cevabı
          if (msg.bot_id || (msg.subtype && msg.subtype !== 'file_share')) continue;   // bot / sistem mesajı
          if (me && msg.user === me) continue;                                   // kendi mesajın
          const a = await slackFetch('reactions.add', { channel: CHANNEL, timestamp: msg.ts, name: m.emoji }, token);
          if (!a.ok && a.error !== 'already_reacted') log('reactions.add:', a.error);
          await sleep(400);
        }
      } catch (e) { log('hata:', e.message || e); }
      finally { busy = false; }
    }

    function render() {
      const cur = modeId();
      for (const [id, b] of Object.entries(btns)) {
        const m = MODES.find((x) => x.id === id);
        const on = cur === id;
        b.textContent = m.icon;
        b.style.backgroundColor = on ? ON : OFF;
        b.style.opacity = on ? '1' : '.75';
        b.title = `Otomatik ${m.name} tepkisi (C08TKRJQ96G ana mesajları): ${on ? 'AÇIK — tıkla: kapat' : 'kapalı — tıkla: aç'}`;
      }
    }

    function start() {
      for (const m of MODES.filter((x) => x.emoji)) {
        const b = Island.button();
        b.style.fontSize = '14px';
        b.addEventListener('click', () => {
          const next = modeId() === m.id ? 'off' : m.id;
          try { localStorage.setItem(MODE_KEY, next); } catch (_) {}
          lastTs = null;   // değişince yalnız bundan sonraki mesajlar
          render();
          log('mod:', next);
        });
        btns[m.id] = b;
        Island.add(b, m.id === 'eyes' ? 4 : 5);
      }
      window.addEventListener('storage', (e) => { if (e.key === MODE_KEY) { lastTs = null; render(); } });
      render();

      const lead = () => { isLeader = true; poll(); setInterval(poll, POLL_MS); };
      if (navigator.locks && navigator.locks.request) navigator.locks.request(LOCK_NAME, () => new Promise(() => lead()));
      else lead();
    }

    return { start };
  })();

  // ============================================================
  // BAŞLATMA
  // ============================================================

  // Ayna kapalı (Dekont Aktar artık C08TKRJQ96G'yi doğrudan izliyor). Açmak için true yap.
  const MIRROR_ENABLED = false;
  // Ayna: Slack kendi WebSocket'ini açmadan ÖNCE kanca kurulmalı (document-start)
  if (MIRROR_ENABLED) Mirror.hookWebSocket();

  function boot() {
    Island.mount();

    try { MarkRead.init(); } catch (e) { console.error('[SlackTools] Okundu modülü:', e); }
    if (MIRROR_ENABLED) { try { Mirror.start(); } catch (e) { console.error('[SlackTools] Ayna modülü:', e); } }
    try { AutoReact.start(); } catch (e) { console.error('[SlackTools] Tepki modülü:', e); }

    if (Watcher.applies()) {
      // Slack SPA'sının ve token'ın hazır olmasını bekle
      setTimeout(() => {
        try { Watcher.init(); } catch (e) { console.error('[SlackTools] Watcher modülü:', e); }
      }, 5000);
    }

    console.log('[SlackTools] v2.3.0 yüklendi.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
