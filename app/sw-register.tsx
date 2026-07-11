'use client';

import { useEffect } from 'react';

export function SWRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => reg.update().catch(() => {}))
        .catch(() => {});
      // When an updated service worker takes over, reload once so the open
      // page immediately runs the new version (installed PWAs otherwise lag
      // a launch behind).
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
    // Ask the browser not to evict IndexedDB (Safari evicts after ~7 days otherwise).
    navigator.storage?.persist?.().catch(() => {});
  }, []);
  return null;
}
