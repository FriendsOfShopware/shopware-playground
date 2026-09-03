<script>
  import { onMount } from 'svelte';
  import Toolbar from './Toolbar.svelte';
  import Drawer from './Drawer.svelte';
  import AddressBar from './AddressBar.svelte';
  import LoadingOverlay from './LoadingOverlay.svelte';
  import { boot, setFrame, reportFrameLoaded, setStatus } from './playground.js';
  import { frameNav } from './stores.js';

  let frame;

  onMount(() => {
    setFrame(frame);
    frame.addEventListener('load', () => {
      frameNav.update((n) => n + 1);
      reportFrameLoaded();
    });
    boot().catch((err) => {
      setStatus('Error: ' + (err && err.message ? err.message : String(err)));
      console.error(err);
    });
  });
</script>

<Toolbar />
<div id="main">
  <iframe id="viewport" title="Shopware" bind:this={frame}></iframe>
  <Drawer />
</div>
<AddressBar />
<LoadingOverlay />
