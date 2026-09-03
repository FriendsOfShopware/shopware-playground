<script>
  import { drawer } from './stores.js';
  import SqlConsole from './SqlConsole.svelte';
  import FileEditor from './FileEditor.svelte';
  import LogViewer from './LogViewer.svelte';

  const tabs = [
    ['sql', 'Database'],
    ['files', 'Files'],
    ['logs', 'Logs'],
  ];
</script>

<section id="console" class:open={$drawer.open} aria-label="Developer tools">
  <header>
    <span class="dot"></span>
    <nav id="tabs">
      {#each tabs as [id, label] (id)}
        <button
          data-tab={id}
          type="button"
          class:active={$drawer.tab === id}
          on:click={() => drawer.set({ open: true, tab: id })}
        >{label}</button>
      {/each}
    </nav>
    <span class="spacer"></span>
    <button
      id="btn-console-close"
      type="button"
      title="Close"
      on:click={() => drawer.update((d) => ({ ...d, open: false }))}
    >✕</button>
  </header>

  <div class="panel" id="tab-sql" hidden={$drawer.tab !== 'sql'}>
    <SqlConsole visible={$drawer.open && $drawer.tab === 'sql'} />
  </div>
  <div class="panel" id="tab-files" hidden={$drawer.tab !== 'files'}>
    <FileEditor visible={$drawer.open && $drawer.tab === 'files'} />
  </div>
  <div class="panel" id="tab-logs" hidden={$drawer.tab !== 'logs'}>
    <LogViewer visible={$drawer.open && $drawer.tab === 'logs'} />
  </div>
</section>
