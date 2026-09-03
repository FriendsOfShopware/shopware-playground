#!/usr/bin/env node
/**
 * Shell bundling shared by copy-assets.mjs (full build) and `npm run dev`
 * (workers only, then Vite serves the app with HMR):
 *
 * - app.js: Svelte shell, built by Vite (lib mode, see vite.config.mjs)
 * - browser-worker.js / service-worker.js: plain JS with WASM asset loaders
 *   and php-wasm version aliases — built by esbuild (Vite/Rollup would need
 *   extra plugins for the .wasm/.so loaders; no benefit moving these)
 *
 * CLI: node src/build-shell.mjs [--workers] [--app]   (default: both)
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const emptyShim = join(root, 'shims/empty.mjs');
const phpWasmAliases = Object.fromEntries(
  ['web-5-2', 'web-7-4', 'web-8-0', 'web-8-1', 'web-8-2', 'web-8-3', 'web-8-5'].map(
    (name) => ['@php-wasm/' + name, emptyShim]
  )
);

async function esbuildBundle(entry, outfile) {
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      outfile,
      loader: { '.wasm': 'file', '.so': 'file', '.la': 'file', '.dat': 'file' },
      assetNames: 'assets/[name]-[hash]',
      publicPath: '/',
      alias: { worker_threads: emptyShim, ...phpWasmAliases },
      external: ['/mariadb/*', '/php/*'],
      logLevel: 'warning',
    });
  } catch (err) {
    throw new Error('esbuild bundle failed for ' + entry + ': ' + (err.message || err));
  }
}

export async function buildWorkers() {
  await esbuildBundle(join(root, 'src/browser-worker.mjs'), join(root, 'public/browser-worker.js'));
  await esbuildBundle(join(root, 'src/service-worker.mjs'), join(root, 'public/service-worker.js'));
  console.log('bundled browser worker and service worker (esbuild)');
}

export async function buildApp() {
  await viteBuild({ root, logLevel: 'warn' });
  console.log('bundled app.js (vite)');
}

export async function buildShell() {
  await buildApp();
  await buildWorkers();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const onlyWorkers = args.includes('--workers');
  const onlyApp = args.includes('--app');
  const run = onlyWorkers || onlyApp ? false : true;
  try {
    if (run || onlyApp) await buildApp();
    if (run || onlyWorkers) await buildWorkers();
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
