#!/usr/bin/env node
/**
 * Install Shopware once under Node PHP WASM + lite4mariadb, then dump SQL
 * into the version bundle (public/versions/<v>/shopware.sql.gz) that seeds
 * fresh browsers. The install runs on an in-memory database so versions
 * never contaminate each other's datadir.
 *
 * Env: SHOPWARE_DIR (default ./shopware) — point at versions-src/<v>/shopware
 * to prepare another version for the toggle.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createPlayground } from './runtime.mjs';
import { dumpDatabase } from './sql-dump.mjs';
import { copyBundlePublicAssets, runShopwareConsole } from './frontend-assets.mjs';
import { detectShopwareVersion, updateVersionsManifest, versionDumpPath } from './shopware-version.mjs';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from './admin-credentials.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const playgroundRoot = join(here, '..');
const shopwareRoot = process.env.SHOPWARE_DIR
  ? resolve(process.env.SHOPWARE_DIR)
  : join(playgroundRoot, 'shopware');
const shopwareVersion = detectShopwareVersion(shopwareRoot) || 'unknown';
const dumpPath = versionDumpPath(join(playgroundRoot, 'public'), shopwareVersion);
const lockPath = join(shopwareRoot, 'install.lock');

const HOST = '127.0.0.1';
const ORIGIN = 'http://127.0.0.1';

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function header(res, name) {
  const headers = res.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return '';
  const value = headers[key];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

async function request(pg, req) {
  const res = await pg.handleRequest({
    method: req.method || 'GET',
    url: req.url,
    headers: {
      Host: HOST,
      Accept: req.accept || 'text/html',
      ...(req.headers || {}),
    },
    body: req.body,
  });
  return res;
}

async function follow(pg, req, maxHops = 6) {
  let current = { ...req };
  for (let i = 0; i < maxHops; i++) {
    const res = await request(pg, current);
    if (res.status >= 300 && res.status < 400) {
      const loc = header(res, 'location');
      if (!loc) return res;
      const url = loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc;
      current = { method: 'GET', url, accept: current.accept };
      continue;
    }
    return res;
  }
  throw new Error('too many redirects from ' + req.url);
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

async function migrateAll(pg) {
  let offset = 0;
  let last = -1;
  let stuck = 0;
  while (true) {
    const res = await request(pg, {
      method: 'POST',
      url: '/installer/database-migrate',
      accept: 'application/json',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ offset }),
    });
    if (res.status !== 200) {
      throw new Error(
        'database-migrate HTTP ' + res.status + ' ' + (res.text || res.errors || '').slice(0, 800)
      );
    }
    let payload;
    try {
      payload = JSON.parse(res.text || '{}');
    } catch {
      throw new Error('database-migrate non-JSON: ' + (res.text || '').slice(0, 400));
    }
    if (payload.error) {
      throw new Error('database-migrate: ' + payload.error);
    }
    offset = Number(payload.offset || 0);
    const total = Number(payload.total || 0);
    log('migrate ' + offset + '/' + total + (payload.isFinished ? ' finished' : ''));
    if (payload.isFinished) return payload;
    if (offset === last) {
      stuck += 1;
      if (stuck >= 3) {
        throw new Error('migrate stalled at offset ' + offset);
      }
    } else {
      stuck = 0;
      last = offset;
    }
  }
}

function writeEnvLocal() {
  const body = [
    'APP_SECRET=playground-app-secret-please-change-32ch',
    'APP_URL=http://127.0.0.1',
    'DATABASE_URL=mysql://root:root@localhost/shopware',
    'INSTANCE_ID=playgroundinstanceid32charsxx',
    'BLUE_GREEN_DEPLOYMENT=0',
    'SHOPWARE_HTTP_CACHE_ENABLED=0',
    'SHOPWARE_ES_ENABLED=0',
    'SHOPWARE_ES_INDEXING_ENABLED=0',
    'MAILER_DSN=null://null',
    'LOCK_DSN=flock',
    'COMPOSER_HOME=/shopware/var/cache/composer',
    '',
  ].join('\n');
  writeFileSync(join(shopwareRoot, '.env.local'), body);
}

function seedDemoDataPlugin(db) {
  const existing = db.query(
    "SELECT name FROM plugin WHERE name = 'SwagPlatformDemoData'"
  );
  if (existing.length) {
    log('SwagPlatformDemoData already in plugin table');
    return;
  }
  const id = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  const autoload = JSON.stringify({
    'psr-4': { 'Swag\\PlatformDemoData\\': 'src/' },
  });
  const sqlStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  db.exec(
    'INSERT INTO plugin (id, name, base_class, composer_name, active, managed_by_composer, path, autoload, author, copyright, license, version, created_at) VALUES (' +
      "UNHEX('" +
      id +
      "'), 'SwagPlatformDemoData', " +
      sqlStr('Swag\\PlatformDemoData\\SwagPlatformDemoData') +
      ", 'swag/demo-data', 0, 1, 'vendor/swag/demo-data', " +
      sqlStr(autoload) +
      ", 'shopware AG', '(c) by shopware AG', 'MIT', '2.1.0', NOW(3))"
  );
  const langs = db.query('SELECT HEX(id) AS id FROM language');
  for (const lang of langs) {
    const langId = String(lang.id || lang.ID || '');
    if (!langId) continue;
    db.exec(
      "INSERT INTO plugin_translation (plugin_id, language_id, label, description, created_at) VALUES (" +
        "UNHEX('" +
        id +
        "'), UNHEX('" +
        langId +
        "'), 'Shopware 6 Demo data', 'Demo data plugin', NOW(3))"
    );
  }
  log('seeded SwagPlatformDemoData plugin row');
}

function markFrwComplete(db) {
  const id = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  try {
    db.exec(
      "INSERT INTO system_config (id, configuration_key, configuration_value, created_at) VALUES (UNHEX('" +
        id +
        '\'), \'core.frw.completedAt\', \'{"_value":"2026-09-02 00:00:00"}\', NOW(6))'
    );
  } catch (e) {
    log('frw config insert skipped: ' + (e && e.message ? e.message : e));
  }
}

async function main() {
  if (existsSync(dumpPath) && existsSync(lockPath) && process.env.FORCE_INSTALL !== '1') {
    log('dump and install.lock already exist; set FORCE_INSTALL=1 to rebuild');
    return;
  }

  const patcher = join(shopwareRoot, 'overrides/patch-installer.php');
  const patched = spawnSync('php', [patcher], { cwd: shopwareRoot, stdio: 'inherit' });
  if (patched.status !== 0) {
    throw new Error('patch-installer.php failed');
  }

  if (existsSync(lockPath)) rmSync(lockPath);

  log('booting PHP WASM + lite4mariadb (Shopware ' + shopwareVersion + ', in-memory)');
  const pg = await createPlayground({
    skipDump: true,
    absoluteUrl: ORIGIN,
    shopwareDir: shopwareRoot,
    dataDir: 'memory://',
  });
  try {
    pg.db.exec('DROP DATABASE IF EXISTS shopware');
    pg.db.exec('CREATE DATABASE shopware');
    pg.db.exec('USE shopware');

    log('database-configuration');
    const cfg = await follow(pg, {
      method: 'POST',
      url: '/installer/database-configuration',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        hostname: 'localhost',
        username: 'root',
        password: '',
        port: '3306',
        databaseName: 'shopware',
      }),
    });
    if (cfg.status !== 200) {
      throw new Error(
        'database-configuration HTTP ' + cfg.status + ' ' + (cfg.text || '').slice(0, 500)
      );
    }
    if (/name="hostname"/.test(cfg.text || '')) {
      const err = (cfg.text || '').match(/<div class="alert alert-error[\s\S]*?<pre>([\s\S]*?)<\/pre>/);
      throw new Error(
        'database-configuration failed: ' + (err ? err[1] : (cfg.text || '').slice(0, 400))
      );
    }

    log('running migrations');
    await migrateAll(pg);

    log('shop configuration');
    const setup = await pg.php.run({
      code: `<?php
        require '/internal/playground_prepend.php';
        require '/shopware/vendor/autoload.php';
        try {
            $info = (new Shopware\\Core\\Maintenance\\System\\Struct\\DatabaseConnectionInformation())->assign([
                'hostname' => 'localhost',
                'username' => 'root',
                'password' => '',
                'port' => 3306,
                'databaseName' => 'shopware',
            ]);
            $connection = (new Shopware\\Core\\Maintenance\\System\\Service\\DatabaseConnectionFactory())->getConnection($info);
            $clock = new Symfony\\Component\\Clock\\NativeClock();
            $dispatcher = new Symfony\\Component\\EventDispatcher\\EventDispatcher();
            $shop = new Shopware\\Core\\Installer\\Configuration\\ShopConfigurationService($dispatcher, $clock);
            $shop->updateShop([
                'name' => 'Playground Shop',
                'locale' => 'en-GB',
                'currency' => 'EUR',
                'additionalCurrencies' => null,
                'country' => 'GBR',
                'email' => 'shop@example.com',
                'host' => '127.0.0.1',
                'schema' => 'http',
                'basePath' => '',
                'blueGreenDeployment' => false,
            ], $connection);
            $users = new Shopware\\Core\\Maintenance\\User\\Service\\UserProvisioner($connection, $clock);
            $users->provision(${JSON.stringify(ADMIN_USERNAME)}, ${JSON.stringify(ADMIN_PASSWORD)}, [
                'firstName' => 'Play',
                'lastName' => 'Ground',
                'email' => 'admin@example.com',
            ]);
            echo 'ok';
        } catch (Throwable $e) {
            fwrite(STDERR, $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            echo 'fail:' . $e->getMessage();
            exit(1);
        }
      `,
    });
    const setupText = String(setup.text || '').trim();
    if (!/^ok$/.test(setupText)) {
      throw new Error(
        'shop configuration failed: ' +
          setupText +
          ' ' +
          String(setup.errors || '').slice(0, 1500)
      );
    }

    markFrwComplete(pg.db);
    writeEnvLocal();
    writeFileSync(lockPath, new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12));
    log('wrote install.lock');

    log('copying prebuilt administration/storefront bundle assets');
    copyBundlePublicAssets(shopwareRoot);

    log('theme:refresh');
    log(await runShopwareConsole(pg, { command: 'theme:refresh' }));
    log('theme:change Storefront');
    log(
      await runShopwareConsole(pg, {
        command: 'theme:change',
        'theme-name': 'Storefront',
        '--all': true,
        '--sync': true,
      })
    );

    // plugin:refresh shells out to git via Composer, which PHP WASM cannot run.
    if (existsSync(join(shopwareRoot, 'vendor/swag/demo-data/composer.json'))) {
      seedDemoDataPlugin(pg.db);
      log('plugin:install --activate SwagPlatformDemoData');
      log(
        await runShopwareConsole(pg, {
          command: 'plugin:install',
          plugins: ['SwagPlatformDemoData'],
          '--activate': true,
          '--skip-asset-build': true,
        })
      );
    } else {
      log('swag/demo-data not installed in this tree; skipping demo data');
    }

    mkdirSync(dirname(dumpPath), { recursive: true });
    log('dumping MariaDB WASM');
    const sql = dumpDatabase(pg.db, {
      database: 'shopware',
      onProgress: (msg) => log(msg),
    });
    const gz = gzipSync(Buffer.from(sql, 'utf8'));
    writeFileSync(dumpPath, gz);
    log('wrote ' + dumpPath + ' (' + gz.length + ' bytes gzip, ' + sql.length + ' bytes sql)');
    const manifest = updateVersionsManifest(join(playgroundRoot, 'public'), shopwareVersion);
    log('versions.json: ' + manifest.versions.map((v) => v.id).join(', '));
    // The install ran with a placeholder origin; drop the compiled cache so
    // neither the zip nor later Node boots inherit stale domain routing.
    rmSync(join(shopwareRoot, 'var/cache'), { recursive: true, force: true });
    log('run npm run build' + (process.env.SHOPWARE_DIR ? ' with SHOPWARE_DIR=' + shopwareRoot : '') + ' to refresh the zip/assets');
  } finally {
    await pg.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
