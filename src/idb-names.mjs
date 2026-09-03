/**
 * IndexedDB database names lite4mariadb uses for a version's persistent
 * datadir. Shared by the browser worker (reset) and the shell (seed
 * invalidation before boot). No node: imports — safe for both bundles.
 */
export function idbNamesForVersion(version) {
  const suffix = 'shopware-playground' + (version ? '-' + version : '');
  // Emscripten IDBFS names databases after the mount point.
  return ['/mariadb/idb/' + suffix, suffix];
}
