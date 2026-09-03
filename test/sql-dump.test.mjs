import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lite4MariaDB } from 'lite4mariadb';
import { dumpDatabase, importDump, shopUrlVariants, sqlLiteral } from '../src/sql-dump.mjs';

test('sql dump round-trips InnoDB rows including binary ids', async () => {
  const src = await Lite4MariaDB.create();
  const dest = await Lite4MariaDB.create();
  try {
    src.exec('CREATE DATABASE shopware');
    src.exec('USE shopware');
    src.exec(
      'CREATE TABLE t (id BINARY(16) NOT NULL PRIMARY KEY, name VARCHAR(32), n INT) ENGINE=InnoDB'
    );
    src.exec("INSERT INTO t VALUES (UNHEX('00112233445566778899aabbccddeeff'), 'hello', 7)");

    const sql = dumpDatabase(src, { database: 'shopware' });
    assert.match(sql, /CREATE TABLE/);
    assert.match(sql, /UNHEX\('00112233445566778899aabbccddeeff'\)/i);
    assert.equal(sqlLiteral({ $h: Buffer.from('<div>hi</div>', 'utf8').toString('hex') }), "'<div>hi</div>'");

    importDump(dest, sql);
    dest.exec('USE shopware');
    const rows = dest.query('SELECT HEX(id) AS id, name, n FROM t');
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].id).toLowerCase(), '00112233445566778899aabbccddeeff');
    assert.equal(rows[0].name, 'hello');
    assert.equal(Number(rows[0].n), 7);

    assert.equal(sqlLiteral(null), 'NULL');
    assert.equal(sqlLiteral({ $h: 'ab' }), "UNHEX('ab')");
  } finally {
    await src.close();
    await dest.close();
  }
});

test('sqlLiteral accepts coerced Uint8Array binary values', async () => {
  const db = await Lite4MariaDB.create();
  try {
    db.exec('CREATE TABLE b (id BINARY(16) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    db.exec("INSERT INTO b VALUES (UNHEX('00112233445566778899aabbccddeeff'))");
    const rows = db.query('SELECT id FROM b');
    assert.ok(rows[0].id instanceof Uint8Array, 'binary column coerces to Uint8Array');
    assert.equal(
      sqlLiteral(rows[0].id),
      "UNHEX('00112233445566778899aabbccddeeff')"
    );
    // Short binary without NUL bytes that decodes as UTF-8 stays a string literal
    assert.equal(sqlLiteral(new Uint8Array([0x68, 0x69])), "'hi'");
  } finally {
    await db.close();
  }
});

test('persistent datadir resumes without reseeding', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'l4m-playground-'));
  try {
    const first = await Lite4MariaDB.create({ dataDir: dir });
    first.exec('CREATE DATABASE shopware');
    first.exec('USE shopware');
    first.exec('CREATE TABLE persist_t (id INT PRIMARY KEY) ENGINE=InnoDB');
    first.exec('INSERT INTO persist_t VALUES (42)');
    await first.close();

    const second = await Lite4MariaDB.create({ dataDir: dir });
    const { hasShopwareSchema } = await import('../src/db-seed.mjs');
    assert.equal(hasShopwareSchema(second), true, 'reopened datadir must report the schema');
    second.exec('USE shopware');
    const rows = second.query('SELECT id FROM persist_t');
    assert.equal(Number(rows[0]?.id), 42);
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shop URL variants follow the live origin instead of the dump host', () => {
  const remote = shopUrlVariants('https://shopware-playground.example.workers.dev');
  assert.equal(remote[0], 'https://shopware-playground.example.workers.dev');
  assert.ok(remote.includes('http://shopware-playground.example.workers.dev'));
  assert.ok(remote.includes('https://shopware-playground.example.workers.dev'));
  assert.equal(
    remote.filter((u) => u.includes('127.0.0.1') || u.includes('localhost')).length,
    0
  );

  const local = shopUrlVariants('http://127.0.0.1:4177');
  assert.ok(local.includes('http://127.0.0.1:4177'));
  assert.ok(local.includes('https://127.0.0.1:4177'));
  assert.ok(local.includes('http://localhost:4177'));
});
