import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationError,
  guessCategory,
  localDate,
  merchantKey,
  parseAmount,
  parseOccurredAt,
  previousMonths,
  daysInMonth,
  convertMinor,
} from '../src/lib.js';

test('parseAmount: Kestirmeler biçimleri', () => {
  const cases = [
    ['₺1.234,56', 123456, 'TRY'],
    ['1.234,56 TL', 123456, 'TRY'],
    ['1,234.56 TRY', 123456, 'TRY'],
    ['45,5', 4550, null],
    ['45.50', 4550, null],
    ['120', 12000, null],
    ['1.234', 123400, null],
    ['1.234.567', 123456700, null],
    ['$12.99', 1299, 'USD'],
    ['€ 7,00', 700, 'EUR'],
    ['12.50 CHF', 1250, 'CHF'],
    [87.3, 8730, null],
  ];
  for (const [input, minor, currency] of cases) {
    assert.deepEqual(parseAmount(input), { minor, currency }, String(input));
  }
});

test('parseAmount: boş tutar null döner', () => {
  assert.deepEqual(parseAmount(''), { minor: null, currency: null });
  assert.deepEqual(parseAmount(undefined), { minor: null, currency: null });
  assert.deepEqual(parseAmount('₺'), { minor: null, currency: 'TRY' });
});

test('parseAmount: geçersiz girdiler reddedilir', () => {
  for (const input of ['-5', '(12,00)', -3, Number.NaN, {}, '1,2,3,45.678']) {
    assert.throws(() => parseAmount(input), ValidationError, String(input));
  }
});

test('merchantKey: şube numarası ve Türkçe harfler sadeleşir', () => {
  assert.equal(merchantKey('MIGROS 4521 KADIKÖY'), 'migros kadikoy');
  assert.equal(merchantKey('Şok Market İstanbul'), 'sok market istanbul');
  assert.equal(merchantKey('A101 ÜSKÜDAR'), 'a101 uskudar');
});

test('guessCategory: anahtar kelime ile tahmin', () => {
  assert.equal(guessCategory('MIGROS 4521 KADIKOY'), 'Market');
  assert.equal(guessCategory('A101 USKUDAR'), 'Market');
  assert.equal(guessCategory('STARBUCKS MODA'), 'Yeme-İçme');
  assert.equal(guessCategory("MCDONALDS BESIKTAS"), 'Yeme-İçme');
  assert.equal(guessCategory('SHELL PETROL'), 'Akaryakıt');
  assert.equal(guessCategory('MEDICAL PARK GOZTEPE'), 'Sağlık');
  assert.equal(guessCategory('BIMEKS ELEKTRONIK'), 'Diğer');
  assert.equal(guessCategory('BILINMEYEN DUKKAN'), 'Diğer');
});

test('localDate: İstanbul saatine göre gün', () => {
  // 21:30 UTC = 00:30 İstanbul, ertesi gün.
  assert.equal(localDate(new Date('2026-10-23T21:30:00Z'), 'Europe/Istanbul'), '2026-10-24');
  assert.equal(localDate(new Date('2026-10-23T20:30:00Z'), 'Europe/Istanbul'), '2026-10-23');
});

test('parseOccurredAt: ofsetli ISO, boş ve gelecek tarih', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  assert.equal(parseOccurredAt('2026-10-23T14:00:00+03:00', now).toISOString(), '2026-10-23T11:00:00.000Z');
  assert.equal(parseOccurredAt('', now), now);
  assert.throws(() => parseOccurredAt('dün', now), ValidationError);
  assert.throws(() => parseOccurredAt('2026-11-01T00:00:00Z', now), ValidationError);
});

test('ay yardımcıları', () => {
  assert.deepEqual(previousMonths('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(daysInMonth('2026-10'), 31);
});

test('parseAmount: Asya para birimleri', () => {
  assert.deepEqual(parseAmount('S$12.50'), { minor: 1250, currency: 'SGD' });
  assert.deepEqual(parseAmount('US$5'), { minor: 500, currency: 'USD' });
  assert.deepEqual(parseAmount('฿120.00'), { minor: 12000, currency: 'THB' });
  assert.deepEqual(parseAmount('¥1,200'), { minor: 120000, currency: 'JPY' });
  assert.deepEqual(parseAmount('Rp 50.000'), { minor: 5000000, currency: 'IDR' });
  assert.deepEqual(parseAmount('Rp50.000'), { minor: 5000000, currency: 'IDR' });
});

test('convertMinor: USD tabanlı kurlarla çevirme', () => {
  const rates = { USD: 1, TRY: 40, EUR: 0.8, JPY: 150 };
  assert.equal(convertMinor(4000, 'TRY', 'USD', rates), 100);
  assert.equal(convertMinor(100, 'USD', 'TRY', rates), 4000);
  assert.equal(convertMinor(800, 'EUR', 'JPY', rates), 150000);
  assert.equal(convertMinor(500, 'TRY', 'TRY', {}), 500);
  assert.equal(convertMinor(500, 'GBP', 'TRY', rates), null);
  assert.equal(convertMinor(null, 'TRY', 'USD', rates), null);
});

test('guessCategory: Asya zincirleri', () => {
  assert.equal(guessCategory('7-ELEVEN SUKHUMVIT'), 'Market');
  assert.equal(guessCategory('LAWSON SHIBUYA'), 'Market');
  assert.equal(guessCategory('GRAB SINGAPORE'), 'Ulaşım');
});
