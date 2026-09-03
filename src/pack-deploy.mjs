#!/usr/bin/env node
/**
 * Stage a static host tree (engine + version bundles) and zip it.
 * Shop URLs are not baked in: the browser rewrites sales_channel_domain
 * to location.origin on boot.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mariadbDist = dirname(fileURLToPath(import.meta.resolve('lite4mariadb')));
const publicDir = join(root, 'public');
const dest = join(root, 'dist/deploy');
const zipPath = join(root, 'dist/shopware-playground-static.zip');

const HEADERS = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin

/service-worker.js
  Service-Worker-Allowed: /
  Cache-Control: no-store
`;

const REDIRECTS = `/index.php    /index.html   200
/index.php/*  /index.html   200
`;

function copyInto(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  return true;
}

function required(path, label) {
  if (!existsSync(path)) {
    throw new Error(label + ' missing: ' + path);
  }
}

required(join(publicDir, 'index.html'), 'playground shell');
required(join(publicDir, 'app.js'), 'bundled app.js (npm run build)');
required(join(publicDir, 'browser-worker.js'), 'bundled browser-worker.js');
required(join(publicDir, 'service-worker.js'), 'bundled service-worker.js');
required(join(publicDir, 'versions.json'), 'version manifest (npm run build)');
required(join(mariadbDist, 'lite4mariadb.wasm'), 'lite4mariadb engine (npm install)');

const manifest = JSON.parse(readFileSync(join(publicDir, 'versions.json'), 'utf8'));
for (const v of manifest.versions || []) {
  required(join(publicDir, 'versions', v.id, 'shopware.sql.gz'), 'installed dump for ' + v.id);
  required(join(publicDir, 'versions', v.id, 'shopware.zip'), 'Shopware MEMFS zip for ' + v.id);
}

if (existsSync(dest)) rmSync(dest, { recursive: true });
mkdirSync(dest, { recursive: true });

copyInto(publicDir, dest);
copyInto(mariadbDist, join(dest, 'mariadb'));
copyInto(join(root, 'php'), join(dest, 'php'));

// Administration assets are heavy and optional on size-constrained hosts.
for (const v of manifest.versions || []) {
  rmSync(join(dest, 'versions', v.id, 'assets', 'bundles', 'administration'), {
    recursive: true,
    force: true,
  });
}

writeFileSync(join(dest, '_headers'), HEADERS);
writeFileSync(join(dest, '_redirects'), REDIRECTS);

if (existsSync(zipPath)) rmSync(zipPath);
const zip = spawnSync('zip', ['-qr', zipPath, '.'], { cwd: dest, stdio: 'inherit' });
if (zip.status !== 0) {
  throw new Error('zip failed; install zip or use dist/deploy/ as the upload directory');
}

const st = statSync(zipPath);
console.log('wrote', zipPath, '(' + Math.round(st.size / 1024 / 1024) + ' MiB)');
console.log('upload dist/deploy/ (or the zip) to any static host with COOP/COEP');
console.log('shop URLs rewrite at boot to location.origin — no APP_URL bake-in');
