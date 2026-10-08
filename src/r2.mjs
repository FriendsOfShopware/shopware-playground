/**
 * Cloudflare R2 over the S3 API (aws4fetch): list a bucket and sync local
 * files into it. Shared by deploy-cf.mjs (whole site) and upload-demo.mjs
 * (one demo directory, e.g. from a GitHub Actions run).
 *
 * Required env (R2 → Manage R2 API Tokens → read+write):
 *   CF_ACCOUNT_ID / R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Optional: PLAYGROUND_R2_BUCKET (default shopware-playground)
 */
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { contentTypeFor } from './cf-content-types.mjs';

export const DEFAULT_BUCKET = 'shopware-playground';
const CONCURRENCY = 16;

export function r2Client(options = {}) {
  const accountId = options.accountId || process.env.CF_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
  const accessKeyId = options.accessKeyId || process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
  const bucket = options.bucket || process.env.PLAYGROUND_R2_BUCKET || DEFAULT_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 credentials missing. Set CF_ACCOUNT_ID (or R2_ACCOUNT_ID), ' +
        'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY — create a read+write token ' +
        'under R2 → Manage R2 API Tokens.'
    );
  }
  return {
    bucket,
    s3: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    base: 'https://' + accountId + '.r2.cloudflarestorage.com/' + bucket,
  };
}

/** Recursively yield { file, key } pairs for a directory. */
export function* walk(dir, keyPrefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, keyPrefix + entry.name + '/');
    } else if (entry.isFile()) {
      yield { file: full, key: keyPrefix + entry.name };
    }
  }
}

/** key → size for every object under `prefix` (all objects when omitted). */
export async function listRemoteObjects(client, prefix = '') {
  const sizes = new Map();
  let token;
  do {
    const url = new URL(client.base);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('max-keys', '1000');
    if (prefix) url.searchParams.set('prefix', prefix);
    if (token) url.searchParams.set('continuation-token', token);
    const res = await client.s3.fetch(url);
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      const err = new Error('R2 list failed: ' + res.status + ' ' + text);
      if (/403|404|Signature|AccessDenied|NoSuchBucket/i.test(res.status + ' ' + text)) {
        err.message += '\nHint: create the bucket first: npx wrangler r2 bucket create ' + client.bucket;
      }
      throw err;
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

export async function putObject(client, { file, key }) {
  const url = client.base + '/' + key.split('/').map(encodeURIComponent).join('/');
  const res = await client.s3.fetch(url, {
    method: 'PUT',
    body: createReadStream(file),
    headers: {
      'content-type': contentTypeFor(key),
      'content-length': String(statSync(file).size),
    },
  });
  if (!res.ok) {
    throw new Error('PUT failed ' + res.status + ' ' + key + ': ' + (await res.text()).slice(0, 160));
  }
}

/**
 * Upload `uploads` ({ file, key }) in parallel, skipping objects whose
 * remote size already matches (content is versioned by path, so size is a
 * good enough identity) unless `force` or the key is in `always`.
 *
 * @returns {Promise<{ uploaded: number, skipped: number }>}
 */
export async function syncToR2(client, uploads, options = {}) {
  const log = options.log || console.log;
  const always = new Set(options.always || []);
  const remote = options.remote || (await listRemoteObjects(client, options.prefix || ''));
  const pending = uploads.filter(
    ({ file, key }) => options.force || always.has(key) || remote.get(key) !== statSync(file).size
  );
  log(uploads.length + ' local objects, ' + remote.size + ' remote → ' + pending.length + ' to upload');

  let done = 0;
  const failures = [];
  const queue = [...pending];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) continue;
        try {
          await putObject(client, item);
          done++;
          if (done % 250 === 0) log('  uploaded ' + done + '/' + pending.length);
        } catch (err) {
          failures.push(err);
          console.error(err.message);
        }
      }
    })
  );
  if (failures.length) throw new Error(failures.length + ' R2 uploads failed');
  return { uploaded: done, skipped: uploads.length - done };
}
