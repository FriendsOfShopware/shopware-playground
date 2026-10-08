/**
 * Node-side demo packaging: turn an installed Shopware tree into a demo
 * directory (see src/demo.mjs for the format) and maintain public/demos.json,
 * the index of built-in demos the shell boots from.
 *
 *   <outDir>/demo.json          descriptor
 *   <outDir>/shopware.zip       MEMFS image of the tree (vendor included)
 *   <outDir>/shopware.sql.gz    seed dump (written by the installer)
 *   <outDir>/assets/...         public/{bundles,theme,media,thumbnail}
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEMO_MANIFEST, demoManifestFields, isDemoId, resolveDemo } from './demo.mjs';
import { copyBundlePublicAssets } from './frontend-assets.mjs';
import { ADMIN_PASSWORD, ADMIN_USERNAME } from './admin-credentials.mjs';

export const DEMO_ASSET_DIRS = ['bundles', 'theme', 'media', 'thumbnail'];
export const DUMP_FILE = 'shopware.sql.gz';
export const ZIP_FILE = 'shopware.zip';

/** Detect "6.7.13.1" from composer.lock (SHOPWARE_VERSION env wins). */
export function detectShopwareVersion(dir) {
  if (process.env.SHOPWARE_VERSION) return process.env.SHOPWARE_VERSION;
  try {
    const lock = JSON.parse(readFileSync(join(dir, 'composer.lock'), 'utf8'));
    const pkg = (lock.packages || []).find((p) => p.name === 'shopware/core');
    return String(pkg?.version || '').replace(/^v/, '');
  } catch {
    return '';
  }
}

/** Built-in demos live under public/demos/<id>/. */
export function demoDir(publicDir, id) {
  return join(publicDir, 'demos', id);
}

export function demoDumpPath(publicDir, id) {
  return join(demoDir(publicDir, id), DUMP_FILE);
}

/** Content identity of a dump; the shell wipes a persisted browser database whose seed differs. */
export function seedOf(dumpPath) {
  try {
    return createHash('sha256').update(readFileSync(dumpPath)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/** Read and resolve a demo directory's manifest (throws when invalid). */
export function readDemoDir(dir) {
  const manifestPath = join(dir, DEMO_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error('not a demo directory (no ' + DEMO_MANIFEST + '): ' + dir);
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const demo = resolveDemo(raw, '/' + DEMO_MANIFEST, { source: 'index' });
  for (const [label, rel] of [
    ['zip', demo.zip],
    ['dump', demo.dump],
  ]) {
    if (!existsSync(join(dir, rel.replace(/^\//, '')))) {
      throw new Error('demo ' + label + ' missing: ' + join(dir, rel));
    }
  }
  return { demo, raw };
}

function zipTree(shopwareDir, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath);
  const zip = spawnSync(
    'zip',
    [
      '-qr',
      zipPath,
      '.',
      '-x',
      'node_modules/*',
      'node_modules/**',
      'var/log/*',
      'var/log/**',
      // regenerable, and a stale routing-domain cache breaks origin rewrites
      'var/cache/*',
      'var/cache/**',
      // served statically from the demo's assets/ dir instead
      'public/bundles/administration/*',
      'public/bundles/administration/**',
    ],
    { cwd: shopwareDir, stdio: 'inherit' }
  );
  if (zip.status !== 0) {
    throw new Error('zip failed for ' + shopwareDir + ' (is `zip` installed?)');
  }
}

/**
 * Package an installed Shopware tree into `outDir`. The seed dump must
 * already be there (installShopware writes it) unless `dumpPath` points at
 * one to copy in.
 *
 * @param {{ shopwareDir: string, outDir: string, id?: string, label?: string,
 *   shopwareVersion?: string, dumpPath?: string, forceZip?: boolean,
 *   admin?: { username: string, password: string }, log?: (msg: string) => void }} options
 */
export function buildDemo(options) {
  const log = options.log || console.log;
  const shopwareDir = resolve(options.shopwareDir);
  const outDir = resolve(options.outDir);
  const shopwareVersion = options.shopwareVersion || detectShopwareVersion(shopwareDir);
  if (!shopwareVersion) {
    throw new Error('cannot detect Shopware version in ' + shopwareDir + '; set SHOPWARE_VERSION');
  }
  const id = options.id || shopwareVersion;
  if (!isDemoId(id)) {
    throw new Error('invalid demo id ' + JSON.stringify(id) + ' (allowed: a-z 0-9 . _ -)');
  }
  if (!existsSync(join(shopwareDir, 'vendor/autoload.php'))) {
    throw new Error('vendor missing; run composer install in ' + shopwareDir);
  }
  mkdirSync(outDir, { recursive: true });

  const dumpPath = join(outDir, DUMP_FILE);
  if (options.dumpPath && resolve(options.dumpPath) !== dumpPath) {
    cpSync(options.dumpPath, dumpPath);
  }
  if (!existsSync(dumpPath)) {
    throw new Error(
      'seed dump missing: ' + dumpPath + ' — run the installer first (node src/prepare-install.mjs)'
    );
  }

  // Static assets: bundle publics + compiled theme + uploaded media.
  copyBundlePublicAssets(shopwareDir);
  const assetsDir = join(outDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  for (const dir of DEMO_ASSET_DIRS) {
    const from = join(shopwareDir, 'public', dir);
    if (!existsSync(from)) continue;
    const to = join(assetsDir, dir);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
  log('copied assets to ' + assetsDir);

  const zipPath = join(outDir, ZIP_FILE);
  if (existsSync(zipPath) && !options.forceZip) {
    log('keeping existing ' + zipPath);
  } else {
    zipTree(shopwareDir, zipPath);
    log('wrote ' + zipPath);
  }

  const manifest = demoManifestFields({
    id,
    label: options.label || 'Shopware ' + shopwareVersion,
    shopware: shopwareVersion,
    zip: ZIP_FILE,
    dump: DUMP_FILE,
    assets: 'assets',
    seed: seedOf(dumpPath),
    admin: options.admin || { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    createdAt: new Date().toISOString(),
  });
  writeFileSync(join(outDir, DEMO_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  log('wrote ' + join(outDir, DEMO_MANIFEST));
  return manifest;
}

/**
 * Merge a built-in demo (public/demos/<id>/) into public/demos.json. Index
 * entries carry site-relative URLs so the shell needs no second fetch.
 */
export function updateDemoIndex(publicDir, id) {
  const indexPath = join(publicDir, 'demos.json');
  let index = { default: '', demos: [] };
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      /* rewrite corrupt index */
    }
  }
  const { raw } = readDemoDir(demoDir(publicDir, id));
  const base = '/demos/' + id + '/';
  const entry = {
    ...raw,
    zip: base + raw.zip,
    dump: base + raw.dump,
    assets: base + String(raw.assets || 'assets').replace(/\/+$/, ''),
  };
  index.demos = [...(index.demos || []).filter((d) => d.id !== id), entry];
  index.demos.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  if (!index.default || !index.demos.some((d) => d.id === index.default)) {
    index.default = index.demos[0].id;
  }
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  return index;
}

export function readDemoIndex(publicDir) {
  try {
    return JSON.parse(readFileSync(join(publicDir, 'demos.json'), 'utf8'));
  } catch {
    return { default: '', demos: [] };
  }
}

/**
 * Where /bundles|/theme|/media|/thumbnail resolve without the service worker
 * (curl, first paint): the default built-in demo's assets directory.
 */
export function defaultDemoAssetsDir(publicDir) {
  const index = readDemoIndex(publicDir);
  const id = index.default || index.demos?.[0]?.id || '';
  return id ? join(demoDir(publicDir, id), 'assets') : '';
}
