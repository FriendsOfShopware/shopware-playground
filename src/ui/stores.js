/**
 * Shared shell state. Classic Svelte stores so plain .js modules
 * (playground.js) can drive the UI without a component hierarchy.
 */
import { writable } from 'svelte/store';

/** Toolbar status line text. */
export const status = writable('Loading…');

/** Worker booted: toolbar buttons and address bar become enabled. */
export const ready = writable(false);

/** First Shopware document rendered in the iframe: hides the boot overlay. */
export const booted = writable(false);

/** Manifest versions + active id. */
export const versions = writable({ list: [], active: '' });

/** Currently booted Shopware version id. */
export const activeVersion = writable('');

/** Developer drawer visibility + active tab ('sql' | 'files' | 'logs'). */
export const drawer = writable({ open: false, tab: 'sql' });

/** Bumped on every iframe load so the address bar re-syncs. */
export const frameNav = writable(0);
