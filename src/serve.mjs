#!/usr/bin/env node
/**
 * Static playground host with COOP/COEP so MariaDB WASM pthreads can use
 * SharedArrayBuffer. Everything is served from this package:
 * /mariadb/* comes straight from node_modules/lite4mariadb/dist.
 */
import http from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPhpAppRoute } from './app-route.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mariadbDist = dirname(fileURLToPath(import.meta.resolve('lite4mariadb')));
const port = Number(process.env.PORT || 4177);

function defaultVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'public/versions.json'), 'utf8'));
    return manifest.default || manifest.versions?.[0]?.id || '';
  } catch {
    return '';
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.php': 'application/x-httpd-php',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  if (decoded === '/' || decoded === '') {
    return join(root, 'public/index.html');
  }
  if (decoded.startsWith('/mariadb/')) {
    return join(mariadbDist, decoded.slice('/mariadb/'.length));
  }
  if (decoded.startsWith('/shopware-files/')) {
    return join(root, 'shopware', decoded.slice('/shopware-files/'.length));
  }
  if (decoded.startsWith('/php/')) {
    return join(root, 'php', decoded.slice('/php/'.length));
  }
  // /theme|/media|/bundles|/thumbnail reach here only without the service
  // worker (e.g. curl): serve the default version's assets.
  if (
    decoded.startsWith('/bundles/') ||
    decoded.startsWith('/theme/') ||
    decoded.startsWith('/media/') ||
    decoded.startsWith('/thumbnail/')
  ) {
    const version = defaultVersion();
    if (version) {
      const versioned = join(root, 'public/versions', version, 'assets', decoded);
      if (existsSync(versioned)) return versioned;
    }
  }
  if (decoded.startsWith('/src/')) {
    return join(root, decoded.slice(1));
  }
  if (decoded.startsWith('/node_modules/')) {
    return join(root, decoded.slice(1));
  }
  const fromPublic = join(root, 'public', decoded);
  if (existsSync(fromPublic)) return fromPublic;
  return join(root, decoded.slice(1));
}

const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    const filePath = resolvePath(req.url || '/');
    if (relative(root, filePath).startsWith('..')) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const st = statSync(filePath);
    if (st.isDirectory()) {
      res.writeHead(403);
      res.end('dir');
      return;
    }
    const body = readFileSync(filePath);
    const headers = {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    if (filePath.endsWith('/service-worker.js') || filePath.endsWith('\\service-worker.js')) {
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (e) {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const method = (req.method || 'GET').toUpperCase();
    if ((method === 'GET' || method === 'HEAD') && isPhpAppRoute(urlPath)) {
      const index = readFileSync(join(root, 'public/index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(method === 'HEAD' ? '' : index);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + (req.url || '') + '\n' + (e && e.message));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Shopware playground http://127.0.0.1:${port}/ (COOP/COEP)`);
});
