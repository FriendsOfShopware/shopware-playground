<script>
  import { ready, frameNav } from './stores.js';
  import { getFrame, currentFramePath, navigateTo } from './playground.js';

  const QUICK_NAV = [
    { label: 'Storefront', path: '/index.php', icon: '⌂' },
    { label: 'Administration', path: '/admin', icon: '⚙' },
    { label: 'Account', path: '/index.php/account', icon: '◉' },
    { label: 'Cart', path: '/index.php/checkout/cart', icon: '▣' },
  ];

  let addr = '';
  let showQuickNav = false;
  let addrEl;

  // Re-sync whenever the iframe finishes a navigation.
  $: if ($frameNav >= 0) syncFromFrame();

  function syncFromFrame() {
    if (typeof document !== 'undefined' && document.activeElement === addrEl) return;
    const path = currentFramePath();
    if (path) addr = path;
  }

  function go(input) {
    navigateTo(input);
    if (addrEl) addrEl.blur();
    showQuickNav = false;
  }

  function onKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      go(addr);
    } else if (event.key === 'Escape') {
      showQuickNav = false;
      addrEl.blur();
    }
  }

  function historyBack() {
    getFrame().contentWindow.history.back();
  }

  function historyForward() {
    getFrame().contentWindow.history.forward();
  }

  function reload() {
    getFrame().contentWindow.location.reload();
  }
</script>

<div id="chrome">
  <button id="btn-back" class="navbtn" type="button" title="Back" disabled={!$ready} on:click={historyBack}>‹</button>
  <button id="btn-fwd" class="navbtn" type="button" title="Forward" disabled={!$ready} on:click={historyForward}>›</button>
  <button id="btn-reload" class="navbtn" type="button" title="Reload" disabled={!$ready} on:click={reload}>⟳</button>
  <div id="addrwrap">
    <input
      id="addr"
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder="/index.php"
      aria-label="Shopware path"
      disabled={!$ready}
      bind:this={addrEl}
      bind:value={addr}
      on:focus={() => (showQuickNav = true)}
      on:blur={() => (showQuickNav = false)}
      on:keydown={onKeydown}
    />
    <button id="addrgo" type="button" title="Go" disabled={!$ready} on:click={() => go(addr)}>→</button>
    <div id="quicknav" hidden={!showQuickNav}>
      {#each QUICK_NAV as item (item.path)}
        <button
          type="button"
          class="qn"
          on:mousedown={(event) => {
            event.preventDefault(); // keep input focus logic from hiding first
            go(item.path);
          }}
        >
          <span class="qn-icon">{item.icon}</span>
          <span>{item.label}</span>
          <span class="qn-path">{item.path}</span>
        </button>
      {/each}
    </div>
  </div>
</div>
