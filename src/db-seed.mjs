/**
 * Shared "is Shopware installed / import seed dump / rewrite shop URLs" logic.
 * Used by both the Node runtime and the browser worker runtime.
 * No node: imports — safe to bundle for the browser.
 */
import { importDump, rewriteShopUrls } from './sql-dump.mjs';

/** True when the (possibly persistent) datadir already contains shopware tables. */
export function hasShopwareSchema(db) {
  try {
    const rows = db.query(
      "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = 'shopware'"
    );
    return Number(rows[0]?.c || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Bring the database into a bootable state:
 * import the seed dump only when the schema is missing (persistent datadirs
 * skip the import on reboot), then point sales-channel URLs at the live origin.
 *
 * @param {{ query: (sql: string) => any[], exec: (sql: string) => any, persist?: () => Promise<void> }} db
 * @param {{ dumpSql?: string|null, absoluteUrl?: string, skipDump?: boolean, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<boolean>} true when the shop domains were rewritten
 */
export async function seedShopware(db, options = {}) {
  db.exec('CREATE DATABASE IF NOT EXISTS shopware');
  db.exec('USE shopware');

  if (options.skipDump) return false;

  if (!hasShopwareSchema(db)) {
    if (options.dumpSql) {
      importDump(db, options.dumpSql, { onProgress: options.onProgress });
      if (typeof db.persist === 'function') {
        await db.persist().catch(() => {});
      }
    }
  }
  return rewriteShopUrls(db, options.absoluteUrl || '');
}
