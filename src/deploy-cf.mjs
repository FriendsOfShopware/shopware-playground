#!/usr/bin/env node
/**
 * Deploy the playground to Cloudflare Workers (playground.fos.gg).
 *
 * 1. Syncs heavy payloads to the R2 bucket over the S3 API (parallel,
 *    skips objects whose size already matches — content is versioned):
 *      public/demos/**     → demos/**       public/assets/** → assets/**
 *      lite4mariadb dist   → mariadb/**     php/**           → php/**
 *      public/demos.json   → demos.json
 *    Demos uploaded separately (playground demo upload) live under the
 *    same demos/ prefix and are left untouched.
 * 2. Stages dist/cf-site/ (shell files only — Workers Static Assets dir).
 * 3. wrangler deploy (Worker + custom domain from wrangler.toml).
 *
 * Required env for the R2 sync: see src/r2.mjs.
 * `wrangler deploy` uses the wrangler login (wrangler login / OAuth).
 *
 * Flags: --sync-only (R2 only), --worker-only (stage + deploy only),
 *        --force (re-upload all objects).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { r2Client, syncToR2, walk } from './r2.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const siteDir = join(root, 'dist/cf-site');
const mariadbDist = dirname(fileURLToPath(import.meta.resolve('lite4mariadb')));

const args = process.argv.slice(2);
const syncOnly = args.includes('--sync-only');
const workerOnly = args.includes('--worker-only');
const force = args.includes('--force');

function required(path, label) {
  if (!existsSync(path)) throw new Error(label + ' missing: ' + path);
}

function collectUploads() {
  const uploads = [];
  for (const { file, key } of walk(join(publicDir, 'demos'), 'demos/')) uploads.push({ file, key });
  for (const { file, key } of walk(join(publicDir, 'assets'), 'assets/')) uploads.push({ file, key });
  for (const { file, key } of walk(mariadbDist, 'mariadb/')) uploads.push({ file, key });
  for (const { file, key } of walk(join(root, 'php'), 'php/')) uploads.push({ file, key });
  uploads.push({ file: join(publicDir, 'demos.json'), key: 'demos.json' });
  return uploads;
}

async function syncR2() {
  const client = r2Client();
  console.log('listing R2 bucket ' + client.bucket + '…');
  const { uploaded } = await syncToR2(client, collectUploads(), {
    force,
    // tiny, and the index must always reflect the local build
    always: ['demos.json'],
  });
  console.log('R2 sync complete (' + uploaded + ' uploaded)');
}

function stageSite() {
  if (existsSync(siteDir)) rmSync(siteDir, { recursive: true });
  mkdirSync(siteDir, { recursive: true });
  for (const name of ['index.html', 'app.js', 'browser-worker.js', 'service-worker.js']) {
    copyFileSync(join(publicDir, name), join(siteDir, name));
  }
  console.log('staged ' + relative(root, siteDir) + ' (shell files)');
}

function deployWorker() {
  const res = spawnSync('npx', ['wrangler', 'deploy'], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) throw new Error('wrangler deploy failed');
}

for (const name of ['index.html', 'app.js', 'browser-worker.js', 'service-worker.js', 'demos.json']) {
  required(join(publicDir, name), 'build output (npm run build)');
}
const index = JSON.parse(readFileSync(join(publicDir, 'demos.json'), 'utf8'));
for (const d of index.demos || []) {
  required(join(publicDir, 'demos', d.id, 'demo.json'), 'demo manifest for ' + d.id);
  required(join(publicDir, 'demos', d.id, 'shopware.zip'), 'Shopware zip for ' + d.id);
  required(join(publicDir, 'demos', d.id, 'shopware.sql.gz'), 'SQL dump for ' + d.id);
}

if (!workerOnly) await syncR2();
if (!syncOnly) {
  stageSite();
  deployWorker();
  console.log('deployed — https://playground.fos.gg');
}
