import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayground } from '../src/runtime.mjs';

test('playground lite4mariadb InnoDB round-trip and SHOW ENGINES', async () => {
  const pg = await createPlayground({ skipDump: true, dataDir: 'memory://' });
  try {
    pg.db.exec('DROP TABLE IF EXISTS playground_t');
    pg.db.exec(
      'CREATE TABLE playground_t (id INT PRIMARY KEY, v VARCHAR(64)) ENGINE=InnoDB'
    );
    pg.db.exec("INSERT INTO playground_t VALUES (1, 'shopware-wasm')");
    const rows = pg.db.query('SELECT v FROM playground_t WHERE id = 1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].v, 'shopware-wasm');

    const engines = pg.db.query('SHOW ENGINES');
    const innodb = engines.find(
      (r) => String(r.Engine || r.ENGINE || '').toLowerCase() === 'innodb'
    );
    assert.ok(innodb, 'SHOW ENGINES must list InnoDB');
    const support = String(innodb.Support || innodb.support || '').toUpperCase();
    assert.notEqual(support, 'DISABLED');
    assert.ok(support === 'YES' || support === 'DEFAULT', support);

    const viaPhp = await pg.php.run({
      code: `<?php
        require '/internal/playground_prepend.php';
        $rows = mariadblite_query("SELECT v FROM playground_t WHERE id = 1");
        echo $rows[0]['v'] ?? '';
      `,
    });
    assert.equal((viaPhp.text || '').trim(), 'shopware-wasm');

    const memory = await pg.php.run({
      code: `<?php
        require '/internal/playground_prepend.php';
        echo ini_get('memory_limit');
      `,
    });
    assert.equal((memory.text || '').trim(), '512M');
  } finally {
    await pg.close();
  }
});

test('binary values cross the PHP SQL bridge as {$h: hex}', async () => {
  const pg = await createPlayground({ skipDump: true, dataDir: 'memory://' });
  try {
    pg.db.exec('DROP TABLE IF EXISTS bridge_bin');
    pg.db.exec('CREATE TABLE bridge_bin (id BINARY(16) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    pg.db.exec("INSERT INTO bridge_bin VALUES (UNHEX('00112233445566778899aabbccddeeff'))");

    const viaPhp = await pg.php.run({
      code: `<?php
        require '/internal/playground_prepend.php';
        $rows = mariadblite_query('SELECT HEX(id) AS h FROM bridge_bin');
        echo strtolower($rows[0]['h'] ?? '');
      `,
    });
    assert.equal((viaPhp.text || '').trim(), '00112233445566778899aabbccddeeff');
  } finally {
    await pg.close();
  }
});
