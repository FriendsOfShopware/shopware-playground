/**
 * IndexedDB database names lite4mariadb uses for a demo's persistent
 * datadir. Shared by the browser worker (reset) and the shell (seed
 * invalidation before boot). No node: imports — safe for both bundles.
 *
 * `storageKey` is the demo's storage key (see src/demo.mjs): the demo id for
 * built-in and hosted demos, a URL hash for remote ones.
 */
export const IDB_PREFIX = 'shopware-playground';

export function idbDataDir(storageKey) {
  return 'idb://' + IDB_PREFIX + (storageKey ? '-' + storageKey : '');
}

export function idbNamesForDemo(storageKey) {
  const suffix = IDB_PREFIX + (storageKey ? '-' + storageKey : '');
  // Emscripten IDBFS names databases after the mount point.
  return ['/mariadb/idb/' + suffix, suffix];
}

/** Match databases that belong to one demo (enumeration via indexedDB.databases()). */
export function idbBelongsToDemo(name, storageKey) {
  if (!name || !name.includes(IDB_PREFIX)) return false;
  return !storageKey || name.endsWith(IDB_PREFIX + '-' + storageKey);
}
