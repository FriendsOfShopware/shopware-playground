/**
 * Path classification shared by the service worker, the static hosts
 * (serve.mjs, vite, the Cloudflare Worker) and the shell.
 */
import { DEMO_QUERY_PARAM, DEMOS_INDEX_PATH, DEMOS_PATH_PREFIX, isDemoAssetPath } from './demo.mjs';

export { DEMO_ASSET_PREFIXES, demoAssetUrl, isDemoAssetPath } from './demo.mjs';

/**
 * Real static assets. Do not treat SEO suffixes like SWDEMO10007.1 as files.
 */
const STATIC_FILE_EXT =
  /\.(?:html?|js|mjs|cjs|css|json|map|wasm|svg|png|jpe?g|gif|webp|ico|avif|woff2?|ttf|otf|eot|zip|gz|dat|so|la|txt|xml|webmanifest)$/i;

/**
 * Paths the static host should serve as files vs. PHP front-controller routes.
 */
export function isStaticPlaygroundPath(pathname) {
  if (
    pathname.startsWith('/mariadb/') ||
    pathname.startsWith(DEMOS_PATH_PREFIX) ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/php/') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    isDemoAssetPath(pathname) ||
    pathname === '/app.js' ||
    pathname === '/browser-worker.js' ||
    pathname === '/service-worker.js' ||
    pathname === DEMOS_INDEX_PATH
  ) {
    return true;
  }
  return STATIC_FILE_EXT.test(pathname);
}

export function isPhpAppRoute(pathname) {
  if (!pathname || pathname === '/') return false;
  return !isStaticPlaygroundPath(pathname);
}

/**
 * Paths the Service Worker must never steal (playground engine + wasm).
 */
export function isEngineBypassPath(pathname) {
  return (
    pathname === '/app.js' ||
    pathname === '/browser-worker.js' ||
    pathname === '/service-worker.js' ||
    pathname === DEMOS_INDEX_PATH ||
    pathname.startsWith('/mariadb/') ||
    pathname.startsWith(DEMOS_PATH_PREFIX) ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/php/') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    // Vite dev server internals (/@vite/client, /@id/, /@fs/) — dev only,
    // nothing requests these from the built bundle.
    pathname.startsWith('/@')
  );
}

/**
 * Shopware front-controller routes handled by PHP WASM.
 * `/` is PHP only inside the nested iframe; the top-level tab is the shell.
 */
export function isShopwarePhpPath(pathname, nested = false) {
  if (pathname === '/index.php' || pathname.startsWith('/index.php/')) {
    return true;
  }
  // Shopware API routes may end in a static-looking extension
  // (e.g. /api/_info/entity-schema.json) but are PHP controllers.
  if (pathname.startsWith('/api/')) {
    return true;
  }
  if (isEngineBypassPath(pathname) || isStaticPlaygroundPath(pathname)) {
    return false;
  }
  if (!pathname || pathname === '/') {
    return nested;
  }
  return true;
}

/**
 * The Shopware path to open on boot, derived from the shell's own URL.
 * Playground-only query parameters (?demo=) are stripped so they never reach
 * Shopware.
 */
export function initialShopwarePath(loc = typeof location === 'undefined' ? null : location) {
  if (!loc) return '/';
  const pathname = loc.pathname || '/';
  if (pathname === '/' || pathname === '' || isStaticPlaygroundPath(pathname)) return '/';
  const params = new URLSearchParams(loc.search || '');
  params.delete(DEMO_QUERY_PARAM);
  const search = params.toString();
  return pathname + (search ? '?' + search : '');
}
