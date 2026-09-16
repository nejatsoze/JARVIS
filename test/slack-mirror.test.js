const H = require('./slack-harness.js');
const API = H.sandbox.window.SlackMirror;

let pass = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { failCount++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const SRC = 'C08TKRJQ96G';
const DST = 'C0BMBT1A6KX';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const posts = () => H.calls.filter((c) => c.method === 'chat.postMessage');
const lastPost = () => posts()[posts().length - 1];
const called = (method) => H.calls.some((c) => c.method === method);

API.config.POST_INTERVAL_MS = 0;   // testte kuyruk beklemesin

(async function run() {
  await tick(60);   // start(): token çözümü + kanal doğrulama + ilk yoklama

  console.log('\n== saf yardımcılar ==');
  const _ = API._;
  check('@channel düz metne iner (yalnız açıklamalı kipte kullanılır)',
    _.neutralizeBroadcasts('selam <!channel> ve <!here>') === 'selam @channel ve @here');
  check('grup çağrısı etiketine iner',
    _.neutralizeBroadcasts('<!subteam^S123|@destek> bakar mısın') === '@destek bakar mısın');
  check('mention id çıkarımı tekil',
    JSON.stringify(_.mentionIds('<@U1> <@U2> <@U1>')) === JSON.stringify(['U1', 'U2']));
  check('mention düz metne çevrilir',
    _.plainMentions('<@U1> bak', { U1: 'ada' }) === '@ada bak');
  check('dosya bağlantısı ham url',
    _.fileLinks({ files: [{ permalink: 'https://x/a.png' }, { permalink: 'https://x/b.png' }] })
      === 'https://x/a.png\nhttps://x/b.png');
  check('boş mesaj aynalanmaz', !_.isMirrorable({ ts: '1.0', text: '   ' }));
  check('dosyalı mesaj aynalanır', _.isMirrorable({ ts: '1.0', files: [{ name: 'a.png' }] }));
  check('katılma mesajı elenir', !_.isMirrorable({ ts: '1.0', text: 'katıldı', subtype: 'channel_join' }));
  check('ts sayısal karşılaştırılır', _.tsGreater('1712345678.000200', '1712345678.000100'));

  console.log('\n== token seçimi ==');
  const infoCalls = H.calls.filter((c) => c.method === 'conversations.info');
  check('kaynak kanalı göremeyen token elendi',
    infoCalls[0].params.token === 'xoxc-yanlis-takim' && infoCalls[0].params.channel === SRC, infoCalls[0].params);
  check('kanalı gören token seçildi',
    infoCalls.some((c) => c.params.token === 'xoxc-dogru-takim' && c.params.channel === SRC));
  check('durum: dinleniyor', API.status().status === 'dinleniyor', API.status());

  console.log('\n== birebir kopya (varsayılan) ==');
  const RAW = 'merhaba <!channel> <@U5> *kalın* `kod` :tada: <https://ornek.com|bağlantı>';
  const BLOCKS = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'merhaba' }] }] }];
  H.emit({ type: 'message', channel: SRC, user: 'U9', text: RAW, ts: '1000.000100', blocks: BLOCKS });
  await tick(80);
  check('hedef kanala gönderildi', lastPost().params.channel === DST, lastPost().params);
  check('metin BİREBİR — ekleme/çıkarma yok', lastPost().params.text === RAW, lastPost().params.text);
  check('yazar satırı eklenmedi', !/^\*/.test(lastPost().params.text));
  check('bloklar birebir taşındı', lastPost().params.blocks === JSON.stringify(BLOCKS), lastPost().params.blocks);
  check('kalıcı bağlantı istenmedi (alıntı kutusu oluşmaz)', !called('chat.getPermalink'));
  check('kullanıcı adı çözümlenmedi (gereksiz istek yok)', !called('users.info'));
  check('sayaç arttı', API.state.count === 1, API.state.count);
  check('gönderim seçilen token ile yapıldı', lastPost().params.token === 'xoxc-dogru-takim');

  console.log('\n== tekilleştirme ==');
  const before = posts().length;
  H.emit({ type: 'message', channel: SRC, user: 'U9', text: 'merhaba', ts: '1000.000100' });
  await tick(60);
  check('aynı ts ikinci kez gönderilmez', posts().length === before, posts().length);

  console.log('\n== başka kanal / sistem mesajı ==');
  H.emit({ type: 'message', channel: 'CZZZZZZZZ', user: 'U9', text: 'x', ts: '1001.000200' });
  H.emit({ type: 'message', channel: SRC, user: 'U9', subtype: 'channel_join', text: 'katıldı', ts: '1001.000300' });
  H.emit({ type: 'message', channel: SRC, user: 'U9', text: '', ts: '1001.000400' });
  await tick(60);
  check('yabancı kanal ve sistem mesajı aktarılmaz', posts().length === before, posts().length);

  console.log('\n== thread cevabı ==');
  const parentDst = API.state.map['1000.000100'];
  H.emit({ type: 'message', channel: SRC, user: 'U7', text: 'cevap', ts: '1002.000100', thread_ts: '1000.000100' });
  await tick(80);
  check('cevap üst mesajın thread\'ine düştü', lastPost().params.thread_ts === parentDst, lastPost().params);
  check('cevap metni birebir', lastPost().params.text === 'cevap', lastPost().params.text);

  console.log('\n== aynalanmamış üst mesajın cevabı ==');
  H.historyQueue.push({ ok: true, messages: [{ ts: '1003.000100', user: 'U3', text: 'eski üst mesaj' }] });
  H.emit({ type: 'message', channel: SRC, user: 'U4', text: 'geç cevap', ts: '1003.000900', thread_ts: '1003.000100' });
  await tick(120);
  const son2 = posts().slice(-2);
  check('önce üst mesaj aktarıldı', son2[0].params.text === 'eski üst mesaj', son2[0].params.text);
  check('sonra cevap aynı thread\'e düştü',
    son2[1].params.thread_ts === API.state.map['1003.000100'] && son2[1].params.text === 'geç cevap', son2[1].params);

  console.log('\n== dosya eki ==');
  H.emit({ type: 'message', channel: SRC, user: 'U9', text: 'bak', ts: '1004.000100',
    files: [{ name: 'rapor.pdf', permalink: 'https://t.slack.com/files/rapor.pdf' }] });
  await tick(80);
  check('dosya bağlantısı ham hâliyle eklendi',
    lastPost().params.text === 'bak\nhttps://t.slack.com/files/rapor.pdf', lastPost().params.text);

  H.emit({ type: 'message', channel: SRC, user: 'U9', text: 'blok + dosya', ts: '1004.000200',
    blocks: BLOCKS, files: [{ name: 'a.png', permalink: 'https://t.slack.com/files/a.png' }] });
  await tick(80);
  const withFile = JSON.parse(lastPost().params.blocks);
  check('bloklu mesajda dosya bağlantısı blok olarak eklendi',
    withFile.length === BLOCKS.length + 1 &&
    withFile[withFile.length - 1].text.text === 'https://t.slack.com/files/a.png', withFile);

  console.log('\n== düzenleme ve silme ==');
  H.emit({ type: 'message', channel: SRC, subtype: 'message_changed',
    message: { ts: '1000.000100', user: 'U9', text: 'düzeltilmiş <@U5>' }, ts: '1005.000100' });
  await tick(80);
  const upd = H.calls.filter((c) => c.method === 'chat.update').pop();
  check('düzenleme hedefte birebir güncellendi',
    upd && upd.params.channel === DST && upd.params.ts === parentDst && upd.params.text === 'düzeltilmiş <@U5>',
    upd && upd.params);

  H.emit({ type: 'message', channel: SRC, subtype: 'message_deleted', deleted_ts: '1004.000100', ts: '1005.000200' });
  await tick(80);
  const del = H.calls.filter((c) => c.method === 'chat.delete').pop();
  check('silme hedefte uygulandı', del && del.params.channel === DST, del && del.params);
  check('silinen eşleşme unutuldu', !API.state.map['1004.000100']);

  console.log('\n== yoklama yedeği (WebSocket kaçırırsa) ==');
  H.historyQueue.push({ ok: true, messages: [
    { ts: '2000.000200', user: 'U1', text: 'ikinci', reply_count: 1, latest_reply: '2000.000300' },
    { ts: '2000.000100', user: 'U1', text: 'birinci' },
  ] });
  H.repliesQueue.push({ ok: true, messages: [
    { ts: '2000.000200', user: 'U1', text: 'ikinci' },
    { ts: '2000.000300', user: 'U2', text: 'thread cevabı', thread_ts: '2000.000200' },
  ] });
  await API.poll();
  await tick(150);
  const metinler = posts().slice(-3).map((c) => c.params.text);
  check('yoklama eskiden yeniye aktardı',
    metinler[0] === 'birinci' && metinler[1] === 'ikinci', metinler);
  check('yoklama thread cevabını da aldı', metinler[2] === 'thread cevabı', metinler);

  console.log('\n== yazar taklidi: desteklenmiyorsa kendiliğinden geri düşer ==');
  API.config.IMPERSONATE_AUTHOR = true;
  const beforeImp = posts().length;
  H.emit({ type: 'message', channel: SRC, user: 'U9', text: 'taklit denemesi', ts: '4000.000100' });
  await tick(150);
  const imp = posts().slice(beforeImp);
  check('önce yazar adıyla denendi', imp[0].params.username === 'kullanici-U9', imp[0] && imp[0].params);
  check('reddedilince taklitsiz yeniden gönderildi',
    imp.length === 2 && imp[1].params.username === undefined && imp[1].params.text === 'taklit denemesi', imp.map((c) => c.params));
  check('taklit kapatıldı', API.config.IMPERSONATE_AUTHOR === false);
  check('mesaj yine de aynalandı', Boolean(API.state.map['4000.000100']));

  console.log('\n== açıklamalı kip (EXACT_COPY: false) ==');
  API.config.EXACT_COPY = false;
  H.emit({ type: 'message', channel: SRC, user: 'U9', text: 'selam <!channel> <@U5>', ts: '5000.000100' });
  await tick(200);
  const ann = lastPost().params.text;
  check('yazar satırı eklendi', /^\*kullanici-U9\*/.test(ann), ann);
  check('kalıcı bağlantı eklendi', /archives\/C08TKRJQ96G\/p5000000100/.test(ann), ann);
  check('@channel ping\'i etkisizleştirildi', ann.includes('@channel') && !ann.includes('<!channel>'), ann);
  check('mention düz metne çevrildi', ann.includes('@kullanici-U5') && !ann.includes('<@U5>'), ann);
  API.config.EXACT_COPY = true;

  console.log('\n== duraklatma ==');
  API.pause();
  const beforePause = posts().length;
  H.emit({ type: 'message', channel: SRC, user: 'U9', text: 'duraklatıldı', ts: '6000.000100' });
  await tick(60);
  check('duraklatınca gönderilmez', posts().length === beforePause);
  API.resume();
  H.emit({ type: 'message', channel: SRC, user: 'U9', text: 'devam', ts: '6000.000200' });
  await tick(100);
  check('devam edince gönderilir', lastPost().params.text === 'devam', lastPost().params.text);

  console.log('\n== bozuk çerçeve ==');
  const beforeBad = posts().length;
  H.emit('bozuk-json{ C08TKRJQ96G');
  await tick(40);
  check('bozuk JSON çökertmez', posts().length === beforeBad);

  console.log(`\n${pass} geçti, ${failCount} başarısız`);
  process.exit(failCount ? 1 : 0);
})();
