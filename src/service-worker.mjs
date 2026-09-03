/**
 * Thin Service Worker: intercept same-origin Shopware HTTP and forward
 * PHP routes to the playground page, which owns the Dedicated Worker
 * (PHP WASM + lite4mariadb). Static assets stay on the network, but
 * theme/media/bundles are rewritten to the active version's asset dir
 * (/versions/<v>/assets/...) based on the shell's version cookie.
 */
import {
  isEngineBypassPath,
  isShopwarePhpPath,
  isVersionedAssetPath,
  versionedAssetPath,
} from './app-route.mjs';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// The Cookie header is attached after the SW fetch stage, so the active
// version cannot be read from request headers — the shell page pushes it
// via postMessage and answers queries instead.
let activeVersion = '';

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'sw-playground-version') {
    activeVersion = event.data.version || '';
  }
  if (event.data && event.data.type === 'sw-playground-version-query' && event.ports[0]) {
    event.ports[0].postMessage({ version: activeVersion });
  }
});

async function queryVersionFromClients() {
  if (activeVersion) return activeVersion;
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const client of windows) {
    try {
      const version = await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(''), 1500);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          resolve((event.data && event.data.version) || '');
        };
        client.postMessage({ type: 'sw-playground-version-query' }, [channel.port2]);
      });
      if (version) {
        activeVersion = version;
        return version;
      }
    } catch {
      // client gone — try the next one
    }
  }
  return '';
}

function pathnameOf(request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '/';
  }
}

async function isNestedClient(event) {
  const dest = (event.request.headers.get('Sec-Fetch-Dest') || '').toLowerCase();
  if (dest === 'iframe') return true;
  const id = event.clientId;
  if (!id) return false;
  const client = await self.clients.get(id);
  return Boolean(client && client.frameType === 'nested');
}

function headerMap(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function responseHeaders(headers) {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === 'x-frame-options') continue;
    const values = Array.isArray(value) ? value : [value];
    // The playground shell embeds Shopware in an iframe; Shopware ships
    // `frame-ancestors 'none'` (admin CSP), which would block that.
    if (key.toLowerCase().startsWith('content-security-policy')) {
      for (const item of values) {
        const stripped = String(item).replace(/frame-ancestors[^;]*;?/gi, '').trim();
        if (stripped) out.append(key, stripped);
      }
      continue;
    }
    for (const item of values) {
      if (item == null || item === '') continue;
      if (key.toLowerCase() === 'set-cookie') {
        out.append(key, String(item));
      } else {
        out.set(key, String(item));
      }
    }
  }
  out.set('Cross-Origin-Resource-Policy', 'same-origin');
  out.set('Cross-Origin-Embedder-Policy', 'require-corp');
  out.set('Cross-Origin-Opener-Policy', 'same-origin');
  return out;
}

async function phpViaPage(req) {
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const client =
    windows.find((c) => c.frameType === 'top-level') || windows[0];
  if (!client) {
    throw new Error('playground page is not available for PHP routing');
  }
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      reject(new Error('PHP request timed out: ' + req.url));
    }, 180000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const data = event.data || {};
      if (data.ok === false) {
        reject(new Error(data.error || 'PHP request failed'));
        return;
      }
      resolve(data);
    };
    client.postMessage({ type: 'php-request', req }, [channel.port2]);
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const pathname = pathnameOf(request);
  if (isEngineBypassPath(pathname)) return;

  event.respondWith(
    (async () => {
      // Versioned static assets: rewrite to the active version's bundle.
      if (isVersionedAssetPath(pathname)) {
        const version = await queryVersionFromClients();
        const rewritten = versionedAssetPath(pathname, version);
        if (rewritten) {
          const res = await fetch(new URL(rewritten, url).toString(), {
            headers: request.headers,
          });
          // Re-create the response so its URL is empty: a passthrough response
          // keeps the rewritten /versions/... URL, which browsers then use as
          // the module base URL — the admin SPA would load its chunks twice
          // (once via /bundles/, once via /versions/) and boot breaks.
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }
        return fetch(request);
      }

      // The playground has no external network: Shopware's update check calls
      // releases.shopware.com and 500s (CA bundle missing in WASM). Answer
      // "no update available" directly, like UpdateController::updateApiCheck
      // does when there are no updates.
      if (pathname === '/api/_action/update/check') {
        return new Response('null', {
          headers: { 'content-type': 'application/json' },
        });
      }
      // All /api/_action/store/* endpoints call the external Shopware store
      // API, which is unreachable from WASM: the request hangs until TCP
      // timeout and blocks the single PHP instance behind it. Answer with
      // empty lists so the admin stays responsive.
      if (pathname.startsWith('/api/_action/store/')) {
        return new Response('[]', {
          headers: { 'content-type': 'application/json' },
        });
      }

      const nested = await isNestedClient(event);
      if (!isShopwarePhpPath(pathname, nested)) {
        return fetch(request);
      }
      const method = request.method || 'GET';
      let body;
      if (method !== 'GET' && method !== 'HEAD') {
        body = await request.arrayBuffer();
      }
      const php = await phpViaPage({
        url: url.pathname + url.search,
        method,
        headers: {
          ...headerMap(request.headers),
          Host: url.host,
        },
        body,
      });
      const status = php.status || 200;
      if (status >= 300 && status < 400) {
        const location = responseHeaders(php.headers).get('location');
        if (location) {
          return Response.redirect(new URL(location, url).toString(), status);
        }
      }
      const empty = [101, 103, 204, 205, 304].includes(status);
      return new Response(empty ? null : php.body || php.text || '', {
        status,
        headers: responseHeaders(php.headers),
      });
    })()
  );
});
