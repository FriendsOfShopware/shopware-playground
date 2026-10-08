/**
 * `playground demo upload`: push a packed demo directory to the playground's
 * R2 bucket under demos/<name>/ so it opens at
 *   https://playground.fos.gg/?demo=<name>
 * The Cloudflare Worker serves /demos/<name>/* straight from R2 (same
 * origin — no CORS setup needed). Re-uploading the same name replaces the
 * demo; browsers that cached the old database notice the changed seed and
 * re-import.
 */
import { resolve } from 'node:path';
import { readDemoDir } from './demo-build.mjs';
import { DEMO_MANIFEST, isDemoId } from './demo.mjs';
import { listRemoteObjects, r2Client, syncToR2, walk } from './r2.mjs';

export const DEFAULT_PLAYGROUND_URL = 'https://playground.fos.gg';

/**
 * @param {{ dir: string, name?: string, force?: boolean, playgroundUrl?: string,
 *   log?: (msg: string) => void }} options
 * @returns {Promise<{ name: string, url: string, uploaded: number, skipped: number }>}
 */
export async function uploadDemo(options) {
  const log = options.log || console.log;
  const dir = resolve(options.dir);
  const { demo } = readDemoDir(dir);
  const name = options.name || demo.id;
  if (!isDemoId(name)) {
    throw new Error('invalid demo name ' + JSON.stringify(name) + ' (allowed: a-z 0-9 . _ -)');
  }
  const prefix = 'demos/' + name + '/';
  const client = r2Client();
  log('uploading demo "' + demo.label + '" (' + dir + ') → ' + client.bucket + '/' + prefix);
  const uploads = [...walk(dir, prefix)];
  const remote = await listRemoteObjects(client, prefix);
  const { uploaded, skipped } = await syncToR2(client, uploads, {
    force: options.force,
    remote,
    // the manifest, zip and dump define the demo — never trust a size match
    always: [prefix + DEMO_MANIFEST, prefix + 'shopware.zip', prefix + 'shopware.sql.gz'],
    log,
  });
  const url =
    (options.playgroundUrl || process.env.PLAYGROUND_URL || DEFAULT_PLAYGROUND_URL).replace(/\/+$/, '') +
    '/?demo=' +
    encodeURIComponent(name);
  return { name, url, uploaded, skipped };
}
