<script>
  import { ready } from './stores.js';
  import { navigateTo } from './playground.js';
  import { ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_PATH } from '../admin-credentials.mjs';

  export let open = false;

  let copied = '';
  function copy(value, which) {
    copied = '';
    const done = () => {
      copied = which;
      setTimeout(() => (copied = ''), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, () => {});
    }
  }

  function openAdmin() {
    navigateTo(ADMIN_PATH);
    open = false;
  }

  function onKeydown(event) {
    if (event.key === 'Escape') open = false;
  }
</script>

{#if open}
  <div
    id="adminmodal"
    role="dialog"
    aria-label="Admin credentials"
    on:keydown={onKeydown}
  >
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="adminmodal-backdrop" on:click={() => (open = false)}></div>
    <div class="adminmodal-card">
      <header>
        <strong>Administration login</strong>
        <button type="button" title="Close" on:click={() => (open = false)}>✕</button>
      </header>
      <div class="adminmodal-body">
        <div class="credrow">
          <span class="credlabel">Username</span>
          <code>{ADMIN_USERNAME}</code>
          <button type="button" on:click={() => copy(ADMIN_USERNAME, 'u')}>
            {copied === 'u' ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <div class="credrow">
          <span class="credlabel">Password</span>
          <code>{ADMIN_PASSWORD}</code>
          <button type="button" on:click={() => copy(ADMIN_PASSWORD, 'p')}>
            {copied === 'p' ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <button
          type="button"
          class="openadmin"
          disabled={!$ready}
          on:click={openAdmin}
        >Open administration →</button>
      </div>
    </div>
  </div>
{/if}
