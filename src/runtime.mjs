/**
 * Playground runtime (Node): lite4mariadb + PHP WASM + bundled shopware/production.
 * This module is the shipped API used by prepare-install and tests.
 *
 * Persistence: by default the database lives in data/mariadb-<version>
 * (NODEFS), so reboots skip the SQL dump import. Pass dataDir: 'memory://'
 * for ephemeral instances.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PHP, PHPRequestHandler, setPhpIniEntries } from '@php-wasm/universal';
import { Lite4MariaDB } from 'lite4mariadb';
import { attachSqlBridge } from './sql-bridge.mjs';
import { installSpawnStub } from './spawn-stub.mjs';
import { seedShopware } from './db-seed.mjs';
import { detectShopwareVersion, versionDumpPath } from './shopware-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const playgroundRoot = join(here, '..');
const defaultShopwareRoot = join(playgroundRoot, 'shopware');
const publicDir = join(playgroundRoot, 'public');
const prependSource = readFileSync(join(playgroundRoot, 'php/auto_prepend.php'), 'utf8');

export const SHOPWARE_DOCUMENT_ROOT = '/shopware/public';
export const SHOPWARE_PUBLIC_ROUTE = '/';

const mainTreeVersion = detectShopwareVersion(defaultShopwareRoot) || 'unknown';
export const SHOPWARE_VERSION = mainTreeVersion;
export const SHOPWARE_DUMP_PATH = versionDumpPath(publicDir, mainTreeVersion);

async function loadPhpRuntime() {
  const { loadNodeRuntime } = await import('@php-wasm/node');
  return loadNodeRuntime('8.4', {
    emscriptenOptions: { processId: 1 },
    extensions: ['intl'],
  });
}

async function mountShopware(php, shopwareRoot) {
  const { createNodeFsMountHandler } = await import('@php-wasm/node');
  php.mkdir('/shopware');
  await php.mount('/shopware', createNodeFsMountHandler(shopwareRoot));
  php.writeFile('/internal/playground_prepend.php', prependSource);
  php.chdir('/shopware/public');
}

function loadInstalledDump() {
  if (existsSync(SHOPWARE_DUMP_PATH)) {
    return gunzipSync(readFileSync(SHOPWARE_DUMP_PATH)).toString('utf8');
  }
  // Legacy location from before version bundles.
  const legacy = join(playgroundRoot, 'data/shopware.sql.gz');
  if (existsSync(legacy)) {
    return gunzipSync(readFileSync(legacy)).toString('utf8');
  }
  return null;
}

export async function createPlayground(options = {}) {
  const shopwareRoot = options.shopwareDir
    ? resolve(options.shopwareDir)
    : defaultShopwareRoot;
  const version = options.shopwareDir ? detectShopwareVersion(shopwareRoot) : mainTreeVersion;
  const db =
    options.db ||
    (await Lite4MariaDB.create({
      dataDir:
        options.dataDir ||
        join(playgroundRoot, 'data', 'mariadb' + (version ? '-' + version : '')),
      ...(options.mariadb || {}),
    }));

  const absoluteUrl = options.absoluteUrl || 'http://127.0.0.1';
  await seedShopware(db, {
    dumpSql: options.dumpSql || loadInstalledDump(),
    absoluteUrl,
    skipDump: options.skipDump,
  });

  // Shopware caches sales_channel_domain in var/cache under a fixed key.
  // The cache is only valid for the origin it was built with — track that
  // origin in a marker file and drop the cache when it changes, otherwise
  // every storefront request 400s with "Sales Channel Not Found".
  const originMarker = join(shopwareRoot, 'var/cache/playground-origin.txt');
  const cachedOrigin = existsSync(originMarker) ? readFileSync(originMarker, 'utf8') : '';
  if (cachedOrigin !== absoluteUrl) {
    rmSync(join(shopwareRoot, 'var/cache'), { recursive: true, force: true });
    mkdirSync(join(shopwareRoot, 'var/cache'), { recursive: true });
    writeFileSync(originMarker, absoluteUrl);
  }

  const php = new PHP(await loadPhpRuntime());
  await setPhpIniEntries(php, { memory_limit: '512M' });
  await installSpawnStub(php);
  attachSqlBridge(php, db);
  await mountShopware(php, shopwareRoot);

  const handler = new PHPRequestHandler({
    php,
    documentRoot: SHOPWARE_DOCUMENT_ROOT,
    absoluteUrl: options.absoluteUrl || 'http://127.0.0.1',
    getFileNotFoundAction: () => ({
      type: 'internal-redirect',
      uri: '/index.php',
    }),
  });

  return {
    db,
    php,
    handler,
    version,
    /**
     * Same request path the playground page uses.
     * @param {{ method?: string, url: string, headers?: Record<string,string>, body?: string }} req
     */
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
