/**
 * Unit tests for the Cloudflare Worker (worker/index.mjs) with a mocked
 * env: PLAYGROUND_R2 as an in-memory map, ASSETS as a stub fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';

const VERSIONS_JSON = JSON.stringify({
  default: '6.7.13.1',
  versions: [{ id: '6.7.13.1' }, { id: '6.6.10.23' }],
});

function makeEnv() {
  const r2 = new Map([
    ['versions.json', { body: VERSIONS_JSON, contentType: 'application/json' }],
    ['mariadb/index.mjs', { body: 'ENGINE', contentType: 'text/javascript' }],
    ['versions/6.7.13.1/shopware.zip', { body: 'ZIP67', contentType: 'application/zip' }],
    ['versions/6.7.13.1/assets/bundles/foo/bar.css', { body: 'CSS', contentType: 'text/css' }],
    ['php/auto_prepend.php', { body: '<?php', contentType: 'application/x-httpd-php' }],
  ]);
  const assets = new Map([
    ['/index.html', '<html>shell</html>'],
    ['/app.js', 'APP'],
    ['/service-worker.js', 'SW'],
  ]);
  const requests = { r2: [], assets: [] };
  const env = {
    PLAYGROUND_R2: {
      async get(key) {
        requests.r2.push(key);
        const hit = r2.get(key);
        if (!hit) return null;
        return {
          body: new TextEncoder().encode(hit.body),
          size: hit.body.length,
          etag: 'etag-' + key,
          httpMetadata: { contentType: hit.contentType },
          text: async () => hit.body,
        };
      },
      async head(key) {
        requests.r2.push(key);
        const hit = r2.get(key);
        return hit ? { size: hit.body.length, etag: 'etag-' + key, httpMetadata: { contentType: hit.contentType } } : null;
      },
    },
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.assets.push(path);
        const hit = assets.get(path);
        return hit
          ? new Response(hit, { status: 200, headers: { 'content-type': 'text/html' } })
          : new Response('not found', { status: 404 });
      },
    },
  };
  return { env, requests };
}

function get(env, path, method = 'GET') {
  return worker.fetch(new Request('https://playground.fos.gg' + path, { method }), env);
}

test('shell requests hit ASSETS and carry isolation headers', async () => {
  const { env } = makeEnv();
  const res = await get(env, '/app.js');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'APP');
  assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
});

test('root and Shopware PHP routes serve the shell index.html', async () => {
  const { env, requests } = makeEnv();
  for (const path of ['/', '/index.php', '/index.php/widgets/checkout/info']) {
    const res = await get(env, path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), '<html>shell</html>', path);
  }
  // Each path is tried directly first (404), then falls back to the shell.
  assert.deepEqual(requests.assets, [
    '/',
    '/index.html',
    '/index.php',
    '/index.html',
    '/index.php/widgets/checkout/info',
    '/index.html',
  ]);
});

test('service-worker.js gets Service-Worker-Allowed', async () => {
  const { env } = makeEnv();
  const res = await get(env, '/service-worker.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Service-Worker-Allowed'), '/');
});

test('heavy payloads come from R2 with stored content type', async () => {
  const { env } = makeEnv();
  const zip = await get(env, '/versions/6.7.13.1/shopware.zip');
  assert.equal(zip.status, 200);
  assert.equal(await zip.text(), 'ZIP67');
  assert.equal(zip.headers.get('Content-Type'), 'application/zip');

  const engine = await get(env, '/mariadb/index.mjs');
  assert.equal(await engine.text(), 'ENGINE');

  const manifest = await get(env, '/versions.json');
  assert.equal(manifest.headers.get('Content-Type'), 'application/json');
  assert.equal(JSON.parse(await manifest.text()).default, '6.7.13.1');

  const prepend = await get(env, '/php/auto_prepend.php');
  assert.equal(await prepend.text(), '<?php');
});

test('versioned asset prefixes fall back to the default version in R2', async () => {
  const { env, requests } = makeEnv();
  const res = await get(env, '/bundles/foo/bar.css');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'CSS');
  assert.ok(requests.r2.includes('versions/6.7.13.1/assets/bundles/foo/bar.css'));
});

test('R2 miss is a 404 with isolation headers', async () => {
  const { env } = makeEnv();
  const res = await get(env, '/versions/9.9.9/shopware.zip');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
});

test('HEAD reads object metadata without a body', async () => {
  const { env } = makeEnv();
  const res = await get(env, '/versions/6.7.13.1/shopware.zip', 'HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), '5');
  assert.equal(await res.text(), '');
});

test('non-GET methods are rejected', async () => {
  const { env } = makeEnv();
  const res = await get(env, '/versions.json', 'POST');
  assert.equal(res.status, 405);
});
