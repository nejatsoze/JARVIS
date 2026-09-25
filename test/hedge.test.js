const { load } = require('./harness.js');
const { sandbox } = load('betby-hedge-dedektor.user.js');
const API = sandbox.window.BBHedge;
const C = API.core;

let pass = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { failCount++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// getBetHistoryList cevabı biçiminde örnek veri
let seq = 0;
function bet(o) {
  seq++;
  const sel = Object.assign({ eventId: 'E1', event: 'Haiti - Trinidad and Tobago', marketId: '18', market: 'Total',
    outcomeId: '12', outcome: 'over 2.5', k: 1.9, sport: 'Soccer', tournament: 'Friendly', eventScheduled: '2026/09/25 20:00:00' }, o.sel);
  return Object.assign({ betId: 'B' + seq, playerId: 'P' + seq, extPlayerId: 'X' + seq, username: 'u' + seq, accepted: true,
    betType: 'Single', betStatus: 'open', betTimestamp: '2026/09/25 10:00:00', stake: 100, stakeCurrency: 4000, betCurrency: 'TRY',
    odd: sel.k, ip: '10.' + seq + '.0.1', brandName: 'Zumabet', selections: [sel] }, o, { selections: o.selections || [sel] });
}

console.log('\n== yardımcılar ==');
check('num: 1,288.60', C.num('1,288.60') === 1288.6);
check('num: 1.288,60', C.num('1.288,60') === 1288.6);
check('num: "2.5"', C.num('2.5') === 2.5);
check('parseTs: YYYY/MM/DD UTC', C.parseTs('2026/09/25 06:04:15') === Date.UTC(2026, 8, 25, 6, 4, 15));
check('parseTs: ISO Z', C.parseTs('2026-09-25T06:04:15.000Z') === Date.UTC(2026, 8, 25, 6, 4, 15));
check('parseTs: +03:00', C.parseTs('2026-09-25T09:04:15+03:00') === Date.UTC(2026, 8, 25, 6, 4, 15));
check('parseTs: epoch sn', C.parseTs(1790000000) === 1790000000000);

console.log('\n== imza ==');
const sig = (outcome, market = 'Total') => C.signature(C.normalizeBet(bet({ sel: { outcome, market } })).selections[0], C.DEFAULTS);
check('over 2.5 → total/over/2.5', (() => { const s = sig('over 2.5'); return s.kind === 'total' && s.side === 'over' && s.line === 2.5; })());
check('under 151.5 → under', sig('under 151.5', 'Total (incl. overtime)').side === 'under');
check('handikap mutlak çizgi', sig('Haiti (-1.5)', 'Handicap').key === sig('Trinidad (+1.5)', 'Handicap').key);
check('correct score yok sayılır', sig('2:1', 'Correct score') === null);
check('onlyTotals 1x2\'yi eler', C.signature(C.normalizeBet(bet({ sel: { outcome: 'Haiti', market: '1x2', marketId: '1', outcomeId: '1' } })).selections[0],
  Object.assign({}, C.DEFAULTS, { onlyTotals: true })) === null);

console.log('\n== analiz ==');
const data = { data: { data: { total: 9, items: [
  // Senaryo 1: aynı maç, aynı çizgi, aynı IP, 40 sn arayla, dengeli ödeme → yüksek skor
  bet({ ip: '1.2.3.4', betTimestamp: '2026/09/25 10:00:00', stake: 100, sel: { outcome: 'over 2.5', outcomeId: '12', k: 1.9 } }),
  bet({ ip: '1.2.3.4', betTimestamp: '2026/09/25 10:00:40', stake: 95, sel: { outcome: 'under 2.5', outcomeId: '13', k: 2.0 } }),
  // Senaryo 2: bağımsız görünen oyuncular, saatler arayla, farklı IP → düşük skor
  bet({ eventId: 'E2', betTimestamp: '2026/09/25 08:00:00', stake: 10, sel: { eventId: 'E2', event: 'Indonesia - Iraq', outcome: 'over 3.5', k: 1.5 } }),
  bet({ eventId: 'E2', betTimestamp: '2026/09/25 12:00:00', stake: 300, sel: { eventId: 'E2', event: 'Indonesia - Iraq', outcome: 'under 3.5', outcomeId: '13', k: 2.5 } }),
  // Senaryo 3: aynı oyuncu iki tarafı oynarsa hesaplar arası değil → yok
  bet({ playerId: 'SAME', sel: { eventId: 'E3', outcome: 'over 1.5' } }),
  bet({ playerId: 'SAME', sel: { eventId: 'E3', outcome: 'under 1.5', outcomeId: '13' } }),
  // Senaryo 4: çizgi farkı 2 gol → tolerans dışı
  bet({ sel: { eventId: 'E4', outcome: 'over 1.5' } }),
  bet({ sel: { eventId: 'E4', outcome: 'under 3.5', outcomeId: '13' } }),
  // Senaryo 5: reddedilmiş bahis sayılmaz
  bet({ accepted: false, sel: { eventId: 'E5', outcome: 'over 2.5' } }),
] } } };
const extra = [
  bet({ sel: { eventId: 'E5', outcome: 'under 2.5', outcomeId: '13' } }),
  // Senaryo 6: kombine ayağı varsayılan olarak dışarıda
  bet({ betType: 'Combo', selections: [
    { eventId: 'E1', event: 'Haiti - Trinidad and Tobago', marketId: '18', market: 'Total', outcomeId: '13', outcome: 'under 2.5', k: 2 },
    { eventId: 'E9', event: 'X - Y', marketId: '1', market: '1x2', outcomeId: '1', outcome: 'X', k: 2 },
  ] }),
];

let r = API.ingest(data);
check('9 bahis alındı', r.total === 9 && r.added === 9, r);
API.ingest(extra);
const groups = API.allGroups();
const g1 = groups.find((g) => g.eventId === 'E1');
check('E1 bulundu', !!g1);
check('E1 skoru 100 (aynı IP + 40 sn + denge + tam ters)', g1 && g1.score === 100, g1 && g1.score);
check('E1 ilişki tam ters', g1 && g1.pairs[0].relation === 'tam ters');
check('E1 kombine ayak varsayılan dışarıda', g1 && g1.legs.length === 2, g1 && g1.legs.length);
const g2 = groups.find((g) => g.eventId === 'E2');
check('E2 düşük skor (40)', g2 && g2.score === 40, g2 && g2.score);
check('E2 varsayılan eşik 50 altında listelenmez', !API.groups().some((g) => g.eventId === 'E2'));
check('E3 aynı oyuncu → yok', !groups.some((g) => g.eventId === 'E3'));
check('E4 çizgi farkı 2 → yok', !groups.some((g) => g.eventId === 'E4'));
check('E5 reddedilen bahis → yok', !groups.some((g) => g.eventId === 'E5'));
check('sıralama: en yüksek skor ilk', groups[0].eventId === 'E1');

API.set('includeCombos', true);
const g1c = API.allGroups().find((g) => g.eventId === 'E1');
check('kombineler açılınca E1 ayak sayısı 3', g1c && g1c.legs.length === 3, g1c && g1c.legs.length);
check('kombine eşleşmesi işaretli ve düşürülmüş', g1c.pairs.some((p) => p.flags.includes('kombine') && p.score < 100));
API.set('includeCombos', false);

console.log('\n== tekrar eden hesap çifti ==');
API.clear();
const pairBets = [];
for (let i = 0; i < 3; i++) {
  pairBets.push(bet({ playerId: 'A', username: 'alice', ip: '5.5.5.' + (i + 1), betTimestamp: `2026/09/25 1${i}:00:00`, stake: 50,
    sel: { eventId: 'R' + i, event: 'Maç ' + i, outcome: 'over 2.5', k: 2 } }));
  pairBets.push(bet({ playerId: 'B', username: 'bob', ip: '9.9.9.' + (i + 1), betTimestamp: `2026/09/25 1${i}:03:00`, stake: 50,
    sel: { eventId: 'R' + i, event: 'Maç ' + i, outcome: 'under 2.5', outcomeId: '13', k: 2 } }));
}
API.ingest(pairBets);
const pr = API.pairs().find((p) => p.pk === 'A~B');
check('A~B çifti 3 maçta', pr && pr.events.size === 3, pr && pr.events.size);
check('tekrar bonusu: 40+15+15 = 70 → +30 = 100', pr && pr.best === 100, pr && pr.best);
check('toplam stake 300 EUR', pr && pr.stakeEur === 300, pr && pr.stakeEur);

console.log('\n== REST (snake_case, düz satır) ==');
API.clear();
API.ingest({ data: [
  { bet_id: 'S1', player_id: 'Q1', ext_player_id: '111', bet_timestamp: '2026-09-25 10:00:00', stake: '20.00', odd: '1.80', ip: '7.7.7.7',
    event_id: 'Z1', event_name: 'A - B', market_id: '18', market_name: 'Total', outcome_id: '12', outcome_name: 'over 2.5', accepted: 'Yes' },
  { bet_id: 'S2', player_id: 'Q2', ext_player_id: '222', bet_timestamp: '2026-09-25 10:00:30', stake: '22.00', odd: '1.95', ip: '7.7.7.7',
    event_id: 'Z1', event_name: 'A - B', market_id: '18', market_name: 'Total', outcome_id: '13', outcome_name: 'under 2.5', accepted: 'Yes' },
] });
const z = API.allGroups().find((g) => g.eventId === 'Z1');
check('düz snake_case satırlar da eşleşir', z && z.score === 100, z && z.score);

console.log('\n== filtre gövdesi ==');
const f = C.buildFilters(Date.UTC(2026, 8, 1), 400);
check('rBetDate ISO', f.rBetDate.rangeFrom === '2026-09-01T00:00:00.000Z');
check('offset/limit', f.offset === 400 && f.limit === C.DEFAULTS.pageSize);
check('yalnız kabul edilen, test oyuncuları hariç', f.acceptedBets[0] === 'Yes' && f.testPlayers === 'exclude');

console.log('\n== sayfalama toplamı ==');
check('GraphQL total', C.findTotal({ data: { data: { items: [], total: 520 } } }) === 520);
check('REST total_count', C.findTotal({ total_count: '1234', data: [] }) === 1234);
check('toplam yoksa NaN', Number.isNaN(C.findTotal({ data: { data: { items: [] } } })));

console.log('\n== GT bağlantısı ==');
check('GT profil adresi', C.gtUrl('13667023') === 'https://core-secundus.gmntc.com/core/app/core/players/13667023/detail');
check('sayısal olmayan id → null', C.gtUrl('abc') === null && C.gtUrl('') === null);

console.log('\n== CSV ==');
const rows = API.csvRows();
check('CSV başlık + 1 satır', rows.length === 2, rows.length);

console.log(`\n${pass} geçti, ${failCount} başarısız`);
process.exit(failCount ? 1 : 0);
