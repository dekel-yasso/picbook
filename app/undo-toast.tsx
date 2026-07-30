'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';

export const UNDO_MS = 5000;

/** A pending destructive action: already hidden from the UI, not yet committed. */
export interface PendingAction {
  message: string;
  /** Actually perform the deletion (IndexedDB + remote). Runs when the toast expires or is superseded. */
  commit: () => void | Promise<void>;
  /** Undo the optimistic hide — no data was actually deleted yet. */
  undo: () => void;
}

/**
 * Ink-fill toast with a draining countdown bar, replacing window.confirm for
 * destructive actions: the action already ran optimistically in the UI, and
 * this is the user's window to undo before it's committed for real.
 */
export function UndoToast({ pending, onUndo }: { pending: PendingAction; onUndo: () => void }) {
  const { t } = useI18n();
  // Restart the drain animation whenever a new pending action replaces the last one.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const raf = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(raf);
  }, [pending]);

  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[70] flex justify-center">
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 bg-ink px-3.5 py-3 text-ground">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="truncate text-[13px] font-bold">{pending.message}</p>
          <div className="h-0.5 w-[120px] bg-[rgba(243,242,242,.25)]">
            <div
              className="h-full bg-ground transition-[width] ease-linear"
              style={{ width: armed ? '0%' : '100%', transitionDuration: `${UNDO_MS}ms` }}
            />
          </div>
        </div>
        <button onClick={onUndo} className="shrink-0 text-[12px] font-extrabold uppercase tracking-wide text-[#8fb3d9]">
          {t('undo')}
        </button>
      </div>
    </div>
  );
}
