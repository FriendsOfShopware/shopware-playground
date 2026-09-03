/**
 * Load only PHP 8.4 asyncify (plus intl) for the browser worker.
 * Other @php-wasm/web versions are aliased out at bundle time.
 */
import { loadWebRuntime } from '@php-wasm/web';

export async function loadPlaygroundWebRuntime() {
  if (!('setImmediate' in globalThis)) {
    globalThis.setImmediate = (fn) => setTimeout(fn, 0);
  }
  return loadWebRuntime('8.4', {
    extensions: ['intl'],
  });
}
