import {
  CATEGORIES,
  ValidationError,
  cleanText,
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

async function listTransactions(env, url) {
  const month = requireMonth(url);
  const { results } = await env.DB.prepare(
    `SELECT * FROM transactions WHERE local_date BETWEEN ?1 AND ?2
     ORDER BY occurred_at DESC, id DESC`,
  )
    .bind(`${month}-01`, `${month}-31`)
    .all();
  return json({ transactions: results });
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
       SET merchant = ?1, card = ?2, note = ?3, amount_minor = ?4, category = ?5, occurred_at = ?6, local_date = ?7
       WHERE id = ?8 RETURNING *`,
    ).bind(next.merchant, next.card, next.note, next.amount_minor, next.category, next.occurred_at, next.local_date, id),
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

async function getSettings(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'monthly_budget_minor'").first();
  return { monthly_budget_minor: row ? Number(row.value) : null, currency: env.CURRENCY, timezone: env.TIMEZONE };
}

async function putSettings(request, env) {
  const body = await readJson(request);
  if ('monthly_budget' in body) {
    const { minor } = parseAmount(body.monthly_budget);
    if (minor === null) {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'monthly_budget_minor'").run();
    } else {
      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES ('monthly_budget_minor', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
        .bind(String(minor))
        .run();
    }
  }
  return json(await getSettings(env));
}

async function summary(env, url) {
  const month = requireMonth(url);
  const from = `${month}-01`;
  const to = `${month}-31`;
  const months = previousMonths(month, HISTORY_MONTHS);

  const [totals, byCategory, byDay, others, history, settings] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS count,
              SUM(amount_minor IS NULL) AS missing_amount_count
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2 AND currency = ?3`,
    ).bind(from, to, env.CURRENCY).first(),
    env.DB.prepare(
      `SELECT category, COALESCE(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS count
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2 AND currency = ?3
       GROUP BY category ORDER BY total_minor DESC`,
    ).bind(from, to, env.CURRENCY).all(),
    env.DB.prepare(
      `SELECT local_date AS date, COALESCE(SUM(amount_minor), 0) AS total_minor
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2 AND currency = ?3
       GROUP BY local_date ORDER BY local_date`,
    ).bind(from, to, env.CURRENCY).all(),
    env.DB.prepare(
      `SELECT currency, COALESCE(SUM(amount_minor), 0) AS total_minor, COUNT(*) AS count
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2 AND currency != ?3
       GROUP BY currency`,
    ).bind(from, to, env.CURRENCY).all(),
    env.DB.prepare(
      `SELECT substr(local_date, 1, 7) AS month, COALESCE(SUM(amount_minor), 0) AS total_minor
       FROM transactions WHERE local_date BETWEEN ?1 AND ?2 AND currency = ?3
       GROUP BY month`,
    ).bind(`${months[0]}-01`, to, env.CURRENCY).all(),
    getSettings(env),
  ]);

  const historyByMonth = new Map(history.results.map((r) => [r.month, r.total_minor]));
  return json({
    month,
    currency: env.CURRENCY,
    total_minor: totals.total_minor,
    count: totals.count,
    missing_amount_count: totals.missing_amount_count || 0,
    budget_minor: settings.monthly_budget_minor,
    by_category: byCategory.results,
    by_day: byDay.results,
    history: months.map((m) => ({ month: m, total_minor: historyByMonth.get(m) || 0 })),
    other_currencies: others.results,
  });
}
