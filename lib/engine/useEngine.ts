'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDB } from './db';
import {
  fingerprint,
  type BookPlan,
  type ClipPlan,
  type EngineEvent,
  type EngineRequest,
  type PhotoMeta,
} from './types';

export interface IngestProgress {
  done: number;
  total: number;
  unsupported: number;
  running: boolean;
}

export interface AnalyzeProgress {
  done: number;
  total: number;
  running: boolean;
}

const IDLE: IngestProgress = { done: 0, total: 0, unsupported: 0, running: false };

export function useEngine() {
  const workerRef = useRef<Worker | null>(null);
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [progress, setProgress] = useState<IngestProgress>(IDLE);
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeProgress>({ done: 0, total: 0, running: false });
  const [bookProgress, setBookProgress] = useState<AnalyzeProgress>({ done: 0, total: 0, running: false });
  const [embedProgress, setEmbedProgress] = useState<
    AnalyzeProgress & { phase: 'download' | 'embed' }
  >({ phase: 'download', done: 0, total: 0, running: false });
  const [facesProgress, setFacesProgress] = useState<AnalyzeProgress>({ done: 0, total: 0, running: false });
  // Bumped whenever the worker stores new keeper renditions; consumers re-read the store.
  const [renditionsVersion, setRenditionsVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const bookResolver = useRef<{ resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null>(null);
  const coverResolver = useRef<{ resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null>(null);
  const [clipProgress, setClipProgress] = useState<AnalyzeProgress>({ done: 0, total: 0, running: false });
  const clipResolver = useRef<{ resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null>(null);

  // Analyzed metas are buffered and flushed on a timer: one state update per
  // ~250ms instead of one per photo, which matters at 2,000 photos.
  const analyzedBuf = useRef<Map<string, PhotoMeta>>(new Map());
  const flushTimer = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      flushTimer.current = null;
      const buf = analyzedBuf.current;
      if (!buf.size) return;
      analyzedBuf.current = new Map();
      setPhotos((prev) => prev.map((p) => buf.get(p.id) ?? p));
    };
    const scheduleFlush = () => {
      if (flushTimer.current == null) flushTimer.current = window.setTimeout(flush, 250);
    };

    const worker = new Worker(new URL('./worker.ts', import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<EngineEvent>) => {
      const ev = e.data;
      if (ev.type === 'photo') {
        // Replace-or-append: a cached photo re-imported into another trip
        // arrives with an updated tripId.
        setPhotos((prev) => {
          const i = prev.findIndex((p) => p.id === ev.meta.id);
          if (i < 0) return [...prev, ev.meta];
          const next = [...prev];
          next[i] = ev.meta;
          return next;
        });
        setProgress((p) => ({
          ...p,
          done: ev.done,
          total: ev.total,
          unsupported: p.unsupported + (ev.meta.status === 'unsupported' ? 1 : 0),
        }));
      } else if (ev.type === 'ingest-done') {
        setProgress({ done: ev.done, total: ev.total, unsupported: ev.unsupported, running: false });
      } else if (ev.type === 'photo-analyzed') {
        analyzedBuf.current.set(ev.meta.id, ev.meta);
        scheduleFlush();
      } else if (ev.type === 'analyze-progress') {
        setAnalyzeProgress({ done: ev.done, total: ev.total, running: ev.done < ev.total });
      } else if (ev.type === 'analyze-done') {
        if (flushTimer.current != null) window.clearTimeout(flushTimer.current);
        flush();
        setAnalyzeProgress((p) => ({ ...p, running: false }));
      } else if (ev.type === 'embed-progress') {
        setEmbedProgress({ phase: ev.phase, done: ev.done, total: ev.total, running: true });
      } else if (ev.type === 'embed-done') {
        if (flushTimer.current != null) window.clearTimeout(flushTimer.current);
        flush();
        setEmbedProgress((p) => ({ ...p, running: false }));
      } else if (ev.type === 'faces-progress') {
        setFacesProgress({ done: ev.done, total: ev.total, running: ev.done < ev.total });
      } else if (ev.type === 'faces-done') {
        if (flushTimer.current != null) window.clearTimeout(flushTimer.current);
        flush();
        setFacesProgress((p) => ({ ...p, running: false }));
      } else if (ev.type === 'renditions-done') {
        if (ev.stored > 0) setRenditionsVersion((v) => v + 1);
      } else if (ev.type === 'book-progress') {
        setBookProgress({ done: ev.done, total: ev.total, running: true });
      } else if (ev.type === 'book-done') {
        setBookProgress((p) => ({ ...p, running: false }));
        bookResolver.current?.resolve(new Uint8Array(ev.bytes));
        bookResolver.current = null;
      } else if (ev.type === 'cover-done') {
        coverResolver.current?.resolve(new Uint8Array(ev.bytes));
        coverResolver.current = null;
      } else if (ev.type === 'clip-progress') {
        setClipProgress({ done: ev.done, total: ev.total, running: true });
      } else if (ev.type === 'clip-done') {
        setClipProgress((p) => ({ ...p, running: false }));
        clipResolver.current?.resolve(new Uint8Array(ev.bytes));
        clipResolver.current = null;
      } else if (ev.type === 'engine-error') {
        setError(ev.message);
        setProgress((p) => ({ ...p, running: false }));
        setAnalyzeProgress((p) => ({ ...p, running: false }));
        setBookProgress((p) => ({ ...p, running: false }));
        setEmbedProgress((p) => ({ ...p, running: false }));
        setFacesProgress((p) => ({ ...p, running: false }));
        setClipProgress((p) => ({ ...p, running: false }));
        bookResolver.current?.reject(new Error(ev.message));
        bookResolver.current = null;
        coverResolver.current?.reject(new Error(ev.message));
        coverResolver.current = null;
        clipResolver.current?.reject(new Error(ev.message));
        clipResolver.current = null;
      }
    };

    // Photos ingested in previous sessions (resumability lives in IndexedDB),
    // then a catch-up analyze pass for anything that was interrupted.
    let cancelled = false;
    getDB()
      .then((db) => db.getAll('photos'))
      .then((cached) => {
        if (cancelled) return;
        if (cached.length) setPhotos((prev) => (prev.length ? prev : cached));
        worker.postMessage({ type: 'analyze' } satisfies EngineRequest);
      });

    return () => {
      cancelled = true;
      if (flushTimer.current != null) window.clearTimeout(flushTimer.current);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Originals picked this session, for full-quality viewing and sharing.
  // Deliberately not persisted: multi-GB libraries don't belong in IndexedDB.
  const filesRef = useRef<Map<string, File>>(new Map());

  const ingest = useCallback((files: File[], tripId: string) => {
    if (!files.length || !workerRef.current) return;
    for (const f of files) filesRef.current.set(fingerprint(f), f);
    setError(null);
    setProgress({ done: 0, total: files.length, unsupported: 0, running: true });
    workerRef.current.postMessage({ type: 'ingest', files, tripId } satisfies EngineRequest);
  }, []);

  // Keep the screen awake while the pipeline runs — iOS suspends the tab when
  // the screen sleeps, stalling a long import mid-way.
  const busy =
    progress.running ||
    analyzeProgress.running ||
    bookProgress.running ||
    embedProgress.running ||
    facesProgress.running;
  useEffect(() => {
    if (!busy || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;
    navigator.wakeLock
      .request('screen')
      .then((l) => {
        lock = l;
        if (released) l.release().catch(() => {});
      })
      .catch(() => {});
    return () => {
      released = true;
      lock?.release().catch(() => {});
    };
  }, [busy]);

  const getFile = useCallback((id: string) => filesRef.current.get(id), []);

  /** Drop photos from in-memory state after they were deleted from the DB. */
  const forgetPhotos = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setPhotos((prev) => prev.filter((p) => !gone.has(p.id)));
    for (const id of ids) filesRef.current.delete(id);
  }, []);

  const requestEmbed = useCallback(() => {
    workerRef.current?.postMessage({ type: 'embed' } satisfies EngineRequest);
  }, []);

  const requestRenditions = useCallback((items: [string, File][]) => {
    if (items.length && workerRef.current) {
      workerRef.current.postMessage({ type: 'renditions', items } satisfies EngineRequest);
    }
  }, []);

  const renderBook = useCallback((plan: BookPlan, files: Map<string, File>) => {
    return new Promise<Uint8Array>((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error('engine not ready'));
        return;
      }
      bookResolver.current = { resolve, reject };
      setBookProgress({ done: 0, total: 0, running: true });
      worker.postMessage({ type: 'book', plan, files: [...files] } satisfies EngineRequest);
    });
  }, []);

  const renderCover = useCallback((plan: BookPlan, files: Map<string, File>, title: string) => {
    return new Promise<Uint8Array>((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error('engine not ready'));
        return;
      }
      coverResolver.current = { resolve, reject };
      worker.postMessage({ type: 'cover', plan, files: [...files], title } satisfies EngineRequest);
    });
  }, []);

  const renderClipVideo = useCallback(
    (plan: ClipPlan, files: Map<string, File>, sound?: import('./audio').EncodedSound) => {
      return new Promise<Uint8Array>((resolve, reject) => {
        const worker = workerRef.current;
        if (!worker) {
          reject(new Error('engine not ready'));
          return;
        }
        clipResolver.current = { resolve, reject };
        setClipProgress({ done: 0, total: 0, running: true });
        worker.postMessage(
          { type: 'clip', plan, files: [...files], sound } satisfies EngineRequest,
          sound ? sound.chunks.map((c) => c.data.buffer) : [],
        );
      });
    },
    [],
  );

  return {
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
  };
}
