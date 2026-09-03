/**
 * Shopware version helpers (Node only): detect the version of a Shopware
 * tree and maintain public/versions.json, the manifest the shell boots from.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Detect "6.7.13.1" from composer.lock (SHOPWARE_VERSION env wins). */
export function detectShopwareVersion(dir) {
  if (process.env.SHOPWARE_VERSION) return process.env.SHOPWARE_VERSION;
  try {
    const lock = JSON.parse(readFileSync(join(dir, 'composer.lock'), 'utf8'));
    const pkg = (lock.packages || []).find((p) => p.name === 'shopware/core');
    return String(pkg?.version || '').replace(/^v/, '');
  } catch {
    return '';
  }
}

export function versionBundleDir(publicDir, version) {
  return join(publicDir, 'versions', version);
}

export function versionDumpPath(publicDir, version) {
  return join(versionBundleDir(publicDir, version), 'shopware.sql.gz');
}

/** Merge a built version into versions.json; keep default valid. */
export function updateVersionsManifest(publicDir, version) {
  const manifestPath = join(publicDir, 'versions.json');
  let manifest = { default: version, versions: [] };
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      /* rewrite corrupt manifest */
    }
  }
  // Content identity of the seed dump: the shell wipes a persisted browser
  // database whose stored seed differs, so redeploying a changed dump
  // auto-heals stale/poisoned playground state instead of reusing it forever.
  const seedOf = (v) => {
    try {
      return createHash('sha256')
        .update(readFileSync(versionDumpPath(publicDir, v)))
        .digest('hex')
        .slice(0, 16);
    } catch {
      return '';
    }
  };
  const seed = seedOf(version);
  const entry = {
    id: version,
    label: 'Shopware ' + version,
    zip: '/versions/' + version + '/shopware.zip',
    dump: '/versions/' + version + '/shopware.sql.gz',
    seed,
  };
  manifest.versions = [...(manifest.versions || []).filter((v) => v.id !== version), entry];
  // Backfill seeds for entries built before seed tracking existed.
  for (const v of manifest.versions) {
    if (!v.seed) v.seed = seedOf(v.id);
  }
  manifest.versions.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  if (!manifest.default || !manifest.versions.some((v) => v.id === manifest.default)) {
    manifest.default = version;
  }
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
