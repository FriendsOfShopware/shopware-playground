/**
 * Real static assets. Do not treat SEO suffixes like SWDEMO10007.1 as files.
 */
const STATIC_FILE_EXT =
  /\.(?:html?|js|mjs|cjs|css|json|map|wasm|svg|png|jpe?g|gif|webp|ico|avif|woff2?|ttf|otf|eot|zip|gz|dat|so|la|txt|xml|webmanifest)$/i;

/**
 * Shopware storefront/admin assets that live per version under
 * /versions/<v>/assets/... The service worker rewrites these paths so each
 * booted Shopware version gets its own compiled theme/media/bundles.
 */
export const VERSIONED_ASSET_PREFIXES = ['/bundles/', '/theme/', '/media/', '/thumbnail/'];

export function isVersionedAssetPath(pathname) {
  return VERSIONED_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function versionedAssetPath(pathname, version) {
  if (!version || !isVersionedAssetPath(pathname)) return null;
  return '/versions/' + encodeURIComponent(version) + '/assets' + pathname;
}

/** The shell marks the active Shopware version in a cookie so the service
 * worker can route asset requests statelessly. */
export const VERSION_COOKIE = 'sw_playground_version';

export function versionFromCookieHeader(header) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === VERSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return '';
}

/**
 * Paths the static host should serve as files vs. PHP front-controller routes.
 */
export function isStaticPlaygroundPath(pathname) {
  if (
    pathname.startsWith('/mariadb/') ||
    pathname.startsWith('/versions/') ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/php/') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    isVersionedAssetPath(pathname) ||
    pathname === '/app.js' ||
    pathname === '/browser-worker.js' ||
    pathname === '/service-worker.js' ||
    pathname === '/versions.json'
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
    pathname === '/versions.json' ||
    pathname.startsWith('/mariadb/') ||
    pathname.startsWith('/versions/') ||
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

export function initialShopwarePath() {
  if (typeof location === 'undefined') return '/';
  const path = location.pathname + location.search;
  if (path === '/' || path === '') return '/';
  if (isStaticPlaygroundPath(location.pathname)) return '/';
  return path;
}
