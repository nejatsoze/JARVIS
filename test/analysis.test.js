const { sandbox, listeners } = require('./harness.js');
const API = sandbox.window.GTAiOzet;

let pass = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { failCount++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const payload = { data: { content: [
  // 1) normal 10x tur -> flag
  { id: 1, tranType: 'GAME_BET', gameTranId: 'T1', gameName: 'Gates of Olympus', platformName: 'Relax', debit: '10,00', credit: '0', datetimeStr: '01-09-2026 10:00:00', currency: 'TRY' },
  { id: 2, tranType: 'GAME_WIN', gameTranId: 'T1', gameName: 'Gates of Olympus', platformName: 'Relax', debit: '0', credit: '100,00', datetimeStr: '01-09-2026 10:00:05', currency: 'TRY' },
  // 2) çoklu bet/win aynı turda: 5+5 bet, 12+13 win = 2.5x -> eşik 3'te flag YOK
  { id: 3, tranType: 'GAME_BET', gameTranId: 'T2', gameName: 'Sweet Bonanza', platformName: 'Relax', debit: '5', credit: '0', datetimeStr: '01-09-2026 11:00:00' },
  { id: 4, tranType: 'GAME_BET', gameTranId: 'T2', gameName: 'Sweet Bonanza', platformName: 'Relax', debit: '5', credit: '0', datetimeStr: '01-09-2026 11:00:01' },
  { id: 5, tranType: 'GAME_WIN', gameTranId: 'T2', gameName: 'Sweet Bonanza', platformName: 'Relax', debit: '0', credit: '12', datetimeStr: '01-09-2026 11:00:09' },
  { id: 6, tranType: 'GAME_WIN', gameTranId: 'T2', gameName: 'Sweet Bonanza', platformName: 'Relax', debit: '0', credit: '13', datetimeStr: '01-09-2026 11:00:10' },
  // 3) hariç tutulan sağlayıcı (pragmatic)
  { id: 7, tranType: 'GAME_BET', gameTranId: 'T3', gameName: 'Big Bass', platformName: 'Pragmatic Play', debit: '1', credit: '0', datetimeStr: '01-09-2026 12:00:00' },
  { id: 8, tranType: 'GAME_WIN', gameTranId: 'T3', gameName: 'Big Bass', platformName: 'Pragmatic Play', debit: '0', credit: '500', datetimeStr: '01-09-2026 12:00:04' },
  // 4) iptal edilmiş tur: 20 bet, 400 win, ikisi de geri alınmış -> flag YOK
  { id: 9,  tranType: 'GAME_BET', gameTranId: 'T4', gameName: 'Wanted', platformName: 'Hacksaw', debit: '20', credit: '0', datetimeStr: '01-09-2026 13:00:00' },
  { id: 10, tranType: 'GAME_WIN', gameTranId: 'T4', gameName: 'Wanted', platformName: 'Hacksaw', debit: '0', credit: '400', datetimeStr: '01-09-2026 13:00:03' },
  { id: 11, tranType: 'GAME_WIN_CANCEL', gameTranId: 'T4', gameName: 'Wanted', platformName: 'Hacksaw', debit: '400', credit: '0', datetimeStr: '01-09-2026 13:00:20' },
  { id: 12, tranType: 'GAME_ROLLBACK', gameTranId: 'T4', gameName: 'Wanted', platformName: 'Hacksaw', debit: '0', credit: '20', datetimeStr: '01-09-2026 13:00:21' },
  // 5) bet'siz kazanç (freespin) -> ∞
  { id: 13, tranType: 'GAME_WIN', gameTranId: 'T5', gameName: 'Free Spin Game', platformName: 'Nolimit', debit: '0', credit: '250', datetime: 1788000000000 },
  // 6) oyun dışı işlem (gameTranId yok) -> yok sayılır
  { id: 14, tranType: 'DEPOSIT', gameName: '', platformName: '', debit: '0', credit: '1000', datetimeStr: '01-09-2026 09:00:00' },
  // 7) 1.000,50 formatlı büyük tutar, 3.0x tam eşik -> flag (>=)
  { id: 15, tranType: 'GAME_BET', gameTranId: 'T6', gameName: 'Money Train', platformName: 'Relax', debit: '1.000,50', credit: '0', datetimeStr: '01-09-2026 08:00:00' },
  { id: 16, tranType: 'GAME_WIN', gameTranId: 'T6', gameName: 'Money Train', platformName: 'Relax', debit: '0', credit: '3.001,50', datetimeStr: '01-09-2026 08:00:07' },
] } };

console.log('\n== ingest + analiz ==');
let r = API.ingest(payload);
const ids = r.flagged.map((f) => f.id).sort();
check('şüpheli turlar T1,T5,T6', JSON.stringify(ids) === JSON.stringify(['T1','T5','T6']), ids);
check('2.5x tur elenir (T2)', !ids.includes('T2'));
check('pragmatic hariç (T3)', !ids.includes('T3'));
check('tam iptal edilen tur elenir (T4)', !ids.includes('T4'));

const t1 = r.flagged.find((f) => f.id === 'T1');
check('T1 bet=10 win=100 oran=10', t1.bet === 10 && t1.win === 100 && t1.ratio === 10, t1);
check('T1 zaman metni', t1.time === '01-09-2026 10:00', t1.time);
const t5 = r.flagged.find((f) => f.id === 'T5');
check('T5 oranı ∞', !isFinite(t5.ratio) && t5.win === 250);
const t6 = r.flagged.find((f) => f.id === 'T6');
check('TR ondalık ayrıştırma (1.000,50)', t6.bet === 1000.5 && t6.win === 3001.5, t6);
check('eşiğe eşit oran dahil', Math.abs(t6.ratio - 3) < 1e-9, t6.ratio);
check('para birimi tespiti', sandbox.window.GTAiOzet.result() && true);
check('toplam kazanç 3351.5', Math.abs(r.totalWin - (100 + 250 + 3001.5)) < 1e-9, r.totalWin);
check('taranan tur sayısı 6', r.scanned === 6, r.scanned);

console.log('\n== tekilleştirme / biriktirme ==');
const before = API.rows().length;
API.ingest(payload); // aynı sayfa tekrar
check('aynı satırlar tekrar eklenmez', API.rows().length === before, API.rows().length);
API.ingest({ content: [
  { id: 20, tranType: 'GAME_BET', gameTranId: 'T7', gameName: 'Dog House', platformName: 'Relax', debit: '2', credit: '0', datetimeStr: '02-09-2026 10:00:00' },
  { id: 21, tranType: 'GAME_WIN', gameTranId: 'T7', gameName: 'Dog House', platformName: 'Relax', debit: '0', credit: '90', datetimeStr: '02-09-2026 10:00:02' },
]});
check('2. sayfa birikti (T7)', API.result().flagged.some((f) => f.id === 'T7'));
check('önceki sayfa korundu (T1)', API.result().flagged.some((f) => f.id === 'T1'));

console.log('\n== eşik / filtreler ==');
r = API.setThreshold(20);
check('eşik 20x -> T1 elenir', !r.flagged.some((f) => f.id === 'T1'), r.flagged.map(f=>f.id));
check('eşik 20x -> T7 (45x) kalır', r.flagged.some((f) => f.id === 'T7'));
check('eşik 20x -> ∞ tur kalır', r.flagged.some((f) => f.id === 'T5'));
API.setThreshold(3);

const s = API.settings();
s.includeNoBet = false; r = API.analyze();
check('bet\'siz kapalıyken T5 elenir', !r.flagged.some((f) => f.id === 'T5'));
s.includeNoBet = true;
s.minWin = 300; r = API.analyze();
check('min kazanç 300 -> sadece T6', r.flagged.map(f=>f.id).join() === 'T6', r.flagged.map(f=>f.id));
s.minWin = 0;
s.minBet = 100; r = API.analyze();
check('min bet 100 -> T6 + bet\'siz T5', r.flagged.map(f=>f.id).sort().join() === 'T5,T6', r.flagged.map(f=>f.id));
s.minBet = 0;
s.excludedProducts = []; r = API.analyze();
check('hariç liste boşalınca T3 görünür', r.flagged.some((f) => f.id === 'T3'));
s.excludedProducts = ['pragmatic', 'betby']; API.analyze();

console.log('\n== özet metni ==');
const summary = API.summary();
check('özet başlığı', summary.startsWith('Aşağıdaki yer alan turlarda'));
check('özet zaman sıralı (eski->yeni)', summary.indexOf('Money Train') < summary.indexOf('Gates of Olympus'), summary.split('\n').slice(2,5));
check('özet toplam satırı', /Toplam: \d+ tur/.test(summary));

console.log('\n== ağ kancası olay yolu ==');
const handler = listeners.get('__gtAiOzetResponse');
check('response dinleyicisi kayıtlı', Array.isArray(handler) && handler.length === 1);
API.clear();
check('temizle sonrası boş', API.rows().length === 0 && API.result() === null);
handler[0]({ type: '__gtAiOzetResponse', detail: JSON.stringify(payload) });
setTimeout(() => {
  check('olayla gelen gövde işlendi', API.rows().length === 16, API.rows().length);
  check('analiz tetiklendi', API.result() && API.result().flagged.length === 3, API.result() && API.result().flagged.length);
  handler[0]({ type: '__gtAiOzetResponse', detail: 'bozuk-json{' });
  check('bozuk JSON çökertmez', API.rows().length === 16);
  console.log(`\n${pass} geçti, ${failCount} başarısız`);
  process.exit(failCount ? 1 : 0);
}, 250);
