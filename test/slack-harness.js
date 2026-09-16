const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Slack aynalama userscript'ini tarayıcısız çalıştırmak için asgari taklit:
// localStorage (token), fetch (Slack API), WebSocket (canlı olaylar), DOM (rozet).

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, id: '',
    children: [], textContent: '', title: '',
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this._on || (this._on = {}))[type] = fn; },
    remove() {},
  };
}

const document = {
  readyState: 'complete',
  documentElement: makeEl('html'),
  head: makeEl('head'),
  body: makeEl('body'),
  createElement: makeEl,
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
};

const storage = new Map([
  ['localConfig_v2', JSON.stringify({
    // aktif takım kaynak kanalı GÖREMEYEN takım: token elemesi sınansın
    lastActiveTeamId: 'T000',
    teams: {
      T000: { id: 'T000', token: 'xoxc-yanlis-takim' },
      T111: { id: 'T111', token: 'xoxc-dogru-takim' },
    },
  })],
]);

// --- Slack API taklidi -------------------------------------------------
const calls = [];                  // { method, params }
const historyQueue = [];           // sıradaki conversations.history cevapları
const repliesQueue = [];           // sıradaki conversations.replies cevapları
let postSeq = 0;

function respond(method, params) {
  switch (method) {
    case 'conversations.info':
      // yalnız "doğru takım" token'ı kaynak kanalı görebilsin
      if (params.token !== 'xoxc-dogru-takim') return { ok: false, error: 'channel_not_found' };
      return { ok: true, channel: { id: params.channel, name: params.channel === 'C08TKRJQ96G' ? 'kaynak' : 'hedef' } };
    case 'users.info':
      return { ok: true, user: { profile: { display_name: 'kullanici-' + params.user } } };
    case 'chat.getPermalink':
      return { ok: true, permalink: `https://t.slack.com/archives/${params.channel}/p${String(params.message_ts).replace('.', '')}` };
    case 'chat.postMessage':
      return { ok: true, ts: `900${++postSeq}.000000` };
    case 'chat.update':
    case 'chat.delete':
      return { ok: true };
    case 'conversations.history':
      return historyQueue.length ? historyQueue.shift() : { ok: true, messages: [] };
    case 'conversations.replies':
      return repliesQueue.length ? repliesQueue.shift() : { ok: true, messages: [] };
    default:
      return { ok: false, error: 'unknown_method' };
  }
}

class FormDataStub {
  constructor() { this._e = {}; }
  append(k, v) { this._e[k] = v; }
  get(k) { return this._e[k]; }
  entries() { return Object.entries(this._e); }
}

function fetchStub(url, init) {
  const method = String(url).split('/api/')[1];
  const params = {};
  for (const [k, v] of (init.body.entries ? init.body.entries() : [])) params[k] = v;
  const body = respond(method, params);
  calls.push({ method, params });
  return Promise.resolve({
    status: body.ok ? 200 : 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  });
}

// --- WebSocket taklidi -------------------------------------------------
const sockets = [];
class WebSocketStub {
  constructor(url) { this.url = url; this._on = []; sockets.push(this); }
  addEventListener(type, fn) { if (type === 'message') this._on.push(fn); }
  send() {}
  close() {}
}

const sandbox = {
  console,
  document,
  location: { origin: 'https://app.slack.com', hostname: 'app.slack.com' },
  fetch: fetchStub,
  FormData: FormDataStub,
  WebSocket: WebSocketStub,
  Proxy, Reflect, TextDecoder,
  Blob: class { constructor(p) { this.parts = p; } },
  JSON, Math, Date, Number, String, Array, Object, Map, Set, Promise, RegExp, Error,
  isFinite, parseInt, parseFloat,
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: {
    get length() { return storage.size; },
    key: (i) => [...storage.keys()][i],
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'slack-kanal-aynala.user.js'), 'utf8'),
  sandbox,
  { filename: 'slack-kanal-aynala.user.js' }
);

/** Kancalanmış WebSocket üzerinden Slack olayı yollar. */
function emit(event) {
  const ws = new sandbox.window.WebSocket('wss://wss-primary.slack.com/');
  ws._on.forEach((fn) => fn({ data: typeof event === 'string' ? event : JSON.stringify(event) }));
}

module.exports = { sandbox, calls, historyQueue, repliesQueue, sockets, emit, storage };
