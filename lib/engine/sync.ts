// Client side of cloud sync. What syncs is small JSON per trip: trip meta,
// photo metas (embeddings stripped — recomputable), decisions, and the book.
// Pull applies trips/decisions/books; photo metas for photos this device has
// never seen are skipped (no thumbs to show — renditions-in-cloud comes later).

import { getDB } from './db';
import { DEFAULT_TRIP_ID, loadTrips } from './trips';
import type { BookDoc, Decision, PhotoMeta, Trip } from './types';

export interface TripBundle {
  trip: Trip;
  photos: Omit<PhotoMeta, 'embedding'>[];
  decisions: Record<string, Decision>;
  book?: BookDoc;
  updatedAt: number;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export function whoami(): Promise<string | null> {
  return api<{ email: string }>('/api/auth/me')
    .then((r) => r.email)
    .catch(() => null);
}

export function signIn(email: string, password: string): Promise<{ email: string; created: boolean }> {
  return api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

export function signOut(): Promise<unknown> {
  return api('/api/auth/logout', { method: 'POST' });
}

/** Remove a trip's cloud copy so it doesn't resurrect on the next pull. Best-effort. */
export function deleteTripRemote(tripId: string): Promise<unknown> {
  return api(`/api/sync?tripId=${encodeURIComponent(tripId)}`, { method: 'DELETE' }).catch(() => null);
}

async function collectBundles(): Promise<TripBundle[]> {
  const db = await getDB();
  const trips = await loadTrips();
  const photos = await db.getAll('photos');
  const decisionKeys = await db.getAllKeys('decisions');
  const decisionVals = await db.getAll('decisions');
  const decisions = new Map(decisionKeys.map((k, i) => [k, decisionVals[i]]));
  const now = Date.now();

  const bundles: TripBundle[] = [];
  for (const trip of trips) {
    const tripPhotos = photos.filter((p) => (p.tripId ?? DEFAULT_TRIP_ID) === trip.id);
    const tripDecisions: Record<string, Decision> = {};
    for (const p of tripPhotos) {
      const d = decisions.get(p.id);
      if (d) tripDecisions[p.id] = d;
    }
    bundles.push({
      trip,
      photos: tripPhotos.map((p) => {
        const { embedding: _embedding, ...rest } = p;
        return rest;
      }),
      decisions: tripDecisions,
      book: await db.get('books', trip.id),
      updatedAt: now,
    });
  }
  return bundles;
}

async function applyBundles(bundles: TripBundle[]): Promise<number> {
  const db = await getDB();
  let applied = 0;
  for (const bundle of bundles) {
    if (!bundle?.trip?.id) continue;
    const existing = await db.get('trips', bundle.trip.id);
    // Newest rename wins across devices.
    if (!existing || (bundle.trip.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      await db.put('trips', bundle.trip, bundle.trip.id);
    }

    if (bundle.book) {
      const localBook = await db.get('books', bundle.trip.id);
      if (!localBook || bundle.book.updatedAt > localBook.updatedAt) {
        await db.put('books', bundle.book, bundle.trip.id);
      }
    }
    for (const [photoId, decision] of Object.entries(bundle.decisions ?? {})) {
      await db.put('decisions', decision, photoId);
    }
    applied++;
  }
  return applied;
}

/** Pull remote → apply → push local. Resolves to pulled/pushed counts. */
export async function syncNow(): Promise<{ pulled: number; pushed: number }> {
  const remote = await api<{ bundles: TripBundle[] }>('/api/sync');
  await applyBundles(remote.bundles);
  const bundles = await collectBundles();
  const pushed = await api<{ stored: number }>('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundles }),
  });
  return { pulled: remote.bundles.length, pushed: pushed.stored };
}
