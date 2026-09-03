<script>
  import { send } from './playground.js';

  export let visible = false;

  let tables = [];
  let tablesLoaded = false;
  let sql = '';
  let result = null;
  let truncated = false;
  let elapsed = 0;
  let error = '';
  let meta = '';

  $: if (visible && !tablesLoaded) {
    tablesLoaded = true;
    loadTables();
  }

  function formatCell(value) {
    if (value === null || value === undefined) return { text: 'NULL', cls: 'null' };
    if (value instanceof Uint8Array) {
      const hex = [...value.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { text: '0x' + hex + (value.length > 16 ? '…' : ''), cls: 'bin' };
    }
    if (typeof value === 'object') return { text: JSON.stringify(value), cls: '' };
    return { text: String(value), cls: '' };
  }

  async function runSql() {
    const query = sql.trim();
    if (!query) return;
    const started = performance.now();
    error = '';
    try {
      const res = await send({ type: 'sql', sql: query });
      result = res.result || {};
      truncated = res.truncated;
      elapsed = Math.round(performance.now() - started);
      const rows = result.rows || [];
      meta = result.fields && result.fields.length
        ? rows.length + ' row' + (rows.length === 1 ? '' : 's') +
          (truncated ? ' (capped)' : '') + ' in ' + elapsed + ' ms'
        : elapsed + ' ms';
    } catch (err) {
      result = null;
      meta = '';
      error = err && err.message ? err.message : String(err);
    }
  }

  async function loadTables() {
    try {
      const res = await send({ type: 'sql', sql: 'SHOW FULL TABLES' });
      const rows = (res.result && res.result.rows) || [];
      tables = rows
        .map((row) => Object.values(row))
        .filter(([name, kind]) => name && !String(kind).toUpperCase().includes('VIEW'))
        .map(([name]) => String(name));
    } catch {
      /* tables list is best-effort */
    }
  }

  function pickTable(name) {
    sql = 'SELECT * FROM `' + name + '` LIMIT 100';
    runSql();
  }

  function onKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      runSql();
    }
  }
</script>

<div id="tables" title="Click a table to select from it">
  {#each tables as name (name)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <span on:click={() => pickTable(name)}>{name}</span>
  {/each}
</div>
<textarea
  id="sql"
  spellcheck="false"
  placeholder="SELECT * FROM product LIMIT 10"
  bind:value={sql}
  on:keydown={onKeydown}
></textarea>
<div class="runrow">
  <button id="runsql" type="button" on:click={runSql}>Run ⌘/Ctrl+Enter</button>
  <span id="sqlmeta">{meta}</span>
</div>
<div id="sqlout">
  {#if error}
    <pre class="err">{error}</pre>
  {:else if result && result.fields && result.fields.length}
    <table>
      <thead>
        <tr>
          {#each result.fields as f (f)}
            <th>{f}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each result.rows || [] as row}
          <tr>
            {#each result.fields as f (f)}
              {@const cell = formatCell(row[f])}
              <td class={cell.cls || undefined} title={cell.text}>{cell.text}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if result}
    <p class="ok">OK — {result.affected ?? 0} affected</p>
  {/if}
</div>
