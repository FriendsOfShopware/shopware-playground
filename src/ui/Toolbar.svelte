<script>
  import { status, ready, demos, activeDemo, drawer } from './stores.js';
  import { switchDemo, exportPlayground, resetPlayground, setStatus } from './playground.js';
  import AdminModal from './AdminModal.svelte';

  const OPEN_DEMO = '__open-demo__';

  let exporting = false;
  let resetting = false;
  let showAdmin = false;

  /** Option text: the label, plus the Shopware version when the label omits it. */
  function optionLabel(demo) {
    const label = demo.label || demo.id;
    if (demo.shopware && !label.includes(demo.shopware)) {
      return label + ' · Shopware ' + demo.shopware;
    }
    return label;
  }

  /** Value that re-selects a demo: index demos by id, others by their ref. */
  function optionValue(demo) {
    if (demo.source === 'remote') return demo.manifestUrl;
    return demo.id;
  }

  function onSelect(event) {
    const value = event.currentTarget.value;
    if (value === OPEN_DEMO) {
      event.currentTarget.value = $activeDemo ? optionValue($activeDemo) : '';
      const ref = prompt(
        'Open a demo by name (uploaded with "playground demo upload") or by the URL of its demo.json:'
      );
      if (ref) switchDemo(ref);
      return;
    }
    if ($activeDemo && value === optionValue($activeDemo)) return;
    switchDemo(value);
  }

  function openDrawer(tab) {
    drawer.update((d) =>
      d.open && d.tab === tab ? { open: false, tab } : { open: true, tab }
    );
  }

  async function doExport() {
    exporting = true;
    try {
      await exportPlayground();
    } catch (err) {
      setStatus('Export failed: ' + (err && err.message ? err.message : err));
    } finally {
      exporting = false;
    }
  }

  async function doReset() {
    const label = $activeDemo ? ' for ' + $activeDemo.label : '';
    if (!confirm('Reset the playground' + label + '?\n\nThe database is wiped and the demo data is re-imported.')) {
      return;
    }
    resetting = true;
    try {
      await resetPlayground();
    } catch (err) {
      setStatus('Reset failed: ' + (err && err.message ? err.message : err));
      resetting = false;
    }
  }
</script>

<div id="bar">
  <strong>Shopware playground</strong>
  <select
    id="demo"
    title="Demo"
    disabled={!$ready}
    value={$activeDemo ? optionValue($activeDemo) : ''}
    on:change={onSelect}
  >
    {#if !$demos.list.length}
      <option value="">…</option>
    {/if}
    {#each $demos.list as demo (demo.storageKey)}
      <option value={optionValue(demo)}>{optionLabel(demo)}</option>
    {/each}
    <option disabled>──────────</option>
    <option value={OPEN_DEMO}>Open demo…</option>
  </select>
  <span id="status">{$status}</span>
  <span class="spacer"></span>
  <button id="btn-admin" type="button" title="Admin credentials" on:click={() => (showAdmin = true)}>Admin</button>
  <button id="btn-database" type="button" disabled={!$ready} on:click={() => openDrawer('sql')}>Database</button>
  <button id="btn-files" type="button" disabled={!$ready} on:click={() => openDrawer('files')}>Files</button>
  <button id="btn-logs" type="button" disabled={!$ready} on:click={() => openDrawer('logs')}>Logs</button>
  <button id="btn-export" type="button" disabled={!$ready || exporting} on:click={doExport}>Export</button>
  <button id="btn-reset" type="button" disabled={!$ready || resetting} on:click={doReset}>Reset</button>
</div>
<AdminModal bind:open={showAdmin} />
