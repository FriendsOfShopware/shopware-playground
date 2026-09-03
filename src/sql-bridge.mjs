/**
 * SQL bridge between PHP WASM (post_message_to_js) and lite4mariadb.
 * Shared by the Node runtime and the browser worker runtime.
 *
 * The PHP side (php/auto_prepend.php + src/Playground DBAL driver) speaks the
 * classic wire format: every value is a string, binary is {$h: hex}.
 * lite4mariadb >= 0.1 coerces rows to JS types (number, Uint8Array, parsed
 * JSON), so the bridge re-encodes to the wire format before JSON.stringify.
 */

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function toWireValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return { $h: bytesToHex(value) };
  if (ArrayBuffer.isView(value)) {
    return { $h: bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    // JSON columns are coerced to objects; PHP expects the raw JSON text.
    return JSON.stringify(value);
  }
  return value;
}

export function toWireResult(res) {
  if (!res || !Array.isArray(res.rows)) return res;
  return {
    ...res,
    rows: res.rows.map((row) => {
      const out = {};
      for (const [key, value] of Object.entries(row)) out[key] = toWireValue(value);
      return out;
    }),
  };
}

function decodeSql(msg) {
  if (msg.sql_b64) {
    const bin = atob(msg.sql_b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return String(msg.sql || '');
}

export function attachSqlBridge(php, db) {
  php.onMessage((data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return JSON.stringify({ ok: false, error: 'invalid rpc json' });
    }
    if (msg.op !== 'query') {
      return JSON.stringify({ ok: false, error: 'unknown op' });
    }
    try {
      const sql = decodeSql(msg);
      return JSON.stringify(toWireResult(db.exec(sql)));
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        errno: e?.errno,
      });
    }
  });
}
