const TOKEN_KEY = 'harcama.token';
const CACHE_PREFIX = 'harcama.cache.';
const CATEGORY_COLORS = {
  'Market': 'var(--c1)',
  'Yeme-İçme': 'var(--c2)',
  'Ulaşım': 'var(--c3)',
  'Akaryakıt': 'var(--c4)',
  'Alışveriş': 'var(--c5)',
  'Faturalar': 'var(--c6)',
  'Sağlık': 'var(--c7)',
  'Eğlence': 'var(--c8)',
  'Diğer': 'var(--c9)',
};
const CATEGORIES = Object.keys(CATEGORY_COLORS);

const $ = (id) => document.getElementById(id);
const state = { month: currentMonth(), currency: 'TRY', summary: null, transactions: [], editing: null };

// ---------- yardımcılar ----------

function storage(fn) {
  try { return fn(localStorage); } catch { return null; }
}

function currentMonth(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return currentMonth(new Date(y, m - 1 + delta, 1));
}

function daysIn(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function money(minor, currency = state.currency, opts = {}) {
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency', currency, maximumFractionDigits: opts.whole ? 0 : 2, minimumFractionDigits: opts.whole ? 0 : 2,
  }).format((minor || 0) / 100);
}

function compact(minor) {
  return new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 }).format((minor || 0) / 100);
}

function monthLabel(month, style = 'long') {
  const [y, m] = month.split('-').map(Number);
  const opts = style === 'long' ? { month: 'long', year: 'numeric' } : { month: 'short' };
  return new Intl.DateTimeFormat('tr-TR', opts).format(new Date(y, m - 1, 1));
}

function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' }).format(new Date(y, m - 1, d));
}

function timeLabel(iso) {
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function minorToInput(minor) {
  if (minor === null || minor === undefined) return '';
  return (minor / 100).toFixed(2).replace('.', ',');
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- API ----------

class AuthError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const token = storage((s) => s.getItem(TOKEN_KEY));
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError();
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Hata (${res.status})`);
  return data;
}

// Çevrimdışıyken son görüntüyü göstermek için GET yanıtlarını sakla.
async function cachedGet(path) {
  try {
    const data = await api(path);
    storage((s) => s.setItem(CACHE_PREFIX + path, JSON.stringify(data)));
    return { data, stale: false };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const cached = storage((s) => s.getItem(CACHE_PREFIX + path));
    if (cached) return { data: JSON.parse(cached), stale: true };
    throw err;
  }
}

// ---------- akış ----------

function showLogin(message = '') {
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('login-token').focus();
}

async function load() {
  $('month-label').textContent = monthLabel(state.month);
  $('next-month').disabled = state.month >= currentMonth();
  try {
    const [summary, list] = await Promise.all([
      cachedGet(`/api/summary?month=${state.month}`),
      cachedGet(`/api/transactions?month=${state.month}`),
    ]);
    state.summary = summary.data;
    state.currency = summary.data.currency;
    state.transactions = list.data.transactions;
    $('offline').hidden = !(summary.stale || list.stale);
    $('login').hidden = true;
    $('app').hidden = false;
    render();
  } catch (err) {
    if (err instanceof AuthError) {
      storage((s) => s.removeItem(TOKEN_KEY));
      showLogin('Anahtar geçersiz.');
    } else {
      $('app').hidden = false;
      $('offline').hidden = false;
      $('offline').textContent = `Veriler yüklenemedi: ${err.message}`;
    }
  }
}

function render() {
  renderBudget();
  renderTrend();
  renderCategories();
  renderHistory();
  renderTransactions();
}

/** Ayın kaçıncı günündeyiz (geçmiş ay → tamamı, gelecek ay → 0). */
function elapsedDays() {
  const n = daysIn(state.month);
  const now = currentMonth();
  if (state.month < now) return n;
  if (state.month > now) return 0;
  return new Date().getDate();
}

function renderBudget() {
  const s = state.summary;
  const n = daysIn(state.month);
  const elapsed = elapsedDays();
  const isCurrent = state.month === currentMonth();
  const budget = s.budget_minor;

  $('budget-title').textContent = isCurrent ? 'Bu ay harcanan' : `${monthLabel(state.month)} harcaması`;
  $('spent').innerHTML = budget
    ? `${esc(money(s.total_minor))} <small>/ ${esc(money(budget, undefined, { whole: true }))}</small>`
    : esc(money(s.total_minor));

  const progress = $('progress');
  progress.hidden = !budget;
  $('set-budget').hidden = !!budget;
  const meta = [];
  const avg = elapsed ? s.total_minor / elapsed : 0;

  if (budget) {
    const ratio = s.total_minor / budget;
    const paceRatio = elapsed / n;
    $('progress-fill').style.width = `${Math.min(ratio, 1) * 100}%`;
    $('progress-pace').style.left = `calc(${paceRatio * 100}% - 1px)`;
    $('progress-pace').hidden = !isCurrent;
    progress.classList.toggle('over', ratio > 1);
    progress.classList.toggle('ahead', ratio <= 1 && isCurrent && ratio > paceRatio);
    progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));

    const remaining = budget - s.total_minor;
    meta.push([remaining >= 0 ? 'Kalan' : 'Aşım', money(Math.abs(remaining), undefined, { whole: true }), remaining < 0]);
    if (isCurrent) {
      const daysLeft = n - elapsed + 1;
      meta.push(['Günlük limit', remaining > 0 ? money(remaining / daysLeft, undefined, { whole: true }) : '—']);
      const projected = avg * n;
      meta.push(['Ay sonu tahmini', money(projected, undefined, { whole: true }), projected > budget]);
    } else {
      meta.push(['Günlük ort.', money(avg, undefined, { whole: true })]);
      meta.push(['Bütçe kullanımı', `%${Math.round(ratio * 100)}`, ratio > 1]);
    }
  } else {
    meta.push(['İşlem', String(s.count)]);
    meta.push(['Günlük ort.', money(avg, undefined, { whole: true })]);
    if (isCurrent) meta.push(['Ay sonu tahmini', money(avg * n, undefined, { whole: true })]);
  }
  $('budget-meta').innerHTML = meta
    .map(([label, value, neg]) => `<div><span>${esc(label)}</span><strong class="${neg ? 'neg' : ''}">${esc(value)}</strong></div>`)
    .join('');

  const missing = $('missing');
  missing.hidden = !s.missing_amount_count;
  missing.textContent = `${s.missing_amount_count} harcamanın tutarı gelmedi. Listeden dokunup tutarı girin.`;
  if (s.other_currencies.length) {
    missing.hidden = false;
    const others = s.other_currencies.map((o) => money(o.total_minor, o.currency)).join(', ');
    missing.textContent = (s.missing_amount_count ? missing.textContent + ' ' : '') + `Yabancı para harcamaları toplama dahil değil: ${others}.`;
  }
}

function renderTrend() {
  const s = state.summary;
  const n = daysIn(state.month);
  const elapsed = elapsedDays();
  const W = 340, H = 150, L = 34, R = 6, T = 8, B = 20;
  const byDay = new Map(s.by_day.map((d) => [Number(d.date.slice(8, 10)), d.total_minor]));

  const points = [[0, 0]];
  let running = 0;
  for (let d = 1; d <= elapsed; d++) {
    running += byDay.get(d) || 0;
    points.push([d, running]);
  }
  const maxY = Math.max(s.budget_minor || 0, running, 1) * 1.08;
  const x = (d) => L + (d / n) * (W - L - R);
  const y = (v) => T + (1 - v / maxY) * (H - T - B);

  let svg = '';
  for (const f of [0, 0.5, 1]) {
    const v = maxY * f;
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${esc(compact(v))}</text>`;
  }
  for (const d of [1, 10, 20, n]) svg += `<text x="${x(d)}" y="${H - 4}" text-anchor="middle">${d}</text>`;

  if (s.budget_minor) {
    svg += `<line class="budget-line" x1="${L}" x2="${W - R}" y1="${y(s.budget_minor)}" y2="${y(s.budget_minor)}"/>`;
    svg += `<line class="pace-line" x1="${x(0)}" y1="${y(0)}" x2="${x(n)}" y2="${y(s.budget_minor)}"/>`;
  }
  if (points.length > 1) {
    const line = points.map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    svg += `<polygon class="spent-area" points="${x(0)},${y(0)} ${line} ${x(elapsed)},${y(0)}"/>`;
    svg += `<polyline class="spent-line" points="${line}"/>`;
    svg += `<circle class="today-dot" r="4" cx="${x(elapsed)}" cy="${y(running)}"/>`;
  }
  $('trend-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ay içi kümülatif harcama">${svg}</svg>`;
  $('trend-legend').innerHTML =
    `<span><i></i>Harcama</span>` +
    (s.budget_minor ? `<span><i class="pace"></i>İdeal tempo</span><span><i class="budget"></i>Bütçe</span>` : '');
}

function renderCategories() {
  const cats = state.summary.by_category.filter((c) => c.total_minor > 0);
  const total = cats.reduce((a, c) => a + c.total_minor, 0);
  if (!total) {
    $('donut').innerHTML = '';
    $('cat-list').innerHTML = '<li class="empty" style="display:block">Henüz harcama yok.</li>';
    return;
  }
  const r = 52, C = 2 * Math.PI * r;
  let offset = 0;
  let arcs = '';
  for (const c of cats) {
    const len = (c.total_minor / total) * C;
    arcs += `<circle r="${r}" cx="66" cy="66" fill="none" stroke="${CATEGORY_COLORS[c.category] || 'var(--c9)'}" stroke-width="18"
      stroke-dasharray="${Math.max(len - 1.5, 0.5)} ${C}" stroke-dashoffset="${-offset}" transform="rotate(-90 66 66)"/>`;
    offset += len;
  }
  $('donut').innerHTML = `<svg viewBox="0 0 132 132" role="img" aria-label="Kategori dağılımı">${arcs}
    <text class="center" x="66" y="68" text-anchor="middle">${esc(compact(total))}</text>
    <text class="center-sub" x="66" y="82" text-anchor="middle">${esc(state.currency)}</text></svg>`;
  $('cat-list').innerHTML = cats
    .map((c) => `<li><span class="dot" style="background:${CATEGORY_COLORS[c.category] || 'var(--c9)'}"></span>
      <span class="name">${esc(c.category)}</span>
      <span class="amt">${esc(money(c.total_minor, undefined, { whole: true }))}<span class="pct">%${Math.round((c.total_minor / total) * 100)}</span></span></li>`)
    .join('');
}

function renderHistory() {
  const h = state.summary.history;
  const W = 340, H = 130, T = 18, B = 18;
  const max = Math.max(...h.map((m) => m.total_minor), state.summary.budget_minor || 0, 1);
  const slot = W / h.length;
  const bw = Math.min(34, slot * 0.6);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  let svg = '';
  if (state.summary.budget_minor) {
    const by = y(state.summary.budget_minor);
    svg += `<line class="budget-line" x1="0" x2="${W}" y1="${by}" y2="${by}" stroke-dasharray="3 3"/>`;
  }
  h.forEach((m, i) => {
    const cx = slot * i + slot / 2;
    const top = y(m.total_minor);
    const current = m.month === state.month;
    svg += `<rect class="bar${current ? ' current' : ''}" x="${cx - bw / 2}" y="${top}" width="${bw}" height="${Math.max(H - B - top, 0)}" rx="6"/>`;
    if (m.total_minor) svg += `<text class="${current ? 'bar-label' : ''}" x="${cx}" y="${top - 5}" text-anchor="middle">${esc(compact(m.total_minor))}</text>`;
    svg += `<text x="${cx}" y="${H - 4}" text-anchor="middle">${esc(monthLabel(m.month, 'short'))}</text>`;
  });
  $('history-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Son 6 ayın toplamları">${svg}</svg>`;
}

function renderTransactions() {
  const list = $('tx-list');
  if (!state.transactions.length) {
    list.innerHTML = '<p class="empty">Bu ay kayıt yok. Apple Pay ile ödeme yaptığınızda burada görünecek.</p>';
    return;
  }
  const days = new Map();
  for (const t of state.transactions) {
    if (!days.has(t.local_date)) days.set(t.local_date, []);
    days.get(t.local_date).push(t);
  }
  let html = '';
  for (const [date, items] of days) {
    const dayTotal = items.filter((t) => t.currency === state.currency).reduce((a, t) => a + (t.amount_minor || 0), 0);
    const hasLocal = items.some((t) => t.currency === state.currency);
    html += `<div class="tx-day"><h3><span>${esc(dayLabel(date))}</span><span>${hasLocal ? esc(money(dayTotal)) : ''}</span></h3><div class="tx-group">`;
    for (const t of items) {
      const color = CATEGORY_COLORS[t.category] || 'var(--c9)';
      const sub = [t.category, timeLabel(t.occurred_at), t.card, t.note].filter(Boolean).join(' · ');
      const amount = t.amount_minor === null
        ? '<span class="amount missing">Tutar gir</span>'
        : `<span class="amount">${esc(money(t.amount_minor, t.currency))}</span>`;
      html += `<button class="tx" data-id="${t.id}">
        <span class="badge" style="background:${color}">${esc(t.category.slice(0, 2))}</span>
        <span class="main"><span class="merchant">${esc(t.merchant)}</span><span class="sub">${esc(sub)}</span></span>
        ${amount}</button>`;
    }
    html += '</div></div>';
  }
  list.innerHTML = html;
}

// ---------- düzenleme ----------

function renderChips(selected) {
  $('category-chips').innerHTML = CATEGORIES
    .map((c) => `<button type="button" class="chip" aria-pressed="${c === selected}" data-cat="${esc(c)}">${esc(c)}</button>`)
    .join('');
}

function openTx(tx) {
  state.editing = tx;
  const form = $('tx-form');
  $('tx-dialog-title').textContent = tx ? 'Harcamayı düzenle' : 'Yeni harcama';
  form.amount.value = tx ? minorToInput(tx.amount_minor) : '';
  form.merchant.value = tx?.merchant || '';
  form.note.value = tx?.note || '';
  form.date.value = toLocalInput(tx?.occurred_at || new Date().toISOString());
  renderChips(tx?.category || 'Diğer');
  $('tx-card').textContent = tx?.card ? `Kart: ${tx.card}${tx.source === 'shortcut' ? ' · Apple Pay' : ''}` : '';
  $('delete-tx').hidden = !tx;
  $('tx-error').textContent = '';
  $('tx-dialog').showModal();
  if (!tx) form.amount.focus();
}

async function saveTx(event) {
  event.preventDefault();
  const form = $('tx-form');
  const category = document.querySelector('#category-chips [aria-pressed="true"]')?.dataset.cat;
  const body = {
    amount: form.amount.value.trim(),
    merchant: form.merchant.value.trim(),
    note: form.note.value.trim(),
    category,
    date: new Date(form.date.value).toISOString(),
  };
  try {
    if (state.editing) {
      await api(`/api/transactions/${state.editing.id}`, { method: 'PATCH', body });
    } else {
      if (!body.amount) throw new Error('Tutar girin.');
      await api('/api/transactions', { method: 'POST', body: { ...body, source: 'manual' } });
    }
    $('tx-dialog').close();
    await load();
  } catch (err) {
    $('tx-error').textContent = err instanceof AuthError ? 'Oturum geçersiz.' : err.message;
  }
}

async function deleteTx() {
  if (!state.editing || !confirm(`“${state.editing.merchant}” silinsin mi?`)) return;
  try {
    await api(`/api/transactions/${state.editing.id}`, { method: 'DELETE' });
    $('tx-dialog').close();
    await load();
  } catch (err) {
    $('tx-error').textContent = err.message;
  }
}

async function openSettings() {
  const form = $('settings-form');
  $('api-url').textContent = `${location.origin}/api/transactions`;
  $('settings-error').textContent = '';
  form.budget.value = state.summary?.budget_minor ? minorToInput(state.summary.budget_minor) : '';
  $('settings-dialog').showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await api('/api/settings', { method: 'PUT', body: { monthly_budget: $('settings-form').budget.value.trim() } });
    $('settings-dialog').close();
    await load();
  } catch (err) {
    $('settings-error').textContent = err.message;
  }
}

// ---------- olaylar ----------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('login-token').value.trim();
  storage((s) => s.setItem(TOKEN_KEY, token));
  await load();
});
$('prev-month').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); load(); });
$('next-month').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); load(); });
$('add-tx').addEventListener('click', () => openTx(null));
$('tx-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.tx');
  if (btn) openTx(state.transactions.find((t) => t.id === Number(btn.dataset.id)));
});
$('category-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  for (const c of $('category-chips').children) c.setAttribute('aria-pressed', String(c === chip));
});
$('tx-form').addEventListener('submit', saveTx);
$('delete-tx').addEventListener('click', deleteTx);
$('open-settings').addEventListener('click', openSettings);
$('set-budget').addEventListener('click', openSettings);
$('settings-form').addEventListener('submit', saveSettings);
$('logout').addEventListener('click', () => {
  storage((s) => {
    for (const k of Object.keys(s)) if (k.startsWith('harcama.')) s.removeItem(k);
  });
  $('settings-dialog').close();
  showLogin();
});
for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => btn.closest('dialog').close());
}
// Uygulamaya geri dönülünce (ör. ödeme sonrası) verileri tazele.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('app').hidden) load();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

if (storage((s) => s.getItem(TOKEN_KEY))) load();
else showLogin();
