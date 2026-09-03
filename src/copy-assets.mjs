#!/usr/bin/env node
/**
 * Build the browser bundle: esbuild the shell/worker/service-worker,
 * then assemble the version bundle for the Shopware tree:
 *
 *   public/versions/<v>/shopware.zip      MEMFS image
 *   public/versions/<v>/shopware.sql.gz   seed dump (first boot per browser)
 *   public/versions/<v>/assets/...        bundles/theme/media served statically
 *   public/versions.json                  version manifest for the shell
 *
 * The lite4mariadb engine is served from node_modules — nothing to copy.
 *
 * Env: SHOPWARE_DIR (default ./shopware), SHOPWARE_VERSION (default: detected
 * from composer.lock), FORCE_ZIP=1 to rebuild the zip.
 */
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildShell } from './build-shell.mjs';
import { copyBundlePublicAssets } from './frontend-assets.mjs';
import { detectShopwareVersion, updateVersionsManifest, versionBundleDir } from './shopware-version.mjs';

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

const version = detectShopwareVersion(shopwareDir);
if (!version) {
  throw new Error('cannot detect Shopware version; set SHOPWARE_VERSION');
}
const versionDir = versionBundleDir(publicDir, version);
const versionAssets = join(versionDir, 'assets');
mkdirSync(versionAssets, { recursive: true });
console.log('building version bundle for Shopware', version);

const patcher = join(shopwareDir, 'overrides/patch-installer.php');
if (existsSync(patcher)) {
  const patched = spawnSync('php', [patcher], { cwd: shopwareDir, stdio: 'inherit' });
  if (patched.status !== 0) {
    console.warn('Shopware installer patcher failed');
  } else {
    console.log('patched Shopware installer for MariaDB WASM / PHP WASM');
  }
}

await buildShell();

// Static per-version assets: bundle publics + compiled theme + uploaded media.
copyBundlePublicAssets(shopwareDir);
for (const dir of ['bundles', 'theme', 'media', 'thumbnail']) {
  const from = join(shopwareDir, 'public', dir);
  if (!existsSync(from)) continue;
  const to = join(versionAssets, dir);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}
console.log('copied version assets to public/versions/' + version + '/assets');

// The seed dump is written here by prepare-install.mjs.
if (!existsSync(join(versionDir, 'shopware.sql.gz'))) {
  console.warn('versions/' + version + '/shopware.sql.gz missing; run node src/prepare-install.mjs');
}

if (!existsSync(join(shopwareDir, 'vendor/autoload.php'))) {
  throw new Error('shopware/vendor missing; composer install in ' + shopwareDir);
}

const zipPath = join(versionDir, 'shopware.zip');
if (existsSync(zipPath) && process.env.FORCE_ZIP !== '1') {
  console.log('keeping existing', zipPath);
} else {
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
      'public/bundles/administration/*',
      'public/bundles/administration/**',
    ],
    { cwd: shopwareDir, stdio: 'inherit' }
  );
  if (zip.status !== 0) {
    console.warn('zip not available or failed; browser MEMFS copy will be skipped');
  } else {
    console.log('wrote', zipPath);
  }
}

// Merge this version into the manifest the shell boots from.
const manifest = updateVersionsManifest(publicDir, version);
console.log('versions.json:', manifest.versions.map((v) => v.id).join(', '), '(default ' + manifest.default + ')');
