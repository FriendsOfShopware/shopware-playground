/**
 * Framework-agnostic playground shell logic: worker RPC, service-worker
 * bridge, version manifest, boot sequence, export/reset. UI state is
 * published through the Svelte stores in stores.js.
 */
import { initialShopwarePath, VERSION_COOKIE } from '../app-route.mjs';
import { idbNamesForVersion } from '../idb-names.mjs';
import { status, ready, booted, versions, activeVersion } from './stores.js';

let worker;
let currentVersion = '';
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

function pushVersionToServiceWorker() {
  const post = (sw) =>
    sw && sw.postMessage({ type: 'sw-playground-version', version: currentVersion });
  if (navigator.serviceWorker.controller) {
    post(navigator.serviceWorker.controller);
  } else {
    navigator.serviceWorker.ready.then((reg) => post(reg.active));
  }
}

function attachServiceWorkerBridge() {
  navigator.serviceWorker.addEventListener('controllerchange', () =>
    pushVersionToServiceWorker()
  );
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const data = event.data || {};
    const port = event.ports && event.ports[0];
    // The SW cannot see Cookie headers; it asks the page for the active
    // version when it needs to rewrite theme/media/bundles asset paths.
    if (data.type === 'sw-playground-version-query') {
      if (port) port.postMessage({ version: currentVersion });
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

/* ---------------------------------------------------------------- versions */

async function loadVersions() {
  const res = await fetch('/versions.json');
  if (!res.ok) {
    throw new Error('versions.json missing; run npm run build');
  }
  const manifest = await res.json();
  const list = Array.isArray(manifest.versions) ? manifest.versions : [];
  if (!list.length) {
    throw new Error('versions.json lists no Shopware versions; run npm run build');
  }
  const stored = localStorage.getItem('sw-playground-version');
  const active = list.some((v) => v.id === stored)
    ? stored
    : manifest.default || list[0].id;
  return { list, active };
}

export function selectVersion(version) {
  localStorage.setItem('sw-playground-version', version);
  document.cookie = VERSION_COOKIE + '=' + encodeURIComponent(version) + '; path=/; SameSite=Strict';
}

export function switchVersion(next) {
  if (!next || next === currentVersion) return;
  selectVersion(next);
  setStatus('Switching to Shopware ' + next + '…');
  location.reload();
}

/* ------------------------------------------------------- export and reset */

export async function exportPlayground() {
  setStatus('Building export…');
  const res = await send({ type: 'export', origin: location.origin });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const name = 'shopware-playground-' + (currentVersion || 'export') + '-' + stamp + '.zip';
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
  localStorage.removeItem('sw-playground-version');
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
 * Wipe this version's persisted database when the deployed seed dump changed
 * (or predates seed markers). Without this, a poisoned IndexedDB from an
 * older deployment is reused forever — hasShopwareSchema only checks that
 * ANY tables exist, never which dump they came from.
 */
async function ensureSeedFreshness(version, seed) {
  if (!version || !seed || typeof indexedDB === 'undefined') return;
  const markerKey = 'sw-playground-seed-' + version;
  let stored = '';
  try {
    stored = localStorage.getItem(markerKey) || '';
  } catch {
    return;
  }
  if (stored === seed) return;
  const names = new Set(idbNamesForVersion(version));
  try {
    for (const info of await indexedDB.databases()) {
      if (info.name && info.name.endsWith('shopware-playground-' + version)) {
        names.add(info.name);
      }
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
  setStatus('Loading version manifest…');
  const { list, active } = await loadVersions();
  currentVersion = active;
  selectVersion(active);
  versions.set({ list, active });
  activeVersion.set(active);
  const activeEntry = list.find((v) => v.id === active) || list[0];
  await ensureSeedFreshness(active, activeEntry && activeEntry.seed);

  setStatus('Registering service worker…');
  attachServiceWorkerBridge();
  await registerServiceWorker();
  pushVersionToServiceWorker();

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
    version: activeEntry.id,
    zipUrl: activeEntry.zip,
    dumpUrl: activeEntry.dump,
  });

  ready.set(true);

  let path = initialShopwarePath();
  if (path === '/' || path === '') {
    path = '/index.php';
  }
  if (frameEl) {
    frameEl.src = location.origin + path;
  }
  setStatus('Opening Shopware ' + currentVersion + '…');
}

export function reportFrameLoaded() {
  // The iframe also fires load for its initial about:blank — only a real
  // Shopware document counts as booted.
  if (currentFramePath()) booted.set(true);
  try {
    const doc = frameEl && frameEl.contentDocument;
    const title = doc && doc.title ? doc.title : '';
    setStatus('Shopware ' + currentVersion + ' — HTTP 200' + (title ? ' — ' + title : ''));
  } catch {
    setStatus('Shopware ' + currentVersion + ' loaded');
  }
}
