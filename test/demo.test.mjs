/**
 * Unit tests for the demo model (src/demo.mjs) and the Node packaging
 * helpers (src/demo-build.mjs) — no PHP/MariaDB boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  absoluteUrl,
  demoAssetUrl,
  isDemoId,
  manifestUrlFrom,
  parseDemoRef,
  resolveDemo,
  resolveRelative,
  storageKeyFor,
} from '../src/demo.mjs';
import { readDemoDir, seedOf, updateDemoIndex, defaultDemoAssetsDir } from '../src/demo-build.mjs';

test('demo ids are restricted to safe path segments', () => {
  assert.equal(isDemoId('6.7.13.1'), true);
  assert.equal(isDemoId('frosh-tools-pr_12'), true);
  assert.equal(isDemoId('../etc'), false);
  assert.equal(isDemoId('a/b'), false);
  assert.equal(isDemoId(''), false);
  assert.equal(isDemoId('-leading'), false);
});

test('parseDemoRef classifies index ids, hosted names and remote URLs', () => {
  const index = ['6.7.13.1', '6.6.10.23'];
  assert.deepEqual(parseDemoRef('', index), { kind: 'default' });
  assert.deepEqual(parseDemoRef('6.6.10.23', index), { kind: 'index', id: '6.6.10.23' });
  assert.deepEqual(parseDemoRef('frosh-tools-pr-12', index), {
    kind: 'hosted',
    id: 'frosh-tools-pr-12',
    url: '/demos/frosh-tools-pr-12/demo.json',
  });
  assert.deepEqual(parseDemoRef('https://cdn.example.com/x/demo.json', index), {
    kind: 'remote',
    url: 'https://cdn.example.com/x/demo.json',
  });
  assert.equal(
    parseDemoRef('https://cdn.example.com/x/', index).url,
    'https://cdn.example.com/x/demo.json',
    'directory URLs get demo.json appended'
  );
  assert.equal(manifestUrlFrom('https://h/d'), 'https://h/d/demo.json');
  assert.equal(manifestUrlFrom('https://h/d/custom.json?v=1'), 'https://h/d/custom.json?v=1');
  assert.throws(() => parseDemoRef('../escape', index), /invalid demo reference/);
});

test('storage keys separate remote demos by manifest URL', () => {
  assert.equal(storageKeyFor({ kind: 'index', id: '6.7.13.1' }), '6.7.13.1');
  assert.equal(storageKeyFor({ kind: 'hosted', id: 'pr-12' }), 'pr-12');
  const a = storageKeyFor({ kind: 'remote', url: 'https://a/demo.json' });
  const b = storageKeyFor({ kind: 'remote', url: 'https://b/demo.json' });
  assert.match(a, /^remote-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(a, storageKeyFor({ kind: 'remote', url: 'https://a/demo.json' }), 'deterministic');
});

test('resolveRelative handles site-relative and absolute manifest locations', () => {
  assert.equal(resolveRelative('shopware.zip', '/demos/x/demo.json'), '/demos/x/shopware.zip');
  assert.equal(resolveRelative('./assets', '/demos/x/demo.json'), '/demos/x/assets');
  assert.equal(resolveRelative('../shared/assets', '/demos/x/demo.json'), '/demos/shared/assets');
  assert.equal(
    resolveRelative('shopware.zip', 'https://cdn.example.com/pr/12/demo.json?token=1'),
    'https://cdn.example.com/pr/12/shopware.zip'
  );
  assert.equal(resolveRelative('/abs/x.zip', 'https://cdn.example.com/d/demo.json'), '/abs/x.zip');
  assert.equal(resolveRelative('https://other/x.zip', '/demos/x/demo.json'), 'https://other/x.zip');
  assert.equal(absoluteUrl('/demos/x/shopware.zip', 'https://playground.fos.gg'), 'https://playground.fos.gg/demos/x/shopware.zip');
  assert.equal(absoluteUrl('https://cdn/x.zip', 'https://playground.fos.gg'), 'https://cdn/x.zip');
});

test('resolveDemo validates and fills defaults', () => {
  const demo = resolveDemo(
    { id: 'frosh-tools-pr-12', label: 'FroshTools PR 12', shopware: '6.7.13.1', seed: 'abc' },
    'https://cdn.example.com/demo/demo.json',
    { source: 'remote', storageKey: 'remote-deadbeef' }
  );
  assert.equal(demo.zip, 'https://cdn.example.com/demo/shopware.zip');
  assert.equal(demo.dump, 'https://cdn.example.com/demo/shopware.sql.gz');
  assert.equal(demo.assets, 'https://cdn.example.com/demo/assets');
  assert.equal(demo.storageKey, 'remote-deadbeef');
  assert.equal(demo.admin, null);
  assert.equal(demoAssetUrl('/theme/a/all.css', demo.assets), 'https://cdn.example.com/demo/assets/theme/a/all.css');

  const builtIn = resolveDemo({ id: '6.7.13.1', shopware: '6.7.13.1', zip: '/demos/6.7.13.1/shopware.zip' }, '/demos.json', { source: 'index' });
  assert.equal(builtIn.label, 'Shopware 6.7.13.1');
  assert.equal(builtIn.zip, '/demos/6.7.13.1/shopware.zip');
  assert.equal(builtIn.dump, '/shopware.sql.gz', 'defaults resolve against the index location');
  assert.equal(builtIn.storageKey, '6.7.13.1');

  assert.throws(() => resolveDemo({ label: 'no id' }, '/x/demo.json'), /"id"/);
  assert.throws(() => resolveDemo({ id: 'x', format: 99 }, '/x/demo.json'), /newer/);
  assert.throws(() => resolveDemo(null, '/x/demo.json'), /not an object/);
});

test('demo index merges built-in demo directories with site-relative URLs', () => {
  const publicDir = mkdtempSync(join(tmpdir(), 'pg-demos-'));
  try {
    const write = (id, dumpBytes) => {
      const dir = join(publicDir, 'demos', id);
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'shopware.zip'), 'zip');
      writeFileSync(join(dir, 'shopware.sql.gz'), dumpBytes);
      writeFileSync(
        join(dir, 'demo.json'),
        JSON.stringify({
          format: 1,
          id,
          label: 'Shopware ' + id,
          shopware: id,
          zip: 'shopware.zip',
          dump: 'shopware.sql.gz',
          assets: 'assets',
          seed: seedOf(join(dir, 'shopware.sql.gz')),
        })
      );
    };
    write('6.6.10.23', 'dump-66');
    write('6.7.13.1', 'dump-67');

    const { demo } = readDemoDir(join(publicDir, 'demos', '6.7.13.1'));
    assert.equal(demo.id, '6.7.13.1');
    assert.throws(() => readDemoDir(join(publicDir, 'demos', 'nope')), /not a demo directory/);

    let index = updateDemoIndex(publicDir, '6.6.10.23');
    assert.equal(index.default, '6.6.10.23');
    index = updateDemoIndex(publicDir, '6.7.13.1');
    assert.deepEqual(
      index.demos.map((d) => d.id),
      ['6.7.13.1', '6.6.10.23'],
      'newest first'
    );
    assert.equal(index.default, '6.6.10.23', 'an existing valid default is kept');
    const entry = index.demos[0];
    assert.equal(entry.zip, '/demos/6.7.13.1/shopware.zip');
    assert.equal(entry.dump, '/demos/6.7.13.1/shopware.sql.gz');
    assert.equal(entry.assets, '/demos/6.7.13.1/assets');
    assert.equal(entry.seed, seedOf(join(publicDir, 'demos', '6.7.13.1', 'shopware.sql.gz')));
    assert.ok(existsSync(join(publicDir, 'demos.json')));
    assert.equal(JSON.parse(readFileSync(join(publicDir, 'demos.json'), 'utf8')).demos.length, 2);

    // Index entries resolve exactly like the shell does it.
    const resolved = resolveDemo(entry, '/demos.json', { source: 'index' });
    assert.equal(resolved.assets, '/demos/6.7.13.1/assets');
    assert.equal(defaultDemoAssetsDir(publicDir), join(publicDir, 'demos', '6.6.10.23', 'assets'));

    // Rebuilding a demo replaces its entry instead of duplicating it.
    index = updateDemoIndex(publicDir, '6.7.13.1');
    assert.equal(index.demos.length, 2);
  } finally {
    rmSync(publicDir, { recursive: true, force: true });
  }
});
