/**
 * Dump / restore a lite4mariadb database as delimited SQL.
 * Binary values (Uint8Array from coercion, or legacy {$h: hex}) become
 * UNHEX(...) unless they decode as clean UTF-8 text.
 */

export const STMT_MARK = '\n-- playground-sql\n';

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function quoteString(s) {
  return (
    "'" +
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/\0/g, '\\0')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/'/g, "\\'")
      .replace(/\x1a/g, '\\Z') +
    "'"
  );
}

function hexToBytes(hex) {
  const n = hex.length / 2;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function sqlLiteralFromHex(hex) {
  const bytes = hexToBytes(hex);
  // Shopware primary keys are BINARY(16). Keep those as UNHEX.
  if (bytes.length === 16 || bytes.includes(0)) {
    return "UNHEX('" + hex + "')";
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return quoteString(text);
  } catch {
    return "UNHEX('" + hex + "')";
  }
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Uint8Array) {
    return sqlLiteralFromHex(bytesToHex(value));
  }
  if (ArrayBuffer.isView(value)) {
    return sqlLiteralFromHex(bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  }
  if (typeof value === 'object') {
    if (typeof value.$h === 'string') {
      return sqlLiteralFromHex(value.$h);
    }
    return sqlLiteral(JSON.stringify(value));
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  return quoteString(value);
}

function tableName(row) {
  return String(Object.values(row)[0] || '');
}

function createTableSql(row) {
  return String(row['Create Table'] || row['Create View'] || row.createTable || '');
}

function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '') + '`';
}

function pushStmt(out, sql) {
  const trimmed = String(sql || '').trim();
  if (trimmed) out.push(trimmed);
}

/**
 * @param {{ query: (sql: string) => any[], exec: (sql: string) => any }} db
 * @param {{ database?: string, onProgress?: (msg: string) => void }} [options]
 */
export function dumpDatabase(db, options = {}) {
  const database = options.database || 'shopware';
  const log = options.onProgress || (() => {});
  const out = [];

  pushStmt(out, 'SET FOREIGN_KEY_CHECKS=0');
  pushStmt(out, 'SET UNIQUE_CHECKS=0');
  pushStmt(out, 'DROP DATABASE IF EXISTS ' + quoteIdent(database));
  pushStmt(out, 'CREATE DATABASE ' + quoteIdent(database));
  pushStmt(out, 'USE ' + quoteIdent(database));

  db.exec('USE `' + database.replace(/`/g, '') + '`');
  const tables = db.query('SHOW FULL TABLES');
  const baseTables = [];
  const views = [];
  for (const row of tables) {
    const name = tableName(row);
    if (!name) continue;
    const type = String(row.Table_type || row.table_type || 'BASE TABLE').toUpperCase();
    if (type.includes('VIEW')) views.push(name);
    else baseTables.push(name);
  }

  log('dumping ' + baseTables.length + ' tables, ' + views.length + ' views');

  for (const name of baseTables) {
    const ddl = db.query('SHOW CREATE TABLE ' + quoteIdent(name));
    const create = ddl[0] ? createTableSql(ddl[0]) : '';
    if (!create) {
      throw new Error('SHOW CREATE TABLE failed for ' + name);
    }
    pushStmt(out, 'DROP TABLE IF EXISTS ' + quoteIdent(name));
    pushStmt(out, create);
    const rows = db.query('SELECT * FROM ' + quoteIdent(name));
    if (!rows.length) continue;
    const generated = new Set();
    try {
      for (const col of db.query('SHOW COLUMNS FROM ' + quoteIdent(name))) {
        const extra = String(col.Extra || col.extra || '');
        if (/VIRTUAL|STORED|GENERATED/i.test(extra)) {
          generated.add(String(col.Field || col.field || ''));
        }
      }
    } catch {
      /* keep all columns */
    }
    const colNames = Object.keys(rows[0]).filter((key) => !generated.has(key));
    const cols = colNames.map(quoteIdent);
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      pushStmt(
        out,
        'INSERT INTO ' + quoteIdent(name) + ' (' + cols.join(',') + ') VALUES ' + batch.join(',')
      );
      batch = [];
    };
    for (const row of rows) {
      const tuple = '(' + colNames.map((key) => sqlLiteral(row[key])).join(',') + ')';
      if (tuple.length > 12000) {
        flush();
        pushStmt(
          out,
          'INSERT INTO ' + quoteIdent(name) + ' (' + cols.join(',') + ') VALUES ' + tuple
        );
        continue;
      }
      batch.push(tuple);
      if (batch.length >= 25) flush();
    }
    flush();
    log('dumped ' + name + ' (' + rows.length + ' rows)');
  }

  for (const name of views) {
    const ddl = db.query('SHOW CREATE VIEW ' + quoteIdent(name));
    const create = ddl[0] ? String(ddl[0]['Create View'] || ddl[0]['Create Table'] || '') : '';
    if (create) {
      pushStmt(out, 'DROP VIEW IF EXISTS ' + quoteIdent(name));
      pushStmt(out, create);
    }
  }

  let triggers = [];
  try {
    triggers = db.query('SHOW TRIGGERS');
  } catch {
    triggers = [];
  }
  for (const trigger of triggers) {
    const name = trigger.Trigger || trigger.trigger;
    const timing = trigger.Timing || trigger.timing;
    const event = trigger.Event || trigger.event;
    const table = trigger.Table || trigger.table;
    const statement = trigger.Statement || trigger.statement;
    if (!name || !statement) continue;
    pushStmt(out, 'DROP TRIGGER IF EXISTS ' + quoteIdent(name));
    pushStmt(
      out,
      'CREATE TRIGGER ' +
        quoteIdent(name) +
        ' ' +
        timing +
        ' ' +
        event +
        ' ON ' +
        quoteIdent(table) +
        ' FOR EACH ROW ' +
        statement
    );
  }

  pushStmt(out, 'SET UNIQUE_CHECKS=1');
  pushStmt(out, 'SET FOREIGN_KEY_CHECKS=1');
  return out.join(STMT_MARK);
}

/**
 * @param {{ exec: (sql: string) => any }} db
 * @param {string} sql
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]
 */
export function importDump(db, sql, options = {}) {
  const log = options.onProgress || (() => {});
  const statements = String(sql)
    .split(STMT_MARK)
    .map((s) => s.trim())
    .filter(Boolean);
  const total = statements.length;
  for (let i = 0; i < statements.length; i++) {
    try {
      db.exec(statements[i]);
    } catch (e) {
      // Generated columns (e.g. media.file_hash) cannot be inserted explicitly.
      if (!(e && (e.errno === 1906 || /generated column/i.test(String(e.message || ''))))) {
        throw e;
      }
    }
    if (i === 0 || i + 1 === total || (i + 1) % 50 === 0) {
      log(i + 1, total);
    }
  }
  return total;
}

function randomHexId() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sales-channel URLs to register for a live playground origin.
 * The SQL dump is built against 127.0.0.1; boot rewrites to whatever
 * host serves the static zip (workers.dev, custom domain, localhost).
 */
export function shopUrlVariants(origin) {
  if (!origin) return [];
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return [];
  }
  const hosts = new Set([parsed.host]);
  if (parsed.hostname === '127.0.0.1') {
    hosts.add(parsed.port ? 'localhost:' + parsed.port : 'localhost');
  }
  if (parsed.hostname === 'localhost') {
    hosts.add(parsed.port ? '127.0.0.1:' + parsed.port : '127.0.0.1');
  }
  const urls = new Set();
  urls.add(parsed.origin);
  for (const host of hosts) {
    urls.add('http://' + host);
    urls.add('https://' + host);
  }
  return [...urls];
}

/**
 * Point all sales_channel_domain rows at the live origin.
 * @returns {boolean} true when the domain set actually changed — callers
 * with a warm Shopware var/cache must invalidate the routing-domain cache.
 */
export function rewriteShopUrls(db, origin) {
  const urls = shopUrlVariants(origin);
  if (!urls.length) return false;
  const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  try {
    const templates = db.query(
      "SELECT HEX(sales_channel_id) sid, HEX(language_id) lid, HEX(currency_id) cid, HEX(snippet_set_id) snip FROM sales_channel_domain WHERE url LIKE 'http%' LIMIT 1"
    );
    if (!templates.length) return false;
    const existing = db
      .query("SELECT url FROM sales_channel_domain WHERE url LIKE 'http%' OR url LIKE 'https%'")
      .map((row) => String(row.url));
    const wanted = new Set(urls);
    if (existing.length === wanted.size && existing.every((url) => wanted.has(url))) {
      return false;
    }
    const t = templates[0];
    db.exec("DELETE FROM sales_channel_domain WHERE url LIKE 'http%' OR url LIKE 'https%'");
    for (const url of urls) {
      db.exec(
        "INSERT INTO sales_channel_domain (id, sales_channel_id, language_id, url, currency_id, snippet_set_id, created_at) VALUES (UNHEX('" +
          randomHexId() +
          "'), UNHEX('" +
          t.sid +
          "'), UNHEX('" +
          t.lid +
          "'), '" +
          q(url) +
          "', UNHEX('" +
          t.cid +
          "'), UNHEX('" +
          t.snip +
          "'), NOW(6))"
      );
    }
    return true;
  } catch {
    /* dump may not include sales_channel_domain yet */
    return false;
  }
}
