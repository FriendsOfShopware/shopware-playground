#!/usr/bin/env node
/**
 * playground — CLI for preparing, snapshotting and baking playground states.
 *
 * Typical flow:
 *   playground run                       # click the shop together locally
 *   playground console plugin:refresh    # or script it (bin/console, PHP, SQL)
 *   playground snapshot create my-shop   # freeze the database
 *   playground snapshot restore my-shop  # …and go back later
 *   playground bake my-shop              # make it the seed dump + rebuild bundle
 *
 * Snapshot/restore/sql talk to the MariaDB datadir directly (no PHP boot),
 * so they finish in seconds. Stop `playground run` before restoring.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Lite4MariaDB, SHOPWARE_VERSION, createPlayground } from './runtime.mjs';
import { dumpDatabase, importDump, rewriteShopUrls } from './sql-dump.mjs';
import { runShopwareConsole } from './frontend-assets.mjs';
import { versionDumpPath } from './shopware-version.mjs';

const playgroundRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SNAPSHOTS_DIR = join(playgroundRoot, 'snapshots');
const DEFAULT_ORIGIN = 'http://127.0.0.1:4177';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function fail(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

function defaultDataDir() {
  return join(
    playgroundRoot,
    'data',
    'mariadb' + (SHOPWARE_VERSION ? '-' + SHOPWARE_VERSION : '')
  );
}

/** Open the persistent datadir without booting PHP — the fast path. */
async function openDb(dataDir = defaultDataDir()) {
  return Lite4MariaDB.create({ dataDir });
}

/* ------------------------------------------------------------ snapshots */

function snapshotPaths(name, dir) {
  if (!NAME_RE.test(name || '')) {
    fail('invalid snapshot name ' + JSON.stringify(name) + ' (allowed: a-z 0-9 . _ -)');
  }
  return { gz: join(dir, name + '.sql.gz'), meta: join(dir, name + '.json') };
}

export async function snapshotCreate(name, options = {}) {
  const dir = options.dir || DEFAULT_SNAPSHOTS_DIR;
  mkdirSync(dir, { recursive: true });
  const { gz, meta } = snapshotPaths(name, dir);
  const db = await openDb(options.dataDir);
  try {
    const tables = db.query("SHOW TABLES FROM shopware");
    if (!tables.length) fail('database is empty — run the playground once first');
    const sql = dumpDatabase(db, { onProgress: () => {} });
    writeFileSync(gz, gzipSync(Buffer.from(sql, 'utf8')));
    writeFileSync(
      meta,
      JSON.stringify(
        {
          name,
          version: SHOPWARE_VERSION,
          createdAt: new Date().toISOString(),
          message: options.message || '',
        },
        null,
        2
      ) + '\n'
    );
    await db.persist?.().catch(() => {});
    return { gz, meta, bytes: statSync(gz).size };
  } finally {
    await db.close().catch(() => {});
  }
}

export function snapshotList(dir = DEFAULT_SNAPSHOTS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql.gz'))
    .map((f) => {
      const name = f.slice(0, -'.sql.gz'.length);
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'));
      } catch {
        /* no meta */
      }
      return { name, bytes: statSync(join(dir, f)).size, ...meta };
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function snapshotRestore(name, options = {}) {
  const dir = options.dir || DEFAULT_SNAPSHOTS_DIR;
  const { gz } = snapshotPaths(name, dir);
  if (!existsSync(gz)) fail('snapshot not found: ' + name + ' (looked in ' + dir + ')');
  const sql = gunzipSync(readFileSync(gz)).toString('utf8');
  const db = await openDb(options.dataDir);
  try {
    const count = importDump(db, sql, { onProgress: () => {} });
    rewriteShopUrls(db, options.origin || DEFAULT_ORIGIN);
    await db.persist?.().catch(() => {});
    return count;
  } finally {
    await db.close().catch(() => {});
  }
}

export function snapshotDelete(name, dir = DEFAULT_SNAPSHOTS_DIR) {
  const { gz, meta } = snapshotPaths(name, dir);
  if (!existsSync(gz)) fail('snapshot not found: ' + name);
  rmSync(gz, { force: true });
  rmSync(meta, { force: true });
}

/* ---------------------------------------------------------- arg parsing */

/**
 * bin/console args → ArrayInput params. `--key=value` for valued options,
 * bare `--flag` for booleans; first positional is the command, the rest are
 * positional arguments in definition order.
 */
export function parseConsoleArgs(argv) {
  const params = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 2) params[a.slice(2, eq)] = a.slice(eq + 1);
      else params[a.slice(2)] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      for (const flag of a.slice(1)) params[flag] = true;
    } else {
      positional.push(a);
    }
  }
  if (positional.length) {
    params.command = positional[0];
    positional.slice(1).forEach((v, i) => {
      params[i] = v;
    });
  }
  return params;
}

/* -------------------------------------------------------------- commands */

async function cmdRun(args) {
  let port = process.env.PORT || '4177';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = args[++i];
  }
  const child = spawnSync(process.execPath, [join(playgroundRoot, 'src/serve.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
  });
  process.exit(child.status ?? 0);
}

async function cmdExec(args) {
  const file = args[0];
  if (!file) fail('usage: playground exec <file.php|->');
  let code = file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8');
  code = code.replace(/^\s*<\?php/, '');
  const pg = await createPlayground({ absoluteUrl: DEFAULT_ORIGIN });
  try {
    const res = await pg.php.run({
      code: `<?php
        require '/internal/playground_prepend.php';
        chdir('/shopware');
        $_SERVER['PROJECT_ROOT'] = $_ENV['PROJECT_ROOT'] = '/shopware';
        putenv('PROJECT_ROOT=/shopware');
        require '/shopware/vendor/autoload.php';
        ${code}
      `,
    });
    if (res.text) process.stdout.write(res.text);
    if (res.errors) process.stderr.write(String(res.errors) + '\n');
  } finally {
    await pg.close();
  }
}

async function cmdConsole(args) {
  if (!args.length) fail('usage: playground console <command> [args] [--option=value]');
  const params = parseConsoleArgs(args);
  const pg = await createPlayground({ absoluteUrl: DEFAULT_ORIGIN });
  try {
    const out = await runShopwareConsole(pg, params);
    if (out) process.stdout.write(String(out).replace(/\0/g, '') + '\n');
  } finally {
    await pg.close();
  }
}

async function cmdSql(args) {
  const json = args.includes('--json');
  const query = args.filter((a) => a !== '--json').join(' ');
  if (!query.trim()) fail('usage: playground sql "<query>" [--json]');
  const db = await openDb();
  try {
    db.exec('USE shopware');
    const isSelect = /^\s*(select|show|describe|explain)\b/i.test(query);
    if (isSelect) {
      const rows = db.query(query);
      if (json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        printTable(rows);
      }
    } else {
      db.exec(query);
      await db.persist?.().catch(() => {});
      console.log('ok');
    }
  } finally {
    await db.close().catch(() => {});
  }
}

function printTable(rows) {
  if (!rows.length) {
    console.log('(0 rows)');
    return;
  }
  const cols = Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? 'NULL' : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals) => vals.map((v, i) => cell(v).padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows.slice(0, 200)) console.log(line(cols.map((c) => r[c])));
  if (rows.length > 200) console.log('… ' + (rows.length - 200) + ' more rows');
  console.log('(' + rows.length + ' rows)');
}

async function cmdSnapshotCreate(args) {
  const name = args[0];
  if (!name) fail('usage: playground snapshot create <name> [-m "message"]');
  let message = '';
  const mi = args.indexOf('-m');
  if (mi >= 0 && args[mi + 1]) message = args[mi + 1];
  const r = await snapshotCreate(name, { message });
  console.log('snapshot "' + name + '" → ' + r.gz + ' (' + (r.bytes / 1024 / 1024).toFixed(1) + ' MB gz)');
}

function cmdSnapshotList() {
  const list = snapshotList();
  if (!list.length) {
    console.log('no snapshots yet — playground snapshot create <name>');
    return;
  }
  printTable(
    list.map((s) => ({
      name: s.name,
      version: s.version || '?',
      'size (MB)': (s.bytes / 1024 / 1024).toFixed(1),
      created: (s.createdAt || '').replace('T', ' ').slice(0, 16),
      message: s.message || '',
    }))
  );
}

async function cmdSnapshotRestore(args) {
  const name = args[0];
  if (!name) fail('usage: playground snapshot restore <name> [--origin URL]');
  let origin = DEFAULT_ORIGIN;
  const oi = args.indexOf('--origin');
  if (oi >= 0 && args[oi + 1]) origin = args[oi + 1];
  const count = await snapshotRestore(name, { origin });
  console.log('restored "' + name + '" (' + count + ' statements), shop URLs → ' + origin);
}

function cmdSnapshotDelete(args) {
  const name = args[0];
  if (!name) fail('usage: playground snapshot delete <name>');
  snapshotDelete(name);
  console.log('deleted "' + name + '"');
}

async function cmdBake(args) {
  const name = args[0];
  if (!name) fail('usage: playground bake <name> — make snapshot the seed dump for Shopware ' + SHOPWARE_VERSION);
  const { gz } = snapshotPaths(name, DEFAULT_SNAPSHOTS_DIR);
  if (!existsSync(gz)) fail('snapshot not found: ' + name);
  const target = versionDumpPath(join(playgroundRoot, 'public'), SHOPWARE_VERSION);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(gz, target);
  console.log('seed dump for Shopware ' + SHOPWARE_VERSION + ' ← snapshot "' + name + '"');
  console.log('rebuilding bundle (FORCE_ZIP=1 npm run build)…');
  const r = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    cwd: playgroundRoot,
    env: { ...process.env, FORCE_ZIP: '1' },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log('baked. Deploy with: npm run deploy:cf');
}

/* -------------------------------------------------------------- dispatch */

function help() {
  console.log(`playground — prepare, snapshot and bake Shopware playground states

Usage: node src/cli.mjs <command> …

  run [--port 4177]                serve the browser playground locally
  exec <file.php|->                run PHP code (Shopware autoloaded, cwd=/shopware)
  console <cmd> [args] [--o=v]     run bin/console (e.g. console cache:clear)
  sql "<query>" [--json]           run SQL against the playground database

  snapshot create <name> [-m msg]  dump the database to snapshots/<name>.sql.gz
  snapshot list                    list snapshots
  snapshot restore <name>          replace the database with a snapshot
    [--origin URL]                   (rewrites shop URLs; default ${DEFAULT_ORIGIN})
  snapshot delete <name>           delete a snapshot

  bake <name>                      make snapshot the seed dump for Shopware ${SHOPWARE_VERSION},
                                   rebuild the version bundle (zip + manifest seed)

Snapshots are database-only; baked bundles also refresh files via the zip.
Stop "playground run" before snapshot restore (single datadir access).`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'run':
      return cmdRun(args);
    case 'exec':
      return cmdExec(args);
    case 'console':
      return cmdConsole(args);
    case 'sql':
      return cmdSql(args);
    case 'snapshot':
      switch (args[0]) {
        case 'create':
          return cmdSnapshotCreate(args.slice(1));
        case 'list':
          return cmdSnapshotList();
        case 'restore':
          return cmdSnapshotRestore(args.slice(1));
        case 'delete':
          return cmdSnapshotDelete(args.slice(1));
        default:
          fail('usage: playground snapshot <create|list|restore|delete>');
      }
    // unreachable
    case 'bake':
      return cmdBake(args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      fail('unknown command: ' + cmd + ' (try --help)');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => fail(err && err.message ? err.message : String(err)));
}
