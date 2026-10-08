/**
 * A "demo" is the unit the playground boots: a packaged Shopware tree
 * (shopware.zip for MEMFS), a seed database dump (shopware.sql.gz) and the
 * static assets Shopware serves itself in a classic deployment
 * (assets/{bundles,theme,media,thumbnail}). A demo.json next to those files
 * describes it:
 *
 *   {
 *     "format": 1,
 *     "id": "6.7.13.1",                 // stable identifier (also the storage key)
 *     "label": "Shopware 6.7.13.1",     // shown in the version switcher
 *     "shopware": "6.7.13.1",           // Shopware core version inside the zip
 *     "zip": "shopware.zip",            // relative to demo.json (or absolute)
 *     "dump": "shopware.sql.gz",
 *     "assets": "assets",
 *     "seed": "d42dc732e2abe1eb",       // content hash of the dump (IDB invalidation)
 *     "admin": { "username": "admin", "password": "shopware" },
 *     "createdAt": "2026-10-08T07:00:00.000Z"
 *   }
 *
 * The built-in Shopware versions are demos too; they are listed in
 * /demos.json (same descriptors, URLs site-relative). Additional demos — e.g.
 * a plugin packaged by a GitHub Actions run — are either uploaded to the
 * playground's own storage (opened with ?demo=<name>, served from
 * /demos/<name>/demo.json) or hosted on any CORS-enabled static host
 * (opened with ?demo=https://host/path/demo.json).
 *
 * This module has no node: imports — it is shared by the shell, the service
 * worker, the browser worker and the Node build tooling.
 */

export const DEMO_FORMAT = 1;
export const DEMO_MANIFEST = 'demo.json';
export const DEMO_QUERY_PARAM = 'demo';
export const DEMOS_INDEX_PATH = '/demos.json';
export const DEMOS_PATH_PREFIX = '/demos/';

/** Stable identifiers for demos and hosted demo names. */
export const DEMO_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

export function isDemoId(value) {
  return DEMO_ID_RE.test(String(value || ''));
}

/** Small, dependency-free hash (FNV-1a) for storage keys of remote demos. */
export function shortHash(input) {
  let hash = 0x811c9dc5;
  const text = String(input);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Classify what a `?demo=` value (or a stored selection) refers to.
 *
 *   ''                        → { kind: 'default' }
 *   '6.7.13.1' (in index)     → { kind: 'index', id }
 *   'frosh-tools-pr-12'       → { kind: 'hosted', id, url: '/demos/<id>/demo.json' }
 *   'https://host/x/demo.json'→ { kind: 'remote', url }
 *   'https://host/x/'         → { kind: 'remote', url: 'https://host/x/demo.json' }
 */
export function parseDemoRef(ref, indexIds = []) {
  const value = String(ref || '').trim();
  if (!value) return { kind: 'default' };
  if (/^https?:\/\//i.test(value)) {
    return { kind: 'remote', url: manifestUrlFrom(value) };
  }
  if (indexIds.includes(value)) {
    return { kind: 'index', id: value };
  }
  if (isDemoId(value)) {
    return { kind: 'hosted', id: value, url: DEMOS_PATH_PREFIX + value + '/' + DEMO_MANIFEST };
  }
  throw new Error('invalid demo reference: ' + JSON.stringify(value));
}

/** Accept a directory URL or a URL to the manifest itself. */
export function manifestUrlFrom(url) {
  const text = String(url);
  if (/\.json(\?|#|$)/i.test(text)) return text;
  return text.replace(/\/+$/, '') + '/' + DEMO_MANIFEST;
}

/**
 * Validate a raw manifest and resolve its file locations against the URL it
 * was fetched from. The result is the descriptor the shell boots from.
 *
 * @param {object} raw            parsed demo.json
 * @param {string} manifestUrl    absolute URL (or site-relative path) of demo.json
 * @param {{ source?: 'index'|'hosted'|'remote', storageKey?: string }} [options]
 */
export function resolveDemo(raw, manifestUrl, options = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('demo manifest is not an object (' + manifestUrl + ')');
  }
  const format = Number(raw.format || 1);
  if (format > DEMO_FORMAT) {
    throw new Error(
      'demo manifest format ' + format + ' is newer than this playground (' + DEMO_FORMAT + ')'
    );
  }
  const id = String(raw.id || '').trim();
  if (!isDemoId(id)) {
    throw new Error('demo manifest has no valid "id" (' + manifestUrl + ')');
  }
  const base = manifestUrl;
  const zip = resolveRelative(raw.zip || 'shopware.zip', base);
  const dump = resolveRelative(raw.dump || 'shopware.sql.gz', base);
  const assets = resolveRelative(raw.assets || 'assets', base).replace(/\/+$/, '');
  const source = options.source || 'remote';
  return {
    format,
    id,
    label: String(raw.label || (raw.shopware ? 'Shopware ' + raw.shopware : id)),
    shopware: String(raw.shopware || ''),
    zip,
    dump,
    assets,
    seed: String(raw.seed || ''),
    admin:
      raw.admin && typeof raw.admin === 'object'
        ? { username: String(raw.admin.username || ''), password: String(raw.admin.password || '') }
        : null,
    createdAt: raw.createdAt ? String(raw.createdAt) : '',
    source,
    manifestUrl,
    storageKey: options.storageKey || id,
  };
}

/**
 * Resolve `target` against the manifest location. Site-relative manifest
 * paths ("/demos/x/demo.json") stay site-relative so the index can be built
 * without knowing the deployment origin.
 */
export function resolveRelative(target, base) {
  const value = String(target);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('/')) return value;
  const dir = String(base).replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(dir)) {
    return new URL(value, dir).toString();
  }
  // site-relative: collapse "./" and "../"
  const parts = (dir + value).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' && out.length) continue;
    if (part === '.') continue;
    if (part === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** Turn a possibly site-relative URL into an absolute one for a given origin. */
export function absoluteUrl(target, origin) {
  const value = String(target || '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return String(origin || '').replace(/\/+$/, '') + (value.startsWith('/') ? value : '/' + value);
}

/**
 * Storage key for a demo selection: the IndexedDB database name suffix and
 * the per-demo seed marker. Index and hosted demos use their id; remote
 * demos are keyed by their manifest URL so two hosts publishing the same id
 * never share a datadir.
 */
export function storageKeyFor(ref) {
  if (ref.kind === 'remote') return 'remote-' + shortHash(ref.url);
  return ref.id || '';
}

/**
 * Shopware asset paths (/bundles, /theme, /media, /thumbnail) are served per
 * demo from its assets directory; the service worker rewrites them.
 */
export const DEMO_ASSET_PREFIXES = ['/bundles/', '/theme/', '/media/', '/thumbnail/'];

export function isDemoAssetPath(pathname) {
  return DEMO_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function demoAssetUrl(pathname, assetsBase) {
  if (!assetsBase || !isDemoAssetPath(pathname)) return null;
  return String(assetsBase).replace(/\/+$/, '') + pathname;
}

/** Descriptor → the public fields written to demo.json / demos.json. */
export function demoManifestFields(demo) {
  const out = {
    format: DEMO_FORMAT,
    id: demo.id,
    label: demo.label,
    shopware: demo.shopware,
    zip: demo.zip,
    dump: demo.dump,
    assets: demo.assets,
    seed: demo.seed,
  };
  if (demo.admin) out.admin = demo.admin;
  if (demo.createdAt) out.createdAt = demo.createdAt;
  return out;
}
