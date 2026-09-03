#!/usr/bin/env node
/**
 * Deploy the playground to Cloudflare Workers (playground.fos.gg).
 *
 * 1. Syncs heavy payloads to the R2 bucket over the S3 API (parallel,
 *    skips objects whose size already matches — content is versioned):
 *      public/versions/**  → versions/**    public/assets/** → assets/**
 *      lite4mariadb dist   → mariadb/**     php/**           → php/**
 *      public/versions.json → versions.json
 * 2. Stages dist/cf-site/ (shell files only — Workers Static Assets dir).
 * 3. wrangler deploy (Worker + custom domain from wrangler.toml).
 *
 * Required env for the R2 sync (R2 → Manage R2 API Tokens → read+write):
 *   CF_ACCOUNT_ID / R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * `wrangler deploy` uses the wrangler login (wrangler login / OAuth).
 *
 * Flags: --sync-only (R2 only), --worker-only (stage + deploy only),
 *        --force (re-upload all objects).
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AwsClient } from 'aws4fetch';
import { contentTypeFor } from './cf-content-types.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const siteDir = join(root, 'dist/cf-site');
const mariadbDist = dirname(fileURLToPath(import.meta.resolve('lite4mariadb')));

const args = process.argv.slice(2);
const syncOnly = args.includes('--sync-only');
const workerOnly = args.includes('--worker-only');
const force = args.includes('--force');

const BUCKET = process.env.PLAYGROUND_R2_BUCKET || 'shopware-playground';
const CONCURRENCY = 16;

function required(path, label) {
  if (!existsSync(path)) throw new Error(label + ' missing: ' + path);
}

function* walk(dir, keyPrefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, keyPrefix + entry.name + '/');
    } else if (entry.isFile()) {
      yield { file: full, key: keyPrefix + entry.name };
    }
  }
}

function collectUploads() {
  const uploads = [];
  for (const { file, key } of walk(join(publicDir, 'versions'), 'versions/')) uploads.push({ file, key });
  for (const { file, key } of walk(join(publicDir, 'assets'), 'assets/')) uploads.push({ file, key });
  for (const { file, key } of walk(mariadbDist, 'mariadb/')) uploads.push({ file, key });
  for (const { file, key } of walk(join(root, 'php'), 'php/')) uploads.push({ file, key });
  uploads.push({ file: join(publicDir, 'versions.json'), key: 'versions.json' });
  return uploads;
}

function r2Client() {
  const accountId = process.env.CF_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 credentials missing. Set CF_ACCOUNT_ID (or R2_ACCOUNT_ID), ' +
        'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY — create a read+write token ' +
        'under R2 → Manage R2 API Tokens.'
    );
  }
  return {
    s3: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    base: 'https://' + accountId + '.r2.cloudflarestorage.com/' + BUCKET,
  };
}

async function listRemoteObjects(s3, base) {
  const sizes = new Map();
  let token;
  do {
    const url = new URL(base);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('max-keys', '1000');
    if (token) url.searchParams.set('continuation-token', token);
    const res = await s3.fetch(url);
    if (!res.ok) {
      throw new Error('R2 list failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
    }
    const xml = await res.text();
    for (const match of xml.matchAll(/<Contents>[\s\S]*?<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(match[0])?.[1];
      const size = Number(/<Size>(\d+)<\/Size>/.exec(match[0])?.[1]);
      if (key) sizes.set(key, size);
    }
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (token);
  return sizes;
}

async function syncR2() {
  const uploads = collectUploads();
  const { s3, base } = r2Client();
  console.log('listing R2 bucket ' + BUCKET + '…');
  let remote;
  try {
    remote = await listRemoteObjects(s3, base);
  } catch (err) {
    if (/403|404|Signature|AccessDenied|NoSuchBucket/i.test(String(err && err.message))) {
      throw new Error(
        (err && err.message) +
          '\nHint: create the bucket first: npx wrangler r2 bucket create ' + BUCKET
      );
    }
    throw err;
  }

  const pending = uploads.filter(
    ({ file, key }) => force || remote.get(key) !== statSync(file).size
  );
  console.log(
    uploads.length + ' local objects, ' + remote.size + ' remote → ' + pending.length + ' to upload'
  );

  let done = 0;
  let failed = 0;
  async function uploadOne({ file, key }) {
    const url = base + '/' + key.split('/').map(encodeURIComponent).join('/');
    const res = await s3.fetch(url, {
      method: 'PUT',
      body: createReadStream(file),
      headers: {
        'content-type': contentTypeFor(key),
        'content-length': String(statSync(file).size),
      },
    });
    if (!res.ok) {
      failed++;
      console.error('PUT failed ' + res.status + ' ' + key + ': ' + (await res.text()).slice(0, 160));
      return;
    }
    done++;
    if (done % 250 === 0) console.log('  uploaded ' + done + '/' + pending.length);
  }

  const queue = [...pending];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item) await uploadOne(item);
      }
    })
  );
  if (failed) throw new Error(failed + ' R2 uploads failed');
  console.log('R2 sync complete (' + done + ' uploaded)');
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

for (const name of ['index.html', 'app.js', 'browser-worker.js', 'service-worker.js', 'versions.json']) {
  required(join(publicDir, name), 'build output (npm run build)');
}
const manifest = JSON.parse(readFileSync(join(publicDir, 'versions.json'), 'utf8'));
for (const v of manifest.versions || []) {
  required(join(publicDir, 'versions', v.id, 'shopware.zip'), 'Shopware zip for ' + v.id);
  required(join(publicDir, 'versions', v.id, 'shopware.sql.gz'), 'SQL dump for ' + v.id);
}

if (!workerOnly) await syncR2();
if (!syncOnly) {
  stageSite();
  deployWorker();
  console.log('deployed — https://playground.fos.gg');
}
