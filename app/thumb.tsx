'use client';

import { useEffect, useRef, useState } from 'react';
import { getDB } from '@/lib/engine/db';
import { asBlob } from '@/lib/engine/images';

// Grid virtualization: a thumbnail only hits IndexedDB (and holds an object
// URL / decoded image) while it is within ~MARGIN of the viewport; far away it
// unloads back to a placeholder. Visibility is tracked with plain rect checks
// on scroll/resize plus a slow safety interval — deliberately not
// IntersectionObserver, whose callbacks are suspended in some embedded
// webviews, which would leave the grid as placeholders forever.
const MARGIN = 800;
const SWEEP_MS = 150;
const IDLE_SWEEP_MS = 1000;

interface Sub {
  cb: (near: boolean) => void;
  near: boolean;
}
const subs = new Map<Element, Sub>();
let hooked = false;
let pending = false;

function sweep() {
  pending = false;
  // innerHeight can read 0 in embedded webviews; fall back before giving up.
  const vh = Math.max(window.innerHeight, document.documentElement.clientHeight, 700);
  for (const [el, sub] of subs) {
    const r = el.getBoundingClientRect();
    // Zero-size rects (display:none / content-visibility-skipped) stay as-is.
    const near = r.height > 0 && r.bottom > -MARGIN && r.top < vh + MARGIN;
    if (near !== sub.near) {
      sub.near = near;
      sub.cb(near);
    }
  }
}

function scheduleSweep() {
  if (pending) return;
  pending = true;
  setTimeout(sweep, SWEEP_MS);
}

function hook() {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  window.addEventListener('scroll', scheduleSweep, { passive: true, capture: true });
  window.addEventListener('resize', scheduleSweep, { passive: true });
  // Layout can change without a scroll (collapse a day, filter a theme,
  // photos still importing) — a slow sweep catches those.
  setInterval(() => {
    if (subs.size) scheduleSweep();
  }, IDLE_SWEEP_MS);
}

function observeNear(el: Element, cb: (near: boolean) => void): () => void {
  hook();
  const sub: Sub = { cb, near: false };
  subs.set(el, sub);
  scheduleSweep();
  return () => {
    subs.delete(el);
  };
}

/** Object URL for a photo's cached thumbnail; null while loading, disabled, or absent. */
export function useThumbUrl(id: string, enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return;
    }
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(null);
    getDB()
      .then((db) => db.get('thumbs', id))
      .then((value) => {
        if (value && alive) {
          objectUrl = URL.createObjectURL(asBlob(value));
          setUrl(objectUrl);
        }
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, enabled]);

  return url;
}

export function Thumb({ id, alt }: { id: string; alt: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeNear(el, setNear);
  }, []);
  const url = useThumbUrl(id, near);
  return (
    <div ref={ref} className="aspect-square w-full">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- blob URL from IndexedDB, next/image can't optimize it
        <img src={url} alt={alt} className="h-full w-full rounded object-cover" loading="lazy" />
      ) : (
        <div className="h-full w-full animate-pulse rounded bg-neutral-800" />
      )}
    </div>
  );
}
