<script>
  import { send } from './playground.js';

  export let visible = false;

  let files = [];
  let selected = '';
  let requests = [];
  let meta = '';
  let expanded = new Set();

  $: if (visible) refreshLogs();

  $: selectedFile = files.find((f) => f.name === selected);

  function statusClass(status) {
    return 'st' + Math.floor((status || 0) / 100);
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString();
  }

  function toggleErr(i) {
    const next = new Set(expanded);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    expanded = next;
  }

  async function refreshLogs() {
    meta = 'refreshing…';
    try {
      const res = await send({ type: 'logs' });
      files = res.result.files || [];
      if (!selected && files.length) {
        selected = files[0].name;
      }
      requests = res.result.requests || [];
      meta = 'updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      meta = err && err.message ? err.message : String(err);
    }
  }
</script>

<div class="runrow">
  <button id="logs-refresh" type="button" on:click={refreshLogs}>Refresh</button>
  <span id="logsmeta">{meta}</span>
</div>
<div id="logfiles">
  {#each files as file (file.name)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <span class:active={file.name === selected} on:click={() => (selected = file.name)}>{file.name}</span>
  {/each}
</div>
<pre id="logtail">{#if selectedFile}{#if selectedFile.truncated}[… last 64KB of {selectedFile.size} bytes …]
{/if}{selectedFile.tail || '(empty)'}{:else}{files.length ? 'Select a log file above.' : 'No Shopware log files yet (var/log is empty).'}{/if}</pre>
<div id="reqlog">
  {#if !requests.length}
    <p style="color:#64748b;padding:0.4rem">No requests yet — click around in the shop.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>time</th><th>method</th><th>url</th><th>status</th>
        </tr>
      </thead>
      <tbody>
        {#each requests as entry, i}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <tr class:haserr={Boolean(entry.errors)} on:click={() => entry.errors && toggleErr(i)}>
            <td title={formatTime(entry.ts)}>{formatTime(entry.ts)}</td>
            <td title={entry.method}>{entry.method}</td>
            <td title={entry.url}>{entry.url}</td>
            <td class={statusClass(entry.status)} title={String(entry.status)}>{entry.status}</td>
          </tr>
          {#if entry.errors}
            <tr class="errrow" hidden={!expanded.has(i)}>
              <td colspan="4">{entry.errors}</td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</div>
