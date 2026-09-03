<script>
  import { status, booted, activeVersion } from './stores.js';
  import { ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_PATH } from '../admin-credentials.mjs';

  const STEPS = [
    { label: 'Loading version manifest', match: ['manifest'] },
    { label: 'Registering service worker', match: ['service worker'] },
    {
      label: 'Booting PHP + MariaDB engine',
      match: ['worker', 'maria', 'php', 'kernel', 'download', 'import', 'starting'],
    },
    { label: 'Opening the shop', match: ['opening', 'shopware get', 'http'] },
  ];

  $: text = ($status || '').toLowerCase();
  $: isError = /^error|error:|failed/.test(text);
  $: activeStep = STEPS.reduce(
    (found, step, i) => (step.match.some((m) => text.includes(m)) ? i : found),
    0
  );

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
</script>

{#if !$booted}
  <div id="bootoverlay" role="alertdialog" aria-label="Playground is loading">
    <div class="bootcard" class:error={isError}>
      {#if isError}
        <div class="boot-error-icon">!</div>
        <h2>Something went wrong</h2>
        <p class="boot-status err">{$status}</p>
        <button type="button" class="boot-retry" on:click={() => location.reload()}>
          Reload and try again
        </button>
      {:else}
        <div class="boot-spinner" aria-hidden="true"></div>
        <h2>Starting Shopware {$activeVersion || ''}</h2>
        <p class="boot-status">{$status}</p>
        <ol class="boot-steps">
          {#each STEPS as step, i (step.label)}
            <li class:done={i < activeStep} class:active={i === activeStep}>
              {step.label}
            </li>
          {/each}
        </ol>
        <p class="boot-hint">
          First boot downloads the WASM engine and imports the demo shop — this can
          take a minute. Later visits start in seconds.
        </p>
        <div class="boot-creds">
          <span class="boot-creds-title">Admin login ({ADMIN_PATH})</span>
          <button type="button" class="cred" title="Copy username" on:click={() => copy(ADMIN_USERNAME, 'u')}>
            user <code>{ADMIN_USERNAME}</code>{copied === 'u' ? ' ✓' : ''}
          </button>
          <button type="button" class="cred" title="Copy password" on:click={() => copy(ADMIN_PASSWORD, 'p')}>
            password <code>{ADMIN_PASSWORD}</code>{copied === 'p' ? ' ✓' : ''}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
