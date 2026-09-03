import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import {
  parseConsoleArgs,
  snapshotCreate,
  snapshotList,
  snapshotRestore,
  snapshotDelete,
} from '../src/cli.mjs';
import { Lite4MariaDB, SHOPWARE_DUMP_PATH } from '../src/runtime.mjs';
import { importDump } from '../src/sql-dump.mjs';

test('parseConsoleArgs maps positionals and options', () => {
  assert.deepEqual(parseConsoleArgs(['cache:clear']), { command: 'cache:clear' });
  assert.deepEqual(parseConsoleArgs(['plugin:install', 'Foo', '--activate', '--env=prod']), {
    command: 'plugin:install',
    0: 'Foo',
    activate: true,
    env: 'prod',
  });
  assert.deepEqual(parseConsoleArgs(['user:create', 'admin', '-q']), {
    command: 'user:create',
    0: 'admin',
    q: true,
  });
});

test('snapshot create/list/restore/delete round-trip', async () => {
  assert.ok(existsSync(SHOPWARE_DUMP_PATH), 'version dump missing; run npm run build');
  const dir = mkdtempSync(join(tmpdir(), 'pg-cli-'));
  const dataDir = join(dir, 'db');
  const snaps = join(dir, 'snapshots');
  try {
    // seed a scratch datadir from the installed version dump
    const seedSql = gunzipSync(
      await import('node:fs').then((fs) => fs.readFileSync(SHOPWARE_DUMP_PATH))
    ).toString('utf8');
    let db = await Lite4MariaDB.create({ dataDir });
    importDump(db, seedSql, { onProgress: () => {} });
    await db.persist?.().catch(() => {});
    await db.close().catch(() => {});

    // create
    const created = await snapshotCreate('roundtrip', { dir: snaps, dataDir, message: 'test' });
    assert.ok(created.bytes > 1000, 'snapshot should contain the seeded schema');
    assert.ok(existsSync(created.gz));

    // list
    const list = snapshotList(snaps);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'roundtrip');
    assert.equal(list[0].message, 'test');

    // mutate the database, then restore must bring the marker table back
    db = await Lite4MariaDB.create({ dataDir });
    db.exec('USE shopware');
    db.exec('DROP TABLE IF EXISTS cli_marker');
    db.exec('CREATE TABLE cli_marker (id INT PRIMARY KEY) ENGINE=InnoDB');
    await db.persist?.().catch(() => {});
    await db.close().catch(() => {});

    const statements = await snapshotRestore('roundtrip', { dir: snaps, dataDir });
    assert.ok(statements > 100, 'restore replays the dump');

    db = await Lite4MariaDB.create({ dataDir });
    const gone = db.query(
      "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema='shopware' AND table_name='cli_marker'"
    );
    assert.equal(Number(gone[0].c), 0, 'restore replaces the database wholesale');
    const products = db.query('SELECT COUNT(*) AS c FROM shopware.product');
    assert.ok(Number(products[0].c) > 0, 'restored dump has demo products');
    await db.close().catch(() => {});

    // delete
    snapshotDelete('roundtrip', snaps);
    assert.equal(snapshotList(snaps).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli --help prints usage', () => {
  const r = spawnSync(process.execPath, ['src/cli.mjs', '--help'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /snapshot create/);
  assert.match(r.stdout, /bake/);
});
