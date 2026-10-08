/**
 * `playground demo pack`: install a Shopware tree (plus plugins) under PHP
 * WASM and package it as a self-contained demo directory — the step a CI
 * job runs before `playground demo upload`.
 *
 * The tree must contain the playground overrides (overrides/,
 * config/packages/playground.yaml, the Playground DBAL driver); copying
 * this repository's shopware/ directory over a fresh `composer
 * create-project shopware/production` does that.
 */
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installShopware } from './prepare-install.mjs';
import { buildDemo, DUMP_FILE, detectShopwareVersion } from './demo-build.mjs';
import { isDemoId } from './demo.mjs';

/**
 * @param {{ shopwareDir: string, outDir: string, id?: string, label?: string,
 *   plugins?: string[], reuseInstall?: boolean, log?: (msg: string) => void }} options
 */
export async function packDemo(options) {
  const log = options.log || console.log;
  const shopwareDir = resolve(options.shopwareDir);
  const outDir = resolve(options.outDir);
  if (!existsSync(join(shopwareDir, 'composer.json'))) {
    throw new Error('not a Shopware project: ' + shopwareDir);
  }
  const shopwareVersion = detectShopwareVersion(shopwareDir);
  if (!shopwareVersion) {
    throw new Error('cannot detect Shopware version in ' + shopwareDir + ' (composer.lock)');
  }
  const id = options.id || shopwareVersion;
  if (!isDemoId(id)) {
    throw new Error('invalid demo id ' + JSON.stringify(id) + ' (allowed: a-z 0-9 . _ -)');
  }

  const dumpPath = join(outDir, DUMP_FILE);
  if (options.reuseInstall && existsSync(dumpPath)) {
    log('reusing existing install dump ' + dumpPath);
  } else {
    rmSync(outDir, { recursive: true, force: true });
    await installShopware({
      shopwareDir,
      dumpPath,
      plugins: options.plugins || [],
      log,
    });
  }

  const manifest = buildDemo({
    shopwareDir,
    outDir,
    id,
    label: options.label,
    shopwareVersion,
    forceZip: true,
    log,
  });
  return { outDir, manifest };
}
