/**
 * Framework-agnostic playground shell logic: worker RPC, service-worker
 * bridge, demo selection, boot sequence, export/reset. UI state is
 * published through the Svelte stores in stores.js.
 *
 * Demo selection (see src/demo.mjs): `?demo=<id|name|url>` wins, then the
 * last choice stored in localStorage, then the index default.
 */
import { initialShopwarePath } from '../app-route.mjs';
import {
  DEMO_QUERY_PARAM,
  DEMOS_INDEX_PATH,
  absoluteUrl,
  parseDemoRef,
  resolveDemo,
  storageKeyFor,
} from '../demo.mjs';
import { idbBelongsToDemo, idbNamesForDemo } from '../idb-names.mjs';
import { status, ready, booted, demos, activeDemo } from './stores.js';

const STORED_DEMO_KEY = 'sw-playground-demo';

let worker;
let currentDemo = null;
let knownIndexIds = [];
let frameEl;

export function setFrame(el) {
  frameEl = el;
}

export function getFrame() {
  return frameEl;
}

export function setStatus(msg) {
  status.set(msg);
}

export function send(payload, transfer = []) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    function onMessage(event) {
      const data = event.data || {};
      if (data.id !== id) return;
      if (data.type === 'status') {
        setStatus(data.text);
        return;
      }
      worker.removeEventListener('message', onMessage);
      if (data.type === 'error') {
        reject(new Error(data.error || 'worker error'));
        return;
      }
      resolve(data);
    }
    worker.addEventListener('message', onMessage);
    worker.postMessage({ ...payload, id }, transfer);
  });
}

function phpRequest(req) {
  if (!worker) throw new Error('playground worker not started');
  const transfer = [];
  if (req.body && req.body instanceof ArrayBuffer) {
    transfer.push(req.body);
  }
  return send({ type: 'request', req }, transfer);
}

function resultToPort(res) {
  const body = res.body || null;
  const payload = {
    ok: true,
    status: res.status,
    headers: res.headers || {},
    body,
    text: res.text || '',
    errors: res.errors || '',
  };
  return { payload, transfer: body ? [body] : [] };
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Worker is required for the Shopware playground');
  }
  const registration = await navigator.serviceWorker.register('/service-worker.js', {
    type: 'module',
    scope: '/',
  });
  if (registration.waiting) {
    registration.waiting.postMessage({ type: 'skip-waiting' });
  }
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) {
    return;
  }
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
      once: true,
    });
  });
}

function assetsBaseOf(demo) {
  return demo ? absoluteUrl(demo.assets, location.origin) : '';
}

function pushDemoToServiceWorker() {
  const post = (sw) =>
    sw && sw.postMessage({ type: 'sw-playground-demo', assetsBase: assetsBaseOf(currentDemo) });
  if (navigator.serviceWorker.controller) {
    post(navigator.serviceWorker.controller);
  } else {
    navigator.serviceWorker.ready.then((reg) => post(reg.active));
  }
}

function attachServiceWorkerBridge() {
  navigator.serviceWorker.addEventListener('controllerchange', () => pushDemoToServiceWorker());
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const data = event.data || {};
    const port = event.ports && event.ports[0];
    // A restarted SW has no state; it asks the page where the active demo's
    // theme/media/bundles live before rewriting asset requests.
    if (data.type === 'sw-playground-demo-query') {
      if (port) port.postMessage({ assetsBase: assetsBaseOf(currentDemo) });
      return;
    }
    if (data.type !== 'php-request' || !port) return;
    try {
      const res = await phpRequest(data.req || {});
      const { payload, transfer } = resultToPort(res);
      port.postMessage(payload, transfer);
    } catch (err) {
      port.postMessage({
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  });
}

/* ------------------------------------------------------------------ demos */

async function loadDemoIndex() {
  const res = await fetch(DEMOS_INDEX_PATH);
  if (!res.ok) {
    throw new Error('demos.json missing; run npm run build');
  }
  const index = await res.json();
  const list = (Array.isArray(index.demos) ? index.demos : []).map((entry) =>
    resolveDemo(entry, DEMOS_INDEX_PATH, { source: 'index' })
  );
  if (!list.length) {
    throw new Error('demos.json lists no demos; run npm run build');
  }
  const fallback = list.some((d) => d.id === index.default) ? index.default : list[0].id;
  return { list, fallback };
}

function storedDemoRef() {
  try {
    return localStorage.getItem(STORED_DEMO_KEY) || '';
  } catch {
    return '';
  }
}

function requestedDemoRef() {
  return new URLSearchParams(location.search).get(DEMO_QUERY_PARAM) || '';
}

async function fetchDemo(ref) {
  const res = await fetch(ref.url);
  if (!res.ok) {
    throw new Error(
      (ref.kind === 'hosted' ? 'Demo "' + ref.id + '" not found' : 'Demo manifest not reachable') +
        ' (HTTP ' + res.status + ' for ' + ref.url + ')'
    );
  }
  let raw;
  try {
    raw = await res.json();
  } catch {
    throw new Error('Demo manifest at ' + ref.url + ' is not JSON');
  }
  return resolveDemo(raw, ref.url, { source: ref.kind, storageKey: storageKeyFor(ref) });
}

/**
 * Pick the demo to boot. A bad `?demo=` or a stale stored selection falls
 * back to the index default instead of leaving the page unusable.
 */
async function chooseDemo(index) {
  const indexIds = index.list.map((d) => d.id);
  const candidates = [
    { value: requestedDemoRef(), from: 'url' },
    { value: storedDemoRef(), from: 'stored' },
  ].filter((c) => c.value);
  for (const candidate of candidates) {
    let ref;
    try {
      ref = parseDemoRef(candidate.value, indexIds);
      if (ref.kind === 'index') {
        return { demo: index.list.find((d) => d.id === ref.id), ref: candidate.value };
      }
      // A remote demo runs third-party PHP/JS inside this origin's iframe.
      // Links can be shared by anyone, so a remote host is only booted after
      // the visitor confirms it (stored refs were confirmed earlier).
      const confirmedBefore = candidate.value === storedDemoRef();
      if (ref.kind === 'remote' && candidate.from === 'url' && !confirmedBefore && !confirmRemoteDemo(ref.url)) {
        return { demo: index.list.find((d) => d.id === index.fallback), ref: '' };
      }
      return { demo: await fetchDemo(ref), ref: candidate.value };
    } catch (err) {
      if (candidate.from === 'url') throw err;
      // stored selection no longer resolves (demo removed): forget it
      try {
        localStorage.removeItem(STORED_DEMO_KEY);
      } catch {
        /* ignore */
      }
    }
  }
  return { demo: index.list.find((d) => d.id === index.fallback), ref: '' };
}

function confirmRemoteDemo(url) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }
  if (host === location.host) return true;
  return confirm(
    'Load a demo from ' + host + '?\n\n' +
      'The playground will download and run the Shopware code and database published there.'
  );
}

function rememberDemo(ref) {
  try {
    if (ref) localStorage.setItem(STORED_DEMO_KEY, ref);
    else localStorage.removeItem(STORED_DEMO_KEY);
  } catch {
    /* private mode */
  }
}

/** Keep ?demo= in the address bar for shareable non-index demos only. */
function syncDemoInUrl(demo, ref) {
  const url = new URL(location.href);
  if (demo.source === 'index') url.searchParams.delete(DEMO_QUERY_PARAM);
  else url.searchParams.set(DEMO_QUERY_PARAM, ref);
  if (url.href !== location.href) history.replaceState(null, '', url);
}

/**
 * Switch to another demo: an index id, a hosted demo name or a manifest URL.
 * The page reloads — PHP WASM and MariaDB WASM cannot be re-booted in place.
 */
export function switchDemo(ref) {
  const value = String(ref || '').trim();
  if (!value) return;
  try {
    parseDemoRef(value, knownIndexIds);
  } catch (err) {
    setStatus('Error: ' + err.message);
    return;
  }
  if (/^https?:\/\//i.test(value) && !confirmRemoteDemo(value)) return;
  rememberDemo(value);
  const url = new URL(location.href);
  url.searchParams.set(DEMO_QUERY_PARAM, value);
  setStatus('Switching demo…');
  location.assign(url);
}

/* ------------------------------------------------------- export and reset */

export async function exportPlayground() {
  setStatus('Building export…');
  const res = await send({ type: 'export', origin: location.origin });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const name =
    'shopware-playground-' + ((currentDemo && currentDemo.id) || 'export') + '-' + stamp + '.zip';
  const file = new File([res.body], name, { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  setStatus('Export downloaded: ' + name);
}

export async function resetPlayground() {
  setStatus('Resetting database…');
  await send({ type: 'reset' });
  setStatus('Reset done — reloading…');
  location.reload();
}

/* ------------------------------------------------------------ frame / nav */

export function currentFramePath() {
  try {
    const loc = frameEl && frameEl.contentWindow.location;
    if (!loc || loc.href === 'about:blank') return '';
    return (loc.pathname || '/') + (loc.search || '');
  } catch {
    return '';
  }
}

export function navigateTo(input) {
  let path = String(input || '').trim();
  if (!path) return;
  if (path.startsWith(location.origin)) path = path.slice(location.origin.length);
  if (/^https?:\/\//.test(path)) return; // external URLs stay out of the iframe
  if (!path.startsWith('/')) path = '/' + path;
  if (frameEl) frameEl.src = location.origin + path;
}

/* -------------------------------------------------------------------- boot */

/**
 * Wipe this demo's persisted database when its seed dump changed (or
 * predates seed markers). Without this, a stale IndexedDB from an older
 * upload is reused forever — hasShopwareSchema only checks that ANY tables
 * exist, never which dump they came from.
 */
async function ensureSeedFreshness(storageKey, seed) {
  if (!storageKey || !seed || typeof indexedDB === 'undefined') return;
  const markerKey = 'sw-playground-seed-' + storageKey;
  let stored = '';
  try {
    stored = localStorage.getItem(markerKey) || '';
  } catch {
    return;
  }
  if (stored === seed) return;
  const names = new Set(idbNamesForDemo(storageKey));
  try {
    for (const info of await indexedDB.databases()) {
      if (idbBelongsToDemo(info.name, storageKey)) names.add(info.name);
    }
  } catch {
    /* enumeration unsupported: the explicit names still apply */
  }
  for (const name of names) {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
  try {
    localStorage.setItem(markerKey, seed);
  } catch {
    /* private mode — next boot simply re-checks */
  }
}

export async function boot() {
  setStatus('Loading demo index…');
  const index = await loadDemoIndex();
  knownIndexIds = index.list.map((d) => d.id);
  const { demo, ref } = await chooseDemo(index);
  currentDemo = demo;
  rememberDemo(ref);
  syncDemoInUrl(demo, ref);
  // Non-index demos (hosted/remote) are listed on top while they are active.
  const list = demo.source === 'index' ? index.list : [demo, ...index.list];
  demos.set({ list, active: demo });
  activeDemo.set(demo);
  await ensureSeedFreshness(demo.storageKey, demo.seed);

  setStatus('Registering service worker…');
  attachServiceWorkerBridge();
  await registerServiceWorker();
  pushDemoToServiceWorker();

  setStatus('Starting worker…');
  worker = new Worker('/browser-worker.js', {
    type: 'module',
  });
  worker.addEventListener('error', (err) => {
    setStatus('Worker error: ' + (err && err.message ? err.message : String(err)));
  });
  worker.addEventListener('messageerror', () => {
    setStatus('Worker message error');
  });

  await send({
    type: 'boot',
    origin: location.origin,
    host: location.host,
    demoId: demo.id,
    storageKey: demo.storageKey,
    zipUrl: absoluteUrl(demo.zip, location.origin),
    dumpUrl: absoluteUrl(demo.dump, location.origin),
  });

  ready.set(true);

  let path = initialShopwarePath();
  if (path === '/' || path === '') {
    path = '/index.php';
  }
  if (frameEl) {
    frameEl.src = location.origin + path;
  }
  setStatus('Opening ' + demo.label + '…');
}

export function reportFrameLoaded() {
  // The iframe also fires load for its initial about:blank — only a real
  // Shopware document counts as booted.
  if (currentFramePath()) booted.set(true);
  const label = currentDemo ? currentDemo.label : 'Shopware';
  try {
    const doc = frameEl && frameEl.contentDocument;
    const title = doc && doc.title ? doc.title : '';
    setStatus(label + ' — HTTP 200' + (title ? ' — ' + title : ''));
  } catch {
    setStatus(label + ' loaded');
  }
}
