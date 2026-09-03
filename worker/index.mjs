/**
 * Cloudflare Worker for playground.fos.gg.
 *
 * The playground is a static shell + heavy binary payloads. Shell files
 * (index.html, app.js, browser-worker.js, service-worker.js) come from the
 * Workers Static Assets binding; everything big lives in R2:
 *
 *   /versions/*      → R2 versions/*        (Shopware zips, SQL dumps, assets)
 *   /versions.json   → R2 versions.json
 *   /mariadb/*       → R2 mariadb/*         (lite4mariadb engine)
 *   /assets/*        → R2 assets/*          (PHP WASM runtime assets)
 *   /php/*           → R2 php/*             (auto_prepend)
 *   /bundles|theme|media|thumbnail/* → R2 versions/<default>/assets/*
 *                        (only reached without the service worker, e.g. curl)
 *
 * Everything else falls back to the shell (Shopware front-controller routes
 * load the playground page, which boots the iframe). All responses carry
 * COOP/COEP/CORP so MariaDB WASM pthreads get crossOriginIsolated.
 */
import { isPhpAppRoute } from '../src/app-route.mjs';
import { contentTypeFor } from '../src/cf-content-types.mjs';

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const VERSIONED_ASSET_PREFIXES = ['/bundles/', '/theme/', '/media/', '/thumbnail/'];

let cachedDefaultVersion;

async function defaultVersion(env) {
  if (cachedDefaultVersion !== undefined) return cachedDefaultVersion;
  let version = '';
  try {
    const obj = await env.PLAYGROUND_R2.get('versions.json');
    if (obj) {
      const manifest = JSON.parse(await obj.text());
      version = manifest.default || manifest.versions?.[0]?.id || '';
    }
  } catch {
    // fall through with empty version
  }
  cachedDefaultVersion = version;
  return version;
}

async function r2KeyFor(pathname, env) {
  if (pathname === '/versions.json') return 'versions.json';
  for (const prefix of ['/versions/', '/mariadb/', '/assets/', '/php/']) {
    if (pathname.startsWith(prefix)) return pathname.slice(1);
  }
  for (const prefix of VERSIONED_ASSET_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      const version = await defaultVersion(env);
      return version ? 'versions/' + version + '/assets' + pathname : null;
    }
  }
  return null;
}

function withIsolationHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) {
    headers.set(key, value);
  }
  if (pathname.endsWith('/service-worker.js')) {
    headers.set('Service-Worker-Allowed', '/');
  }
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveR2(env, key, method, pathname) {
  const object =
    method === 'HEAD'
      ? await env.PLAYGROUND_R2.head(key)
      : await env.PLAYGROUND_R2.get(key);
  if (!object) return null;
  const headers = new Headers();
  headers.set(
    'Content-Type',
    (object.httpMetadata && object.httpMetadata.contentType) || contentTypeFor(key)
  );
  headers.set('Content-Length', String(object.size));
  headers.set('ETag', object.etag);
  return withIsolationHeaders(
    new Response(method === 'HEAD' ? null : object.body, { status: 200, headers }),
    pathname
  );
}

async function serveAsset(env, request, assetPath, pathname) {
  const url = new URL(request.url);
  url.pathname = assetPath;
  const response = await env.ASSETS.fetch(new Request(url.toString(), request));
  return withIsolationHeaders(response, pathname);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    if (method !== 'GET' && method !== 'HEAD') {
      return withIsolationHeaders(
        new Response('method not allowed', { status: 405 }),
        pathname
      );
    }

    const key = await r2KeyFor(pathname, env);
    if (key) {
      const response = await serveR2(env, key, method, pathname);
      if (response) return response;
      return withIsolationHeaders(
        new Response('not found: ' + pathname, { status: 404 }),
        pathname
      );
    }

    // Shell files and anything else that exists in the assets binding.
    const assetResponse = await serveAsset(env, request, pathname, pathname);
    if (assetResponse.status !== 404) return assetResponse;

    // Shopware front-controller routes load the playground shell; it boots
    // the requested page inside the iframe.
    if (pathname === '/' || isPhpAppRoute(pathname)) {
      return serveAsset(env, request, '/index.html', pathname);
    }
    return assetResponse;
  },
};
