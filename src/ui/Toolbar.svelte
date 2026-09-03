<script>
  import { status, ready, versions, activeVersion, drawer } from './stores.js';
  import { switchVersion, exportPlayground, resetPlayground, setStatus } from './playground.js';
  import AdminModal from './AdminModal.svelte';

  let exporting = false;
  let resetting = false;
  let showAdmin = false;

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
    const label = $activeVersion ? ' for Shopware ' + $activeVersion : '';
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
    id="version"
    title="Shopware version"
    disabled={!$ready}
    value={$activeVersion}
    on:change={(e) => switchVersion(e.currentTarget.value)}
  >
    {#if !$versions.list.length}
      <option>…</option>
    {/if}
    {#each $versions.list as v (v.id)}
      <option value={v.id}>{v.label || 'Shopware ' + v.id}</option>
    {/each}
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
