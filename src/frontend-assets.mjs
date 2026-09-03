/**
 * Copy prebuilt Shopware bundle public files (assets:install equivalent)
 * and run theme:refresh / theme:change through PHP WASM.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const BUNDLE_PUBLIC_DIRS = [
  ['administration', 'vendor/shopware/administration/Resources/public'],
  ['storefront', 'vendor/shopware/storefront/Resources/public'],
  ['framework', 'vendor/shopware/core/Framework/Resources/public'],
  ['installer', 'vendor/shopware/core/Installer/Resources/public'],
];

export function copyBundlePublicAssets(shopwareRoot) {
  const bundlesRoot = join(shopwareRoot, 'public/bundles');
  mkdirSync(bundlesRoot, { recursive: true });
  for (const [name, rel] of BUNDLE_PUBLIC_DIRS) {
    const from = join(shopwareRoot, rel);
    if (!existsSync(from)) continue;
    const to = join(bundlesRoot, name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
}

function phpString(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * Run a Shopware console command inside the already-booted PHP WASM playground.
 * @param {{ php: { run: (opts: object) => Promise<{ text?: string, errors?: string }> } }} pg
 * @param {Record<string, string|boolean>} input
 */
export async function runShopwareConsole(pg, input) {
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  const res = await pg.php.run({
    code: `<?php
      require '/internal/playground_prepend.php';
      chdir('/shopware');
      $_SERVER['PROJECT_ROOT'] = '/shopware';
      $_ENV['PROJECT_ROOT'] = '/shopware';
      putenv('PROJECT_ROOT=/shopware');
      $_SERVER['APP_ENV'] = 'prod';
      $_SERVER['APP_DEBUG'] = '0';
      $classLoader = require '/shopware/vendor/autoload.php';
      $kernel = Shopware\\Core\\Framework\\Adapter\\Kernel\\KernelFactory::create(
        environment: 'prod',
        debug: false,
        classLoader: $classLoader,
      );
      $app = new Symfony\\Bundle\\FrameworkBundle\\Console\\Application($kernel);
      $app->setAutoExit(false);
      $params = json_decode(base64_decode(${phpString(encoded)}), true, 512, JSON_THROW_ON_ERROR);
      $params['--no-interaction'] = true;
      $input = new Symfony\\Component\\Console\\Input\\ArrayInput($params);
      $output = new Symfony\\Component\\Console\\Output\\BufferedOutput();
      $code = $app->run($input, $output);
      echo $output->fetch();
      echo "\\n__EXIT__=" . $code;
    `,
  });
  const text = String(res.text || '');
  const match = text.match(/__EXIT__=(-?\d+)\s*$/);
  const code = match ? Number(match[1]) : 1;
  if (code !== 0) {
    throw new Error(
      'console ' +
        (input.command || '') +
        ' failed (' +
        code +
        '): ' +
        text.slice(0, 2000) +
        ' ' +
        String(res.errors || '').slice(0, 1000)
    );
  }
  return text;
}
