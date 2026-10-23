const TOKEN_KEY = 'harcama.token';
const CACHE_PREFIX = 'harcama.cache.';
const CATEGORY_COLORS = {
  'Market': 'var(--c-market)',
  'Yeme-İçme': 'var(--c-food)',
  'Ulaşım': 'var(--c-transport)',
  'Akaryakıt': 'var(--c-fuel)',
  'Alışveriş': 'var(--c-shopping)',
  'Faturalar': 'var(--c-bills)',
  'Sağlık': 'var(--c-health)',
  'Eğlence': 'var(--c-fun)',
  'Diğer': 'var(--c-other)',
};
const CATEGORIES = Object.keys(CATEGORY_COLORS);
const CURRENCIES = {
  TRY: { flag: '🇹🇷', name: 'Türk lirası' },
  USD: { flag: '🇺🇸', name: 'ABD doları' },
  EUR: { flag: '🇪🇺', name: 'Euro' },
  IDR: { flag: '🇮🇩', name: 'Endonezya rupisi' },
  THB: { flag: '🇹🇭', name: 'Tayland bahtı' },
  JPY: { flag: '🇯🇵', name: 'Japon yeni' },
  SGD: { flag: '🇸🇬', name: 'Singapur doları' },
};

const $ = (id) => document.getElementById(id);
const state = { month: currentMonth(), currency: 'TRY', summary: null, transactions: [], editing: null, animated: false };

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

/** Tutarlar her para biriminde ×100 saklanır (JPY/IDR dahil). */
function money(minor, currency = state.currency, { whole = false } = {}) {
  const opts = { style: 'currency', currency };
  if (whole) { opts.maximumFractionDigits = 0; opts.minimumFractionDigits = 0; }
  return new Intl.NumberFormat('tr-TR', opts).format((minor || 0) / 100);
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
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Bugün';
  if (date.toDateString() === yesterday.toDateString()) return 'Dün';
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' }).format(date);
}

function timeLabel(iso) {
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function minorToInput(minor) {
  if (minor === null || minor === undefined) return '';
  // "11.671" / "1.234,5" biçimi; sunucu bu ayraçları doğru okur.
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(minor / 100);
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const colorOf = (category) => CATEGORY_COLORS[category] || 'var(--c-other)';

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
    state.offline = summary.stale || list.stale;
    $('login').hidden = true;
    $('app').hidden = false;
    render();
  } catch (err) {
    if (err instanceof AuthError) {
      storage((s) => s.removeItem(TOKEN_KEY));
      showLogin('Anahtar geçersiz. Kurulumda oluşturduğunuz anahtarı girin.');
    } else {
      $('app').hidden = false;
      showNotice([`Veriler yüklenemedi: ${err.message}`]);
    }
  }
}

function render() {
  const meta = CURRENCIES[state.currency] || { flag: '' };
  $('currency-flag').textContent = meta.flag;
  $('currency-code').textContent = state.currency;
  renderDial();
  renderNotices();
  renderCategories();
  renderCards();
  renderHistory();
  renderTransactions();
}

function showNotice(lines) {
  $('notice').hidden = !lines.length;
  $('notice').textContent = lines.join(' ');
}

function renderNotices() {
  const s = state.summary;
  const lines = [];
  if (state.offline) lines.push('Bağlantı yok, son yüklenen veriler gösteriliyor.');
  if (s.missing_amount_count) lines.push(`${s.missing_amount_count} harcamanın tutarı gelmedi. Listede “Tutar gir” yazanlara dokunup tutarı ekleyin.`);
  if (s.unconverted.length) {
    lines.push(`Kuru bulunamayan harcamalar toplama katılmadı: ${s.unconverted.map((u) => money(u.total_minor, u.currency)).join(', ')}.`);
  }
  if (s.fx?.stale) lines.push('Kur servisine ulaşılamadı, son bilinen kurlar kullanılıyor.');
  showNotice(lines);
}

/** Ayın kaçıncı günündeyiz (geçmiş ay → tamamı, gelecek ay → 0). */
function elapsedDays() {
  const n = daysIn(state.month);
  const now = currentMonth();
  if (state.month < now) return n;
  if (state.month > now) return 0;
  return new Date().getDate();
}

function renderDial() {
  const s = state.summary;
  const n = daysIn(state.month);
  const elapsed = elapsedDays();
  const isCurrent = state.month === currentMonth();
  const budget = s.budget_minor;
  const C = 150;
  const polar = (r, frac) => {
    const a = (frac * 360 - 90) * (Math.PI / 180);
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  };

  // Gün çentikleri: uzunluk o günün harcamasıyla orantılı.
  const byDay = new Map(s.by_day.map((d) => [Number(d.date.slice(8, 10)), d.total_minor]));
  const maxDay = Math.max(...byDay.values(), 1);
  let svg = '';
  for (let d = 1; d <= n; d++) {
    const v = byDay.get(d) || 0;
    const len = v ? 7 + 15 * Math.sqrt(v / maxDay) : 4;
    const frac = (d - 0.5) / n;
    const [x1, y1] = polar(126, frac);
    const [x2, y2] = polar(126 + len, frac);
    const cls = d > elapsed ? 'future' : (isCurrent && d === elapsed ? 'today' : (v ? 'spent' : ''));
    svg += `<line class="tick ${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }

  // Bütçe halkası.
  const R = 106;
  const circ = 2 * Math.PI * R;
  svg += `<circle class="track" cx="${C}" cy="${C}" r="${R}"/>`;
  if (budget) {
    const ratio = s.total_minor / budget;
    const pace = elapsed / n;
    const len = Math.min(ratio, 1) * circ;
    const tone = ratio > 1 ? 'over' : (isCurrent && ratio > pace ? 'ahead' : '');
    const animate = state.animated ? '' : 'animate';
    if (len > 0) {
      svg += `<circle class="fill ${tone} ${animate}" cx="${C}" cy="${C}" r="${R}" style="--len:${len.toFixed(1)}"
        stroke-dasharray="${len.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${C} ${C})"/>`;
    }
    if (isCurrent) {
      const [px, py] = polar(R, pace);
      svg += `<circle class="pace" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6"><title>Bugüne kadarki ideal harcama</title></circle>`;
    }
    state.animated = true;
  }
  $('dial-svg').innerHTML = svg;

  $('spent').textContent = money(s.total_minor, state.currency, { whole: true });
  $('dial-sub').textContent = budget
    ? `${money(budget, state.currency, { whole: true })} bütçeden`
    : (isCurrent ? 'bu ay harcandı' : `${monthLabel(state.month)} toplamı`);
  $('set-budget').hidden = !!budget;
  $('dial-hint').hidden = !(budget && isCurrent);

  // Alt istatistikler.
  const avg = elapsed ? s.total_minor / elapsed : 0;
  const stats = [];
  if (budget) {
    const remaining = budget - s.total_minor;
    stats.push([remaining >= 0 ? 'Kalan' : 'Aşım', money(Math.abs(remaining), state.currency, { whole: true }), remaining < 0]);
    if (isCurrent) {
      const daysLeft = n - elapsed + 1;
      stats.push(['Günlük limit', remaining > 0 ? money(remaining / daysLeft, state.currency, { whole: true }) : '—']);
      stats.push(['Ay sonu tahmini', money(avg * n, state.currency, { whole: true }), avg * n > budget]);
    } else {
      stats.push(['Günlük ortalama', money(avg, state.currency, { whole: true })]);
      stats.push(['Bütçe kullanımı', `%${Math.round((s.total_minor / budget) * 100)}`, s.total_minor > budget]);
    }
  } else {
    stats.push(['Harcama', String(s.count)]);
    stats.push(['Günlük ortalama', money(avg, state.currency, { whole: true })]);
    if (isCurrent) stats.push(['Ay sonu tahmini', money(avg * n, state.currency, { whole: true })]);
  }
  $('stats').innerHTML = stats
    .map(([label, value, bad]) => `<div><dt>${esc(label)}</dt><dd class="${bad ? 'bad' : ''}">${esc(value)}</dd></div>`)
    .join('');
}

function renderCategories() {
  const cats = state.summary.by_category.filter((c) => c.total_minor > 0);
  const total = cats.reduce((a, c) => a + c.total_minor, 0);
  if (!total) {
    $('cat-bar').innerHTML = '';
    $('cat-list').outerHTML = '<p id="cat-list" class="empty">Bu ay henüz harcama yok.</p>';
    return;
  }
  if ($('cat-list').tagName !== 'UL') $('cat-list').outerHTML = '<ul id="cat-list" class="cat-list"></ul>';
  $('cat-bar').innerHTML = cats
    .map((c) => `<span style="flex:${c.total_minor};background:${colorOf(c.category)}" title="${esc(c.category)}"></span>`)
    .join('');
  $('cat-list').innerHTML = cats
    .map((c) => `<li><span class="dot" style="background:${colorOf(c.category)}"></span>
      <span class="name">${esc(c.category)}</span>
      <span class="amt">${esc(money(c.total_minor, state.currency, { whole: true }))}</span>
      <span class="pct">%${Math.round((c.total_minor / total) * 100)}</span></li>`)
    .join('');
}

const CARD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 10h17"/></svg>';
const CASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="12" cy="12" r="2.2"/></svg>';
const isCash = (card) => /^nakit$/i.test(card || '');

function renderCards() {
  const cards = state.summary.by_card || [];
  const total = cards.reduce((a, c) => a + c.total_minor, 0);
  const list = $('card-list');
  if (!cards.length) {
    list.innerHTML = '<li class="card-row unset"><span></span><span class="name">Bu ay harcama yok.</span></li>';
    return;
  }
  list.innerHTML = cards
    .map((c) => `<li class="card-row${c.card ? '' : ' unset'}">
      <span class="card-list-icon">${isCash(c.card) ? CASH_ICON : CARD_ICON}</span>
      <span class="name">${esc(c.card || 'Belirtilmemiş')}<small>${c.count} harcama</small></span>
      <span class="amt">${esc(money(c.total_minor, state.currency, { whole: true }))}</span>
      <span class="pct">%${total ? Math.round((c.total_minor / total) * 100) : 0}</span></li>`)
    .join('');
}

function renderCardChips(current) {
  const recent = state.summary?.recent_cards || [];
  const options = [...new Set([...recent, 'Nakit'])];
  $('card-chips').innerHTML = options
    .map((c) => `<button type="button" class="chip" aria-pressed="${c === current}" data-card="${esc(c)}">${esc(c)}</button>`)
    .join('');
}

function renderHistory() {
  const h = state.summary.history;
  const budget = state.summary.budget_minor;
  const W = 340, H = 140, T = 20, B = 20;
  const max = Math.max(...h.map((m) => m.total_minor), budget || 0, 1);
  const slot = W / h.length;
  const bw = Math.min(30, slot * 0.5);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  let svg = '';
  if (budget) svg += `<line class="budget" x1="0" x2="${W}" y1="${y(budget)}" y2="${y(budget)}"/>`;
  h.forEach((m, i) => {
    const cx = slot * i + slot / 2;
    const top = y(m.total_minor);
    const current = m.month === state.month;
    const height = Math.max(H - B - top, m.total_minor ? 4 : 0);
    svg += `<rect class="bar${current ? ' current' : ''}" x="${cx - bw / 2}" y="${H - B - height}" width="${bw}" height="${height}" rx="${bw / 2 > 8 ? 8 : bw / 2}"/>`;
    if (m.total_minor) svg += `<text class="value" x="${cx}" y="${H - B - height - 6}" text-anchor="middle">${esc(compact(m.total_minor))}</text>`;
    svg += `<text x="${cx}" y="${H - 4}" text-anchor="middle">${esc(monthLabel(m.month, 'short'))}</text>`;
  });
  $('history-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Son 6 ayın toplamları (${esc(state.currency)})">${svg}</svg>`;
}

function renderTransactions() {
  const list = $('tx-list');
  if (!state.transactions.length) {
    list.innerHTML = '<p class="empty">Bu ay kayıt yok. Apple Pay ile ödediğinizde harcama burada görünür.</p>';
    return;
  }
  const days = new Map();
  for (const t of state.transactions) {
    if (!days.has(t.local_date)) days.set(t.local_date, []);
    days.get(t.local_date).push(t);
  }
  let html = '';
  for (const [date, items] of days) {
    const dayTotal = items.reduce((a, t) => a + (t.converted_minor || 0), 0);
    html += `<div class="tx-day"><h3><span>${esc(dayLabel(date))}</span><span>${esc(money(dayTotal))}</span></h3><div class="tx-group">`;
    for (const t of items) {
      const foreign = t.currency !== state.currency;
      let money_ = '<span class="amount missing">Tutar gir</span>';
      if (t.amount_minor !== null) {
        const shown = t.converted_minor ?? t.amount_minor;
        const shownCurrency = t.converted_minor === null ? t.currency : state.currency;
        money_ = `<span class="amount">${esc(money(shown, shownCurrency))}</span>`;
        if (foreign && t.converted_minor !== null) money_ += `<span class="orig">${esc(money(t.amount_minor, t.currency))}</span>`;
      }
      const meta = [t.category, timeLabel(t.occurred_at), t.card, t.note].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');
      html += `<button class="tx" data-id="${t.id}">
        <span class="glyph" style="background:${colorOf(t.category)}">${esc(t.merchant.trim().charAt(0).toLocaleUpperCase('tr-TR'))}</span>
        <span class="who"><span class="merchant">${esc(t.merchant)}</span><span class="meta">${meta}</span></span>
        <span class="money">${money_}</span></button>`;
    }
    html += '</div></div>';
  }
  list.innerHTML = html;
}

// ---------- para birimi ----------

function rateLine(code) {
  const rates = state.summary?.fx?.rates;
  if (!rates || code === state.currency || !rates[code] || !rates[state.currency]) return '';
  const value = rates[state.currency] / rates[code];
  const unit = value < 0.1 ? 1000 : 1;
  return `${unit.toLocaleString('tr-TR')} ${code} = ${money(value * unit * 100, state.currency)}`;
}

function openCurrency() {
  $('currency-list').innerHTML = Object.entries(CURRENCIES)
    .map(([code, c]) => `<li><button type="button" role="option" aria-selected="${code === state.currency}" data-code="${code}">
      <span class="flag" aria-hidden="true">${c.flag}</span>
      <span class="label"><strong>${code}</strong><span>${esc(c.name)}</span></span>
      <span class="rate">${esc(rateLine(code))}</span>
      <svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
    </button></li>`)
    .join('');
  $('fx-info').textContent = fxLine();
  $('currency-dialog').showModal();
}

async function chooseCurrency(code) {
  if (code === state.currency) return $('currency-dialog').close();
  for (const b of $('currency-list').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.code === code));
  try {
    await api('/api/settings', { method: 'PUT', body: { display_currency: code } });
    $('currency-dialog').close();
    await load();
  } catch (err) {
    $('fx-info').textContent = err instanceof AuthError ? 'Oturum geçersiz.' : `Kaydedilemedi: ${err.message}`;
  }
}

// ---------- düzenleme ----------

function renderChips(selected) {
  $('category-chips').innerHTML = CATEGORIES
    .map((c) => `<button type="button" class="chip" aria-pressed="${c === selected}" data-cat="${esc(c)}"><i style="background:${colorOf(c)}"></i>${esc(c)}</button>`)
    .join('');
}

function openTx(tx) {
  state.editing = tx;
  const form = $('tx-form');
  $('tx-dialog-title').textContent = tx ? 'Harcamayı düzenle' : 'Yeni harcama';
  const codes = Object.keys(CURRENCIES);
  const current = tx?.currency || state.currency;
  if (!codes.includes(current)) codes.push(current);
  form.currency.innerHTML = codes.map((c) => `<option value="${c}"${c === current ? ' selected' : ''}>${c}</option>`).join('');
  form.amount.value = tx ? minorToInput(tx.amount_minor) : '';
  form.merchant.value = tx?.merchant || '';
  form.note.value = tx?.note || '';
  form.card.value = tx?.card || '';
  renderCardChips(tx?.card || '');
  form.date.value = toLocalInput(tx?.occurred_at || new Date().toISOString());
  renderChips(tx?.category || 'Diğer');
  $('tx-card').textContent = tx ? (tx.source === 'shortcut' ? 'Apple Pay ile otomatik kaydedildi.' : 'Elle eklendi.') : '';
  $('delete-tx').hidden = !tx;
  $('tx-error').textContent = '';
  $('tx-dialog').showModal();
  if (!tx) form.amount.focus();
}

async function saveTx(event) {
  event.preventDefault();
  const form = $('tx-form');
  const body = {
    amount: form.amount.value.trim(),
    currency: form.currency.value,
    merchant: form.merchant.value.trim(),
    note: form.note.value.trim(),
    card: form.card.value.trim(),
    category: document.querySelector('#category-chips [aria-pressed="true"]')?.dataset.cat,
    date: new Date(form.date.value).toISOString(),
  };
  try {
    if (state.editing) {
      await api(`/api/transactions/${state.editing.id}`, { method: 'PATCH', body });
    } else {
      if (!body.amount) throw new Error('Tutarı girin.');
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

function fxLine() {
  const fx = state.summary?.fx;
  if (!fx) return 'Kurlar henüz alınamadı.';
  const when = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(fx.as_of));
  return `Kurlar ${when} itibarıyla, kaynak ${fx.source}.${fx.stale ? ' Kur servisine şu an ulaşılamıyor.' : ''}`;
}

function lastShortcutLabel() {
  const last = state.transactions
    .filter((t) => t.source === 'shortcut')
    .reduce((a, t) => (!a || t.created_at > a ? t.created_at : a), null);
  if (!last) return 'Bu ay yok';
  const day = dayLabel(toLocalInput(last).slice(0, 10));
  const short = day === 'Bugün' || day === 'Dün' ? day : day.split(' ').slice(0, 2).join(' ');
  return `${short} ${timeLabel(last)}`;
}

function openSettings() {
  const form = $('settings-form');
  const meta = CURRENCIES[state.currency] || { flag: '' };
  $('api-url').textContent = `${location.origin}/api/transactions`;
  $('budget-currency').textContent = state.currency;
  $('settings-currency-value').textContent = `${meta.flag} ${state.currency}`;
  $('settings-fx').textContent = fxLine();
  $('last-shortcut').textContent = lastShortcutLabel();
  $('settings-error').textContent = '';
  $('copy-url').textContent = 'Kopyala';
  $('copy-url').classList.remove('done');
  form.budget.value = state.summary?.budget_minor ? minorToInput(Math.round(state.summary.budget_minor / 100) * 100) : '';
  $('settings-dialog').showModal();
}

async function copyUrl() {
  const btn = $('copy-url');
  try {
    await navigator.clipboard.writeText($('api-url').textContent);
    btn.textContent = 'Kopyalandı';
    btn.classList.add('done');
  } catch {
    // Pano izni yoksa metni seçili bırak, kullanıcı elle kopyalasın.
    getSelection().selectAllChildren($('api-url'));
    btn.textContent = 'Seçildi';
  }
  setTimeout(() => { btn.textContent = 'Kopyala'; btn.classList.remove('done'); }, 1800);
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: { monthly_budget: $('settings-form').budget.value.trim(), budget_currency: state.currency },
    });
    $('settings-dialog').close();
    await load();
  } catch (err) {
    $('settings-error').textContent = err.message;
  }
}

// ---------- olaylar ----------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  storage((s) => s.setItem(TOKEN_KEY, $('login-token').value.trim()));
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
$('open-currency').addEventListener('click', openCurrency);
$('currency-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-code]');
  if (btn) chooseCurrency(btn.dataset.code);
});
$('tx-form').addEventListener('submit', saveTx);
$('card-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('tx-form').card.value = chip.dataset.card;
  for (const c of $('card-chips').children) c.setAttribute('aria-pressed', String(c === chip));
});
$('tx-card-input').addEventListener('input', (e) => {
  for (const c of $('card-chips').children) c.setAttribute('aria-pressed', String(c.dataset.card === e.target.value.trim()));
});
$('delete-tx').addEventListener('click', deleteTx);
$('open-settings').addEventListener('click', openSettings);
$('set-budget').addEventListener('click', openSettings);
$('copy-url').addEventListener('click', copyUrl);
$('settings-currency').addEventListener('click', () => { $('settings-dialog').close(); openCurrency(); });
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
// Sayfa dışına (arka plana) dokununca kapat.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
}
// Uygulamaya geri dönülünce (ör. ödeme sonrası) verileri tazele.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('app').hidden && !document.querySelector('dialog[open]')) load();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

if (storage((s) => s.getItem(TOKEN_KEY))) load();
else showLogin();
