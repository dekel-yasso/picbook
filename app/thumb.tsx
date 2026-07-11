'use client';

import { useEffect, useState } from 'react';
import { getDB } from '@/lib/engine/db';
import { asBlob } from '@/lib/engine/images';

/** Object URL for a photo's cached thumbnail; null while loading or if absent. */
export function useThumbUrl(id: string): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
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
  }, [id]);

  return url;
}

export function Thumb({ id, alt }: { id: string; alt: string }) {
  const url = useThumbUrl(id);
  if (!url) return <div className="aspect-square w-full animate-pulse rounded bg-neutral-800" />;
  // eslint-disable-next-line @next/next/no-img-element -- blob URL from IndexedDB, next/image can't optimize it
  return <img src={url} alt={alt} className="aspect-square w-full rounded object-cover" loading="lazy" />;
}
