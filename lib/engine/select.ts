// Best-X selection via maximal marginal relevance: repeatedly pick the
// highest-quality photo that is also far (in time and perceptual hash) from
// what's already picked, so 10 great sunset shots don't crowd out the trip.

import { takenTime } from './cluster';
import { dot, hamming } from './features';
import type { PhotoMeta } from './types';

const QUALITY_WEIGHT = 0.65;
const DIVERSITY_WEIGHT = 0.35;

export interface SelectOptions {
  /** Time distance saturation for the diversity term. Default 3h. */
  timeScaleMs?: number;
  /** A candidate this close in hash AND time to a picked photo is a near-duplicate. */
  dedupDistance?: number;
  dedupWindowMs?: number;
}

export function selectBest(photos: PhotoMeta[], x: number, opts: SelectOptions = {}): PhotoMeta[] {
  const timeScale = opts.timeScaleMs ?? 3 * 60 * 60 * 1000;
  const dedupDistance = opts.dedupDistance ?? 8;
  const dedupWindow = opts.dedupWindowMs ?? 2 * 60 * 60 * 1000;
  if (x >= photos.length) return [...photos];

  // Rank-normalize sharpness so one crazy-sharp outlier doesn't flatten the rest.
  const bySharp = [...photos].sort((a, b) => (a.sharpness ?? 0) - (b.sharpness ?? 0));
  const sharpRank = new Map(bySharp.map((p, i) => [p.id, bySharp.length > 1 ? i / (bySharp.length - 1) : 1]));
  const quality = (p: PhotoMeta) => 0.7 * (sharpRank.get(p.id) ?? 0) + 0.3 * (p.exposure ?? 0.5);

  const distance = (a: PhotoMeta, b: PhotoMeta) => {
    const dt = Math.min(1, Math.abs(takenTime(a) - takenTime(b)) / timeScale);
    // Content distance: CLIP embeddings when available (measures what's IN the
    // photo, not just pixels), hash otherwise.
    const dc =
      a.embedding && b.embedding
        ? Math.min(1, Math.max(0, (1 - dot(a.embedding, b.embedding)) / 0.35))
        : a.phash && b.phash
          ? hamming(a.phash, b.phash) / 64
          : 0.5;
    return 0.5 * dt + 0.5 * dc;
  };
  const isNearDupe = (a: PhotoMeta, b: PhotoMeta) =>
    Math.abs(takenTime(a) - takenTime(b)) <= dedupWindow &&
    ((!!a.phash && !!b.phash && hamming(a.phash, b.phash) <= dedupDistance) ||
      (!!a.embedding && !!b.embedding && dot(a.embedding, b.embedding) >= 0.96));

  const remaining = new Set(photos);
  const picked: PhotoMeta[] = [];
  // Each candidate's distance to its nearest picked photo, kept incrementally: O(x·n).
  const nearest = new Map<string, number>();
  // Candidates that became near-duplicates of something picked: hard-excluded
  // unless the quota can't be filled otherwise.
  const dupes = new Set<string>();

  while (picked.length < x && remaining.size > 0) {
    let best: PhotoMeta | null = null;
    let bestScore = -Infinity;
    let fallback: PhotoMeta | null = null;
    let fallbackScore = -Infinity;
    for (const p of remaining) {
      const div = picked.length === 0 ? 0.5 : (nearest.get(p.id) ?? 1);
      const score = QUALITY_WEIGHT * quality(p) + DIVERSITY_WEIGHT * div;
      if (score > fallbackScore) {
        fallbackScore = score;
        fallback = p;
      }
      if (!dupes.has(p.id) && score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    const pick = best ?? fallback;
    if (!pick) break;
    remaining.delete(pick);
    picked.push(pick);
    for (const p of remaining) {
      const d = distance(p, pick);
      const cur = nearest.get(p.id);
      if (cur === undefined || d < cur) nearest.set(p.id, d);
      if (isNearDupe(p, pick)) dupes.add(p.id);
    }
  }
  return picked;
}
