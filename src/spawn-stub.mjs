// PHP WASM cannot spawn child processes. Without a spawn handler, a PHP
// popen() makes php-wasm's JS bridge throw SPAWN_UNSUPPORTED and then never
// resolve its wake-up promise — the whole runtime hangs silently. Install a
// handler that answers every spawn with exit code 1 and empty output, so
// callers (e.g. Composer's git probes) take their ordinary failure path.

function stubEmitter() {
  const listeners = {};
  return {
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
    },
    off(event, fn) {
      const list = listeners[event];
      if (list) {
        const i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      }
    },
    emit(event, ...args) {
      for (const fn of [...(listeners[event] || [])]) fn(...args);
    },
  };
}

let nextStubPid = 1;

export function installSpawnStub(php) {
  return php.setSpawnHandler(() => {
    const cp = stubEmitter();
    cp.stdout = stubEmitter();
    cp.stderr = stubEmitter();
    cp.kill = () => {};
    cp.pid = 900000 + nextStubPid++;
    queueMicrotask(() => cp.emit('exit', 1));
    return cp;
  });
}
