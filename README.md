# Shopware Playground

Shopware in the browser: PHP WASM + [lite4mariadb](https://www.npmjs.com/package/lite4mariadb)
(MariaDB WASM), no server-side PHP. Live at https://playground.fos.gg.

## Demos

Everything the playground boots is a **demo**: a directory with

| file               | content                                                     |
| ------------------ | ----------------------------------------------------------- |
| `demo.json`        | descriptor (id, label, Shopware version, seed hash, admin)  |
| `shopware.zip`     | the installed Shopware tree (vendor included) for MEMFS      |
| `shopware.sql.gz`  | seed database dump, imported on first boot per browser       |
| `assets/`          | `bundles/`, `theme/`, `media/`, `thumbnail/` served statically |

The built-in Shopware versions (6.6, 6.7) are demos under `public/demos/<version>/`,
listed in `public/demos.json`. Any other demo opens with a query parameter:

| URL                                             | source                                              |
| ----------------------------------------------- | --------------------------------------------------- |
| `/`                                             | last choice, else the index default                 |
| `/?demo=6.6.10.29`                              | built-in demo from `demos.json`                     |
| `/?demo=frosh-tools-pr-12`                      | demo uploaded to the playground's R2 bucket (`/demos/<name>/`) |
| `/?demo=https://host/path/demo.json`            | demo on any static host that sends `Access-Control-Allow-Origin` |

Each demo keeps its own IndexedDB database. Re-publishing a demo with a changed
dump changes the `seed` in `demo.json`; browsers notice and re-import.

## Packaging a plugin demo in CI

A GitHub Actions job installs the plugin into this repository's `shopware/`
tree (a `shopware/production` project with the playground overrides), installs
it under PHP WASM and uploads the result:

```yaml
- uses: actions/checkout@v4
  with: { repository: FriendsOfShopware/shopware-playground, path: playground }
- run: npm ci
  working-directory: playground
- run: composer install --no-interaction
  working-directory: playground/shopware
- run: cp -R "$GITHUB_WORKSPACE/plugin" playground/shopware/custom/plugins/FroshTools

- run: node playground/src/cli.mjs demo pack playground/shopware --out ./demo \
         --id "frosh-tools-pr-${{ github.event.number }}" \
         --label "FroshTools PR #${{ github.event.number }}" \
         --plugin FroshTools
- run: node playground/src/cli.mjs demo upload ./demo
  env:
    CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
    R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
    R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

`demo upload` prints the playground URL and writes `name`/`url` to
`$GITHUB_OUTPUT` for a PR comment. Requirements on the runner: PHP (for the
installer patcher and `composer`), `zip`, Node 22+. For Shopware 6.6 use
`versions-src/6.6.10.29/shopware` instead. Any other tree works as long as it
carries the playground overrides (`overrides/`, `src/Playground/`,
`config/packages/playground.yaml` and the driver wiring in
`config/services.yaml`): the installer talks to MariaDB WASM over a JS bridge
instead of a TCP socket.

`demo pack` installs Shopware with demo data, registers each `--plugin`
(name under `custom/plugins`, or a path like `vendor/frosh/tools`), runs
`plugin:install --activate`, copies the plugin's `src/Resources/public`
into `bundles/`, recompiles the theme and dumps the database.

## Local development

```sh
npm install
composer -d shopware install      # Shopware 6.7 tree with playground overrides
node src/prepare-install.mjs      # install under PHP WASM → public/demos/<v>/shopware.sql.gz
npm run build                     # shell + public/demos/<v>/{demo.json,shopware.zip,assets}
npm start                         # http://127.0.0.1:4177 (or npm run dev for HMR)
```

Another built-in version lives in `versions-src/<version>/shopware`. Only the
playground-specific files are committed (composer pins, `config/`,
`overrides/`, `src/Playground/`); `node src/version-tree.mjs <version>` fills
in the rest of the project skeleton from `shopware/`. Then run
`composer install`, `prepare-install` and `build` with
`SHOPWARE_DIR=versions-src/<version>/shopware`.

To move a built-in demo to a newer Shopware release, bump `shopware/core` in
the tree's `composer.json`, run `composer update "shopware/*" -W`, check that
the files under `overrides/` still match upstream (they are patched copies),
then re-run `prepare-install` and `build` for that tree.

`playground` CLI (`node src/cli.mjs --help`): run, exec, console, sql,
snapshot create/list/restore/delete, bake, demo pack, demo upload.

## Deploying

`npm run deploy:cf` syncs `public/demos/**`, `public/demos.json`, the
MariaDB engine and the PHP prepend to R2 and deploys the Worker
(`worker/index.mjs`) that serves `/demos/*` from the bucket and the shell for
everything else. Demos uploaded by CI live under the same `demos/` prefix and
are not touched by the deploy. `npm run pack-deploy` produces a static-host
tree with `_headers`/`_redirects` instead.
