/**
 * File editor + log viewer RPC for the playground worker (WordPress
 * Playground style). Browser-safe: operates on the PHP WASM MEMFS through
 * the php object's FS helpers. All paths are confined to FS_ROOT.
 */

export const FS_ROOT = '/shopware';

const READ_CAP = 512 * 1024;
const LIST_CAP = 2000;
const LOG_TAIL = 64 * 1024;
const LOG_FILE_CAP = 8;
export const REQUEST_LOG_CAP = 300;

/**
 * Resolve `.`/`..` and confine the result to FS_ROOT. Returns '' for
 * anything that escapes the Shopware tree.
 */
export function normalizeFsPath(input) {
  const raw = String(input || '/').replace(/\\/g, '/');
  const parts = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = '/' + parts.join('/');
  if (resolved !== FS_ROOT && !resolved.startsWith(FS_ROOT + '/')) {
    return '';
  }
  return resolved;
}

export function listDir(php, input) {
  const path = normalizeFsPath(input);
  if (!path) throw new Error('path outside ' + FS_ROOT);
  if (!php.isDir(path)) throw new Error('not a directory: ' + path);
  const names = php.listFiles(path).slice(0, LIST_CAP);
  const entries = names.map((name) => ({
    name,
    dir: php.isDir(path + '/' + name),
  }));
  entries.sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
  );
  return { path, entries, capped: php.listFiles(path).length > LIST_CAP };
}

function looksBinary(bytes) {
  const probe = bytes.subarray(0, 8192);
  for (const b of probe) {
    if (b === 0) return true;
  }
  return false;
}

export function readFsFile(php, input) {
  const path = normalizeFsPath(input);
  if (!path) throw new Error('path outside ' + FS_ROOT);
  if (!php.isFile(path)) throw new Error('not a file: ' + path);
  const bytes = php.readFileAsBuffer(path);
  const size = bytes.length;
  if (looksBinary(bytes)) {
    return { path, size, binary: true, truncated: false, content: '' };
  }
  const truncated = size > READ_CAP;
  const slice = truncated ? bytes.subarray(0, READ_CAP) : bytes;
  return {
    path,
    size,
    binary: false,
    truncated,
    content: new TextDecoder().decode(slice),
  };
}

export function writeFsFile(php, input, content) {
  const path = normalizeFsPath(input);
  if (!path) throw new Error('path outside ' + FS_ROOT);
  if (php.isDir(path)) throw new Error('is a directory: ' + path);
  const text = String(content ?? '');
  php.writeFile(path, text);
  return { path, size: new TextEncoder().encode(text).length };
}

/**
 * Tails of Shopware's var/log/*.log plus the worker's request ring buffer.
 */
export function collectLogs(php, requestLog) {
  const files = [];
  const logDir = FS_ROOT + '/var/log';
  try {
    if (php.isDir(logDir)) {
      const names = php
        .listFiles(logDir)
        .filter((name) => name.endsWith('.log') && php.isFile(logDir + '/' + name))
        .slice(0, LOG_FILE_CAP);
      for (const name of names) {
        const bytes = php.readFileAsBuffer(logDir + '/' + name);
        const tail = bytes.length > LOG_TAIL ? bytes.subarray(bytes.length - LOG_TAIL) : bytes;
        files.push({
          name,
          size: bytes.length,
          truncated: bytes.length > LOG_TAIL,
          tail: new TextDecoder().decode(tail),
        });
      }
    }
  } catch {
    /* var/log may be unreadable mid-boot */
  }
  return { requests: requestLog.slice(-100).reverse(), files };
}

/**
 * Ring buffer of recent PHP requests handled by the worker.
 */
export function createRequestLog() {
  const entries = [];
  return {
    entries,
    record(req, res) {
      entries.push({
        ts: Date.now(),
        method: String(req.method || 'GET'),
        url: String(req.url || ''),
        status: res.status || 0,
        errors: String(res.errors || '').slice(0, 4000),
      });
      if (entries.length > REQUEST_LOG_CAP) entries.shift();
    },
    clear() {
      entries.length = 0;
    },
  };
}
