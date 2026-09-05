'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

const KEY = 'picbook-debug-log';

/** TEMP: surfaces the crash-checkpoint log (see useEngine.ts's 'debug-log'
 *  handling) after a reload, so it can be screenshotted off a phone instead
 *  of needing remote devtools. Remove once the mobile PDF-crash investigation
 *  is done. */
export function DebugLogViewer() {
  const [log, setLog] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setLog(localStorage.getItem(KEY));
    } catch {
      // ignore
    }
  }, []);

  const clear = () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    setLog(null);
    setOpen(false);
  };

  if (!log) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 start-3 z-[90] border-2 border-accent bg-accent px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-white"
      >
        Debug log available
      </button>
      {open && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-[95] flex flex-col bg-ground text-ink">
          <div className="flex items-center justify-between border-b-2 border-ink px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <button onClick={() => setOpen(false)} aria-label="Close" className="px-2 py-1">
              <X size={20} strokeWidth={2.25} />
            </button>
            <span className="text-[14px] font-extrabold">Debug log</span>
            <button onClick={clear} className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Clear
            </button>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{log}</pre>
          </div>
        </div>
      )}
    </>
  );
}
