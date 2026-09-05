'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { applyBookOverrides, planBook } from '@/lib/engine/book';
import { takenTime } from '@/lib/engine/cluster';
import { getDB } from '@/lib/engine/db';
import { exportPagesAsZip } from '@/lib/engine/export-pages';
import type { BookPlan, PhotoMeta } from '@/lib/engine/types';
import { useI18n } from '@/lib/i18n';
import { PdfPreview } from './pdf-preview';
import { Thumb } from './thumb';

interface SwapTarget {
  chapterKey: string;
  slotIndex: number;
  photoId: string;
  pageLabel: number | 'hero';
}

interface BookProps {
  tripId: string;
  keepers: PhotoMeta[];
  pinnedIds: Set<string>;
  places: Map<string, string>;
  getFile: (id: string) => File | undefined;
  renderBook: (plan: BookPlan, files: Map<string, File>) => Promise<Uint8Array<ArrayBuffer>>;
  renderCover: (plan: BookPlan, files: Map<string, File>, title: string, cover?: 'softcover' | 'imagewrap') => Promise<Uint8Array<ArrayBuffer>>;
  tripName: string;
  progress: { done: number; total: number; running: boolean };
  onClose: () => void;
}

export function BookOverlay({ tripId, keepers, pinnedIds, places, getFile, renderBook, renderCover, tripName, progress, onClose }: BookProps) {
  const { lang, t } = useI18n();
  const maxPhotos = keepers.length;
  const [target, setTarget] = useState(Math.min(48, maxPhotos));
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [swap, setSwap] = useState<SwapTarget | null>(null);
  const [swapPick, setSwapPick] = useState<string | null>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The book document (size + edited titles + page swaps) persists across sessions.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    getDB()
      // 'default' is both the default trip id and the pre-trips book key.
      .then((db) => db.get('books', tripId))
      .then((doc) => {
        if (doc) {
          setTitles(doc.titles);
          setOverrides(doc.overrides ?? {});
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
        .then((db) => db.put('books', { target, titles, overrides, updatedAt: Date.now() }, tripId))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [loaded, target, titles, overrides]);

  const plan = useMemo(
    () => planBook(keepers, target, places, pinnedIds, lang),
    [keepers, target, places, pinnedIds, lang],
  );
  const overridden = useMemo(() => applyBookOverrides(plan, overrides), [plan, overrides]);
  const titled = useMemo<BookPlan>(
    () => ({
      ...overridden,
      chapters: overridden.chapters.map((c) => ({ ...c, title: titles[c.key] ?? c.title })),
    }),
    [overridden, titles],
  );
  const pageCount = titled.chapters.reduce((n, c) => n + 1 + c.pages.length, 0);

  // Swap-sheet data: same-day keepers not already used anywhere in the book.
  const keepersById = useMemo(() => new Map(keepers.map((p) => [p.id, p])), [keepers]);
  const allUsedIds = useMemo(
    () => new Set(titled.chapters.flatMap((c) => [c.heroId, ...c.pages.flatMap((p) => p.photoIds)])),
    [titled],
  );
  const swapCandidates = useMemo(() => {
    if (!swap) return [];
    const chapter = titled.chapters.find((c) => c.key === swap.chapterKey);
    if (!chapter) return [];
    const dayKeys = new Set(
      [chapter.heroId, ...chapter.pages.flatMap((p) => p.photoIds)]
        .map((id) => keepersById.get(id))
        .filter((p): p is PhotoMeta => !!p)
        .map((p) => new Date(takenTime(p)).toDateString()),
    );
    return keepers.filter((p) => !allUsedIds.has(p.id) && dayKeys.has(new Date(takenTime(p)).toDateString()));
  }, [swap, titled, keepersById, keepers, allUsedIds]);

  const openSwap = useCallback((next: SwapTarget) => {
    setSwap(next);
    setSwapPick(null);
  }, []);
  const closeSwap = useCallback(() => {
    setSwap(null);
    setSwapPick(null);
  }, []);
  const confirmSwap = useCallback(() => {
    if (!swap || !swapPick) return;
    setOverrides((prev) => ({ ...prev, [`${swap.chapterKey}:${swap.slotIndex}`]: swapPick }));
    closeSwap();
  }, [swap, swapPick, closeSwap]);
  const revertSwap = useCallback(() => {
    if (!swap) return;
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[`${swap.chapterKey}:${swap.slotIndex}`];
      return next;
    });
    closeSwap();
  }, [swap, closeSwap]);

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
      setPdf(new File([bytes], 'picbook.pdf', { type: 'application/pdf' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [titled, getFile, renderBook]);

  const generateCover = useCallback(async (type: 'softcover' | 'imagewrap') => {
    setError(null);
    setCover(null);
    setCoverBusy(true);
    const files = new Map<string, File>();
    const heroId = titled.chapters[0]?.heroId;
    if (heroId) {
      const f = getFile(heroId);
      if (f) files.set(heroId, f);
    }
    try {
      const bytes = await renderCover(titled, files, tripName, type);
      setCover(new File([bytes], `picbook-cover-${type}.pdf`, { type: 'application/pdf' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCoverBusy(false);
    }
  }, [titled, getFile, renderCover, tripName]);

  // Kept synchronous inside the tap's user activation so iOS allows share().
  const shareFile = useCallback((file: File | null) => {
    if (!file) return;
    if (navigator.canShare?.({ files: [file] })) {
      navigator.share({ files: [file] }).catch(() => {});
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  }, []);
  const save = useCallback(() => shareFile(pdf), [shareFile, pdf]);

  // Rasterize each page to a JPEG and zip them — for print sites that only
  // take individual images, not a ready PDF (most Israeli album editors).
  const [imagesZip, setImagesZip] = useState<File | null>(null);
  const [imagesBusy, setImagesBusy] = useState(false);
  const exportImages = useCallback(async () => {
    if (!pdf) return;
    setError(null);
    setImagesZip(null);
    setImagesBusy(true);
    try {
      const blob = await exportPagesAsZip(pdf);
      setImagesZip(new File([blob], 'picbook-pages.zip', { type: 'application/zip' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImagesBusy(false);
    }
  }, [pdf]);

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-ground text-ink">
      <div className="flex items-center justify-between border-b-2 border-ink px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={onClose} aria-label={t('close')} className="px-2 py-1">
          <X size={20} strokeWidth={2.25} />
        </button>
        <span className="text-[14px] font-extrabold">{t('yourBook')}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t('pagesCount', { n: pageCount })}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4">
          <label className="flex flex-col gap-2 text-sm">
            <span className="flex justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
              <span>
                {t('photosInBook')}
                {pinnedIds.size > 0 && t('mustHaves', { n: pinnedIds.size })}
              </span>
              <span className="font-bold normal-case tracking-normal text-ink">
                {t('ofMax', { n: plan.photoCount, max: maxPhotos })}
              </span>
            </span>
            <input
              type="range"
              min={Math.min(4, maxPhotos)}
              max={maxPhotos}
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
              className="h-4 w-full appearance-none bg-transparent [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-track [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-track [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-accent"
            />
          </label>

          {pdf && <PdfPreview file={pdf} />}

          {titled.chapters.map((c) => (
            <section key={c.key} className="flex flex-col gap-2">
              <input
                value={c.title}
                onChange={(e) => setTitles((t) => ({ ...t, [c.key]: e.target.value }))}
                aria-label={`Chapter title for ${c.key}`}
                className="w-full border-2 border-ink bg-white px-3 py-2 text-[15px] font-extrabold text-ink"
              />
              {c.caption && (
                <p className="text-[12px] font-semibold text-accent">
                  {c.caption} · {t('bookTapToEdit')}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => openSwap({ chapterKey: c.key, slotIndex: 0, photoId: c.heroId, pageLabel: 'hero' })}
                  className={`relative h-[112px] w-[112px] ${
                    swap?.chapterKey === c.key && swap.slotIndex === 0 ? 'outline outline-2 -outline-offset-2 outline-accent opacity-50' : ''
                  }`}
                >
                  <Thumb id={c.heroId} alt="Chapter hero" />
                  <span className="absolute start-0 top-0 bg-accent px-[6px] py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                    {t('chapterHero')}
                  </span>
                  <span className="absolute inset-x-0 bottom-0 bg-[rgba(32,30,29,.75)] py-1 text-center text-[9px] font-semibold text-white">
                    {t('bookTapToReplace')}
                  </span>
                </button>
                {c.pages.map((p, i) => {
                  const slotStart = 1 + c.pages.slice(0, i).reduce((n, pg) => n + pg.photoIds.length, 0);
                  const pageSelected = swap?.chapterKey === c.key && swap.pageLabel === i + 1;
                  return (
                    <div
                      key={i}
                      className={`relative grid h-[112px] w-[112px] grid-cols-2 content-start gap-0.5 p-0.5 ${
                        pageSelected ? 'border-2 border-accent' : 'border border-line'
                      }`}
                    >
                      {pageSelected && (
                        <span className="absolute start-0 top-0 z-10 bg-accent px-[6px] py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] text-white">
                          {t('bookPageChip', { n: i + 1 })}
                        </span>
                      )}
                      {p.photoIds.map((id, slotOffset) => {
                        const slotIndex = slotStart + slotOffset;
                        const isTarget = swap?.chapterKey === c.key && swap.slotIndex === slotIndex;
                        return (
                          <button
                            key={id}
                            onClick={() => openSwap({ chapterKey: c.key, slotIndex, photoId: id, pageLabel: i + 1 })}
                            className={`${p.photoIds.length === 1 ? 'col-span-2' : ''} ${
                              isTarget ? 'outline outline-2 -outline-offset-2 outline-accent opacity-50' : ''
                            }`}
                          >
                            <Thumb id={id} alt="" />
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      {swap ? (
        <div className="border-t-2 border-accent bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(32,30,29,.12)]">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-extrabold text-ink">
                {swap.pageLabel === 'hero' ? t('chapterHero') : t('bookSwapTitle', { n: swap.pageLabel })}
              </span>
              <button onClick={closeSwap} className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                {t('bookSwapClose')}
              </button>
            </div>
            <p className="text-xs text-muted">{t('bookSwapHelper')}</p>
            {swapCandidates.length === 0 ? (
              <p className="text-xs text-muted">{t('bookSwapEmpty')}</p>
            ) : (
              <div className="flex gap-2 overflow-x-auto">
                {swapCandidates.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSwapPick(p.id)}
                    className={`h-16 w-16 shrink-0 ${
                      swapPick === p.id ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
                    }`}
                  >
                    <Thumb id={p.id} alt="" />
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={revertSwap} className="flex-1 border-2 border-ink py-2.5 text-[11px] font-semibold text-ink">
                {t('bookRemoveFromPage')}
              </button>
              <button
                onClick={confirmSwap}
                disabled={!swapPick}
                className="flex-1 bg-accent py-2.5 text-[11px] font-semibold text-white disabled:opacity-45"
              >
                {t('bookSwapPhoto')}
              </button>
            </div>
          </div>
        </div>
      ) : (
      <div className="border-t-2 border-ink px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {progress.running && (
            <div className="h-1.5 w-full bg-track">
              <div
                className="h-full bg-ink transition-[width] duration-200"
                style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }}
              />
            </div>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={generate}
              disabled={progress.running || plan.photoCount === 0}
              className="flex-1 border-2 border-ink py-3 text-[13px] font-semibold text-ink disabled:opacity-45"
            >
              {progress.running ? t('rendering') : pdf ? t('reRender') : t('renderPdf')}
            </button>
            {pdf && !progress.running && (
              <button onClick={save} className="flex-1 bg-accent py-3 text-[13px] font-semibold text-white">
                {t('savePdf', { size: (pdf.size / 1024 / 1024).toFixed(1) })}
              </button>
            )}
          </div>
          {pdf && !progress.running && (
            <div className="flex gap-2">
              <button
                onClick={() => generateCover('softcover')}
                disabled={coverBusy}
                className="flex-1 border-2 border-ink py-2.5 text-[11px] font-semibold text-ink disabled:opacity-45"
              >
                {coverBusy ? t('rendering') : t('renderCover')}
              </button>
              <button
                onClick={() => generateCover('imagewrap')}
                disabled={coverBusy}
                className="flex-1 border-2 border-ink py-2.5 text-[11px] font-semibold text-ink disabled:opacity-45"
              >
                {coverBusy ? t('rendering') : t('renderCoverHard')}
              </button>
              {cover && !coverBusy && (
                <button
                  onClick={() => shareFile(cover)}
                  className="flex-1 bg-accent py-2.5 text-[11px] font-semibold text-white"
                >
                  {t('saveCover')}
                </button>
              )}
            </div>
          )}
          {pdf && !progress.running && (
            <div className="flex gap-2">
              <button
                onClick={exportImages}
                disabled={imagesBusy}
                className="flex-1 border-2 border-ink py-2.5 text-[11px] font-semibold text-ink disabled:opacity-45"
              >
                {imagesBusy ? t('rendering') : t('exportImages')}
              </button>
              {imagesZip && !imagesBusy && (
                <button
                  onClick={() => shareFile(imagesZip)}
                  className="flex-1 bg-accent py-2.5 text-[11px] font-semibold text-white"
                >
                  {t('saveImagesZip', { size: (imagesZip.size / 1024 / 1024).toFixed(1) })}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
