'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isKeeper, type Cluster } from '@/lib/engine/cluster';
import { getDB } from '@/lib/engine/db';
import type { Decision, PhotoMeta } from '@/lib/engine/types';
import { useI18n } from '@/lib/i18n';
import { useThumbUrl } from './thumb';

const SWIPE_PX = 50;
const AXIS_LOCK_PX = 10;
const SETTLE_MS = 250;

/** One reviewable photo along with the burst it belongs to. */
export interface ReviewEntry {
  photo: PhotoMeta;
  cluster: Cluster;
}

interface ReviewProps {
  entries: ReviewEntry[];
  startId: string;
  decisions: Map<string, Decision>;
  onDecide: (id: string, decision: Decision | null) => void;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
  getFile: (id: string) => File | undefined;
}

export function ReviewOverlay({
  entries,
  startId,
  decisions,
  onDecide,
  onDelete,
  onClose,
  getFile,
}: ReviewProps) {
  const { t } = useI18n();
  // Snapshot the list on open: decisions made while browsing must not reshuffle
  // positions under the user's thumbs (e.g. rejecting in the Keepers view).
  // Deleting a photo removes it from this snapshot in place.
  const [list, setList] = useState(entries);
  const [index, setIndex] = useState(() =>
    Math.max(0, list.findIndex((e) => e.photo.id === startId)),
  );
  // Horizontal slide state: dragX follows the finger; settle animates the track
  // one pane left/right (or back to center), then the index commits.
  const [dragX, setDragX] = useState(0);
  const [settle, setSettle] = useState<{ dir: -1 | 0 | 1 } | null>(null);

  // While the viewer is open, paint the document itself black: iOS repaints
  // fixed layers late on rotation, and the flash shows the page background.
  useEffect(() => {
    const html = document.documentElement.style;
    const body = document.body.style;
    const prev = [html.backgroundColor, body.backgroundColor];
    html.backgroundColor = '#000';
    body.backgroundColor = '#000';
    return () => {
      html.backgroundColor = prev[0];
      body.backgroundColor = prev[1];
    };
  }, []);

  // Landscape: maximize the photo — chrome floats over it instead of stacking.
  const [landscape, setLandscape] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)');
    const update = () => setLandscape(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const safeIndex = Math.min(index, list.length - 1);
  const { photo, cluster } = list[safeIndex];
  const decision = decisions.get(photo.id);

  const prev = useCallback(() => {
    setSettle((s) => (s === null && safeIndex > 0 ? { dir: -1 } : s));
  }, [safeIndex]);
  const next = useCallback(() => {
    setSettle((s) => (s === null && safeIndex < list.length - 1 ? { dir: 1 } : s));
  }, [safeIndex, list.length]);
  const decideAndAdvance = useCallback(
    (d: Decision) => {
      if (settle) return;
      onDecide(photo.id, d);
      if (safeIndex < list.length - 1) setSettle({ dir: 1 });
      else onClose();
    },
    [settle, photo.id, safeIndex, list.length, onDecide, onClose],
  );

  const deleteCurrent = useCallback(async () => {
    if (settle) return;
    if (!window.confirm(t('deletePhotoConfirm'))) {
      return;
    }
    const id = photo.id;
    await onDelete(id);
    if (list.length <= 1) {
      onClose();
      return;
    }
    setList((prev) => prev.filter((e) => e.photo.id !== id));
    setIndex((i) => Math.min(i, list.length - 2));
  }, [settle, photo.id, list.length, onDelete, onClose, t]);

  // Commit is idempotent and driven by BOTH transitionend and a timer:
  // transitionend can be dropped (hidden tab, iOS quirks), and the timer alone
  // would race a slow transition. First one wins via the ref guard.
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const commitSettle = useCallback(() => {
    const s = settleRef.current;
    if (!s) return;
    settleRef.current = null;
    if (s.dir !== 0) setIndex((i) => Math.min(list.length - 1, Math.max(0, i + s.dir)));
    setSettle(null);
    setDragX(0);
  }, [list.length]);

  useEffect(() => {
    if (!settle) return;
    const t = setTimeout(commitSettle, SETTLE_MS + 80);
    return () => clearTimeout(t);
  }, [settle, commitSettle]);

  const handleSettled = useCallback(
    (e: React.TransitionEvent) => {
      if (e.target === e.currentTarget) commitSettle();
    },
    [commitSettle],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowUp' || e.key === 'k') decideAndAdvance('keep');
      else if (e.key === 'ArrowDown' || e.key === 'x') decideAndAdvance('reject');
      else if (e.key === 'b') decideAndAdvance('book');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next, decideAndAdvance]);

  const gesture = useRef<{ x: number; y: number; axis: 'h' | 'v' | null } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (settle) return;
    const t = e.touches[0];
    gesture.current = { x: t.clientX, y: t.clientY, axis: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (!g || settle) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    if (!g.axis && (Math.abs(dx) > AXIS_LOCK_PX || Math.abs(dy) > AXIS_LOCK_PX)) {
      g.axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
    }
    if (g.axis === 'h') {
      // Rubber-band at the ends instead of revealing an empty pane.
      const atEdge = (dx > 0 && safeIndex === 0) || (dx < 0 && safeIndex === list.length - 1);
      setDragX(atEdge ? dx * 0.25 : dx);
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || settle) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    if (g.axis === 'h') {
      if (dx < -SWIPE_PX && safeIndex < list.length - 1) setSettle({ dir: 1 });
      else if (dx > SWIPE_PX && safeIndex > 0) setSettle({ dir: -1 });
      else setSettle({ dir: 0 });
    } else if (g.axis === 'v') {
      if (dy < -SWIPE_PX) decideAndAdvance('keep');
      else if (dy > SWIPE_PX) decideAndAdvance('reject');
    }
  };

  // The track holds [prev, current, next] panes; -100% centers the current one.
  const panes = useMemo(
    () => [safeIndex - 1, safeIndex, safeIndex + 1].map((j) => list[j] ?? null),
    [list, safeIndex],
  );
  const trackStyle: React.CSSProperties = settle
    ? {
        transform: `translateX(${-100 - settle.dir * 100}%)`,
        transition: `transform ${SETTLE_MS}ms ease-out`,
      }
    : { transform: `translateX(calc(-100% + ${dragX}px))`, transition: 'none' };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
    >
      {!landscape && (
        <div className="flex items-center justify-between px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <button onClick={onClose} aria-label={t('close')} className="rounded-lg px-2 py-1 text-xl leading-none">
            ✕
          </button>
          <span className="text-sm text-neutral-400">
            {safeIndex + 1} / {list.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onDecide(photo.id, null)}
              disabled={!decision}
              className="rounded-lg px-2 py-1 text-xs text-neutral-400 disabled:opacity-0"
            >
              {t('reset')}
            </button>
            <button
              onClick={deleteCurrent}
              aria-label={t('deletePhoto')}
              title={t('deletePhoto')}
              className="rounded-lg px-2 py-1 text-base leading-none text-neutral-400"
            >
              🗑
            </button>
          </div>
        </div>
      )}

      <div
        className="relative flex-1 touch-none select-none overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="flex h-full" style={trackStyle} onTransitionEnd={handleSettled}>
          {panes.map((entry, i) => (
            <div key={entry?.photo.id ?? `edge-${i}`} className="relative h-full w-full shrink-0">
              {entry && (
                <>
                  <FullPhoto id={entry.photo.id} name={entry.photo.name} getFile={getFile} />
                  <FateBadge entry={entry} decisions={decisions} below={landscape} />
                </>
              )}
            </div>
          ))}
        </div>
        {landscape && (
          <>
            <button
              onClick={onClose}
              aria-label={t('close')}
              className="absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1.5 text-lg leading-none"
            >
              ✕
            </button>
            <span className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-xs text-neutral-300">
              {safeIndex + 1} / {list.length}
            </span>
            <button
              onClick={() => decideAndAdvance('reject')}
              className="absolute bottom-3 left-3 rounded-full bg-red-600/90 px-5 py-2.5 text-sm font-semibold"
            >
              {t('reject')}
            </button>
            <button
              onClick={() => decideAndAdvance('book')}
              aria-label={t('mustBook')}
              className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-semibold ${
                decision === 'book' ? 'bg-amber-500 text-black' : 'bg-amber-600/80'
              }`}
            >
              📖
            </button>
            <button
              onClick={() => decideAndAdvance('keep')}
              className="absolute bottom-3 right-3 rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold"
            >
              {t('keep')}
            </button>
          </>
        )}
      </div>

      {/* Fixed-height strip whether or not the current photo is in a burst,
          so the photo doesn't jump vertically while browsing. */}
      <div className={`flex h-[4.5rem] shrink-0 gap-1 overflow-x-auto px-4 py-2 ${landscape ? 'hidden' : ''}`}>
        {cluster.photos.length > 1 &&
          cluster.photos.map((p) => {
            const j = list.findIndex((e) => e.photo.id === p.id);
            return (
              <button
                key={p.id}
                onClick={() => j >= 0 && setIndex(j)}
                className={`h-14 w-14 shrink-0 overflow-hidden rounded ${
                  p.id === photo.id ? 'ring-2 ring-white' : ''
                } ${isKeeper(p, cluster, decisions) ? '' : 'opacity-40'}`}
              >
                <Strip id={p.id} alt={p.name} />
              </button>
            );
          })}
      </div>

      {!landscape && (
        <>
          <div className="flex items-center gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
            <button
              onClick={() => decideAndAdvance('reject')}
              className="flex-1 rounded-xl bg-red-600/90 py-3.5 text-sm font-semibold"
            >
              {t('reject')}
            </button>
            <button
              onClick={() => decideAndAdvance('book')}
              aria-label={t('mustBook')}
              className={`rounded-xl px-4 py-3.5 text-sm font-semibold ${
                decision === 'book' ? 'bg-amber-500 text-black' : 'bg-amber-600/80'
              }`}
            >
              📖
            </button>
            <button
              onClick={() => decideAndAdvance('keep')}
              className="flex-1 rounded-xl bg-emerald-600 py-3.5 text-sm font-semibold"
            >
              {t('keep')}
            </button>
          </div>
          <p className="pb-2 text-center text-[11px] text-neutral-500">{t('swipeHint')}</p>
        </>
      )}
    </div>
  );
}

function FateBadge({
  entry,
  decisions,
  below,
}: {
  entry: ReviewEntry;
  decisions: Map<string, Decision>;
  below?: boolean;
}) {
  const { t } = useI18n();
  const d = decisions.get(entry.photo.id);
  const kept = isKeeper(entry.photo, entry.cluster, decisions);
  return (
    <span
      className={`absolute left-3 ${below ? 'top-14' : 'top-3'} rounded px-2 py-0.5 text-xs font-semibold ${
        d === 'book' ? 'bg-amber-500 text-black' : kept ? 'bg-emerald-500 text-white' : 'bg-neutral-700 text-neutral-200'
      }`}
    >
      {d === 'book'
        ? t('inBook')
        : kept
          ? d === 'keep'
            ? t('kept')
            : t('keepingAuto')
          : d === 'reject'
            ? t('rejected')
            : t('cullingAuto')}
    </span>
  );
}

/** Best available source: this-session original → stored rendition → cached thumb. */
function FullPhoto({ id, name, getFile }: { id: string; name: string; getFile: (id: string) => File | undefined }) {
  const thumbUrl = useThumbUrl(id);
  const [broken, setBroken] = useState(false);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setBroken(false);
    setFullUrl(null);
    const file = getFile(id);
    if (file) {
      objectUrl = URL.createObjectURL(file);
      setFullUrl(objectUrl);
    } else {
      getDB()
        .then((db) => db.get('renditions', id))
        .then((blob) => {
          if (blob && alive) {
            objectUrl = URL.createObjectURL(blob);
            setFullUrl(objectUrl);
          }
        });
    }
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, getFile]);

  const src = !broken && fullUrl ? fullUrl : thumbUrl;
  if (!src) return <div className="h-full w-full animate-pulse bg-neutral-900" />;
  // eslint-disable-next-line @next/next/no-img-element -- blob URLs, next/image can't optimize them
  return <img src={src} alt={name} onError={() => setBroken(true)} className="h-full w-full object-contain" draggable={false} />;
}

function Strip({ id, alt }: { id: string; alt: string }) {
  const url = useThumbUrl(id);
  if (!url) return <div className="h-full w-full bg-neutral-800" />;
  // eslint-disable-next-line @next/next/no-img-element -- blob URL from IndexedDB
  return <img src={url} alt={alt} className="h-full w-full object-cover" />;
}
