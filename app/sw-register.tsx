'use client';

import { useEffect } from 'react';
import { isAppBusy, onceAppIdle } from '@/lib/engine/app-busy';

export function SWRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => reg.update().catch(() => {}))
        .catch(() => {});
      // When an updated service worker takes over, reload once so the open
      // page immediately runs the new version (installed PWAs otherwise lag
      // a launch behind) — but never mid-task: if an overlay is open (book,
      // clip, reviewer...) the user could lose an unsaved render, so wait
      // until the app goes idle instead of reloading out from under them.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        const doReload = () => location.reload();
        if (isAppBusy()) onceAppIdle(doReload);
        else doReload();
      });
    }
    // Ask the browser not to evict IndexedDB (Safari evicts after ~7 days otherwise).
    navigator.storage?.persist?.().catch(() => {});
  }, []);
  return null;
}
