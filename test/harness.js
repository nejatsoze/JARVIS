const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Userscript'i tarayıcısız çalıştırmak için asgari DOM/window taklidi.
// Amaç analiz çekirdeğini (ayrıştırma, gruplama, filtreleme) doğrulamak; arayüz
// panel açılmadığı sürece tembel olduğu için stub'lar yeterlidir.

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, className: '', id: '',
    children: [], textContent: '', innerHTML: '', hidden: false, value: '',
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    appendChild(c){ this.children.push(c); return c; },
    removeChild(c){ return c; },
    remove(){}, setAttribute(){}, addEventListener(){}, removeEventListener(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    closest(){ return null; }, focus(){}, getBoundingClientRect(){ return {left:0,top:0,width:640,height:560}; },
    offsetWidth: 640, offsetHeight: 560, isConnected: true, cloneNode(){ return makeEl(tag); },
  };
  return el;
}

// Her çağrı temiz bir sandbox'ta verilen userscript'i çalıştırır.
function load(file) {
  const listeners = new Map();
  const document = {
    readyState: 'loading',
    documentElement: makeEl('html'),
    head: makeEl('head'),
    body: null,
    createElement: makeEl,
    createDocumentFragment: () => makeEl('fragment'),
    addEventListener(){}, removeEventListener(){},
    querySelectorAll(){ return []; }, querySelector(){ return null; },
    getElementById(){ return null; },
  };

  const storage = new Map();
  const sandbox = {
    console,
    document,
    performance: { now: () => Date.now() },
    navigator: { clipboard: null },
    Intl, JSON, Math, Date, Number, String, Array, Object, Map, Set, Promise, RegExp, Error, isFinite, parseInt, parseFloat,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    MutationObserver: class { observe(){} disconnect(){} },
    IntersectionObserver: class { observe(){} disconnect(){} },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    CustomEvent: class { constructor(type, init){ this.type = type; this.detail = init && init.detail; } },
    Blob: class { constructor(parts){ this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  sandbox.window.dispatchEvent = (ev) => {
    (listeners.get(ev.type) || []).forEach((fn) => fn(ev));
    return true;
  };
  sandbox.window.innerWidth = 1440;
  sandbox.window.innerHeight = 900;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
  return { sandbox, listeners, storage };
}

module.exports = Object.assign(load('gamingtec-ai-ozet.user.js'), { load });
