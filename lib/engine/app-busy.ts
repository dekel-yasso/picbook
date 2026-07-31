// Global "don't interrupt me" flag: the service worker's auto-reload-on-update
// (sw-register.tsx) checks this before reloading, so it never yanks the user
// out of an open overlay (book/clip/reviewer) mid-task. Plain module state,
// not React — the SW registration lives outside the component tree.
let busy = false;
const listeners = new Set<() => void>();

export function setAppBusy(value: boolean): void {
  busy = value;
  if (!busy) for (const l of listeners) l();
}

export function isAppBusy(): boolean {
  return busy;
}

/** Fires once, the next time the app goes idle. Returns an unsubscribe fn. */
export function onceAppIdle(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
