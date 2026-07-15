'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clipSeconds, planClip } from '@/lib/engine/clip';
import type { ClipPlan, ClipTransition, PhotoMeta } from '@/lib/engine/types';
import { useI18n } from '@/lib/i18n';
import { Thumb } from './thumb';

const LENGTHS = [
  { label: 'Short', photos: 20 },
  { label: 'Medium', photos: 40 },
  { label: 'Long', photos: 60 },
] as const;

const TRANSITIONS: { value: ClipTransition; label: string }[] = [
  { value: 'fade', label: 'Fade' },
  { value: 'slide', label: 'Slide' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'mix', label: 'Mix' },
];

interface ClipProps {
  keepers: PhotoMeta[];
  pinnedIds: Set<string>;
  places: Map<string, string>;
  getFile: (id: string) => File | undefined;
  renderClipVideo: (plan: ClipPlan, files: Map<string, File>) => Promise<Uint8Array>;
  progress: { done: number; total: number; running: boolean };
  onClose: () => void;
}

export function ClipOverlay({ keepers, pinnedIds, places, getFile, renderClipVideo, progress, onClose }: ClipProps) {
  const { lang, t } = useI18n();
  const [length, setLength] = useState<(typeof LENGTHS)[number]['label']>('Medium');
  const [transition, setTransition] = useState<ClipTransition>('mix');
  useEffect(() => {
    const stored = localStorage.getItem('picbook-clip-transition') as ClipTransition | null;
    if (stored && TRANSITIONS.some((t) => t.value === stored)) setTransition(stored);
  }, []);
  const pickTransition = useCallback((t: ClipTransition) => {
    setTransition(t);
    localStorage.setItem('picbook-clip-transition', t);
  }, []);
  const [mapsOn, setMapsOn] = useState(true);
  useEffect(() => setMapsOn(localStorage.getItem('picbook-clip-maps') !== '0'), []);
  const toggleMaps = useCallback(() => {
    setMapsOn((on) => {
      localStorage.setItem('picbook-clip-maps', on ? '0' : '1');
      return !on;
    });
  }, []);
  const [video, setVideo] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inline playback of the rendered clip, before any share/save.
  const videoUrl = useMemo(() => (video ? URL.createObjectURL(video) : null), [video]);
  useEffect(
    () => () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    },
    [videoUrl],
  );

  const plan = useMemo(() => {
    const target = LENGTHS.find((l) => l.label === length)?.photos ?? 40;
    return { ...planClip(keepers, Math.min(target, keepers.length), places, pinnedIds, lang, mapsOn), transition };
  }, [keepers, length, places, pinnedIds, transition, lang, mapsOn]);
  const seconds = useMemo(() => clipSeconds(plan), [plan]);
  const photoIds = useMemo(
    () => plan.segments.filter((s) => s.kind === 'photo').map((s) => (s.kind === 'photo' ? s.id : '')),
    [plan],
  );

  const generate = useCallback(async () => {
    setError(null);
    setVideo(null);
    const files = new Map<string, File>();
    for (const id of photoIds) {
      const f = getFile(id);
      if (f) files.set(id, f);
    }
    try {
      const bytes = await renderClipVideo(plan, files);
      setVideo(new File([new Uint8Array(bytes)], 'picbook-clip.mp4', { type: 'video/mp4' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [plan, photoIds, getFile, renderClipVideo]);

  // Kept synchronous inside the tap's user activation so iOS allows share().
  const save = useCallback(() => {
    if (!video) return;
    if (navigator.canShare?.({ files: [video] })) {
      navigator.share({ files: [video] }).catch(() => {});
      return;
    }
    const url = URL.createObjectURL(video);
    const a = document.createElement('a');
    a.href = url;
    a.download = video.name;
    a.click();
    URL.revokeObjectURL(url);
  }, [video]);

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-neutral-500/30 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={onClose} aria-label={t('close')} className="rounded-lg px-2 py-1 text-xl leading-none">
          ✕
        </button>
        <span className="text-sm font-semibold">{t('tripClip')}</span>
        <span className="text-xs text-neutral-500">~{seconds}s</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          <div className="flex overflow-hidden rounded-lg border border-neutral-500/40 text-xs">
            {LENGTHS.map((l) => (
              <button
                key={l.label}
                onClick={() => setLength(l.label)}
                className={`flex-1 px-3 py-2 font-medium ${
                  length === l.label ? 'bg-foreground text-background' : 'text-neutral-500'
                }`}
              >
                {l.label === 'Short' ? t('lenShort') : l.label === 'Medium' ? t('lenMedium') : t('lenLong')}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <span className="shrink-0 text-xs text-neutral-500">{t('transition')}</span>
            {TRANSITIONS.map((tr) => (
              <button
                key={tr.value}
                onClick={() => pickTransition(tr.value)}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
                  transition === tr.value
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-neutral-500/40 text-neutral-500'
                }`}
              >
                {tr.label === 'Fade' ? t('trFade') : tr.label === 'Slide' ? t('trSlide') : tr.label === 'Zoom' ? t('trZoom') : tr.label === 'Wipe' ? t('trWipe') : t('trMix')}
              </button>
            ))}
            <button
              onClick={toggleMaps}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
                mapsOn
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-neutral-500/40 text-neutral-500'
              }`}
            >
              {t('mapTransitions')}
            </button>
          </div>

          {videoUrl && (
            <video
              src={videoUrl}
              controls
              playsInline
              className="w-full rounded-lg bg-black"
              aria-label={t('clipPreview')}
            />
          )}
          <p className="text-xs text-neutral-500">
            {t('clipDesc', { n: plan.photoCount })}
          </p>
          <div className="grid grid-cols-6 gap-1">
            {photoIds.slice(0, 24).map((id) => (
              <Thumb key={id} id={id} alt="" />
            ))}
          </div>
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
              {progress.running ? t('rendering') : video ? t('reRender') : t('renderClip')}
            </button>
            {video && !progress.running && (
              <button
                onClick={save}
                className="flex-1 rounded-xl bg-foreground py-3 text-sm font-semibold text-background"
              >
                {t('saveVideo', { size: (video.size / 1024 / 1024).toFixed(1) })}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
