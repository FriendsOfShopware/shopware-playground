<script>
  import { send } from './playground.js';

  export let visible = false;

  let cwd = '/shopware';
  let entries = [];
  let capped = false;
  let listLoaded = false;
  let file = '';
  let shownPath = '';
  let content = '';
  let dirty = false;
  let editable = false;
  let saveable = false;
  let meta = '';

  $: if (visible && !listLoaded) {
    listLoaded = true;
    loadDir(cwd);
  }

  $: crumbParts = cwd.split('/').filter(Boolean).map((part, i, all) => ({
    part,
    path: '/' + all.slice(0, i + 1).join('/'),
  }));

  async function loadDir(path) {
    try {
      const res = await send({ type: 'fs-list', path });
      cwd = res.result.path;
      entries = res.result.entries || [];
      capped = Boolean(res.result.capped);
    } catch (err) {
      meta = err && err.message ? err.message : String(err);
    }
  }

  function parentDir() {
    return cwd.split('/').slice(0, -1).join('/') || '/shopware';
  }

  async function openFile(path) {
    if (dirty && !confirm('Discard unsaved changes to ' + file + '?')) return;
    meta = 'loading…';
    try {
      const res = await send({ type: 'fs-read', path });
      const f = res.result;
      if (f.binary) {
        meta = 'binary file (' + f.size + ' bytes) — not editable';
        file = '';
        content = '';
        editable = false;
        dirty = false;
        shownPath = f.path;
        return;
      }
      file = f.path;
      shownPath = f.path;
      content = f.content;
      editable = true;
      saveable = !f.truncated;
      dirty = false;
      meta = f.size + ' bytes' + (f.truncated ? ' — showing first 512KB, save disabled' : '');
    } catch (err) {
      meta = err && err.message ? err.message : String(err);
    }
  }

  async function saveFile() {
    if (!file) return;
    saveable = false;
    try {
      const res = await send({ type: 'fs-write', path: file, content });
      dirty = false;
      meta = 'saved ' + res.result.size + ' bytes — applies on next request';
    } catch (err) {
      meta = 'save failed: ' + (err && err.message ? err.message : err);
    } finally {
      saveable = true;
    }
  }

  function onEditorKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      saveFile();
    }
    // Keep Tab inside the editor instead of moving focus.
    if (event.key === 'Tab') {
      event.preventDefault();
      const el = event.currentTarget;
      const { selectionStart: s, selectionEnd: e, value } = el;
      content = value.slice(0, s) + '\t' + value.slice(e);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = s + 1;
      });
    }
  }
</script>

<div id="fscrumb">
  {#each crumbParts as { part, path }, i (path)}
    {#if i > 0}<span class="sep">/</span>{/if}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_missing_attribute -->
    <a on:click={() => loadDir(path)}>{part}</a>
  {/each}
</div>
<div id="fslist">
  {#if cwd !== '/shopware'}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="row dir" on:click={() => loadDir(parentDir())}>
      <span class="icon">↩</span><span>..</span>
    </div>
  {/if}
  {#each entries as entry (entry.name)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="row"
      class:dir={entry.dir}
      on:click={() => (entry.dir ? loadDir(cwd + '/' + entry.name) : openFile(cwd + '/' + entry.name))}
    >
      <span class="icon">{entry.dir ? '▸' : '·'}</span>
      <span>{entry.name}{entry.dir ? '/' : ''}</span>
    </div>
  {/each}
  {#if capped}
    <div class="row">… listing capped</div>
  {/if}
</div>
<div id="fseditorbar">
  <span id="fspath">{shownPath || 'no file open'}</span>
  <span class="spacer" style="flex:1"></span>
  <button id="fssave" type="button" disabled={!editable || !saveable} on:click={saveFile}>Save ⌘/Ctrl+S</button>
  <span id="fsmeta">{meta}</span>
</div>
<textarea
  id="fseditor"
  spellcheck="false"
  disabled={!editable}
  placeholder="Select a file above"
  bind:value={content}
  on:input={() => (dirty = true)}
  on:keydown={onEditorKeydown}
></textarea>
