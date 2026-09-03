/**
 * Extension → Content-Type shared by the Cloudflare Worker (fallback when R2
 * object metadata is missing) and the R2 sync in src/deploy-cf.mjs (stored as
 * object metadata at upload time).
 */
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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.so': 'application/octet-stream',
  '.dat': 'application/octet-stream',
  '.la': 'application/octet-stream',
};

export function contentTypeFor(path) {
  const m = /\.[a-z0-9]+$/i.exec(path || '');
  return (m && TYPES[m[0].toLowerCase()]) || 'application/octet-stream';
}
