'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { planBook } from '@/lib/engine/book';
import { getDB } from '@/lib/engine/db';
import type { BookPlan, PhotoMeta } from '@/lib/engine/types';
import { PdfPreview } from './pdf-preview';
import { Thumb } from './thumb';

interface BookProps {
  tripId: string;
  keepers: PhotoMeta[];
  pinnedIds: Set<string>;
  places: Map<string, string>;
  getFile: (id: string) => File | undefined;
  renderBook: (plan: BookPlan, files: Map<string, File>) => Promise<Uint8Array>;
  progress: { done: number; total: number; running: boolean };
  onClose: () => void;
}

export function BookOverlay({ tripId, keepers, pinnedIds, places, getFile, renderBook, progress, onClose }: BookProps) {
  const maxPhotos = keepers.length;
  const [target, setTarget] = useState(Math.min(48, maxPhotos));
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [pdf, setPdf] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The book document (size + edited titles) persists across sessions.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    getDB()
      // 'default' is both the default trip id and the pre-trips book key.
      .then((db) => db.get('books', tripId))
      .then((doc) => {
        if (doc) {
          setTitles(doc.titles);
          setTarget(Math.min(Math.max(doc.target, Math.min(4, maxPhotos)), maxPhotos));
        }
        setLoaded(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once, at open
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      getDB()
        .then((db) => db.put('books', { target, titles, updatedAt: Date.now() }, tripId))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [loaded, target, titles]);

  const plan = useMemo(
    () => planBook(keepers, target, places, pinnedIds),
    [keepers, target, places, pinnedIds],
  );
  const titled = useMemo<BookPlan>(
    () => ({
      ...plan,
      chapters: plan.chapters.map((c) => ({ ...c, title: titles[c.key] ?? c.title })),
    }),
    [plan, titles],
  );
  const pageCount = titled.chapters.reduce((n, c) => n + 1 + c.pages.length, 0);

  const generate = useCallback(async () => {
    setError(null);
    setPdf(null);
    const files = new Map<string, File>();
    for (const c of titled.chapters) {
      for (const id of [c.heroId, ...c.pages.flatMap((p) => p.photoIds)]) {
        const f = getFile(id);
        if (f) files.set(id, f);
      }
    }
    try {
      const bytes = await renderBook(titled, files);
      setPdf(new File([new Uint8Array(bytes)], 'picbook.pdf', { type: 'application/pdf' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [titled, getFile, renderBook]);

  // Kept synchronous inside the tap's user activation so iOS allows share().
  const save = useCallback(() => {
    if (!pdf) return;
    if (navigator.canShare?.({ files: [pdf] })) {
      navigator.share({ files: [pdf] }).catch(() => {});
      return;
    }
    const url = URL.createObjectURL(pdf);
    const a = document.createElement('a');
    a.href = url;
    a.download = pdf.name;
    a.click();
    URL.revokeObjectURL(url);
  }, [pdf]);

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-neutral-500/30 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-xl leading-none">
          ✕
        </button>
        <span className="text-sm font-semibold">Your book</span>
        <span className="text-xs text-neutral-500">{pageCount} pages</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="flex justify-between text-neutral-500">
              <span>
                Photos in the book
                {pinnedIds.size > 0 && ` · ${pinnedIds.size} 📖 must-haves`}
              </span>
              <span className="font-medium text-foreground">
                {plan.photoCount} of {maxPhotos}
              </span>
            </span>
            <input
              type="range"
              min={Math.min(4, maxPhotos)}
              max={maxPhotos}
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
              className="w-full"
            />
          </label>

          {pdf && <PdfPreview file={pdf} />}

          {titled.chapters.map((c) => (
            <section key={c.key} className="flex flex-col gap-2">
              <input
                value={c.title}
                onChange={(e) => setTitles((t) => ({ ...t, [c.key]: e.target.value }))}
                aria-label={`Chapter title for ${c.key}`}
                className="w-full rounded-lg border border-neutral-500/30 bg-transparent px-3 py-2 text-sm font-medium"
              />
              {c.caption && <p className="text-xs text-neutral-500">{c.caption}</p>}
              <div className="flex flex-wrap gap-2">
                <div className="relative h-28 w-28">
                  <Thumb id={c.heroId} alt="Chapter hero" />
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-semibold text-white">
                    hero
                  </span>
                </div>
                {c.pages.map((p, i) => (
                  <div
                    key={i}
                    className="grid h-28 w-28 grid-cols-2 content-start gap-0.5 rounded-lg border border-neutral-500/30 p-0.5"
                  >
                    {p.photoIds.map((id) => (
                      <div key={id} className={p.photoIds.length === 1 ? 'col-span-2' : ''}>
                        <Thumb id={id} alt="" />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      <div className="border-t border-neutral-500/30 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {progress.running && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-500/30">
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-200"
                style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }}
              />
            </div>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={generate}
              disabled={progress.running || plan.photoCount === 0}
              className="flex-1 rounded-xl border border-neutral-500/50 py-3 text-sm font-semibold disabled:opacity-40"
            >
              {progress.running ? 'Rendering…' : pdf ? 'Re-render' : 'Render PDF'}
            </button>
            {pdf && !progress.running && (
              <button onClick={save} className="flex-1 rounded-xl bg-foreground py-3 text-sm font-semibold text-background">
                Save PDF ({(pdf.size / 1024 / 1024).toFixed(1)} MB)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
