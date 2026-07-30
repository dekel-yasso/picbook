'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Cluster } from '@/lib/engine/cluster';
import type { Decision, PhotoMeta } from '@/lib/engine/types';
import { useI18n } from '@/lib/i18n';
import { Thumb } from './thumb';

const LONG_PRESS_MS = 500;

interface BurstReviewProps {
  clusters: Cluster[];
  startClusterId: string;
  onDecide: (id: string, decision: Decision | null) => void;
  onClose: () => void;
}

/** Short quality-signal summary for the BEST corner chip, e.g. "sharpest, eyes open". */
function bestReason(photo: PhotoMeta, cluster: Cluster): string | null {
  const reasons: string[] = [];
  const sharpVals = cluster.photos.map((p) => p.sharpness ?? 0);
  const maxSharp = Math.max(...sharpVals);
  if (maxSharp > 0 && (photo.sharpness ?? 0) >= maxSharp - 1e-6) reasons.push('sharpest');
  if (photo.faces && photo.faces.n > 0 && photo.faces.eyesOpen >= 0.8) reasons.push('eyes open');
  if (!reasons.length && photo.exposure !== undefined && Math.abs(photo.exposure - 0.5) < 0.1) {
    reasons.push('well exposed');
  }
  return reasons.length ? reasons.join(', ') : null;
}

export function BurstReviewOverlay({ clusters, startClusterId, onDecide, onClose }: BurstReviewProps) {
  const { t } = useI18n();
  const [index, setIndex] = useState(() => Math.max(0, clusters.findIndex((c) => c.id === startClusterId)));
  const cluster = clusters[Math.min(index, clusters.length - 1)];

  const [selected, setSelected] = useState<Set<string>>(() => new Set([cluster.bestId]));
  const [bestId, setBestId] = useState(cluster.bestId);
  useEffect(() => {
    setSelected(new Set([cluster.bestId]));
    setBestId(cluster.bestId);
  }, [cluster.id, cluster.bestId]);

  const toggleKeep = useCallback(
    (id: string) => {
      const wasSelected = selected.has(id);
      setSelected((prev) => {
        const next = new Set(prev);
        if (wasSelected) next.delete(id);
        else next.add(id);
        return next;
      });
      if (!wasSelected) {
        setBestId(id); // newly kept → promote it to the large preview
      } else if (bestId === id) {
        const remaining = [...selected].filter((x) => x !== id);
        setBestId(remaining[0] ?? cluster.bestId);
      }
    },
    [selected, bestId, cluster.bestId],
  );

  // Long-press a thumb to peek at it full-size; release/tap to dismiss.
  const [zoomId, setZoomId] = useState<string | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPress = useCallback((id: string) => {
    pressTimer.current = setTimeout(() => setZoomId(id), LONG_PRESS_MS);
  }, []);
  const cancelPress = useCallback(() => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  }, []);
  useEffect(() => () => cancelPress(), [cancelPress]);

  const confirmAndNext = useCallback(() => {
    for (const p of cluster.photos) {
      onDecide(p.id, selected.has(p.id) ? 'keep' : 'reject');
    }
    if (index >= clusters.length - 1) {
      onClose();
    } else {
      setIndex((i) => i + 1);
    }
  }, [cluster, selected, onDecide, index, clusters.length, onClose]);

  const keepAll = useCallback(() => {
    setSelected(new Set(cluster.photos.map((p) => p.id)));
  }, [cluster]);

  const best = cluster.photos.find((p) => p.id === bestId) ?? cluster.photos[0];
  const reason = bestReason(best, cluster);
  const keepCount = selected.size;
  const cullCount = cluster.photos.length - keepCount;

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-ground text-ink">
      <div className="flex items-center justify-between border-b-2 border-ink px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={onClose} aria-label={t('close')} className="px-2 py-1">
          <X size={20} strokeWidth={2.25} />
        </button>
        <span className="text-[13px] font-bold">{t('burstHeader', { n: cluster.photos.length })}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          {t('burstProgress', { i: index + 1, n: clusters.length })}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('burstBestShotHint')}</p>
          <div className="relative aspect-[4/3] w-full bg-placeholder">
            <Thumb id={best.id} alt="" />
            <span className="absolute start-0 top-0 bg-accent px-[6px] py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] text-white">
              {t('burstBest')}
              {reason ? ` · ${reason}` : ''}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            {cluster.photos.map((p) => {
              const isBest = p.id === bestId;
              const isSelected = selected.has(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => toggleKeep(p.id)}
                  onTouchStart={() => startPress(p.id)}
                  onTouchEnd={cancelPress}
                  onTouchMove={cancelPress}
                  onMouseDown={() => startPress(p.id)}
                  onMouseUp={cancelPress}
                  onMouseLeave={cancelPress}
                  className={`relative aspect-square ${
                    isSelected
                      ? `outline outline-2 -outline-offset-2 ${isBest ? 'outline-accent' : 'outline-ink'}`
                      : 'opacity-45'
                  }`}
                >
                  <Thumb id={p.id} alt="" />
                  {isSelected && (
                    <span
                      className={`absolute bottom-1 end-1 flex h-4 w-4 items-center justify-center ${
                        isBest ? 'bg-accent' : 'bg-ink'
                      }`}
                    >
                      <Check size={11} strokeWidth={3} className="text-white" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <p className="text-xs text-muted">{t('burstHelper')}</p>
        </div>
      </div>

      {zoomId && (
        <button
          onClick={() => setZoomId(null)}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/90 p-6"
          aria-label={t('close')}
        >
          <div className="relative h-full max-h-[80vh] w-full max-w-lg">
            <Thumb id={zoomId} alt="" />
          </div>
        </button>
      )}

      <div className="border-t-2 border-ink px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[14px] font-extrabold">{t('burstSummary', { keep: keepCount, cull: cullCount })}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t('burstOneTap')}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={keepAll} className="flex-1 border-2 border-ink py-3 text-[13px] font-semibold text-ink">
              {t('burstKeepAll')}
            </button>
            <button
              onClick={confirmAndNext}
              className="flex-1 bg-accent py-3 text-[13px] font-semibold text-white"
            >
              {t('burstConfirmNext')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
