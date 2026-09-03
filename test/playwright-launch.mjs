#!/usr/bin/env node
/**
 * Load the playground page with Playwright (if browsers are available),
 * then exercise the toolbar: version select, SQL console, export.
 */
import { chromium } from 'playwright';

const url = process.env.PLAYGROUND_URL || 'http://127.0.0.1:4177/';
const screenshot = process.env.SCREENSHOT || '';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
const consoleErrors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(
  () => {
    const s = document.getElementById('status')?.textContent || '';
    if (/^Error:/.test(s)) return true;
    const frame = document.getElementById('viewport');
    try {
      const html = frame?.contentDocument?.documentElement?.outerHTML || '';
      return /Playground Shop/.test(html) || /theme\/.*all\.css/.test(html);
    } catch {
      return /Shopware HTTP 200/.test(s) || /Shopware .+ — HTTP 200/.test(s);
    }
  },
  undefined,
  { timeout: 300_000 }
);
const status = await page.textContent('#status');
const html = await page.$eval('#viewport', (el) => {
  try {
    return el.contentDocument?.documentElement?.outerHTML || '';
  } catch {
    return el.srcdoc || '';
  }
});
console.log('STATUS', status);
console.log('HTML_LEN', html.length);
console.log('HAS_SHOPWARE', /shopware/i.test(html));

// Version switcher lists the built versions.
const versionOptions = await page.$$eval('#version option', (opts) => opts.map((o) => o.value));
console.log('VERSIONS', versionOptions.join(','));

// SQL console: open drawer, run a query against the live MariaDB WASM.
await page.click('#btn-database');
await page.fill('#sql', 'SELECT COUNT(*) AS c FROM product');
await page.click('#runsql');
await page.waitForFunction(
  () => (document.getElementById('sqlmeta')?.textContent || '').includes('row'),
  undefined,
  { timeout: 60_000 }
);
const sqlMeta = await page.textContent('#sqlmeta');
const firstCell = await page.$eval('#sqlout td', (td) => td.textContent).catch(() => '');
console.log('SQL_META', sqlMeta);
console.log('SQL_COUNT', firstCell);

// Export: produces a zip download.
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 120_000 }),
  page.click('#btn-export'),
]);
console.log('EXPORT_DOWNLOAD', download.suggestedFilename());

// Files tab: browse the WASM filesystem and open a file.
await page.click('#btn-files');
await page.waitForFunction(
  () => (document.getElementById('fslist')?.textContent || '').includes('composer.json'),
  undefined,
  { timeout: 60_000 }
);
await page.click('#fslist .row:has-text("composer.json")');
await page.waitForFunction(
  () => (document.getElementById('fseditor')?.value || '').includes('shopware'),
  undefined,
  { timeout: 60_000 }
);
const fsPath = await page.textContent('#fspath');
console.log('FILES_OPEN', fsPath);

// Write round-trip: append a harmless comment to .env.local and save.
await page.click('#fslist .row:has-text(".env.local")');
await page.waitForFunction(
  () => (document.getElementById('fseditor')?.value || '').length > 0,
  undefined,
  { timeout: 60_000 }
);
await page.evaluate(() => {
  const ed = document.getElementById('fseditor');
  ed.value = ed.value + '\n# playground-e2e-write-test\n';
  ed.dispatchEvent(new Event('input'));
});
await page.click('#fssave');
await page.waitForFunction(
  () => /saved \d+ bytes/.test(document.getElementById('fsmeta')?.textContent || ''),
  undefined,
  { timeout: 60_000 }
);
const fsWriteMeta = await page.textContent('#fsmeta');
console.log('FILES_WRITE', fsWriteMeta);
await page.screenshot({ path: '/tmp/pg-files-tab.png' });

// Logs tab: request ring buffer has entries from the storefront boot.
await page.click('#btn-logs');
await page.waitForFunction(
  () => (document.getElementById('reqlog')?.textContent || '').includes('/index.php'),
  undefined,
  { timeout: 60_000 }
);
const reqLogText = await page.textContent('#reqlog');
console.log('LOGS_REQUESTS', /GET|POST/.test(reqLogText));

// Address bar: tracks the iframe URL and navigates on submit.
await page.click('#btn-logs'); // close drawer for a clean screenshot later
const addrValue = await page.inputValue('#addr');
console.log('ADDR_TRACKS', addrValue);
await page.click('#addr');
const quickNavVisible = await page.isVisible('#quicknav');
await page.keyboard.press('Escape');
await page.fill('#addr', '/index.php');
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => /HTTP 200|GET \/index\.php/.test(document.getElementById('status')?.textContent || ''),
  undefined,
  { timeout: 120_000 }
);
console.log('QUICKNAV', quickNavVisible);
console.log('ADDR_NAV', await page.inputValue('#addr'));

// Version toggle: switch to the non-default version, wait for reboot,
// then switch back.
async function waitForShop() {
  await page.waitForFunction(
    () => {
      const s = document.getElementById('status')?.textContent || '';
      if (/^Error:/.test(s)) return true;
      const frame = document.getElementById('viewport');
      try {
        const fhtml = frame?.contentDocument?.documentElement?.outerHTML || '';
        return /Playground Shop/.test(fhtml) || /theme\/.*all\.css/.test(fhtml);
      } catch {
        return /HTTP 200/.test(s);
      }
    },
    undefined,
    { timeout: 300_000 }
  );
}

let toggled = '';
let toggleOk = true;
if (versionOptions.length > 1) {
  const activeOption = await page.inputValue('#version');
  toggled = versionOptions.find((v) => v !== activeOption) || versionOptions[1];
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }),
    page.selectOption('#version', toggled),
  ]);
  await waitForShop();
  // The status flips to HTTP 200 when the PHP response is ready; the iframe
  // document may still be swapping in (higher latency on remote hosts), so
  // wait for the new document to actually contain Shopware markup.
  await page
    .waitForFunction(
      () =>
        /shopware/i.test(
          document.getElementById('viewport')?.contentDocument?.documentElement
            ?.outerHTML || ''
        ),
      undefined,
      { timeout: 60_000 }
    )
    .catch(() => {});
  const toggledStatus = await page.textContent('#status');
  const toggledHtml = await page.$eval('#viewport', (el) => {
    try {
      return el.contentDocument?.documentElement?.outerHTML || '';
    } catch {
      return el.srcdoc || '';
    }
  });
  console.log('TOGGLED_VERSION', toggled);
  console.log('TOGGLED_STATUS', toggledStatus);
  console.log('TOGGLED_HAS_SHOPWARE', /shopware/i.test(toggledHtml));
  toggleOk = /shopware/i.test(toggledHtml) && toggledHtml.length > 1000 && !/^Error:/.test(toggledStatus || '');
} else {
  console.log('TOGGLE_SKIPPED single version');
}

if (screenshot) {
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log('SCREENSHOT', screenshot);
}
console.log('PAGE_ERRORS', errors.length ? errors.join('\n') : 'none');
console.log('CONSOLE_ERRORS', consoleErrors.length ? consoleErrors.join('\n') : 'none');

let failed = false;
if (!/shopware/i.test(html) || html.length < 1000) failed = true;
if (errors.length) failed = true;
if (!versionOptions.length) failed = true;
if (!(Number(firstCell) > 0)) failed = true;
if (!/composer\.json/.test(fsPath || '')) failed = true;
if (!/saved \d+ bytes/.test(fsWriteMeta || '')) failed = true;
if (!/GET|POST/.test(reqLogText || '')) failed = true;
if (!/\/index\.php/.test(addrValue || '')) failed = true;
if (!quickNavVisible) failed = true;
if (versionOptions.length > 1 && (!toggled || !toggleOk)) failed = true;
await browser.close();
process.exit(failed ? 1 : 0);
