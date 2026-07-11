// Reverse geocoding for chapter/day place names. Sends ONLY coordinates
// (rounded to ~1km) to BigDataCloud's free client-side endpoint — never
// photos. Results are cached forever; offline lookups fail silently.

import { getDB } from './db';
import type { PhotoMeta } from './types';

const ENDPOINT = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

/** Representative place name for a set of photos (median GPS), or null. */
export async function placeForPhotos(photos: PhotoMeta[]): Promise<string | null> {
  const pts = photos.filter((p) => p.gps);
  if (!pts.length) return null;
  const lat = median(pts.map((p) => p.gps!.lat));
  const lon = median(pts.map((p) => p.gps!.lon));
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;

  const db = await getDB();
  const cached = await db.get('geo', key);
  if (cached !== undefined) return cached || null;

  try {
    const res = await fetch(
      `${ENDPOINT}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&localityLanguage=en`,
    );
    if (!res.ok) return null; // don't cache transient failures
    const data: { city?: string; locality?: string; principalSubdivision?: string } =
      await res.json();
    const place = data.city || data.locality || data.principalSubdivision || '';
    await db.put('geo', place, key);
    return place || null;
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
