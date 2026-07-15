// Destructive library operations. Photos here are PicBook's copies (thumbs,
// scores, renditions) — originals in the camera roll are never touched.

import { getDB } from './db';
import { DEFAULT_TRIP_ID } from './trips';

/** Remove a photo and everything derived from it. */
export async function deletePhoto(id: string): Promise<void> {
  await deletePhotos([id]);
}

/** Remove many photos (and their thumbs/renditions/decisions) in one transaction. */
export async function deletePhotos(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getDB();
  const tx = db.transaction(['photos', 'thumbs', 'renditions', 'decisions'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('photos').delete(id);
    tx.objectStore('thumbs').delete(id);
    tx.objectStore('renditions').delete(id);
    tx.objectStore('decisions').delete(id);
  }
  await tx.done;
}

/** Remove a trip with all its photos, decisions, renditions, and book. Returns removed photo ids. */
export async function deleteTrip(tripId: string): Promise<string[]> {
  const db = await getDB();
  const photos = await db.getAll('photos');
  const ids = photos
    .filter((p) => (p.tripId ?? DEFAULT_TRIP_ID) === tripId)
    .map((p) => p.id);

  const tx = db.transaction(['photos', 'thumbs', 'renditions', 'decisions', 'books', 'trips'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('photos').delete(id);
    tx.objectStore('thumbs').delete(id);
    tx.objectStore('renditions').delete(id);
    tx.objectStore('decisions').delete(id);
  }
  tx.objectStore('books').delete(tripId);
  tx.objectStore('trips').delete(tripId);
  await tx.done;
  return ids;
}
