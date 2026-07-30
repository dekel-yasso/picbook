'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Cloud,
  LayoutGrid,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { clusterPhotos, isKeeper, takenTime, type Cluster } from '@/lib/engine/cluster';
import { getDB } from '@/lib/engine/db';
import { loadDecisions, saveDecision } from '@/lib/engine/decisions';
import { placeForPhotos } from '@/lib/engine/geocode';
import { FACES_VERSION } from '@/lib/engine/faces';
import { deletePhoto, deletePhotos, deleteTrip } from '@/lib/engine/library';
import { pickDirectory, pickFiles, supportsDirectoryPicker } from '@/lib/engine/photoSource';
import { deleteTripRemote, syncNow, whoami } from '@/lib/engine/sync';
import { createTrip, DEFAULT_TRIP_ID, loadTrips, renameTrip } from '@/lib/engine/trips';
import type { Decision, PhotoMeta, Trip } from '@/lib/engine/types';
import { useEngine } from '@/lib/engine/useEngine';
import { useI18n } from '@/lib/i18n';
import { themeLabel } from '@/lib/i18n-strings';
import { AccountOverlay } from './account';
import { BookOverlay } from './book';
import { ClipOverlay } from './clip';
import { ReviewOverlay, type ReviewEntry } from './review';
import { Thumb } from './thumb';
import { UpdateBanner } from './update-banner';

export default function Home() {
  const {
    photos,
    progress,
    analyzeProgress,
    bookProgress,
    embedProgress,
    facesProgress,
    clipProgress,
    renderClipVideo,
    renditionsVersion,
    error,
    ingest,
    getFile,
    forgetPhotos,
    requestEmbed,
    requestRenditions,
    renderBook,
    renderCover,
  } = useEngine();
  const { lang, t } = useI18n();
  const [bookOpen, setBookOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [hasDirPicker, setHasDirPicker] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [view, setView] = useState<'all' | 'keepers'>('all');
  const [themeFilter, setThemeFilter] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  // Collapsed day sections — faster navigation through huge trips. Collapsed
  // days render no thumbnails at all, which also lightens the page.
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set());
  const toggleDay = useCallback((label: string) => {
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  // Smart grouping (on-device CLIP) is opt-in: ~85MB one-time model download.
  const [clipEnabled, setClipEnabled] = useState(false);
  useEffect(() => setClipEnabled(localStorage.getItem('picbook-clip') === '1'), []);
  const enableClip = useCallback(() => {
    localStorage.setItem('picbook-clip', '1');
    setClipEnabled(true);
  }, []);
  const needsEmbedding = photos.some(
    (p) => p.status === 'ready' && (!p.embedding || (p.facev ?? 0) < FACES_VERSION),
  );
  useEffect(() => {
    if (!clipEnabled || !needsEmbedding || analyzeProgress.running || progress.running) return;
    const t = setTimeout(requestEmbed, 1000);
    return () => clearTimeout(t);
  }, [clipEnabled, needsEmbedding, analyzeProgress.running, progress.running, requestEmbed]);
  // True from tapping "Add photos" until the OS actually delivers the files —
  // on iOS that hand-off can take minutes for large selections.
  const [receiving, setReceiving] = useState(false);
  const [receivingLong, setReceivingLong] = useState(false);
  useEffect(() => {
    if (!receiving) {
      setReceivingLong(false);
      return;
    }
    const t = setTimeout(() => setReceivingLong(true), 90_000);
    return () => clearTimeout(t);
  }, [receiving]);

  // Trips: photos, stats, and the book are all scoped to the active trip.
  const [trips, setTrips] = useState<Trip[]>([]);
  const [activeTripId, setActiveTripId] = useState(DEFAULT_TRIP_ID);
  useEffect(() => {
    loadTrips().then((all) => {
      setTrips(all);
      const stored = localStorage.getItem('picbook-trip');
      if (stored && all.some((t) => t.id === stored)) setActiveTripId(stored);
    });
  }, []);
  // Day labels are date strings and can collide across trips — start fresh.
  useEffect(() => setCollapsedDays(new Set()), [activeTripId]);
  const switchTrip = useCallback(async (value: string) => {
    if (value === '__new') {
      const name = window.prompt(t('tripNamePrompt'));
      if (!name) return;
      const trip = await createTrip(name);
      setTrips(await loadTrips());
      setActiveTripId(trip.id);
      localStorage.setItem('picbook-trip', trip.id);
      return;
    }
    setActiveTripId(value);
    localStorage.setItem('picbook-trip', value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);
  const renameActive = useCallback(async () => {
    const current = trips.find((tr) => tr.id === activeTripId);
    const name = window.prompt(t('renameTrip'), current?.name ?? '');
    if (!name) return;
    await renameTrip(activeTripId, name);
    setTrips(await loadTrips());
  }, [trips, activeTripId, t]);

  const deleteActiveTrip = useCallback(async () => {
    const current = trips.find((tr) => tr.id === activeTripId);
    const count = photos.filter((p) => (p.tripId ?? DEFAULT_TRIP_ID) === activeTripId).length;
    if (!window.confirm(t('deleteTripConfirm', { name: current?.name ?? '', n: count }))) {
      return;
    }
    const removed = await deleteTrip(activeTripId);
    forgetPhotos(removed);
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const id of removed) next.delete(id);
      return next;
    });
    deleteTripRemote(activeTripId); // best-effort; no-op when signed out
    const all = await loadTrips(); // recreates the default trip if needed
    setTrips(all);
    setActiveTripId(all[0].id);
    localStorage.setItem('picbook-trip', all[0].id);
  }, [trips, activeTripId, photos, forgetPhotos]);

  const removePhoto = useCallback(
    async (id: string) => {
      await deletePhoto(id);
      forgetPhotos([id]);
      setDecisions((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    },
    [forgetPhotos],
  );

  // Bulk-remove a whole day (e.g. photos accidentally imported from another trip).
  const removeDay = useCallback(
    async (label: string, dayClusters: Cluster[]) => {
      const ids = dayClusters.flatMap((c) => c.photos.map((p) => p.id));
      if (!ids.length) return;
      if (!window.confirm(t('deleteDayConfirm', { n: ids.length, day: label }))) return;
      await deletePhotos(ids);
      forgetPhotos(ids);
      setDecisions((prev) => {
        const next = new Map(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    [forgetPhotos, t],
  );

  const addPhotos = useCallback(async () => {
    setReceiving(true);
    try {
      ingest(await pickFiles(), activeTripId);
    } finally {
      setReceiving(false);
    }
  }, [ingest, activeTripId]);

  const addFolder = useCallback(async () => {
    setReceiving(true);
    try {
      ingest(await pickDirectory(), activeTripId);
    } finally {
      setReceiving(false);
    }
  }, [ingest, activeTripId]);

  useEffect(() => {
    setHasDirPicker(supportsDirectoryPicker());
    setCanShare(typeof navigator.share === 'function');
    loadDecisions().then(setDecisions);
  }, []);

  // Auto-sync on launch when signed in, so devices pick up each other's
  // renames/decisions/books without a manual "Sync now".
  useEffect(() => {
    let cancelled = false;
    whoami().then((user) => {
      if (!user || cancelled) return;
      syncNow()
        .then(() => {
          if (cancelled) return;
          loadTrips().then((all) => !cancelled && setTrips(all));
          loadDecisions().then((d) => !cancelled && setDecisions(d));
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const decide = useCallback((id: string, d: Decision | null) => {
    setDecisions((prev) => {
      const next = new Map(prev);
      if (d) next.set(id, d);
      else next.delete(id);
      return next;
    });
    saveDecision(id, d).catch(() => {});
  }, []);

  // Freeze the page behind full-screen overlays: iOS positions fixed overlays
  // against a scrolled/momentum viewport otherwise, opening them half off-screen.
  const overlayOpen = !!reviewing || bookOpen || clipOpen || accountOpen;
  useEffect(() => {
    if (!overlayOpen) return;
    const y = window.scrollY;
    const body = document.body.style;
    body.position = 'fixed';
    body.top = `-${y}px`;
    body.left = '0';
    body.right = '0';
    body.width = '100%';
    return () => {
      body.position = '';
      body.top = '';
      body.left = '';
      body.right = '';
      body.width = '';
      window.scrollTo(0, y);
    };
  }, [overlayOpen]);

  const tripPhotos = useMemo(
    () => photos.filter((p) => (p.tripId ?? DEFAULT_TRIP_ID) === activeTripId),
    [photos, activeTripId],
  );

  const clusters = useMemo(() => clusterPhotos(tripPhotos), [tripPhotos]);
  const days = useMemo(() => {
    const byDay = new Map<string, Cluster[]>();
    for (const c of clusters) {
      const key = new Date(takenTime(c.photos[0])).toDateString();
      const list = byDay.get(key);
      if (list) list.push(c);
      else byDay.set(key, [c]);
    }
    return [...byDay.entries()];
  }, [clusters]);

  const keepers = useMemo(
    () => clusters.flatMap((c) => c.photos.filter((p) => isKeeper(p, c, decisions))),
    [clusters, decisions],
  );
  // Must-be-in-the-book pins (📖) — guaranteed slots in the book and clip.
  const pinnedIds = useMemo(() => {
    const set = new Set<string>();
    for (const [id, d] of decisions) if (d === 'book') set.add(id);
    return set;
  }, [decisions]);
  // Day → place name via reverse geocoding (coordinates only, cached forever).
  const [places, setPlaces] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const [key, dayClusters] of days) {
        if (cancelled || places.has(key)) continue;
        const place = await placeForPhotos(dayClusters.flatMap((c) => c.photos), lang);
        if (cancelled) return;
        if (place) setPlaces((prev) => new Map(prev).set(key, place));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run when the day set changes, not when places fills in
  }, [days, lang]);
  // Re-geocode when any photo's coordinates change (e.g. the GPS healing
  // pass on re-import) — otherwise stale place names linger until relaunch.
  const gpsSignature = useMemo(() => {
    let sig = 0;
    for (const p of tripPhotos) if (p.gps) sig += p.gps.lat + p.gps.lon;
    return Math.round(sig * 1000);
  }, [tripPhotos]);
  useEffect(() => setPlaces(new Map()), [lang, gpsSignature]);

  const themes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of tripPhotos) if (p.theme) counts.set(p.theme, (counts.get(p.theme) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [tripPhotos]);

  const readyCount = clusters.reduce((n, c) => n + c.photos.length, 0);
  const unsupported = tripPhotos.length - readyCount;
  const busy = progress.running || analyzeProgress.running;

  // The full-screen reviewer browses this sequence — everything currently
  // visible in the grid, in grid order.
  const reviewList = useMemo<ReviewEntry[]>(
    () =>
      days.flatMap(([, dayClusters]) =>
        dayClusters.flatMap((c) =>
          c.photos
            .filter(
              (p) =>
                (view === 'all' || isKeeper(p, c, decisions)) &&
                (!themeFilter || p.theme === themeFilter),
            )
            .map((p) => ({ photo: p, cluster: c })),
        ),
      ),
    [days, view, decisions, themeFilter],
  );

  const exportList = useCallback(() => {
    const names = [...keepers].sort((a, b) => takenTime(a) - takenTime(b)).map((p) => p.name);
    const url = URL.createObjectURL(new Blob([names.join('\n') + '\n'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'picbook-keepers.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [keepers]);

  // Print-quality renditions: whenever a keeper still has its original in this
  // session and no stored rendition, ask the worker to save one. This is what
  // lets the book (and sharing) keep full quality in future sessions.
  const [renditionIds, setRenditionIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    getDB()
      .then((db) => db.getAllKeys('renditions'))
      .then((keys) => setRenditionIds(new Set(keys)));
  }, [renditionsVersion]);
  useEffect(() => {
    const items: [string, File][] = [];
    for (const p of keepers) {
      if (renditionIds.has(p.id)) continue;
      const f = getFile(p.id);
      if (f) items.push([p.id, f]);
    }
    if (!items.length) return;
    const t = setTimeout(() => requestRenditions(items), 800);
    return () => clearTimeout(t);
  }, [keepers, renditionIds, getFile, requestRenditions]);

  // Share falls back to stored renditions for keepers from previous sessions.
  const [renditionFiles, setRenditionFiles] = useState<Map<string, File>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = await getDB();
      const map = new Map<string, File>();
      for (const p of keepers) {
        if (getFile(p.id) || !renditionIds.has(p.id)) continue;
        const blob = await db.get('renditions', p.id);
        if (blob) {
          map.set(p.id, new File([blob], p.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }
      }
      if (!cancelled) setRenditionFiles(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [keepers, renditionIds, getFile]);

  const shareableFiles = useMemo(
    () =>
      keepers
        .map((p) => getFile(p.id) ?? renditionFiles.get(p.id))
        .filter((f): f is File => !!f),
    [keepers, getFile, renditionFiles],
  );
  const shareKeepers = useCallback(() => {
    if (!shareableFiles.length) return;
    // Must stay inside the tap's user activation — no awaits before share().
    navigator.share({ files: shareableFiles }).catch(() => {});
  }, [shareableFiles]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-4 p-4 pb-0 pt-0">
      {/* Hidden (not just covered) while an overlay is up: iOS repaints fixed layers late on rotation, flashing the page behind the viewer. */}
      <div
        className={`flex flex-1 flex-col gap-4 ${reviewing || bookOpen || clipOpen || accountOpen ? 'invisible' : ''}`}
      >
      {/* Sticky command bar: actions + live status stay reachable while scrolling. */}
      <div className="sticky top-0 z-30 -mx-4 flex flex-col gap-3 bg-[rgba(243,242,242,.96)] px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur">
      <UpdateBanner />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[21px] font-extrabold tracking-[-0.02em] text-ink">PicBook</h1>
        <div className="flex gap-2">
          <button
            onClick={addPhotos}
            disabled={progress.running || receiving}
            className="bg-accent px-3.5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-45"
          >
            {t('addPhotos')}
          </button>
          {hasDirPicker && (
            <button
              onClick={addFolder}
              disabled={progress.running || receiving}
              className="border-2 border-ink px-3.5 py-2.5 text-[13px] font-semibold text-ink disabled:opacity-45"
            >
              {t('addFolder')}
            </button>
          )}
        </div>
      </header>
      <div className="-mx-4 border-t-2 border-ink" />

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <select
            value={activeTripId}
            onChange={(e) => switchTrip(e.target.value)}
            aria-label="Trip"
            className="w-full appearance-none border-2 border-ink bg-white px-3 py-2 text-[14px] font-semibold text-ink"
          >
            {trips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="__new">{t('newTrip')}</option>
          </select>
          <ChevronDown
            className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-ink"
            size={16}
            strokeWidth={2.25}
          />
        </div>
        <button
          onClick={renameActive}
          aria-label={t('renameTrip')}
          title={t('renameTrip')}
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center border-2 border-ink text-ink"
        >
          <Pencil size={16} strokeWidth={2.25} />
        </button>
        <button
          onClick={deleteActiveTrip}
          aria-label={t('deleteTrip')}
          title={t('deleteTrip')}
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center border-2 border-ink text-ink"
        >
          <Trash2 size={16} strokeWidth={2.25} />
        </button>
        <button
          onClick={() => setAccountOpen(true)}
          className="flex h-[38px] shrink-0 items-center gap-1.5 border-2 border-ink px-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink"
        >
          <Cloud size={16} strokeWidth={2.25} />
          {t('syncBtn')}
        </button>
      </div>

      {receiving && !progress.running && (
        <div className="flex items-center gap-3 border-2 border-ink p-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-1.5 w-full bg-track">
              <div className="h-full w-full animate-pulse bg-accent" />
            </div>
            <p className="text-xs text-muted">
              {receivingLong ? t('receivingLong') : t('receiving')}
            </p>
          </div>
          <button
            onClick={() => setReceiving(false)}
            aria-label={t('dismiss')}
            className="px-1 text-ink"
          >
            <X size={16} strokeWidth={2.25} />
          </button>
        </div>
      )}

      {busy && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 w-full bg-track">
            <div
              className="h-full bg-ink transition-[width] duration-200"
              style={{
                width: progress.running
                  ? `${progress.total ? (100 * progress.done) / progress.total : 0}%`
                  : `${analyzeProgress.total ? (100 * analyzeProgress.done) / analyzeProgress.total : 0}%`,
              }}
            />
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
            {progress.running
              ? t('importing', { done: progress.done, total: progress.total })
              : t('scoring', { done: analyzeProgress.done, total: analyzeProgress.total })}
          </p>
        </div>
      )}

      {embedProgress.running && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 w-full bg-track">
            <div
              className="h-full bg-ink transition-[width] duration-200"
              style={{
                width: `${embedProgress.total ? (100 * embedProgress.done) / embedProgress.total : 0}%`,
              }}
            />
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
            {embedProgress.phase === 'download'
              ? t('downloadingModel', { pct: embedProgress.done })
              : t('understanding', { done: embedProgress.done, total: embedProgress.total })}
          </p>
        </div>
      )}

      {facesProgress.running && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1.5 w-full bg-track">
            <div
              className="h-full bg-ink transition-[width] duration-200"
              style={{
                width: `${facesProgress.total ? (100 * facesProgress.done) / facesProgress.total : 0}%`,
              }}
            />
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
            {t('readingFaces', { done: facesProgress.done, total: facesProgress.total })}
          </p>
        </div>
      )}
      </div>

      {photos.length > 0 && !clipEnabled && (
        <div className="flex items-center justify-between gap-3 border-2 border-ink p-3">
          <p className="text-xs text-muted">
            <span className="font-extrabold text-ink">{t('smartTitle')}</span>
            {t('smartBody')}
          </p>
          <button
            onClick={enableClip}
            className="shrink-0 bg-accent px-3 py-2 text-xs font-semibold text-white"
          >
            {t('enable')}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{t('engineError', { message: error })}</p>}

      {tripPhotos.length > 0 ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {t('stats', { photos: readyCount, keepers: keepers.length, culled: readyCount - keepers.length })}
              {unsupported > 0 && t('statsUnsupported', { n: unsupported })}
            </p>
            <div className="flex border-2 border-ink text-xs">
              {(['all', 'keepers'] as const).map((v, i) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 font-bold ${i === 1 ? 'border-s-2 border-ink' : ''} ${
                    view === v ? 'bg-ink text-ground' : 'text-muted'
                  }`}
                >
                  {v === 'all' ? t('viewAll') : t('viewKeepers')}
                </button>
              ))}
            </div>
          </div>

          {themes.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto">
              {[null, ...themes].map((th) => (
                <button
                  key={th ?? 'all'}
                  onClick={() => setThemeFilter(th)}
                  className={`shrink-0 text-[11px] font-semibold ${
                    themeFilter === th
                      ? 'bg-accent px-2.5 py-1 text-white'
                      : 'border border-line px-[9px] py-[3px] text-muted'
                  }`}
                >
                  {th ? themeLabel(lang, th) : t('allThemes')}
                </button>
              ))}
            </div>
          )}

          {days.map(([label, dayClusters]) => {
            // Theme filtering flattens to cells (a filtered cluster isn't a burst anymore).
            const cells =
              view === 'keepers' || themeFilter
                ? dayClusters.flatMap((c) =>
                    c.photos
                      .filter(
                        (p) =>
                          (view === 'all' || isKeeper(p, c, decisions)) &&
                          (!themeFilter || p.theme === themeFilter),
                      )
                      .map((p) => ({ cluster: c, photo: p })),
                  )
                : null;
            if (cells && cells.length === 0) return null;
            const collapsed = collapsedDays.has(label);
            const dayCount = cells
              ? cells.length
              : dayClusters.reduce((n, c) => n + c.photos.length, 0);
            return (
              <section
                key={label}
                className="flex flex-col gap-2"
                // Off-screen days skip layout/paint entirely; the estimate just
                // keeps the scrollbar stable until a section is first rendered.
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 480px' }}
              >
                <div className="-mx-4 border-t-2 border-ink" />
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => toggleDay(label)}
                    aria-expanded={!collapsed}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
                  >
                    {collapsed ? (
                      lang === 'he' ? (
                        <ArrowLeft className="shrink-0 text-ink" size={14} strokeWidth={2.5} />
                      ) : (
                        <ChevronRight className="shrink-0 text-ink" size={14} strokeWidth={2.5} />
                      )
                    ) : (
                      <ChevronDown className="shrink-0 text-ink" size={14} strokeWidth={2.5} />
                    )}
                    <h2 className="truncate text-[13px] font-extrabold uppercase tracking-wide text-ink">
                      {new Date(label).toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US', {
                        weekday: 'short',
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                      {places.get(label) && (
                        <span className="font-semibold normal-case text-accent"> · {places.get(label)}</span>
                      )}
                    </h2>
                    {collapsed && (
                      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">
                        · {t('dayPhotos', { n: dayCount })}
                      </span>
                    )}
                  </button>
                  {!collapsed && (
                    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      {t('dayPhotos', { n: dayCount })}
                    </span>
                  )}
                  <button
                    onClick={() => removeDay(label, dayClusters)}
                    aria-label={t('deleteDay')}
                    title={t('deleteDay')}
                    className="shrink-0 px-1 py-1 text-muted"
                  >
                    <Trash2 size={14} strokeWidth={2.25} />
                  </button>
                </div>
                {!collapsed && (
                <div className="flex flex-wrap gap-1.5">
                  {cells
                    ? cells.map(({ cluster, photo }) => (
                        <Cell
                          key={photo.id}
                          photo={photo}
                          cluster={cluster}
                          decisions={decisions}
                          dim={false}
                          onOpen={() => setReviewing(photo.id)}
                        />
                      ))
                    : dayClusters.map((c) =>
                        c.photos.length === 1 ? (
                          <Cell
                            key={c.id}
                            photo={c.photos[0]}
                            cluster={c}
                            decisions={decisions}
                            dim
                            onOpen={() => setReviewing(c.photos[0].id)}
                          />
                        ) : (
                          <div
                            key={c.id}
                            className="flex flex-wrap gap-1 border-2 border-ink p-1"
                          >
                            {c.photos.map((p) => (
                              <Cell
                                key={p.id}
                                photo={p}
                                cluster={c}
                                decisions={decisions}
                                dim
                                onOpen={() => setReviewing(p.id)}
                              />
                            ))}
                          </div>
                        ),
                      )}
                </div>
                )}
              </section>
            );
          })}
        </>
      ) : (
        !busy && (
          <div className="flex flex-1 flex-col items-start justify-center gap-3 text-start">
            <p className="text-[11px] font-bold uppercase tracking-wide text-accent">
              {t('onDeviceOnly')}
            </p>
            <p className="text-[32px] font-extrabold leading-[1.05] text-ink">{t('noPhotos')}</p>
            <p className="max-w-xs text-sm text-muted">
              {t('noPhotosBody')}
            </p>
            <button
              onClick={addPhotos}
              disabled={progress.running || receiving}
              className="mt-1 border-2 border-ink px-3.5 py-2.5 text-[13px] font-semibold text-ink disabled:opacity-45"
            >
              {t('addPhotos')} +
            </button>
          </div>
        )
      )}

      {keepers.length > 0 && (
        /* Sticky (in-flow), not fixed: iOS mis-anchors fixed bars during scroll
           momentum. mt-auto keeps it at the viewport bottom for short content. */
        <footer className="sticky bottom-0 z-20 -mx-4 mt-auto border-t-2 border-ink bg-[rgba(243,242,242,.96)] backdrop-blur">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <span className="text-sm font-extrabold text-ink">{t('keepersCount', { n: keepers.length })}</span>
            <div className="flex gap-2">
              <button
                onClick={exportList}
                className="border-2 border-ink px-3 py-2 text-xs font-semibold text-ink"
              >
                {t('exportList')}
              </button>
              {canShare && shareableFiles.length > 0 && (
                <button
                  onClick={shareKeepers}
                  className="border-2 border-ink px-3 py-2 text-xs font-semibold text-ink"
                >
                  {t('shareN', { n: shareableFiles.length })}
                </button>
              )}
              <button
                onClick={() => setClipOpen(true)}
                aria-label={t('tripClip')}
                className="flex items-center gap-1.5 border-2 border-ink px-3 py-2 text-xs font-semibold text-ink"
              >
                <LayoutGrid size={14} strokeWidth={2.25} />
                {t('clipBtn')}
              </button>
              <button
                onClick={() => setBookOpen(true)}
                className="flex items-center gap-1.5 bg-accent px-3 py-2 text-xs font-semibold text-white"
              >
                {t('bookBtn')}
                {lang === 'he' ? (
                  <ArrowLeft size={14} strokeWidth={2.5} />
                ) : (
                  <ArrowRight size={14} strokeWidth={2.5} />
                )}
              </button>
            </div>
          </div>
        </footer>
      )}

      </div>

      {accountOpen && (
        <AccountOverlay
          onClose={() => setAccountOpen(false)}
          onSynced={() => {
            // Synced trips/decisions/books may have changed — reload them.
            loadTrips().then(setTrips);
            loadDecisions().then(setDecisions);
          }}
        />
      )}

      {clipOpen && (
        <ClipOverlay
          keepers={keepers}
          pinnedIds={pinnedIds}
          places={places}
          getFile={getFile}
          renderClipVideo={renderClipVideo}
          progress={clipProgress}
          onClose={() => setClipOpen(false)}
        />
      )}

      {bookOpen && (
        <BookOverlay
          tripId={activeTripId}
          keepers={keepers}
          pinnedIds={pinnedIds}
          places={places}
          getFile={getFile}
          renderBook={renderBook}
          renderCover={renderCover}
          tripName={trips.find((tr) => tr.id === activeTripId)?.name ?? 'PicBook'}
          progress={bookProgress}
          onClose={() => setBookOpen(false)}
        />
      )}

      {reviewing && reviewList.length > 0 && (
        <ReviewOverlay
          entries={reviewList}
          startId={reviewing}
          decisions={decisions}
          onDecide={decide}
          onDelete={removePhoto}
          onClose={() => setReviewing(null)}
          getFile={getFile}
        />
      )}
    </main>
  );
}

function Cell({
  photo,
  cluster,
  decisions,
  dim,
  onOpen,
}: {
  photo: PhotoMeta;
  cluster: Cluster;
  decisions: Map<string, Decision>;
  dim: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const kept = isKeeper(photo, cluster, decisions);
  const decision = decisions.get(photo.id);
  const badge = decision
    ? decision === 'keep'
      ? { label: '✓', cls: 'bg-ink text-ground' }
      : decision === 'book'
        ? { label: t('badgeBook'), cls: 'bg-accent text-white' }
        : { label: '✕', cls: 'bg-accent text-white' }
    : cluster.photos.length > 1 && cluster.bestId === photo.id
      ? { label: t('badgeBest'), cls: 'bg-ink text-ground' }
      : null;

  return (
    <button
      onClick={onOpen}
      className={`relative h-20 w-20 ${dim && !kept ? 'opacity-40' : ''}`}
      aria-label={`Review ${photo.name}`}
    >
      <Thumb id={photo.id} alt={photo.name} />
      {badge && (
        <span
          className={`absolute start-0 top-0 px-[5px] py-0.5 text-[9px] font-bold uppercase leading-none tracking-[0.06em] ${badge.cls}`}
        >
          {badge.label}
        </span>
      )}
    </button>
  );
}
