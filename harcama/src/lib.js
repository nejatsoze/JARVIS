// Saf yardımcılar: Worker'dan bağımsız, node:test ile test edilir.

export const CATEGORIES = [
  'Market',
  'Yeme & İçme',
  'Ulaşım & Konaklama',
  'Akaryakıt',
  'Alışveriş',
  'Faturalar',
  'Sağlık',
  'Eğlence',
  'Diğer',
];

// Öğrenilmiş bir eşleşme yoksa ilk tahmin için anahtar kelimeler.
const KEYWORDS = [
  ['Market', ['migros', 'carrefour', 'a101', 'bim', 'sok market', 'macrocenter', 'file market', 'hakmar', 'getir', 'istegelsin', 'market', 'bakkal', 'manav', 'kasap', 'firin', 'eleven', 'lawson', 'familymart', 'family mart', 'fairprice', 'indomaret', 'alfamart', 'big c', 'lotus']],
  ['Yeme & İçme', ['starbucks', 'kahve', 'coffee', 'cafe', 'kafe', 'restoran', 'restaurant', 'burger', 'pizza', 'doner', 'kebap', 'lokanta', 'simit', 'yemeksepeti', 'trendyol yemek', 'mcdonald', 'kfc', 'popeyes', 'pastane', 'baklava']],
  ['Sağlık', ['eczane', 'pharmacy', 'hastane', 'hospital', 'klinik', 'acibadem', 'medical park', 'dis hekim', 'dis klinig']],
  ['Akaryakıt', ['shell', 'opet', 'bp', 'petrol ofisi', 'total', 'aytemiz', 'lukoil', 'akaryakit', 'petrol']],
  ['Ulaşım & Konaklama', ['istanbulkart', 'metro', 'iett', 'uber', 'bitaksi', 'taksi', 'taxi', 'otopark', 'thy', 'pegasus', 'ajet', 'hgs', 'ogs', 'marmaray', 'vapur', 'marti', 'grab', 'gojek', 'bolt', 'bts', 'mrt', 'suica', 'pasmo', 'otel', 'hotel', 'hostel', 'resort', 'airbnb', 'booking', 'agoda', 'expedia', 'marriott', 'hilton', 'radisson', 'ibis']],
  ['Faturalar', ['turkcell', 'vodafone', 'turk telekom', 'superonline', 'enerjisa', 'igdas', 'iski', 'elektrik', 'dogalgaz', 'su idaresi', 'netflix', 'spotify', 'youtube', 'apple.com', 'icloud', 'disney', 'exxen', 'blutv']],
  ['Eğlence', ['sinema', 'cinema', 'cinemaximum', 'biletix', 'passo', 'steam', 'playstation', 'xbox', 'konser', 'muze', 'bowling']],
  ['Alışveriş', ['trendyol', 'hepsiburada', 'amazon', 'zara', 'h&m', 'lc waikiki', 'koton', 'mavi', 'decathlon', 'teknosa', 'mediamarkt', 'vatan', 'ikea', 'boyner', 'ebebek', 'gratis', 'watsons', 'rossmann']],
];

// Sıra önemli: "S$" "$"dan önce denenmeli.
const CURRENCY_SYMBOLS = [
  [/₺|\bTL\b|\bTRY\b/i, 'TRY'],
  [/(?<!U)S\$|\bSGD\b/i, 'SGD'],
  [/\$|\bUSD\b/i, 'USD'],
  [/€|\bEUR\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/฿|\bTHB\b/i, 'THB'],
  [/¥|円|\bJPY\b/i, 'JPY'],
  [/\bRp\.?(?=\s|\d|$)|\bIDR\b/i, 'IDR'],
];

// Arayüzde seçilebilen gösterim para birimleri.
export const DISPLAY_CURRENCIES = ['TRY', 'USD', 'EUR', 'IDR', 'THB', 'JPY', 'SGD'];

/**
 * Kuruş cinsinden tutarı başka para birimine çevirir. `rates` aynı tabana (ör. USD=1) göre.
 * Kur yoksa null döner; çağıran bunu "çevrilemedi" olarak raporlar.
 */
export function convertMinor(minor, from, to, rates) {
  if (minor === null || minor === undefined) return null;
  if (from === to) return minor;
  const rf = rates?.[from];
  const rt = rates?.[to];
  if (!rf || !rt) return null;
  return Math.round((minor * rt) / rf);
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Kestirmeler'den gelen tutarı kuruşa çevirir.
 * "₺1.234,56", "1,234.56 TRY", "45,5", "120" veya sayı kabul eder.
 * Boş tutar (bazı bankalar göndermiyor) → minor: null.
 */
export function parseAmount(input) {
  if (input === null || input === undefined || input === '') return { minor: null, currency: null };
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new ValidationError('Tutar geçersiz');
    return { minor: Math.round(input * 100), currency: null };
  }
  if (typeof input !== 'string') throw new ValidationError('Tutar geçersiz');

  const text = input.trim();
  let currency = null;
  for (const [re, code] of CURRENCY_SYMBOLS) {
    if (re.test(text)) { currency = code; break; }
  }
  if (!currency) {
    const code = text.match(/\b([A-Z]{3})\b/);
    if (code) currency = code[1];
  }

  if (/-|\(.*\)/.test(text)) throw new ValidationError('Negatif tutar desteklenmiyor');
  let num = text.replace(/[^\d.,]/g, '');
  if (!num) return { minor: null, currency };

  const lastComma = num.lastIndexOf(',');
  const lastDot = num.lastIndexOf('.');
  let decimalSep = null;
  if (lastComma !== -1 && lastDot !== -1) {
    decimalSep = lastComma > lastDot ? ',' : '.';
  } else if (lastComma !== -1 || lastDot !== -1) {
    const sep = lastComma !== -1 ? ',' : '.';
    const occurrences = num.split(sep).length - 1;
    const digitsAfter = num.length - num.lastIndexOf(sep) - 1;
    // Tek ayraç ve ardından 1-2 hane → ondalık; 3 hane → binlik ("1.234").
    if (occurrences === 1 && digitsAfter > 0 && digitsAfter <= 2) decimalSep = sep;
  }

  let intPart = num;
  let fracPart = '';
  if (decimalSep) {
    const idx = num.lastIndexOf(decimalSep);
    intPart = num.slice(0, idx);
    fracPart = num.slice(idx + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d*$/.test(fracPart) || fracPart.length > 2) throw new ValidationError('Tutar geçersiz');
  if (!intPart && !fracPart) return { minor: null, currency };

  const minor = Number(intPart || '0') * 100 + Number(fracPart.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(minor)) throw new ValidationError('Tutar çok büyük');
  return { minor, currency };
}

/** Öğrenilmiş kategori eşleşmeleri için kararlı anahtar: "MIGROS 4521 KADIKÖY" → "migros kadikoy". */
export function merchantKey(merchant) {
  return String(merchant)
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9&.]+/g, ' ')
    .split(' ')
    .filter((t) => t && !/^[\d.]+$/.test(t))
    .join(' ');
}

export function guessCategory(merchant) {
  const key = ` ${merchantKey(merchant)} `;
  // Kısa kelimeler tam kelime eşleşmeli ("bim" ≠ "bimeks"), uzunlar önek yeter ("mcdonald" → "mcdonalds").
  const matches = (w) => (w.length >= 5 ? key.includes(` ${w}`) : key.includes(` ${w} `));
  for (const [category, words] of KEYWORDS) {
    if (words.some(matches)) return category;
  }
  return 'Diğer';
}

/** ISO tarihi (ofsetli ya da ofsetsiz) doğrular; yoksa şimdiki zamanı kullanır. */
export function parseOccurredAt(input, now = new Date()) {
  if (input === null || input === undefined || input === '') return now;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) throw new ValidationError('Tarih geçersiz');
  if (date.getTime() - now.getTime() > 24 * 3600 * 1000) throw new ValidationError('Tarih gelecekte olamaz');
  return date;
}

/** Verilen saat diliminde YYYY-MM-DD. */
export function localDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "2026-10" → bir önceki n ay dahil liste, eskiden yeniye. */
export function previousMonths(month, count) {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Metin alanlarını kırpar, uzunluk sınırı uygular. */
export function cleanText(value, field, max, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new ValidationError(`${field} gerekli`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} metin olmalı`);
  const text = value.trim();
  if (!text) {
    if (required) throw new ValidationError(`${field} gerekli`);
    return null;
  }
  if (text.length > max) throw new ValidationError(`${field} en fazla ${max} karakter olabilir`);
  return text;
}
