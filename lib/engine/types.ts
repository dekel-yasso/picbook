export interface Trip {
  id: string;
  name: string;
  createdAt: number;
  /** Last rename/creation; sync keeps whichever side is newer. */
  updatedAt?: number;
}

export interface PhotoMeta {
  id: string;
  /** Trip this photo belongs to; absent = the default trip (pre-trips photos). */
  tripId?: string;
  name: string;
  size: number;
  lastModified: number;
  /** Epoch ms from EXIF DateTimeOriginal/CreateDate; null if the photo has no date. */
  takenAt: number | null;
  gps: { lat: number; lon: number } | null;
  thumbWidth: number;
  thumbHeight: number;
  status: 'ready' | 'unsupported';
  addedAt: number;
  /** Analysis features; absent until the analyze pass has run on this photo. */
  phash?: string;
  sharpness?: number;
  exposure?: number;
  /** Feature-algorithm version that produced the above; bumping FEATURES_VERSION triggers re-analysis. */
  featv?: number;
  /** L2-normalized CLIP image embedding; present once the on-device model has seen this photo. */
  embedding?: number[];
  /** Best-matching theme label derived from the embedding. */
  theme?: string;
  /** Face summary from the on-device detector: count + eyes-open (0..1, 1 = everyone's eyes open). */
  faces?: { n: number; eyesOpen: number };
  /** Face-algorithm version; absent = faces not scanned yet. */
  facev?: number;
}

/** A user's explicit override; absent means "trust the auto-pick".
 *  'book' = keep AND guarantee a spot in the book/clip, no matter the quotas. */
export type Decision = 'keep' | 'reject' | 'book';

/** Stored/synced decision with its timestamp — newest wins across devices.
 *  v: null is a tombstone (the user cleared the decision). Legacy entries are
 *  bare Decision strings, treated as { v, at: 0 }. */
export interface DecisionRecord {
  v: Decision | null;
  at: number;
}

/** One book page: 1–4 photo ids laid out by deterministic rules. */
export interface BookPage {
  photoIds: string[];
}

export interface BookChapter {
  /** Stable key (the day) so user-edited titles survive replanning. */
  key: string;
  title: string;
  /** Auto caption for the hero page: date + CLIP scene phrase. */
  caption?: string;
  heroId: string;
  pages: BookPage[];
}

export interface BookPlan {
  chapters: BookChapter[];
  photoCount: number;
}

/** Persisted book document — small JSON, the photos stay on the device. */
export interface BookDoc {
  target: number;
  titles: Record<string, string>;
  updatedAt: number;
}

/** One timeline segment of the trip clip. */
export type ClipSegment = { kind: 'title'; text: string; sub?: string } | { kind: 'photo'; id: string };

export type ClipTransition = 'fade' | 'slide' | 'zoom' | 'wipe' | 'mix';

export interface ClipPlan {
  segments: ClipSegment[];
  photoCount: number;
  transition?: ClipTransition;
}

export type EngineRequest =
  | { type: 'ingest'; files: File[]; tripId: string }
  | { type: 'analyze' }
  | { type: 'embed' }
  | { type: 'renditions'; items: [string, File][] }
  | { type: 'book'; plan: BookPlan; files: [string, File][] }
  | { type: 'clip'; plan: ClipPlan; files: [string, File][] };

export type EngineEvent =
  | { type: 'photo'; meta: PhotoMeta; done: number; total: number }
  | { type: 'ingest-done'; done: number; total: number; unsupported: number }
  | { type: 'photo-analyzed'; meta: PhotoMeta }
  | { type: 'analyze-progress'; done: number; total: number }
  | { type: 'analyze-done'; analyzed: number }
  | { type: 'embed-progress'; phase: 'download' | 'embed'; done: number; total: number }
  | { type: 'embed-done'; embedded: number }
  | { type: 'faces-progress'; done: number; total: number }
  | { type: 'faces-done'; scanned: number }
  | { type: 'renditions-done'; stored: number }
  | { type: 'book-progress'; done: number; total: number }
  | { type: 'book-done'; bytes: ArrayBuffer }
  | { type: 'clip-progress'; done: number; total: number }
  | { type: 'clip-done'; bytes: ArrayBuffer }
  | { type: 'engine-error'; message: string };

/**
 * Cache key for a photo across sessions. Name+size+mtime is enough to make
 * re-ingesting the same picks a no-op; a content hash would survive renames
 * but costs a full read per file.
 */
export function fingerprint(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}
