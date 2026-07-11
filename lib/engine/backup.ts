// .picbook backup file: everything needed to continue working on another
// browser/install on the same (or another) machine — trips, photo metas,
// thumbnails, decisions, books. Embeddings and renditions are excluded
// (recomputed / regenerated from originals after re-import).
//
// Binary layout: "PICBOOK1" magic (8 bytes) · header length (uint32 LE) ·
// header JSON · concatenated thumbnail blobs. Blob parts keep memory flat on
// both ends — no base64, no giant strings.

import { normalizeDecision } from './decisions';
import { getDB } from './db';
import { loadTrips } from './trips';
import type { BookDoc, Decision, DecisionRecord, PhotoMeta, Trip } from './types';

const MAGIC = 'PICBOOK1';

interface BackupHeader {
  version: 1;
  exportedAt: number;
  trips: Trip[];
  photos: Omit<PhotoMeta, 'embedding'>[];
  decisions: Record<string, Decision | DecisionRecord>;
  books: Record<string, BookDoc>;
  blobs: { id: string; offset: number; size: number; type: string }[];
}

export async function exportBackup(): Promise<Blob> {
  const db = await getDB();
  const trips = await loadTrips();
  const photos = await db.getAll('photos');
  const decisionKeys = await db.getAllKeys('decisions');
  const decisionVals = await db.getAll('decisions');
  const books: Record<string, BookDoc> = {};
  for (const trip of trips) {
    const doc = await db.get('books', trip.id);
    if (doc) books[trip.id] = doc;
  }

  const parts: (Blob | ArrayBuffer)[] = [];
  const blobs: BackupHeader['blobs'] = [];
  let offset = 0;
  for (const p of photos) {
    const thumb = await db.get('thumbs', p.id);
    if (!thumb) continue;
    const size = thumb instanceof Blob ? thumb.size : thumb.byteLength;
    const type = thumb instanceof Blob ? thumb.type : 'image/jpeg';
    blobs.push({ id: p.id, offset, size, type });
    parts.push(thumb);
    offset += size;
  }

  const header: BackupHeader = {
    version: 1,
    exportedAt: Date.now(),
    trips,
    photos: photos.map((p) => {
      const { embedding: _embedding, ...rest } = p;
      return rest;
    }),
    decisions: Object.fromEntries(decisionKeys.map((k, i) => [k, decisionVals[i]])),
    books,
    blobs,
  };

  const enc = new TextEncoder();
  const headerBytes = enc.encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, headerBytes.length, true);
  return new Blob([enc.encode(MAGIC), len, headerBytes, ...parts], {
    type: 'application/octet-stream',
  });
}

// Small batches + raw ArrayBuffers: iOS WebKit's IndexedDB throws internal
// errors ("attempt to delete range…") on large batched Blob writes.
const IMPORT_BATCH = 20;

export async function importBackup(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<{ photos: number; trips: number }> {
  const magic = await file.slice(0, 8).text();
  if (magic !== MAGIC) throw new Error('Not a PicBook backup file');
  const lenBuf = new DataView(await file.slice(8, 12).arrayBuffer());
  const headerLen = lenBuf.getUint32(0, true);
  const header = JSON.parse(await file.slice(12, 12 + headerLen).text()) as BackupHeader;
  if (header.version !== 1) throw new Error('Unsupported backup version');
  const base = 12 + headerLen;

  const db = await getDB();
  let photosAdded = 0;

  for (const trip of header.trips ?? []) {
    if (!(await db.get('trips', trip.id))) await db.put('trips', trip, trip.id);
  }

  const existing = new Set(await db.getAllKeys('photos'));
  const blobIndex = new Map((header.blobs ?? []).map((b) => [b.id, b]));
  const todo = (header.photos ?? []).filter((p) => !existing.has(p.id));
  const total = todo.length;

  for (let i = 0; i < todo.length; i += IMPORT_BATCH) {
    const batch = todo.slice(i, i + IMPORT_BATCH);
    // Read thumbnail bytes BEFORE the transaction: forces real reads from the
    // picked file (iOS can stall on lazily-stored file-backed slices) and
    // surfaces read errors instead of hanging.
    const thumbs = await Promise.all(
      batch.map(async (photo) => {
        const entry = blobIndex.get(photo.id);
        if (!entry) return null;
        return file.slice(base + entry.offset, base + entry.offset + entry.size).arrayBuffer();
      }),
    );
    const writeBatch = async () => {
      const tx = db.transaction(['photos', 'thumbs'], 'readwrite');
      for (let k = 0; k < batch.length; k++) {
        tx.objectStore('photos').put(batch[k] as never, batch[k].id);
        const thumb = thumbs[k];
        if (thumb) tx.objectStore('thumbs').put(thumb, batch[k].id);
      }
      await tx.done;
    };
    try {
      await writeBatch();
    } catch {
      // One retry after a beat — WebKit's IndexedDB occasionally hiccups.
      await new Promise((r) => setTimeout(r, 150));
      await writeBatch();
    }
    photosAdded += batch.length;
    onProgress?.(photosAdded, total);
  }

  for (const [id, raw] of Object.entries(header.decisions ?? {})) {
    const incoming = normalizeDecision(raw);
    const local = await db.get('decisions', id);
    if (!local || incoming.at > normalizeDecision(local).at) {
      await db.put('decisions', incoming, id);
    }
  }
  for (const [tripId, doc] of Object.entries(header.books ?? {})) {
    const local = await db.get('books', tripId);
    if (!local || doc.updatedAt > local.updatedAt) await db.put('books', doc, tripId);
  }
  return { photos: photosAdded, trips: (header.trips ?? []).length };
}
