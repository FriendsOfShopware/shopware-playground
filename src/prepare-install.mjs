#!/usr/bin/env node
/**
 * Install Shopware once under Node PHP WASM + lite4mariadb, then dump SQL
 * into the demo directory (public/demos/<v>/shopware.sql.gz for built-in
 * demos) that seeds fresh browsers. The install runs on an in-memory
 * database so demos never contaminate each other's datadir.
 *
 * CLI env: SHOPWARE_DIR (default ./shopware — point at
 * versions-src/<v>/shopware to prepare another built-in version),
 * PLAYGROUND_PLUGINS (comma-separated plugin names/paths to install and
 * activate, see installShopware), FORCE_INSTALL=1 to redo an install.
 *
 * `installShopware()` is the reusable part; `playground demo pack` uses it
 * to package a plugin demo for upload.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createPlayground } from './runtime.mjs';
import { dumpDatabase } from './sql-dump.mjs';
import {
  copyBundlePublicAssets,
  copyPluginPublicAssets,
  runShopwareConsole,
} from './frontend-assets.mjs';
import { demoDumpPath, detectShopwareVersion } from './demo-build.mjs';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from './admin-credentials.mjs';

const HOST = '127.0.0.1';
const ORIGIN = 'http://127.0.0.1';

function header(res, name) {
  const headers = res.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return '';
  const value = headers[key];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

async function request(pg, req) {
  return pg.handleRequest({
    method: req.method || 'GET',
    url: req.url,
    headers: {
      Host: HOST,
      Accept: req.accept || 'text/html',
      ...(req.headers || {}),
    },
    body: req.body,
  });
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

async function migrateAll(pg, log) {
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

function writeEnvLocal(shopwareRoot) {
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

const sqlStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const randomId = () => [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

/**
 * Register a plugin in the `plugin` table from its composer.json, the way
 * plugin:refresh would — except plugin:refresh shells out to git via
 * Composer, which PHP WASM cannot run.
 *
 * @param {{ name: string, path: string, composer: object, managedByComposer: boolean }} plugin
 */
function seedPluginRow(db, plugin, log) {
  const existing = db.query('SELECT name FROM plugin WHERE name = ' + sqlStr(plugin.name));
  if (existing.length) {
    log(plugin.name + ' already in plugin table');
    return;
  }
  const c = plugin.composer;
  const extra = c.extra || {};
  const id = randomId();
  const author = Array.isArray(c.authors) && c.authors[0] ? c.authors[0].name || '' : '';
  db.exec(
    'INSERT INTO plugin (id, name, base_class, composer_name, active, managed_by_composer, path, autoload, author, copyright, license, version, created_at) VALUES (' +
      "UNHEX('" + id + "'), " +
      sqlStr(plugin.name) + ', ' +
      sqlStr(extra['shopware-plugin-class'] || '') + ', ' +
      sqlStr(c.name || '') + ', 0, ' +
      (plugin.managedByComposer ? 1 : 0) + ', ' +
      sqlStr(plugin.path) + ', ' +
      sqlStr(JSON.stringify(c.autoload || {})) + ', ' +
      sqlStr(author) + ', ' +
      sqlStr(extra.copyright || '') + ', ' +
      sqlStr(c.license ? [].concat(c.license).join(', ') : '') + ', ' +
      sqlStr(String(c.version || '1.0.0').replace(/^v/, '')) + ', NOW(3))'
  );
  const labels = typeof extra.label === 'object' && extra.label ? extra.label : {};
  const descriptions = typeof extra.description === 'object' && extra.description ? extra.description : {};
  const fallbackLabel = labels['en-GB'] || Object.values(labels)[0] || plugin.name;
  const langs = db.query(
    'SELECT HEX(l.id) AS id, lo.code AS code FROM language l LEFT JOIN locale lo ON lo.id = l.locale_id'
  );
  for (const lang of langs) {
    const langId = String(lang.id || lang.ID || '');
    if (!langId) continue;
    const code = String(lang.code || '');
    db.exec(
      'INSERT INTO plugin_translation (plugin_id, language_id, label, description, created_at) VALUES (' +
        "UNHEX('" + id + "'), UNHEX('" + langId + "'), " +
        sqlStr(labels[code] || fallbackLabel) + ', ' +
        sqlStr(descriptions[code] || descriptions['en-GB'] || '') + ', NOW(3))'
    );
  }
  log('seeded plugin row for ' + plugin.name + ' (' + plugin.path + ')');
}

function markFrwComplete(db, log) {
  try {
    db.exec(
      "INSERT INTO system_config (id, configuration_key, configuration_value, created_at) VALUES (UNHEX('" +
        randomId() +
        '\'), \'core.frw.completedAt\', \'{"_value":"2026-09-02 00:00:00"}\', NOW(6))'
    );
  } catch (e) {
    log('frw config insert skipped: ' + (e && e.message ? e.message : e));
  }
}

/**
 * Locate a plugin inside the Shopware tree. Accepts a plugin name
 * (custom/plugins/<Name>, custom/static-plugins/<Name>) or a path relative
 * to the tree (e.g. vendor/frosh/tools).
 */
export function resolvePlugin(shopwareRoot, ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('empty plugin reference');
  const candidates = value.includes('/')
    ? [value]
    : ['custom/plugins/' + value, 'custom/static-plugins/' + value];
  for (const rel of candidates) {
    const composerPath = join(shopwareRoot, rel, 'composer.json');
    if (!existsSync(composerPath)) continue;
    const composer = JSON.parse(readFileSync(composerPath, 'utf8'));
    const baseClass = composer.extra && composer.extra['shopware-plugin-class'];
    if (!baseClass) {
      throw new Error(rel + '/composer.json has no extra.shopware-plugin-class — not a Shopware plugin');
    }
    return {
      name: String(baseClass).split('\\').pop(),
      path: rel.replace(/\/+$/, ''),
      dir: join(shopwareRoot, rel),
      composer,
      managedByComposer: rel.startsWith('vendor/'),
    };
  }
  throw new Error(
    'plugin not found: ' + value + ' (looked for ' + candidates.join(', ') + ' under ' + shopwareRoot + ')'
  );
}

/**
 * Run the Shopware installer against an in-memory MariaDB WASM, provision
 * the admin user, install demo data + the given plugins, compile the theme
 * and write the gzipped seed dump.
 *
 * @param {{ shopwareDir: string, dumpPath: string, plugins?: string[],
 *   log?: (msg: string) => void }} options
 */
export async function installShopware(options) {
  const shopwareRoot = resolve(options.shopwareDir);
  const dumpPath = resolve(options.dumpPath);
  const log = options.log || ((msg) => console.log('[' + new Date().toISOString() + '] ' + msg));
  const shopwareVersion = detectShopwareVersion(shopwareRoot) || 'unknown';
  const lockPath = join(shopwareRoot, 'install.lock');
  const plugins = (options.plugins || []).map((ref) => resolvePlugin(shopwareRoot, ref));

  const patcher = join(shopwareRoot, 'overrides/patch-installer.php');
  if (!existsSync(patcher)) {
    throw new Error(
      'overrides/patch-installer.php missing in ' + shopwareRoot +
        ' — the tree needs the playground overrides (copy shopware/overrides + config/packages/playground.yaml)'
    );
  }
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
    await migrateAll(pg, log);

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

    markFrwComplete(pg.db, log);
    writeEnvLocal(shopwareRoot);
    writeFileSync(lockPath, new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12));
    log('wrote install.lock');

    log('copying prebuilt administration/storefront bundle assets');
    copyBundlePublicAssets(shopwareRoot);
    for (const plugin of plugins) {
      copyPluginPublicAssets(shopwareRoot, plugin.dir, plugin.name);
    }

    const compileTheme = async () => {
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
    };
    await compileTheme();

    // plugin:refresh shells out to git via Composer, which PHP WASM cannot run.
    if (existsSync(join(shopwareRoot, 'vendor/swag/demo-data/composer.json'))) {
      seedPluginRow(
        pg.db,
        {
          name: 'SwagPlatformDemoData',
          path: 'vendor/swag/demo-data',
          managedByComposer: true,
          composer: JSON.parse(readFileSync(join(shopwareRoot, 'vendor/swag/demo-data/composer.json'), 'utf8')),
        },
        log
      );
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

    for (const plugin of plugins) {
      seedPluginRow(pg.db, plugin, log);
      log('plugin:install --activate ' + plugin.name);
      log(
        await runShopwareConsole(pg, {
          command: 'plugin:install',
          plugins: [plugin.name],
          '--activate': true,
          '--skip-asset-build': true,
        })
      );
    }
    if (plugins.length) {
      // Plugins may extend the storefront theme: compile again with them active.
      await compileTheme();
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
    // The install ran with a placeholder origin; drop the compiled cache so
    // neither the zip nor later Node boots inherit stale domain routing.
    rmSync(join(shopwareRoot, 'var/cache'), { recursive: true, force: true });
    return { shopwareVersion, dumpPath, plugins: plugins.map((p) => p.name) };
  } finally {
    await pg.close();
  }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const playgroundRoot = join(here, '..');
  const shopwareRoot = process.env.SHOPWARE_DIR
    ? resolve(process.env.SHOPWARE_DIR)
    : join(playgroundRoot, 'shopware');
  const shopwareVersion = detectShopwareVersion(shopwareRoot) || 'unknown';
  const dumpPath = demoDumpPath(join(playgroundRoot, 'public'), shopwareVersion);
  const lockPath = join(shopwareRoot, 'install.lock');

  if (existsSync(dumpPath) && existsSync(lockPath) && process.env.FORCE_INSTALL !== '1') {
    console.log('dump and install.lock already exist; set FORCE_INSTALL=1 to rebuild');
    return;
  }
  const plugins = (process.env.PLAYGROUND_PLUGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await installShopware({ shopwareDir: shopwareRoot, dumpPath, plugins });
  console.log(
    'run npm run build' +
      (process.env.SHOPWARE_DIR ? ' with SHOPWARE_DIR=' + shopwareRoot : '') +
      ' to package the demo'
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
