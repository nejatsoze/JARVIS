import {
  CATEGORIES,
  DISPLAY_CURRENCIES,
  ValidationError,
  cleanText,
  convertMinor,
  guessCategory,
  isMonth,
  localDate,
  merchantKey,
  parseAmount,
  parseOccurredAt,
  previousMonths,
} from './lib.js';

const MAX_BODY_BYTES = 10_000;
// Kestirme aynı ödeme için iki kez çalışırsa (ya da yeniden denenirse) çift kayıt olmasın.
const DEDUPE_WINDOW_MS = 90_000;
const HISTORY_MONTHS = 6;
const RECENT_CARDS_LIMIT = 8;
// Ücretsiz kaynaklar günde birkaç kez güncelleniyor; saatlik önbellek yeterli ve kotayı korur.
const FX_TTL_MS = 60 * 60 * 1000;
const FX_TIMEOUT_MS = 4000;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const started = Date.now();
    let response;
    try {
      response = await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ error: err.code, message: err.message }, err.status);
      } else if (err instanceof ValidationError) {
        response = json({ error: 'validation', message: err.message }, 400);
      } else {
        console.error(JSON.stringify({ msg: 'unhandled', path: url.pathname, error: String(err?.stack || err) }));
        response = json({ error: 'internal', message: 'Sunucu hatası' }, 500);
      }
    }
    console.log(JSON.stringify({ method: request.method, path: url.pathname, status: response.status, ms: Date.now() - started }));
    return response;
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/health' && method === 'GET') {
    await env.DB.prepare('SELECT 1').first();
    return json({ ok: true });
  }

  await requireAuth(request, env);

  if (pathname === '/api/transactions') {
    if (method === 'POST') return createTransaction(request, env);
    if (method === 'GET') return listTransactions(env, url);
  }
  const idMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (method === 'PATCH') return updateTransaction(request, env, id);
    if (method === 'DELETE') return deleteTransaction(env, id);
  }
  if (pathname === '/api/summary' && method === 'GET') return summary(env, url);
  if (pathname === '/api/settings') {
    if (method === 'GET') return json(await getSettings(env));
    if (method === 'PUT') return putSettings(request, env);
  }
  if (pathname === '/api/categories' && method === 'GET') return json({ categories: CATEGORIES });

  throw new HttpError(404, 'not_found', 'Bulunamadı');
}

async function requireAuth(request, env) {
  if (!env.API_TOKEN) throw new HttpError(500, 'misconfigured', 'API_TOKEN tanımlı değil');
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !(await safeEqual(token, env.API_TOKEN))) {
    throw new HttpError(401, 'unauthorized', 'Geçersiz anahtar');
  }
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  // Uzunluk farkını sızdırmamak için önce özetleri karşılaştır.
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'İstek çok büyük');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'İstek çok büyük');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new ValidationError('Gövde geçerli bir JSON nesnesi olmalı');
  }
}

function validCategory(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!CATEGORIES.includes(value)) throw new ValidationError(`Kategori şunlardan biri olmalı: ${CATEGORIES.join(', ')}`);
  return value;
}

function validCurrency(value) {
  if (!/^[A-Z]{3}$/.test(value)) throw new ValidationError('Para birimi 3 harfli kod olmalı (ör. TRY)');
  return value;
}

async function createTransaction(request, env) {
  const body = await readJson(request);
  const merchant = cleanText(body.merchant, 'İşyeri', 120, { required: true });
  const card = cleanText(body.card, 'Kart', 80);
  const note = cleanText(body.note, 'Not', 280);
  const { minor, currency: parsedCurrency } = parseAmount(body.amount);
  const currency = validCurrency(
    typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim().toUpperCase() : parsedCurrency || env.CURRENCY,
  );
  const occurred = parseOccurredAt(body.date);
  const source = body.source === 'manual' ? 'manual' : 'shortcut';

  const duplicate = await env.DB.prepare(
    `SELECT * FROM transactions
     WHERE merchant = ?1 AND amount_minor IS ?2 AND occurred_at BETWEEN ?3 AND ?4
     LIMIT 1`,
  )
    .bind(
      merchant,
      minor,
      new Date(occurred.getTime() - DEDUPE_WINDOW_MS).toISOString(),
      new Date(occurred.getTime() + DEDUPE_WINDOW_MS).toISOString(),
    )
    .first();
  if (duplicate) return json({ transaction: duplicate, duplicate: true });

  let category = validCategory(body.category);
  if (!category) {
    const learned = await env.DB.prepare('SELECT category FROM merchant_categories WHERE merchant_key = ?1')
      .bind(merchantKey(merchant))
      .first();
    category = learned?.category || guessCategory(merchant);
  }

  const row = await env.DB.prepare(
    `INSERT INTO transactions (merchant, amount_minor, currency, card, category, note, source, occurred_at, local_date)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     RETURNING *`,
  )
    .bind(merchant, minor, currency, card, category, note, source, occurred.toISOString(), localDate(occurred, env.TIMEZONE))
    .first();
  return json({ transaction: row, duplicate: false }, 201);
}

function requireMonth(url) {
  const month = url.searchParams.get('month');
  if (!isMonth(month)) throw new ValidationError('month parametresi YYYY-AA biçiminde olmalı');
  return month;
}

function displayCurrency(url, settings) {
  const requested = url.searchParams.get('currency');
  if (requested === null) return settings.display_currency;
  if (!DISPLAY_CURRENCIES.includes(requested)) {
    throw new ValidationError(`currency şunlardan biri olmalı: ${DISPLAY_CURRENCIES.join(', ')}`);
  }
  return requested;
}

async function listTransactions(env, url) {
  const month = requireMonth(url);
  const settings = await getSettings(env);
  const currency = displayCurrency(url, settings);
  const [{ results }, fx] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM transactions WHERE local_date BETWEEN ?1 AND ?2
       ORDER BY occurred_at DESC, id DESC`,
    )
      .bind(`${month}-01`, `${month}-31`)
      .all(),
    getRates(env),
  ]);
  const transactions = results.map((t) => ({
    ...t,
    converted_minor: convertMinor(t.amount_minor, t.currency, currency, fx?.rates),
  }));
  return json({ currency, transactions });
}

async function updateTransaction(request, env, id) {
  const body = await readJson(request);
  const existing = await env.DB.prepare('SELECT * FROM transactions WHERE id = ?1').bind(id).first();
  if (!existing) throw new HttpError(404, 'not_found', 'Kayıt bulunamadı');

  const next = { ...existing };
  if ('merchant' in body) next.merchant = cleanText(body.merchant, 'İşyeri', 120, { required: true });
  if ('card' in body) next.card = cleanText(body.card, 'Kart', 80);
  if ('note' in body) next.note = cleanText(body.note, 'Not', 280);
  if ('amount' in body) next.amount_minor = parseAmount(body.amount).minor;
  if ('currency' in body) next.currency = validCurrency(String(body.currency).trim().toUpperCase());
  if ('category' in body) {
    const category = validCategory(body.category);
    if (!category) throw new ValidationError('Kategori gerekli');
    next.category = category;
  }
  if ('date' in body) {
    const occurred = parseOccurredAt(body.date);
    next.occurred_at = occurred.toISOString();
    next.local_date = localDate(occurred, env.TIMEZONE);
  }

  const statements = [
    env.DB.prepare(
      `UPDATE transactions
       SET merchant = ?1, card = ?2, note = ?3, amount_minor = ?4, category = ?5, occurred_at = ?6, local_date = ?7, currency = ?8
       WHERE id = ?9 RETURNING *`,
    ).bind(next.merchant, next.card, next.note, next.amount_minor, next.category, next.occurred_at, next.local_date, next.currency, id),
  ];
  // Kategori elle değiştirildiyse bu işyeri için hatırla (istenmezse "learn": false).
  if (next.category !== existing.category && body.learn !== false) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO merchant_categories (merchant_key, category) VALUES (?1, ?2)
         ON CONFLICT (merchant_key) DO UPDATE SET category = excluded.category`,
      ).bind(merchantKey(next.merchant), next.category),
    );
  }
  const [updated] = await env.DB.batch(statements);
  return json({ transaction: updated.results[0] });
}

async function deleteTransaction(env, id) {
  const result = await env.DB.prepare('DELETE FROM transactions WHERE id = ?1').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found', 'Kayıt bulunamadı');
  return new Response(null, { status: 204 });
}

const SETTING_KEYS = ['monthly_budget_minor', 'budget_currency', 'display_currency'];

async function getSettings(env) {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${SETTING_KEYS.map(() => '?').join(', ')})`,
  )
    .bind(...SETTING_KEYS)
    .all();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return {
    monthly_budget_minor: map.monthly_budget_minor ? Number(map.monthly_budget_minor) : null,
    // Eski kayıtlarda bütçe para birimi yok: o zamanlar tek para birimi CURRENCY idi.
    budget_currency: map.budget_currency || env.CURRENCY,
    display_currency: map.display_currency || env.CURRENCY,
    currencies: DISPLAY_CURRENCIES,
    timezone: env.TIMEZONE,
  };
}

const upsertSetting = (env, key, value) =>
  env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).bind(key, value);

async function putSettings(request, env) {
  const body = await readJson(request);
  const statements = [];
  let display = null;
  if ('display_currency' in body) {
    if (!DISPLAY_CURRENCIES.includes(body.display_currency)) {
      throw new ValidationError(`Para birimi şunlardan biri olmalı: ${DISPLAY_CURRENCIES.join(', ')}`);
    }
    display = body.display_currency;
    statements.push(upsertSetting(env, 'display_currency', display));
  }
  if ('monthly_budget' in body) {
    const { minor } = parseAmount(body.monthly_budget);
    if (minor === null) {
      statements.push(env.DB.prepare("DELETE FROM settings WHERE key IN ('monthly_budget_minor', 'budget_currency')"));
    } else {
      // Bütçe, girildiği andaki gösterim para biriminde saklanır; diğer birimlere kurla çevrilir.
      const budgetCurrency = body.budget_currency || display || (await getSettings(env)).display_currency;
      if (!DISPLAY_CURRENCIES.includes(budgetCurrency)) throw new ValidationError('Bütçe para birimi geçersiz');
      statements.push(upsertSetting(env, 'monthly_budget_minor', String(minor)));
      statements.push(upsertSetting(env, 'budget_currency', budgetCurrency));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  return json(await getSettings(env));
}

// ---------- Döviz kurları ----------

function validRates(rates) {
  if (!rates || typeof rates !== 'object') return null;
  const clean = {};
  for (const [code, value] of Object.entries(rates)) {
    if (/^[A-Z]{3}$/.test(code) && typeof value === 'number' && value > 0 && Number.isFinite(value)) clean[code] = value;
  }
  clean.USD = 1;
  return DISPLAY_CURRENCIES.every((c) => clean[c]) ? clean : null;
}

const FX_SOURCES = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (d) => (d.result === 'success' ? { rates: validRates(d.rates), as_of: new Date(d.time_last_update_unix * 1000).toISOString() } : null),
  },
  {
    name: 'frankfurter',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD',
    parse: (d) => ({ rates: validRates(d.rates), as_of: `${d.date}T16:00:00Z` }),
  },
];

async function fetchRates() {
  for (const source of FX_SOURCES) {
    try {
      const res = await fetch(source.url, { signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = source.parse(await res.json());
      if (parsed?.rates) return { ...parsed, source: source.name };
      throw new Error('beklenmeyen yanıt');
    } catch (err) {
      console.error(JSON.stringify({ msg: 'fx_fetch_failed', source: source.name, error: String(err) }));
    }
  }
  return null;
}

/**
 * USD tabanlı kurlar. Önbellek tazeyse onu, değilse kaynaklardan yenisini döner;
 * kaynaklar çökerse son bilinen kurlarla (stale: true) devam eder.
 */
async function getRates(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'fx_rates'").first();
  const cached = row ? JSON.parse(row.value) : null;
  if (cached && Date.now() - Date.parse(cached.fetched_at) < FX_TTL_MS) return { ...cached, stale: false };

  const fresh = await fetchRates();
  if (fresh) {
    const record = { ...fresh, fetched_at: new Date().toISOString() };
    await upsertSetting(env, 'fx_rates', JSON.stringify(record)).run();
    return { ...record, stale: false };
  }
  return cached ? { ...cached, stale: true } : null;
}

// ---------- Özet ----------

async function summary(env, url) {
  const month = requireMonth(url);
  const from = `${month}-01`;
  const to = `${month}-31`;
  const months = previousMonths(month, HISTORY_MONTHS);
  const settings = await getSettings(env);
  const currency = displayCurrency(url, settings);

  const [byCategory, byDay, history, byCard, recentCards, fx] = await Promise.all([
    env.DB.prepare(
      `SELECT category, currency, COALESCE(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS count,
              SUM(amount_minor IS NULL) AS missing
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2
       GROUP BY category, currency`,
    ).bind(from, to).all(),
    env.DB.prepare(
      `SELECT local_date AS date, currency, COALESCE(SUM(amount_minor), 0) AS total_minor
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2
       GROUP BY local_date, currency`,
    ).bind(from, to).all(),
    env.DB.prepare(
      `SELECT substr(local_date, 1, 7) AS month, currency, COALESCE(SUM(amount_minor), 0) AS total_minor
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2
       GROUP BY month, currency`,
    ).bind(`${months[0]}-01`, to).all(),
    env.DB.prepare(
      `SELECT card, currency, COALESCE(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS count
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2
       GROUP BY card, currency`,
    ).bind(from, to).all(),
    // Formdaki hızlı seçim için: tüm zamanlarda en son kullanılan ödeme yöntemleri.
    env.DB.prepare(
      `SELECT card FROM transactions WHERE card IS NOT NULL
       GROUP BY card ORDER BY MAX(occurred_at) DESC LIMIT ?1`,
    ).bind(RECENT_CARDS_LIMIT).all(),
    getRates(env),
  ]);

  // Kuru bulunamayan para birimleri toplama katılmaz, ayrıca raporlanır.
  const unconverted = new Map();
  const convert = (minor, from, track) => {
    const value = convertMinor(minor, from, currency, fx?.rates);
    if (value === null && minor && track) unconverted.set(from, (unconverted.get(from) || 0) + minor);
    return value || 0;
  };
  const sumInto = (map, key, value) => map.set(key, (map.get(key) || 0) + value);

  const categories = new Map();
  let total = 0;
  let count = 0;
  let missing = 0;
  for (const r of byCategory.results) {
    const value = convert(r.total_minor, r.currency, true);
    const entry = categories.get(r.category) || { category: r.category, total_minor: 0, count: 0 };
    entry.total_minor += value;
    entry.count += r.count;
    categories.set(r.category, entry);
    total += value;
    count += r.count;
    missing += r.missing || 0;
  }
  const days = new Map();
  for (const r of byDay.results) sumInto(days, r.date, convert(r.total_minor, r.currency, false));
  const cards = new Map();
  for (const r of byCard.results) {
    const entry = cards.get(r.card) || { card: r.card, total_minor: 0, count: 0 };
    entry.total_minor += convert(r.total_minor, r.currency, false);
    entry.count += r.count;
    cards.set(r.card, entry);
  }
  const monthTotals = new Map();
  for (const r of history.results) sumInto(monthTotals, r.month, convert(r.total_minor, r.currency, false));

  const pick = (rates) => rates && Object.fromEntries(DISPLAY_CURRENCIES.map((c) => [c, rates[c]]));
  return json({
    month,
    currency,
    total_minor: total,
    count,
    missing_amount_count: missing,
    budget_minor: settings.monthly_budget_minor === null
      ? null
      : convertMinor(settings.monthly_budget_minor, settings.budget_currency, currency, fx?.rates),
    budget_currency: settings.budget_currency,
    by_category: [...categories.values()].sort((a, b) => b.total_minor - a.total_minor),
    by_card: [...cards.values()].sort((a, b) => b.total_minor - a.total_minor),
    recent_cards: recentCards.results.map((r) => r.card),
    by_day: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, total_minor]) => ({ date, total_minor })),
    history: months.map((m) => ({ month: m, total_minor: monthTotals.get(m) || 0 })),
    unconverted: [...unconverted].map(([code, total_minor]) => ({ currency: code, total_minor })),
    fx: fx ? { rates: pick(fx.rates), as_of: fx.as_of, fetched_at: fx.fetched_at, source: fx.source, stale: fx.stale } : null,
  });
}
