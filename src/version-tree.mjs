#!/usr/bin/env node
/**
 * Materialise a built-in version tree on a fresh checkout.
 *
 * Only the playground-specific files of versions-src/<version>/shopware are
 * committed (composer.json/lock, config/, overrides/, src/Playground/). The
 * rest of the shopware/production skeleton (bin/, public/index.php, .env,
 * custom/, …) is identical across versions and is copied from ./shopware.
 * Existing files are never overwritten.
 *
 *   node src/version-tree.mjs 6.6.10.29
 *   composer -d versions-src/6.6.10.29/shopware install
 *   SHOPWARE_DIR=versions-src/6.6.10.29/shopware node src/prepare-install.mjs
 *   SHOPWARE_DIR=versions-src/6.6.10.29/shopware npm run build
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node src/version-tree.mjs <shopware-version>  (e.g. 6.6.10.29)');
  process.exit(1);
}

const sourceTree = join(root, 'shopware');
const targetTree = join(root, 'versions-src', version, 'shopware');
// Files tracked in ./shopware except the per-version ones.
const tracked = execFileSync('git', ['ls-files', 'shopware'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((f) => f.slice('shopware/'.length))
  .filter((rel) => !/^(vendor|overrides|config|src\/Playground)\//.test(rel))
  .filter((rel) => rel !== 'composer.json' && rel !== 'composer.lock');

let copied = 0;
for (const rel of tracked) {
  const to = join(targetTree, rel);
  if (existsSync(to)) continue;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(sourceTree, rel), to);
  copied++;
}
for (const dir of ['custom/plugins', 'custom/static-plugins', 'custom/apps', 'files', 'var']) {
  mkdirSync(join(targetTree, dir), { recursive: true });
}
for (const required of ['composer.json', 'overrides/patch-installer.php', 'src/Playground/MariadbLiteDriver.php']) {
  if (!existsSync(join(targetTree, required))) {
    console.warn('warning: ' + join('versions-src', version, 'shopware', required) + ' missing — commit the version-specific files first');
  }
}
console.log('copied ' + copied + ' skeleton files into versions-src/' + version + '/shopware');
console.log('next: composer -d versions-src/' + version + '/shopware install');
