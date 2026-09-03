/**
 * Dedicated Worker: PHP WASM + lite4mariadb share one thread so
 * post_message_to_js SQL RPC stays synchronous.
 *
 * Message types: boot, request (Shopware HTTP), sql (console),
 * export (download zip), reset (wipe IndexedDB for this version),
 * fs-list/fs-read/fs-write (file editor), logs (request log + var/log tails).
 */
import { createPlayground } from './browser-runtime.mjs';
import { idbNamesForVersion } from './idb-names.mjs';
import { buildExportZip } from './export.mjs';
import {
  collectLogs,
  createRequestLog,
  listDir,
  readFsFile,
  writeFsFile,
} from './fs-rpc.mjs';

let playground;
let activeVersion = '';
const requestLog = createRequestLog();

self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = reason && reason.message ? reason.message : String(reason);
  self.postMessage({ type: 'error', error: 'worker: ' + message });
});

const SQL_ROW_CAP = 500;

async function deleteIdb(name) {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

async function resetStorage() {
  try {
    await playground.close();
  } catch {
    /* already tearing down */
  }
  const candidates = new Set(idbNamesForVersion(activeVersion));
  try {
    for (const info of await indexedDB.databases()) {
      if (info.name && info.name.includes('shopware-playground')) {
        // Only wipe the active version; other versions keep their state.
        if (!activeVersion || info.name.endsWith(activeVersion)) {
          candidates.add(info.name);
        }
      }
    }
  } catch {
    /* indexedDB.databases() unsupported: the explicit names still apply */
  }
  for (const name of candidates) {
    await deleteIdb(name);
  }
}

let queue = Promise.resolve();

self.onmessage = (event) => {
  // PHP WASM (asyncify build) is single-threaded: while one request is
  // suspended (e.g. waiting on the SQL bridge), a second handler.request()
  // would re-enter the same PHP instance and corrupt the bridge state
  // ("Send timeout expired" → 500). Serialize all playground access.
  queue = queue.then(
    () => handleMessage(event),
    () => handleMessage(event)
  );
};

async function handleMessage(event) {
  const msg = event.data || {};
  const id = msg.id;
  try {
    if (msg.type === 'boot') {
      activeVersion = msg.version || '';
      self.postMessage({ id, type: 'status', text: 'Starting MariaDB WASM + PHP WASM…' });
      playground = await createPlayground({
        absoluteUrl: msg.origin || self.location.origin,
        version: activeVersion,
        zipUrl: msg.zipUrl,
        dumpUrl: msg.dumpUrl,
      });
      self.postMessage({ id, type: 'status', text: 'Shopware kernel ready' });
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (!playground) {
      throw new Error('playground not booted');
    }
    if (msg.type === 'request') {
      const req = msg.req || {};
      const url = String(req.url || '');
      if (!url.startsWith('/widgets/')) {
        self.postMessage({
          id,
          type: 'status',
          text: 'Shopware ' + (req.method || 'GET') + ' ' + url,
        });
      }
      let body = req.body;
      if (body && body instanceof ArrayBuffer) {
        body = new Uint8Array(body);
      }
      const res = await playground.handleRequest({ ...req, body });
      requestLog.record(req, res);
      const bytes = res.bytes instanceof Uint8Array ? res.bytes : new TextEncoder().encode(res.text || '');
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      self.postMessage(
        {
          id,
          type: 'result',
          status: res.status,
          text: res.text,
          body: buffer,
          headers: res.headers || {},
          errors: res.errors ? String(res.errors) : '',
        },
        [buffer]
      );
      return;
    }
    if (msg.type === 'sql') {
      const result = playground.db.exec(String(msg.sql || ''));
      let truncated = false;
      if (result.rows && result.rows.length > SQL_ROW_CAP) {
        result.rows = result.rows.slice(0, SQL_ROW_CAP);
        truncated = true;
      }
      // Structured clone carries Uint8Array binary values natively.
      self.postMessage({ id, type: 'sql-result', result, truncated });
      return;
    }
    if (msg.type === 'export') {
      self.postMessage({ id, type: 'status', text: 'Building export zip…' });
      const bytes = await buildExportZip(playground, {
        version: activeVersion,
        absoluteUrl: msg.origin || self.location.origin,
      });
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      self.postMessage({ id, type: 'export-result', body: buffer }, [buffer]);
      return;
    }
    if (msg.type === 'reset') {
      await resetStorage();
      requestLog.clear();
      self.postMessage({ id, type: 'reset-done' });
      return;
    }
    if (msg.type === 'fs-list') {
      self.postMessage({ id, type: 'fs-list-result', result: listDir(playground.php, msg.path) });
      return;
    }
    if (msg.type === 'fs-read') {
      self.postMessage({ id, type: 'fs-read-result', result: readFsFile(playground.php, msg.path) });
      return;
    }
    if (msg.type === 'fs-write') {
      const result = writeFsFile(playground.php, msg.path, msg.content);
      self.postMessage({ id, type: 'fs-write-result', result });
      return;
    }
    if (msg.type === 'logs') {
      self.postMessage({ id, type: 'logs-result', result: collectLogs(playground.php, requestLog.entries) });
      return;
    }
    throw new Error('unknown worker message type: ' + msg.type);
  } catch (err) {
    self.postMessage({
      id,
      type: 'error',
      error: err && err.message ? err.message : String(err),
    });
  }
}
