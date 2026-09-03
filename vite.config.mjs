/**
 * Vite is the dev server (HMR for the Svelte shell) and builds the shell
 * bundle (public/app.js, lib mode). The playground needs a few things a
 * plain Vite server doesn't do, mirrored from src/serve.mjs:
 *
 * - COOP/COEP/CORP on everything (MariaDB WASM pthreads need
 *   crossOriginIsolated for SharedArrayBuffer)
 * - /mariadb/* served from node_modules/lite4mariadb/dist
 * - /php/* served from the local php/ dir (auto_prepend)
 * - /bundles|theme|media|thumbnail fallback to the default version's assets
 *   (only hit without the service worker, e.g. curl)
 * - / and PHP app routes serve public/index.html, with the script tag
 *   pointed at /src/browser-entry.mjs so Vite transforms + HMRs the shell
 *
 * Worker and service-worker bundles are plain JS with WASM loader aliases —
 * they stay on esbuild (src/build-shell.mjs), prebuilt into public/.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { isPhpAppRoute } from './src/app-route.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const mariadbDist = dirname(fileURLToPath(import.meta.resolve('lite4mariadb')));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
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
  '.php': 'application/x-httpd-php',
};

function defaultVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(publicDir, 'versions.json'), 'utf8'));
    return manifest.default || manifest.versions?.[0]?.id || '';
  } catch {
    return '';
  }
}

function sendFile(res, filePath) {
  if (relative(root, filePath).startsWith('..')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

function playgroundShell() {
  return {
    name: 'playground-shell',
    configureServer(server) {
      // Pre-phase: runs before Vite's middlewares. Our special paths never
      // collide with Vite's module graph (/src, /@fs, /@vite, node_modules);
      // everything else falls through to publicDir serving + transforms.
      // (A post hook would come after htmlFallbackMiddleware, which rewrites
      // '/' to '/index.html' and breaks shell serving.)
      {
        server.middlewares.use(async (req, res, next) => {
          // We run before Vite's header middleware, so responses we end
          // ourselves would otherwise lack the isolation headers.
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
          const method = (req.method || 'GET').toUpperCase();

          // Vite-internal module requests (/@vite/client, /@id/, /@fs/) have
          // no file extension and would otherwise hit the shell fallback.
          if (urlPath.startsWith('/@')) {
            next();
            return;
          }

          // Runtime-fetched bundle assets carry a literal '?url' query
          // (php-wasm .so/.wasm imports); Vite's static middleware does not
          // strip the query and 404s. Serve any public file directly when a
          // query is present.
          if ((req.url || '').includes('?')) {
            const fromPublic = join(publicDir, urlPath);
            if (existsSync(fromPublic) && !statSync(fromPublic).isDirectory()) {
              sendFile(res, fromPublic);
              return;
            }
          }

          if (urlPath.startsWith('/mariadb/')) {
            sendFile(res, join(mariadbDist, urlPath.slice('/mariadb/'.length)));
            return;
          }
          if (urlPath.startsWith('/php/')) {
            sendFile(res, join(root, 'php', urlPath.slice('/php/'.length)));
            return;
          }
          if (urlPath.startsWith('/shopware-files/')) {
            sendFile(res, join(root, 'shopware', urlPath.slice('/shopware-files/'.length)));
            return;
          }
          if (
            urlPath.startsWith('/bundles/') ||
            urlPath.startsWith('/theme/') ||
            urlPath.startsWith('/media/') ||
            urlPath.startsWith('/thumbnail/')
          ) {
            const version = defaultVersion();
            const versioned = version
              ? join(publicDir, 'versions', version, 'assets', urlPath)
              : '';
            if (versioned && existsSync(versioned)) {
              sendFile(res, versioned);
              return;
            }
          }

          const wantsShell =
            method === 'GET' &&
            (urlPath === '/' || urlPath === '' || isPhpAppRoute(urlPath));
          if (!wantsShell) {
            next();
            return;
          }
          try {
            const html = readFileSync(join(publicDir, 'index.html'), 'utf8').replace(
              'src="/app.js"',
              'src="/src/browser-entry.mjs"'
            );
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(await server.transformIndexHtml(req.url || '/', html));
          } catch (err) {
            next(err);
          }
        });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [svelte(), playgroundShell()],
  // Dev serves public/ statically (versions bundles, prebuilt worker/SW);
  // build must not copy it into itself (app.js is emitted there).
  publicDir: command === 'serve' ? 'public' : false,
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT || 4177),
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Service-Worker-Allowed': '/',
    },
  },
  build: {
    outDir: 'public',
    emptyOutDir: false,
    lib: {
      entry: join(root, 'src/browser-entry.mjs'),
      formats: ['es'],
      fileName: () => 'app.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
}));
