import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createPlayground,
  SHOPWARE_PUBLIC_ROUTE,
  SHOPWARE_DUMP_PATH,
} from '../src/runtime.mjs';

test('shipped playground serves installed Shopware HTML from PHP WASM', async () => {
  assert.ok(
    existsSync(SHOPWARE_DUMP_PATH),
    'data/shopware.sql.gz missing; run node src/prepare-install.mjs'
  );

  // Default dataDir (data/mariadb) persists across runs: the dump import
  // happens once, reboots reuse the datadir.
  const pg = await createPlayground({ absoluteUrl: 'http://127.0.0.1:4177' });
  try {
    const res = await pg.handleRequest({
      url: SHOPWARE_PUBLIC_ROUTE,
      method: 'GET',
      headers: { Accept: 'text/html', Host: '127.0.0.1:4177' },
    });
    if (res.status !== 200) {
      writeFileSync('/tmp/shopware-http-failure.log', String(res.errors || '') + '\n---TEXT---\n' + String(res.text || ''));
    }
    assert.equal(res.status, 200, 'expected HTTP 200, got ' + res.status + ' (details: /tmp/shopware-http-failure.log)');
    assert.match(res.text, /<!DOCTYPE html>/i);
    assert.match(res.text, /Playground Shop/);
    assert.match(
      res.text,
      /<title[^>]*>\s*(Home|Catalogue #1)\s*<\/title>/i,
      'storefront homepage title (demo data overwrites Home with Catalogue #1)'
    );
    assert.match(res.text, /\/media\//, 'demo storefront should reference media assets');
    assert.doesNotMatch(res.text, /\/installer\/requirements/);
    assert.doesNotMatch(res.text, />Setup</);
    assert.match(
      res.text,
      /\/theme\/|\/bundles\/storefront\//,
      'storefront HTML should reference compiled theme or bundle assets'
    );

    // Category listing exercises inherited cheapest_price reads (serialized
    // CheapestPriceContainer with NUL bytes via subquery/JOIN) — regression
    // test for the lite4mariadb row-export truncation at the first NUL byte.
    const category = await pg.handleRequest({
      url: '/Clothing/',
      method: 'GET',
      headers: { Accept: 'text/html', Host: '127.0.0.1:4177' },
    });
    assert.equal(
      category.status,
      200,
      'category listing should render, got ' + category.status
    );
    assert.match(category.text, /Clothing/);
    assert.doesNotMatch(category.text, /something went wrong/i);

    const tables = pg.db.query("SHOW TABLES LIKE 'sales_channel'");
    assert.ok(tables.length > 0, 'installed dump must include sales_channel');
    const plugin = pg.db.query(
      "SELECT active, installed_at FROM plugin WHERE name = 'SwagPlatformDemoData'"
    );
    assert.ok(plugin.length, 'dump must include SwagPlatformDemoData');
    assert.ok(
      Number(plugin[0]?.active ?? plugin[0]?.ACTIVE) === 1,
      'SwagPlatformDemoData must be active in the dump'
    );
    assert.ok(
      plugin[0]?.installed_at || plugin[0]?.INSTALLED_AT,
      'SwagPlatformDemoData must be installed in the dump'
    );
    const products = pg.db.query('SELECT COUNT(*) AS c FROM product');
    assert.ok(
      Number(products[0]?.c || 0) > 0,
      'demo data plugin should seed products into the dump'
    );
    const media = pg.db.query('SELECT COUNT(*) AS c FROM media');
    assert.ok(
      Number(media[0]?.c || 0) > 0,
      'demo data plugin should seed media into the dump'
    );

    const engines = pg.db.query('SHOW ENGINES');
    const innodb = engines.find(
      (r) => String(r.Engine || r.ENGINE || '').toLowerCase() === 'innodb'
    );
    assert.ok(innodb, 'SHOW ENGINES must list InnoDB');
    const support = String(innodb.Support || innodb.support || '').toUpperCase();
    assert.notEqual(support, 'DISABLED');

    // Export: zip with SQL dump + manifest + media (WordPress Playground style).
    const { buildExportZip } = await import('../src/export.mjs');
    const zip = await buildExportZip(pg, {
      version: pg.version,
      absoluteUrl: 'http://127.0.0.1:4177',
    });
    assert.ok(zip.length > 100_000, 'export zip should contain the full dump');
    assert.equal(String.fromCharCode(...zip.slice(0, 2)), 'PK', 'zip magic');
    const tmpZip = join(tmpdir(), 'playground-export-test.zip');
    writeFileSync(tmpZip, zip);
    const listing = spawnSync('unzip', ['-l', tmpZip]).stdout?.toString() || '';
    rmSync(tmpZip, { force: true });
    assert.match(listing, /shopware\.sql/);
    assert.match(listing, /playground-export\.json/);
    assert.match(listing, /media\//, 'export should include uploaded media');
  } finally {
    await pg.close();
  }
});
