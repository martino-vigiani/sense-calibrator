// Harness DOM-stub per il ciclo di vita dell'app: esegue il VERO js/app.js in
// un contesto vm, con un DOM finto costruito dagli id di index.html, WebHID
// finto (DualSense virtuale di ops/sim) e un orologio virtuale che governa
// setTimeout, performance.now e requestAnimationFrame. Nessun browser, nessun
// controller fisico, nessuna attesa reale.
//
// Il sorgente di app.js è eseguito com'è; l'unica trasformazione riscrive gli
// `import` in letture da una tabella di moduli: js/ds5.js e js/calib/* sono i
// moduli reali, game/sensitivity/playtest/telemetry sono stub (non servono al
// ciclo di vita e toccherebbero un DOM vero).
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { VClock } from '../../ops/sim/vclock.mjs';
import { FakeDualSense } from '../../ops/sim/fake-dualsense.mjs';
import * as ds5Module from '../../js/ds5.js';
import * as measureModule from '../../js/calib/measure.js';
import * as samplingModule from '../../js/calib/sampling.js';
import * as quickModule from '../../js/calib/quick.js';
import * as quickPolicyModule from '../../js/calib/quick-policy.js';
import * as latticeModule from '../../js/calib/lattice.js';
import * as outcomeModule from '../../js/ui/outcome.js';
import * as handsOffModule from '../../js/ui/hands-off.js';
import * as connectHelpModule from '../../js/ui/connect-help.js';
import * as rangeProgressModule from '../../js/ui/range-progress.js';
import * as opsModule from '../../js/calib/ops.js';
import * as wizardGateModule from '../../js/calib/wizard-gate.js';
import * as rangeCoverageModule from '../../js/calib/range-coverage.js';
import * as rangeDiagnosticsModule from '../../js/calib/range-diagnostics.js';
import * as guardModule from '../../js/quick-center-guard.js';
import * as telemetryV2Module from '../../js/telemetry-v2.js';
import * as restNoiseModule from '../../js/calib/rest-noise.js';

const APP_SOURCE = fs.readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8');
const INDEX_HTML = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

/* ------------------------------ DOM finto ------------------------------ */

class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...names) { for (const n of names) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  toString() { return [...this.set].join(' '); }
}

const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const noop = () => {};
const canvasContext = new Proxy({}, { get: (target, key) => (key in target ? target[key] : noop), set: () => true });

class FakeElement {
  constructor(doc, tag = 'div', attrs = {}) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.width = 200;
    this.height = 200;
    this.subElements = new Map();
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }
  // Come il DOM: `hidden` riflette l'attributo (usato dal gate sperimentale).
  get hidden() { return this.attributes.has('hidden'); }
  set hidden(value) { if (value) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }
  get className() { return this.classList.toString(); }
  set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get id() { return this.attributes.get('id') ?? ''; }
  setAttribute(name, value = '') {
    value = String(value);
    this.attributes.set(name, value);
    if (name === 'class') this.className = value;
    else if (name === 'disabled') this.disabled = true;
    else if (name === 'width') this.width = Number(value);
    else if (name === 'height') this.height = Number(value);
    else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.attributes.has(name) : !!force;
    if (on) this.attributes.set(name, ''); else this.attributes.delete(name);
    return on;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter(f => f !== fn));
  }
  dispatch(type, event = {}) {
    return (this.listeners.get(type) ?? []).map(fn => fn({ type, target: this, preventDefault: noop, ...event }));
  }
  // Come nel browser: un bottone disabilitato non riceve il click.
  click() {
    if (this.disabled) return [];
    return this.dispatch('click');
  }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  select() {}
  appendChild(child) { child.parentNode = this; this.children.push(child); this.ownerDocument.onAppend?.(this, child); return child; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    this.parentNode = null;
  }
  getContext() { return canvasContext; }
  querySelector(selector) {
    if (!this.subElements.has(selector)) this.subElements.set(selector, new FakeElement(this.ownerDocument, 'div'));
    return this.subElements.get(selector);
  }
  querySelectorAll() { return []; }
}

// Selettori supportati: tag, .classe, [attr], [attr="valore"], combinati.
function matches(el, selector) {
  const re = /^([a-z0-9]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i;
  const m = selector.trim().match(re);
  if (!m) return false;
  const [, tag, classes, attrs] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const c of classes.split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
  for (const a of attrs.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (!el.hasAttribute(a[1])) return false;
    if (a[2] !== undefined && el.getAttribute(a[1]) !== a[2]) return false;
  }
  return true;
}

function parseIndex(doc) {
  const all = [];
  for (const tagMatch of INDEX_HTML.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const [, tag, rawAttrs] = tagMatch;
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    if (!attrs.id && !attrs.class && !['header', 'main', 'footer'].includes(tag.toLowerCase()) && !('data-tool' in attrs)) continue;
    const el = new FakeElement(doc, tag, attrs);
    all.push(el);
    if (attrs.id) doc.byId.set(attrs.id, el);
  }
  return all;
}

function makeDocument() {
  const doc = {
    byId: new Map(),
    activeElement: null,
    hidden: false,
    listeners: new Map(),
    appended: [],
  };
  doc.body = new FakeElement(doc, 'body');
  doc.all = parseIndex(doc);
  doc.activeElement = doc.body;
  doc.getElementById = id => {
    if (!doc.byId.has(id)) doc.byId.set(id, new FakeElement(doc, 'div', { id }));
    return doc.byId.get(id);
  };
  doc.querySelectorAll = selector => doc.all.filter(el => selector.split(',').some(s => matches(el, s)));
  doc.querySelector = selector => doc.querySelectorAll(selector)[0] ?? null;
  doc.createElement = tag => new FakeElement(doc, tag);
  doc.addEventListener = (type, fn) => {
    if (!doc.listeners.has(type)) doc.listeners.set(type, []);
    doc.listeners.get(type).push(fn);
  };
  doc.removeEventListener = noop;
  doc.execCommand = () => true;
  doc.onAppend = (parent, child) => { if (parent.id === 'toasts') doc.appended.push(child); };
  return doc;
}

/* ------------------------------ WebHID finto ------------------------------ */

export function makeDevice(clock, { seed = 7, drift = [[0.2, -0.3], [-0.1, 0.4]], noise = 0.05, sf = 0, faults = [], schedule = [], name, module = {} } = {}) {
  return new FakeDualSense({
    clock,
    seed,
    sticks: drift.map(d => ({ drift: d, noise, bias: { axis: 0, B: 0 } })),
    fw: { sf, cmdMs: [2, 6] },
    timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    hand: { schedule },
    faults,
    name,
    module,
  });
}

function makeHid() {
  const hid = {
    authorized: [],
    chooser: [],
    listeners: new Map(),
    async getDevices() { return [...hid.authorized]; },
    async requestDevice() { return [...hid.chooser]; },
    addEventListener(type, fn) {
      if (!hid.listeners.has(type)) hid.listeners.set(type, []);
      hid.listeners.get(type).push(fn);
    },
    fire(type, device) { for (const fn of hid.listeners.get(type) ?? []) fn({ type, device }); },
  };
  return hid;
}

/* ------------------------------ caricamento ------------------------------ */

const STUBS = {
  './game.js': { initGame: () => ({ open: noop, close: noop }) },
  './sensitivity.js': { initSensitivityFinder: () => ({ open: noop, close: noop }) },
  './playtest.js': { initPlaytest: () => ({ open: noop, close: noop, feedSample: noop }) },
};

function rewriteImports(source) {
  return source.replace(/import\s*\{([^}]*)\}\s*from\s*'([^']+)';/g, (_, names, spec) => {
    const bindings = names.split(',').map(n => n.trim()).filter(Boolean)
      .map(n => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2')).join(', ');
    return `const { ${bindings} } = __imports[${JSON.stringify(spec)}];`;
  });
}
const SCRIPT = new vm.Script(rewriteImports(APP_SOURCE), { filename: 'js/app.js (harness)' });

// Stato interno leggibile dai test: le dichiarazioni top-level di uno script
// vm stanno nello scope lessicale globale del contesto, visibile a script
// successivi nello stesso contesto.
const PEEK = new vm.Script(`({
  busy: ops.busy, epoch: ops.epoch, ds5, sticks, unsaved, deviceInfo, wizard, driftTest,
  quickPreflightBlocked, lastDriftResult, rangeSession, rangeCheck, rangeWriteLock: rangeLockFor(deviceKey), lastWizardComparison,
})`);

// `session`: una Map condivisa tra due loadApp simula un ricaricamento nella
// stessa scheda (sessionStorage sopravvive, localStorage anche).
export async function loadApp({ authorized = [], chooser = [], hidAvailable = true, search = '', hostname = 'sense.test', clock = new VClock(), storage = {}, telemetryNoticeSeen = true, session = new Map() } = {}) {
  const doc = makeDocument();
  const hid = makeHid();
  hid.authorized.push(...authorized);
  hid.chooser.push(...chooser);
  // "Avviso letto" vuol dire l'avviso attuale: v1 (notice) e v2 (scope).
  const store = new Map(Object.entries({
    ...(telemetryNoticeSeen ? { 'sense-telemetry-notice': '1', 'sense-telemetry-scope': '4' } : {}),
    ...storage,
  }));
  const uploads = [];
  // Eventi v2 che hanno raggiunto uploadEventV2 (builder e validatore reali,
  // solo fetch sostituito).
  const uploadsV2 = [];
  const consoleCalls = [];
  const raf = { paused: false, queue: [], pending: new Map() };
  const windowListeners = new Map();
  const h = {
    clock, doc, hid, store, uploads, uploadsV2, consoleCalls, raf,
    confirmAnswer: true,
    toasts: () => doc.appended.map(el => el.textContent),
  };
  const sandbox = {
    console: { ...console, info: (...args) => consoleCalls.push(['info', ...args]) },
    document: doc,
    navigator: hidAvailable ? { hid, clipboard: { writeText: async () => {} } } : { clipboard: { writeText: async () => {} } },
    location: { hostname, search, hash: '', href: `https://${hostname}/${search}`, protocol: 'https:' },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: key => { store.delete(key); },
    },
    sessionStorage: {
      getItem: key => (session.has(key) ? session.get(key) : null),
      setItem: (key, value) => { session.set(key, String(value)); },
      removeItem: key => { session.delete(key); },
    },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    // rAF a ~60 Hz sull'orologio virtuale; in una tab nascosta il browser lo
    // sospende, e l'harness lo imita accodando i callback finché non riappare.
    requestAnimationFrame: cb => {
      if (raf.paused) { raf.queue.push(cb); return 0; }
      const id = clock.setTimeout(() => { raf.pending.delete(id); cb(clock.now()); }, 16);
      raf.pending.set(id, cb);
      return id;
    },
    cancelAnimationFrame: id => { raf.pending.delete(id); clock.clearTimeout(id); },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    performance: { now: clock.now },
    crypto: webcrypto,
    TextEncoder,
    confirm: () => h.confirmAnswer,
    structuredClone,
    URLSearchParams,
    devicePixelRatio: 1,
    addEventListener: (type, fn) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    __imports: {
      './ds5.js': ds5Module,
      './telemetry.js': { uploadCalibrationEvent: async entry => { uploads.push(structuredClone(entry)); return true; } },
      './quick-center-guard.js': guardModule,
      './telemetry-v2.js': {
        ...telemetryV2Module,
        uploadEventV2: async event => {
          if (telemetryV2Module.validateEventV2(event) !== null) return false;
          uploadsV2.push(structuredClone(event));
          return true;
        },
      },
      './calib/rest-noise.js': restNoiseModule,
      './calib/measure.js': measureModule,
      './calib/sampling.js': samplingModule,
      './calib/quick.js': quickModule,
      './calib/quick-policy.js': quickPolicyModule,
      './calib/lattice.js': latticeModule,
      './ui/outcome.js': outcomeModule,
      './ui/hands-off.js': handsOffModule,
      './ui/connect-help.js': connectHelpModule,
      './ui/range-progress.js': rangeProgressModule,
      './calib/ops.js': opsModule,
      './calib/wizard-gate.js': wizardGateModule,
      './calib/range-coverage.js': rangeCoverageModule,
      './calib/range-diagnostics.js': rangeDiagnosticsModule,
      ...STUBS,
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  SCRIPT.runInContext(ctx);
  Object.assign(h, {
    ctx,
    window: sandbox,
    windowListeners,
    $: id => doc.getElementById(id),
    peek: () => PEEK.runInContext(ctx),
    // Valuta un'espressione nello scope di app.js (anche const/let top-level).
    eval: code => vm.runInContext(code, ctx),
    // Esegue il tempo virtuale finché `promise` non si risolve.
    run: promise => clock.run(Promise.resolve(promise), Infinity),
    advance: ms => clock.run(new Promise(r => clock.setTimeout(r, ms)), Infinity),
    // Click come nel browser (ignorato se disabilitato); ritorna le promise dei
    // gestori, così il test può attenderle con h.run(...).
    click: id => Promise.all(doc.getElementById(id).click()),
    visible: id => !doc.getElementById(id).classList.contains('hidden'),
    sessions: () => JSON.parse(store.get('sense-calib-sessions') ?? '[]'),
    // Callback rAF in attesa (o sospesi) che sono esattamente `fn`.
    pendingRaf: fn => [...raf.pending.values(), ...raf.queue].filter(cb => cb === fn).length,
    setHidden(hidden) {
      doc.hidden = hidden;
      raf.paused = hidden;
      if (!hidden) {
        const queued = raf.queue.splice(0);
        for (const cb of queued) sandbox.requestAnimationFrame(cb);
      }
      for (const fn of doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' });
    },
    keydown: (key, extra = {}) => { for (const fn of doc.listeners.get('keydown') ?? []) fn({ key, preventDefault: noop, ...extra }); },
  });
  // boot() è async e parte a fine script: lascia girare l'auto-connessione.
  await h.advance(0);
  return h;
}
