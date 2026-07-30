'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Thumb } from './thumb';

export interface TripSummary {
  id: string;
  name: string;
  dateRange: string | null;
  photoCount: number;
  keeperCount: number;
  reviewed: boolean;
  coverId: string | null;
}

interface TripSwitcherProps {
  trips: TripSummary[];
  activeTripId: string;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** Creates a new trip and returns its id so the card opens straight into rename. */
  onCreate: () => string;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const SWIPE_PX = 90;

export function TripSwitcher({
  trips,
  activeTripId,
  onSelect,
  onRename,
  onCreate,
  onDelete,
  onClose,
}: TripSwitcherProps) {
  const { t } = useI18n();
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const startCreate = useCallback(() => {
    setRenamingId(onCreate());
  }, [onCreate]);

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-ground text-ink">
      <div className="flex items-center justify-between border-b-2 border-ink px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={onClose} aria-label={t('close')} className="px-2 py-1">
          <X size={20} strokeWidth={2.25} />
        </button>
        <span className="text-[14px] font-extrabold">{t('trips')}</span>
        <span className="w-8" />
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          {trips.map((tr) => (
            <TripCard
              key={tr.id}
              trip={tr}
              active={tr.id === activeTripId}
              renaming={renamingId === tr.id}
              onOpenRename={() => setRenamingId(tr.id)}
              onCommitRename={(name) => {
                onRename(tr.id, name);
                setRenamingId(null);
              }}
              onSelect={() => onSelect(tr.id)}
              onDelete={() => onDelete(tr.id)}
            />
          ))}
          <button
            onClick={startCreate}
            className="flex items-center justify-between border-2 border-ink px-3.5 py-3 text-[13px] font-semibold text-ink"
          >
            {t('newTripBtn')}
            <Plus size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>
      <p className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-[10px] font-semibold uppercase tracking-wide text-muted">
        {t('tripSwipeHint')}
      </p>
    </div>
  );
}

function TripCard({
  trip,
  active,
  renaming,
  onOpenRename,
  onCommitRename,
  onSelect,
  onDelete,
}: {
  trip: TripSummary;
  active: boolean;
  renaming: boolean;
  onOpenRename: () => void;
  onCommitRename: (name: string) => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(trip.name);
  useEffect(() => setDraft(trip.name), [trip.name]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  // Swipe-left-to-delete: drag the card, commit past a threshold, spring back otherwise.
  const [dragX, setDragX] = useState(0);
  const [settling, setSettling] = useState(false);
  // dx lives on the ref (updated synchronously in touchmove) rather than the
  // dragX state, which is still stale (pre-batched-update) by the time
  // touchend fires in the same gesture.
  const gesture = useRef<{ x: number; y: number; axis: 'h' | 'v' | null; dx: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (renaming) return;
    const t0 = e.touches[0];
    gesture.current = { x: t0.clientX, y: t0.clientY, axis: null, dx: 0 };
    setSettling(false);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (!g) return;
    const t0 = e.touches[0];
    const dx = t0.clientX - g.x;
    const dy = t0.clientY - g.y;
    if (!g.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) g.axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
    if (g.axis === 'h') {
      g.dx = Math.min(0, dx);
      setDragX(g.dx);
    }
  };
  const onTouchEnd = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    setSettling(true);
    if (g.dx < -SWIPE_PX) onDelete();
    else setDragX(0);
  };

  return (
    <div className="relative overflow-hidden">
      <div className="absolute inset-0 flex items-center justify-end bg-accent px-5 text-white">
        <Trash2 size={18} strokeWidth={2.25} />
      </div>
      <div
        className={`relative flex items-center gap-3 border-2 bg-ground p-3 ${active ? 'border-accent' : 'border-line'}`}
        style={{ transform: `translateX(${dragX}px)`, transition: settling ? 'transform 150ms ease-out' : 'none' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTransitionEnd={() => setSettling(false)}
      >
        <button onClick={onSelect} className="relative h-[72px] w-[72px] shrink-0">
          {trip.coverId ? (
            <Thumb id={trip.coverId} alt="" />
          ) : (
            <div className="h-full w-full bg-placeholder" />
          )}
          {active && (
            <span className="absolute start-0 top-0 bg-accent px-[6px] py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] text-white">
              {t('tripActive')}
            </span>
          )}
        </button>
        <button onClick={onSelect} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-start">
          {renaming ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitRename(draft);
                if (e.key === 'Escape') onCommitRename(trip.name);
              }}
              onBlur={() => onCommitRename(draft)}
              className="w-full border-2 border-ink bg-white px-2 py-1 text-[15px] font-extrabold text-ink"
            />
          ) : (
            <span className="truncate text-[15px] font-extrabold text-ink">{trip.name}</span>
          )}
          {trip.dateRange && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{trip.dateRange}</span>
          )}
          <span className="text-xs text-muted">
            {trip.reviewed ? t('tripCounts', { photos: trip.photoCount, keepers: trip.keeperCount }) : t('tripNotReviewedYet')}
          </span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenRename();
          }}
          aria-label={t('renameTrip')}
          className="shrink-0 p-1 text-muted"
        >
          <Pencil size={16} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}
