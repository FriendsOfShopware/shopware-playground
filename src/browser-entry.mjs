/**
 * Playground shell entry: mounts the Svelte UI. All logic lives in
 * src/ui/ (playground.js = worker/SW/RPC, components = views).
 */
import { mount } from 'svelte';
import App from './ui/App.svelte';

if (typeof window !== 'undefined') {
  mount(App, { target: document.getElementById('app') });
}
