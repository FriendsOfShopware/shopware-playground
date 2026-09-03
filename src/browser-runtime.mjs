/**
 * Browser runtime: PHP web WASM + lite4mariadb. No node: imports.
 * Shopware production tree is loaded from /shopware.zip into PHP MEMFS.
 *
 * Persistence: the database lives in IndexedDB (idb://shopware-playground),
 * so reboots skip the SQL dump import. The lite4mariadb engine is served
 * unbundled from /mariadb/* (node_modules/lite4mariadb/dist) so its
 * Emscripten pthread workers resolve next to the glue script.
 */
import { PHP, PHPRequestHandler, setPhpIniEntries } from '@php-wasm/universal';
import { loadPlaygroundWebRuntime } from './php-web-runtime.mjs';
import { Lite4MariaDB } from '/mariadb/index.mjs';
import { attachSqlBridge } from './sql-bridge.mjs';
import { installSpawnStub } from './spawn-stub.mjs';
import { seedShopware } from './db-seed.mjs';

export const SHOPWARE_DOCUMENT_ROOT = '/shopware/public';
export const SHOPWARE_PUBLIC_ROUTE = '/';

async function loadInstalledDump(dumpUrl) {
  const res = await fetch(dumpUrl);
  if (!res.ok) return null;
  // Some static hosts (e.g. the Vite dev server) serve .gz files with
  // Content-Encoding: gzip — the browser then hands us decompressed bytes.
  if ((res.headers.get('content-encoding') || '').includes('gzip')) {
    return await res.text();
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DecompressionStream is required to import the installed Shopware dump');
  }
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

export async function createPlayground(options = {}) {
  const version = options.version || '';
  const db =
    options.db ||
    (await Lite4MariaDB.create({
      dataDir:
        options.dataDir ||
        'idb://shopware-playground' + (version ? '-' + version : ''),
      ...(options.mariadb || {}),
    }));

  await seedShopware(db, {
    dumpSql: options.dumpSql || (await loadInstalledDump(options.dumpUrl || '/shopware.sql.gz')),
    absoluteUrl:
      options.absoluteUrl || (typeof location !== 'undefined' ? location.origin : ''),
    skipDump: options.skipDump,
  });

  const php = new PHP(await loadPlaygroundWebRuntime());
  await setPhpIniEntries(php, { memory_limit: '512M' });
  await installSpawnStub(php);
  attachSqlBridge(php, db);

  const prependRes = await fetch('/php/auto_prepend.php');
  php.writeFile('/internal/playground_prepend.php', await prependRes.text());
  php.writeFile('/internal/playground_skip_heavy_migrations', '1');

  const zipRes = await fetch(options.zipUrl || '/shopware.zip');
  if (!zipRes.ok) {
    throw new Error('Shopware zip missing at ' + (options.zipUrl || '/shopware.zip') + '; run node src/copy-assets.mjs');
  }
  php.writeFile('/tmp/shopware.zip', new Uint8Array(await zipRes.arrayBuffer()));
  php.mkdir('/shopware');
  const unzip = await php.run({
    code: `<?php
      $z = new ZipArchive();
      if ($z->open('/tmp/shopware.zip') !== true) { fwrite(STDERR, 'zip open failed'); exit(1); }
      $z->extractTo('/shopware');
      $z->close();
      echo 'ok';
    `,
  });
  if (!/ok/.test(unzip.text || '')) {
    throw new Error('unzip shopware failed: ' + (unzip.errors || unzip.text));
  }
  const liveOrigin =
    options.absoluteUrl || (typeof location !== 'undefined' ? location.origin : '');
  if (liveOrigin) {
    let env = '';
    try {
      env = php.readFileAsText('/shopware/.env.local');
    } catch {
      env = '';
    }
    if (/^APP_URL=/m.test(env)) {
      env = env.replace(/^APP_URL=.*$/m, 'APP_URL=' + liveOrigin);
    } else {
      env += (env && !env.endsWith('\n') ? '\n' : '') + 'APP_URL=' + liveOrigin + '\n';
    }
    php.writeFile('/shopware/.env.local', env);
  }
  php.chdir('/shopware/public');

  const handler = new PHPRequestHandler({
    php,
    documentRoot: SHOPWARE_DOCUMENT_ROOT,
    absoluteUrl: options.absoluteUrl || (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1'),
    getFileNotFoundAction: () => ({
      type: 'internal-redirect',
      uri: '/index.php',
    }),
  });

  return {
    db,
    php,
    handler,
    async handleRequest(req) {
      let body = req.body;
      if (typeof body === 'string') {
        body = new TextEncoder().encode(body);
      } else if (body instanceof ArrayBuffer) {
        body = new Uint8Array(body);
      }
      const response = await handler.request({
        method: req.method || 'GET',
        url: req.url,
        headers: req.headers || { Accept: 'text/html' },
        body,
      });
      return {
        status: response.httpStatusCode,
        headers: response.headers,
        text: response.text || '',
        bytes: response.bytes,
        errors: response.errors,
      };
    },
    async close() {
      try {
        php.exit(0);
      } catch {
        /* PHP WASM keeps the event loop alive until exit() */
      }
      try {
        await db.close();
      } catch {
        /* pthread workers may already be tearing down */
      }
    },
  };
}

export { Lite4MariaDB };
