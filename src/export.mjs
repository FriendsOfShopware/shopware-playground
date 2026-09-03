/**
 * Export the playground state as a zip: full SQL dump + uploaded media +
 * a manifest (like WordPress Playground's zipWpContent, but the meaningful
 * state here is the MariaDB database — Shopware code ships in the version zip).
 * Runs inside the worker; no node: imports.
 */
import { dumpDatabase } from './sql-dump.mjs';

/**
 * @param {{ db: { query: (sql: string) => any[], exec: (sql: string) => any }, php: any }} playground
 * @param {{ version?: string, absoluteUrl?: string }} [options]
 * @returns {Promise<Uint8Array>} zip bytes
 */
export async function buildExportZip(playground, options = {}) {
  const { db, php } = playground;
  const sql = dumpDatabase(db, { database: 'shopware' });

  php.mkdir('/tmp/playground-export');
  php.writeFile('/tmp/playground-export/shopware.sql', sql);

  const manifest = JSON.stringify({
    formatVersion: 1,
    kind: 'shopware-playground',
    shopwareVersion: options.version || null,
    siteUrl: options.absoluteUrl || null,
    exportedAt: new Date().toISOString(),
  });
  php.writeFile('/tmp/playground-export/manifest.json.b64', btoa(manifest));

  const res = await php.run({
    code: `<?php
      $zip = new ZipArchive();
      $path = '/tmp/playground-export/export.zip';
      if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        fwrite(STDERR, 'zip create failed');
        exit(1);
      }
      $zip->addFile('/tmp/playground-export/shopware.sql', 'shopware.sql');
      $zip->addFromString('playground-export.json', base64_decode(file_get_contents('/tmp/playground-export/manifest.json.b64')));
      // User uploads live in public/media inside MEMFS (session state).
      $media = '/shopware/public/media';
      if (is_dir($media)) {
        $it = new RecursiveIteratorIterator(
          new RecursiveDirectoryIterator($media, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($it as $file) {
          if (!$file->isFile()) continue;
          $rel = substr($file->getPathname(), strlen($media));
          $zip->addFile($file->getPathname(), 'media' . $rel);
        }
      }
      $zip->close();
      echo 'ok';
    `,
  });
  if (!/ok/.test(res.text || '')) {
    throw new Error('export zip failed: ' + (res.errors || res.text || ''));
  }
  const bytes = php.readFileAsBuffer('/tmp/playground-export/export.zip');
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}
