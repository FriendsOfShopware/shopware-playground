import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPhpAppRoute,
  isStaticPlaygroundPath,
  isEngineBypassPath,
  isShopwarePhpPath,
  isVersionedAssetPath,
  versionedAssetPath,
  versionFromCookieHeader,
  VERSION_COOKIE,
} from '../src/app-route.mjs';
import {
  createRequestLog,
  listDir,
  normalizeFsPath,
  readFsFile,
  writeFsFile,
  REQUEST_LOG_CAP,
} from '../src/fs-rpc.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('playground page is browser ESM (no Node require/module load path)', () => {
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  assert.match(html, /<script type="module"/);
  assert.match(html, /src="\/app\.js"/);
  assert.doesNotMatch(html, /\brequire\s*\(/);
  assert.doesNotMatch(html, /\bmodule\.exports\b/);

  const entry = readFileSync(join(root, 'src/browser-entry.mjs'), 'utf8');
  // Svelte UI: the entry only mounts the app; logic lives in src/ui/.
  assert.match(entry, /from 'svelte'/);
  assert.match(entry, /ui\/App\.svelte/);
  assert.doesNotMatch(entry, /srcdoc/);
  assert.doesNotMatch(entry, /__playgroundFetch/);
  assert.doesNotMatch(entry, /onFrameClick/);
  assert.doesNotMatch(entry, /from 'node:/);
  assert.doesNotMatch(entry, /\brequire\s*\(/);
  assert.match(entry, /typeof window/);

  const shell = readFileSync(join(root, 'src/ui/playground.js'), 'utf8');
  assert.match(shell, /new Worker/);
  assert.match(shell, /browser-worker\.js/);
  assert.match(shell, /serviceWorker\.register/);
  assert.match(shell, /service-worker\.js/);
  assert.match(shell, /php-request/);
  assert.match(shell, /frameEl\.src/);
  assert.doesNotMatch(shell, /from 'node:/);
  // toolbar features
  assert.match(shell, /versions\.json/, 'shell loads the version manifest');
  assert.match(shell, /VERSION_COOKIE/);
  assert.match(shell, /type: 'export'/);
  assert.match(shell, /type: 'reset'/);

  const uiDir = join(root, 'src/ui');
  const components = readdirSync(uiDir)
    .filter((f) => f.endsWith('.svelte'))
    .map((f) => readFileSync(join(uiDir, f), 'utf8'))
    .join('\n');
  assert.match(components, /id="btn-files"/);
  assert.match(components, /id="btn-logs"/);
  assert.match(components, /id="tab-files"/);
  assert.match(components, /id="tab-logs"/);
  assert.match(components, /id="fseditor"/);
  assert.match(components, /id="reqlog"/);
  // browser chrome at the bottom
  assert.match(components, /id="chrome"/);
  assert.match(components, /id="addr"/);
  assert.match(components, /id="quicknav"/);
  assert.match(components, /id="btn-back"/);
  assert.match(components, /id="btn-reload"/);
  assert.match(shell, /navigateTo/, 'shell navigates the iframe from the address bar');
  assert.match(components, /syncFromFrame/, 'address bar tracks iframe navigations');
  assert.match(components, /type: 'sql'/, 'shell talks SQL to the worker');
  assert.match(components, /type: 'fs-list'/, 'shell browses the WASM filesystem');
  assert.match(components, /type: 'fs-read'/);
  assert.match(components, /type: 'fs-write'/);
  assert.match(components, /type: 'logs'/, 'shell fetches request + file logs');

  const worker = readFileSync(join(root, 'src/browser-worker.mjs'), 'utf8');
  assert.match(worker, /from '\.\/browser-runtime\.mjs'/);
  assert.match(worker, /body: buffer/);
  assert.doesNotMatch(worker, /from 'node:/);
  assert.doesNotMatch(worker, /\brequire\s*\(/);
  assert.match(worker, /msg\.type === 'sql'/);
  assert.match(worker, /msg\.type === 'export'/);
  assert.match(worker, /msg\.type === 'reset'/);
  assert.match(worker, /msg\.type === 'fs-list'/);
  assert.match(worker, /msg\.type === 'fs-read'/);
  assert.match(worker, /msg\.type === 'fs-write'/);
  assert.match(worker, /msg\.type === 'logs'/);
  assert.match(worker, /requestLog\.record/, 'worker keeps a request ring buffer');
  assert.match(worker, /deleteDatabase/, 'reset wipes IndexedDB');

  const sw = readFileSync(join(root, 'src/service-worker.mjs'), 'utf8');
  assert.match(sw, /addEventListener\('fetch'/);
  assert.match(sw, /phpViaPage/);
  assert.match(sw, /isShopwarePhpPath/);
  assert.match(sw, /versionedAssetPath/, 'SW rewrites assets to the active version');
  assert.doesNotMatch(sw, /from 'node:/);

  const browserRt = readFileSync(join(root, 'src/browser-runtime.mjs'), 'utf8');
  assert.doesNotMatch(browserRt, /from 'node:/);
  assert.doesNotMatch(browserRt, /\brequire\s*\(/);
  assert.match(browserRt, /loadPlaygroundWebRuntime/);
  assert.match(browserRt, /Lite4MariaDB/);
  assert.match(browserRt, /idb:\/\//, 'browser runtime persists to IndexedDB');

  const bridge = readFileSync(join(root, 'src/sql-bridge.mjs'), 'utf8');
  assert.doesNotMatch(bridge, /from 'node:/);
  assert.match(bridge, /\$h/, 'bridge re-encodes binary to the {$h: hex} wire format');

  const seed = readFileSync(join(root, 'src/db-seed.mjs'), 'utf8');
  assert.doesNotMatch(seed, /from 'node:/);

  const exp = readFileSync(join(root, 'src/export.mjs'), 'utf8');
  assert.doesNotMatch(exp, /from 'node:/);
  assert.match(exp, /ZipArchive/);
  assert.match(exp, /dumpDatabase/);

  const phpRt = readFileSync(join(root, 'src/php-web-runtime.mjs'), 'utf8');
  assert.doesNotMatch(phpRt, /from 'node:/);
  assert.doesNotMatch(phpRt, /\brequire\s*\(/);
  assert.match(phpRt, /loadWebRuntime/);
  assert.match(phpRt, /['"]8\.4['"]/);
  assert.match(phpRt, /intl/);

  const serve = readFileSync(join(root, 'src/serve.mjs'), 'utf8');
  assert.match(serve, /isPhpAppRoute/);
  assert.match(serve, /Service-Worker-Allowed/);
  assert.match(serve, /lite4mariadb/, 'serve.mjs serves the engine from node_modules');
  assert.doesNotMatch(serve, /wasm\/dist/, 'no in-tree wasm build paths');

  const runtime = readFileSync(join(root, 'src/runtime.mjs'), 'utf8');
  assert.match(runtime, /from 'lite4mariadb'/);
  assert.doesNotMatch(runtime, /wasm\/dist/, 'no in-tree wasm build imports');

  const pack = readFileSync(join(root, 'src/pack-deploy.mjs'), 'utf8');
  assert.match(pack, /_headers/);
  assert.match(pack, /Cross-Origin-Embedder-Policy: require-corp/);
  assert.match(pack, /administration/);
  assert.match(pack, /shopware-playground-static\.zip/);
});

test('installed shop and dump paths are routed correctly', () => {
  assert.equal(isPhpAppRoute('/'), false);
  assert.equal(isPhpAppRoute('/installer'), true);
  assert.equal(isStaticPlaygroundPath('/app.js'), true);
  assert.equal(isStaticPlaygroundPath('/versions.json'), true);
  assert.equal(isStaticPlaygroundPath('/versions/6.7.13.1/shopware.sql.gz'), true);
  assert.equal(isStaticPlaygroundPath('/service-worker.js'), true);
  assert.equal(isStaticPlaygroundPath('/bundles/storefront/storefront/shopware/shopware.js'), true);
  assert.equal(isStaticPlaygroundPath('/theme/abc/css/all.css'), true);
  assert.equal(isStaticPlaygroundPath('/media/10/a8/c6/logo.png'), true);
  assert.equal(isStaticPlaygroundPath('/thumbnail/10/a8/c6/logo.png'), true);
  assert.equal(
    isStaticPlaygroundPath('/Main-product-with-properties/SWDEMO10007.1'),
    false,
    'Shopware product numbers with dots are PHP routes, not files'
  );
  assert.equal(isPhpAppRoute('/Main-product-with-properties/SWDEMO10007.1'), true);
  assert.equal(
    isShopwarePhpPath('/Main-product-with-properties/SWDEMO10007.1', true),
    true
  );
  assert.equal(isEngineBypassPath('/browser-worker.js'), true);
  assert.equal(isEngineBypassPath('/mariadb/index.mjs'), true);
  assert.equal(isEngineBypassPath('/versions/6.7.13.1/shopware.zip'), true);
  assert.equal(isShopwarePhpPath('/', false), false);
  assert.equal(isShopwarePhpPath('/', true), true);
  assert.equal(isShopwarePhpPath('/index.php', false), true);
  assert.equal(isShopwarePhpPath('/admin', true), true);
  assert.equal(
    isShopwarePhpPath('/api/_info/entity-schema.json', true),
    true,
    'API routes keep .json suffixes but are PHP controllers'
  );
  assert.equal(isShopwarePhpPath('/widgets/checkout/info', true), true);
  assert.equal(isShopwarePhpPath('/theme/abc/css/all.css', true), false);
});

test('versioned asset routing rewrites theme/media/bundles to the version bundle', () => {
  assert.equal(isVersionedAssetPath('/theme/abc/css/all.css'), true);
  assert.equal(isVersionedAssetPath('/media/x/y.png'), true);
  assert.equal(isVersionedAssetPath('/bundles/storefront/a.js'), true);
  assert.equal(isVersionedAssetPath('/index.php'), false);

  assert.equal(
    versionedAssetPath('/theme/abc/css/all.css', '6.7.13.1'),
    '/versions/6.7.13.1/assets/theme/abc/css/all.css'
  );
  assert.equal(versionedAssetPath('/index.php', '6.7.13.1'), null);
  assert.equal(versionedAssetPath('/theme/abc/css/all.css', ''), null);

  assert.equal(
    versionFromCookieHeader('a=1; ' + VERSION_COOKIE + '=6.6.10.23; b=2'),
    '6.6.10.23'
  );
  assert.equal(versionFromCookieHeader(''), '');
  assert.equal(versionFromCookieHeader(null), '');
  assert.equal(versionFromCookieHeader('other=1'), '');
});

test('fs-rpc confines paths to the Shopware tree', () => {
  assert.equal(normalizeFsPath('/shopware/public'), '/shopware/public');
  assert.equal(normalizeFsPath('/shopware'), '/shopware');
  assert.equal(normalizeFsPath('/shopware//public/.'), '/shopware/public');
  assert.equal(normalizeFsPath('/shopware/../etc/passwd'), '', 'traversal is blocked');
  assert.equal(normalizeFsPath('/etc/passwd'), '');
  assert.equal(normalizeFsPath('/shopware/../../x'), '');
  assert.equal(normalizeFsPath(''), '', 'empty resolves outside root');
});

function mockPhp(files) {
  return {
    isDir: (p) => files[p] === 'dir',
    isFile: (p) => typeof files[p] === 'string' || files[p] instanceof Uint8Array,
    listFiles: (p) =>
      Object.keys(files)
        .filter((k) => k !== p && k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'))
        .map((k) => k.slice(p.length + 1)),
    readFileAsBuffer: (p) =>
      files[p] instanceof Uint8Array ? files[p] : new TextEncoder().encode(files[p]),
    writeFile: (p, c) => {
      files[p] = String(c);
    },
  };
}

test('fs-rpc list/read/write against a mock MEMFS', () => {
  const files = {
    '/shopware': 'dir',
    '/shopware/public': 'dir',
    '/shopware/composer.json': '{"name":"shopware"}',
    '/shopware/public/index.php': '<?php echo 1;',
    '/shopware/bin.bin': new Uint8Array([0, 1, 2]),
  };
  const php = mockPhp(files);

  const listing = listDir(php, '/shopware');
  assert.deepEqual(
    listing.entries.map((e) => [e.name, e.dir]),
    [
      ['public', true],
      ['bin.bin', false],
      ['composer.json', false],
    ],
    'dirs first, then files sorted'
  );

  const read = readFsFile(php, '/shopware/composer.json');
  assert.equal(read.binary, false);
  assert.match(read.content, /shopware/);

  const bin = readFsFile(php, '/shopware/bin.bin');
  assert.equal(bin.binary, true, 'null bytes mark a file as binary');

  writeFsFile(php, '/shopware/public/index.php', '<?php echo 2;');
  assert.equal(files['/shopware/public/index.php'], '<?php echo 2;');

  assert.throws(() => readFsFile(php, '/../etc/passwd'), /outside/);
  assert.throws(() => writeFsFile(php, '/shopware/public', 'x'), /directory/);
});

test('request log ring buffer caps and records errors', () => {
  const log = createRequestLog();
  for (let i = 0; i < REQUEST_LOG_CAP + 20; i++) {
    log.record({ method: 'GET', url: '/r' + i }, { status: 200, errors: '' });
  }
  assert.equal(log.entries.length, REQUEST_LOG_CAP);
  assert.equal(log.entries.at(-1).url, '/r' + (REQUEST_LOG_CAP + 19));

  log.record({ method: 'POST', url: '/boom' }, { status: 500, errors: 'boom'.repeat(2000) });
  const last = log.entries.at(-1);
  assert.equal(last.status, 500);
  assert.ok(last.errors.length <= 4000, 'errors are truncated');
  log.clear();
  assert.equal(log.entries.length, 0);
});
