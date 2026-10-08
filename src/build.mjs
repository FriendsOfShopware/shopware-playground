#!/usr/bin/env node
/**
 * Build the browser bundle: esbuild/vite the shell, worker and service
 * worker, then package the Shopware tree as a built-in demo:
 *
 *   public/demos/<id>/demo.json       descriptor
 *   public/demos/<id>/shopware.zip    MEMFS image
 *   public/demos/<id>/shopware.sql.gz seed dump (from prepare-install.mjs)
 *   public/demos/<id>/assets/...      bundles/theme/media served statically
 *   public/demos.json                 index of built-in demos for the shell
 *
 * The lite4mariadb engine is served from node_modules — nothing to copy.
 *
 * Env: SHOPWARE_DIR (default ./shopware; point at versions-src/<v>/shopware
 * for the other toggle entries), SHOPWARE_VERSION (default: detected from
 * composer.lock), FORCE_ZIP=1 to rebuild the zip, SHELL_ONLY=1 to skip the
 * demo (just rebuild app.js + workers).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildShell } from './build-shell.mjs';
import { buildDemo, demoDir, detectShopwareVersion, updateDemoIndex } from './demo-build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const shopwareDir = process.env.SHOPWARE_DIR
  ? resolve(process.env.SHOPWARE_DIR)
  : join(root, 'shopware');

mkdirSync(publicDir, { recursive: true });

const lite4mariadbDist = dirname(fileURLToPath(import.meta.resolve('lite4mariadb')));
if (!existsSync(join(lite4mariadbDist, 'lite4mariadb.wasm'))) {
  throw new Error('lite4mariadb dist missing; run npm install');
}

await buildShell();

if (process.env.SHELL_ONLY === '1') {
  console.log('SHELL_ONLY=1: skipped demo packaging');
} else {
  const version = detectShopwareVersion(shopwareDir);
  if (!version) {
    throw new Error('cannot detect Shopware version; set SHOPWARE_VERSION');
  }
  console.log('packaging built-in demo for Shopware', version);

  // Built-in trees are patched in place so the installer and the browser
  // boot the same code (idempotent).
  const patcher = join(shopwareDir, 'overrides/patch-installer.php');
  if (existsSync(patcher)) {
    const patched = spawnSync('php', [patcher], { cwd: shopwareDir, stdio: 'inherit' });
    if (patched.status !== 0) {
      console.warn('Shopware installer patcher failed');
    }
  }

  const outDir = demoDir(publicDir, version);
  if (!existsSync(join(outDir, 'shopware.sql.gz'))) {
    throw new Error(
      'demos/' + version + '/shopware.sql.gz missing; run node src/prepare-install.mjs' +
        (process.env.SHOPWARE_DIR ? ' with SHOPWARE_DIR=' + shopwareDir : '')
    );
  }
  buildDemo({
    shopwareDir,
    outDir,
    id: version,
    shopwareVersion: version,
    forceZip: process.env.FORCE_ZIP === '1',
  });

  const index = updateDemoIndex(publicDir, version);
  console.log(
    'demos.json:',
    index.demos.map((d) => d.id).join(', '),
    '(default ' + index.default + ')'
  );
}
