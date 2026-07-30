'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Shows a tap-to-update bar when the server runs a newer build than this page.
 * Installed PWAs have no reload button, so this is their update path. Checks
 * on launch, whenever the app returns to the foreground, and periodically.
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const current = process.env.NEXT_PUBLIC_BUILD;
    if (!current) return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        const { build } = (await res.json()) as { build?: string };
        if (!stopped && build && build !== 'dev' && build !== current) setAvailable(true);
      } catch {
        // offline — try again later
      }
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, []);

  const update = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
    } catch {
      // reload picks it up regardless (network-first pages)
    }
    location.reload();
  }, []);

  if (!available) return null;
  return (
    <button
      onClick={update}
      className="flex w-full items-center justify-center gap-1.5 border-2 border-accent px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-accent"
    >
      <RefreshCw size={13} strokeWidth={2.25} />
      {t('updateAvailable')}
    </button>
  );
}
