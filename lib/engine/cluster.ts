// Burst clustering + best-of-cluster picking. Pure functions over PhotoMeta —
// cheap enough to run on the main thread whenever photos change.

import { dot, hamming } from './features';
import type { Decision, PhotoMeta } from './types';

export interface Cluster {
  id: string;
  /** Chronological. */
  photos: PhotoMeta[];
  bestId: string;
}

// Shots within this gap of each other are candidates for the same burst.
const GAP_MS = 90_000;
// Within a time burst, split when perceptual hashes diverge more than this
// (different subject shot in quick succession).
const SPLIT_DISTANCE = 16;
// Cross-time merge: clusters up to this far apart whose photos hash very close
// are the same scene revisited ("walked back for one more shot"). Much stricter
// than SPLIT_DISTANCE because time is no longer vouching for them — and only
// for hashes with enough set bits: low-texture scenes (skies, beaches, sunsets)
// all hash near-zero under the dead-zone dHash, so closeness means nothing there.
const MERGE_DISTANCE = 6;
const MERGE_MIN_TEXTURE = 8;
const MERGE_WINDOW_MS = 60 * 60 * 1000;
// CLIP cosine thresholds (when embeddings exist). Semantic similarity survives
// angle/zoom changes that break pixel hashes.
const EMB_SAME_SUBJECT = 0.9; // within a burst: keep together
const EMB_REVISIT = 0.93; // across time: merge clusters

export const takenTime = (p: PhotoMeta) => p.takenAt ?? p.lastModified;

function popcount(hash: string): number {
  let x = BigInt(`0x${hash}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Effective fate: an explicit decision wins; otherwise singletons and burst best-picks are keepers. */
export function isKeeper(p: PhotoMeta, cluster: Cluster, decisions: Map<string, Decision>): boolean {
  const d = decisions.get(p.id);
  if (d) return d === 'keep';
  return cluster.photos.length === 1 || cluster.bestId === p.id;
}

export function clusterPhotos(photos: PhotoMeta[]): Cluster[] {
  const sorted = photos
    .filter((p) => p.status === 'ready')
    .sort((a, b) => takenTime(a) - takenTime(b));

  const bursts: PhotoMeta[][] = [];
  for (const p of sorted) {
    const cur = bursts[bursts.length - 1];
    if (cur && takenTime(p) - takenTime(cur[cur.length - 1]) <= GAP_MS) cur.push(p);
    else bursts.push([p]);
  }

  return mergeRevisits(bursts.flatMap(splitBySimilarity)).map((ps) => ({
    id: ps[0].id,
    photos: ps,
    bestId: pickBest(ps),
  }));
}

/** Merge chronologically-ordered clusters that are the same scene shot again within the window. */
function mergeRevisits(groups: PhotoMeta[][]): PhotoMeta[][] {
  const merged: PhotoMeta[][] = [];
  for (const group of groups) {
    const start = takenTime(group[0]);
    let home: PhotoMeta[] | undefined;
    for (let i = merged.length - 1; i >= 0; i--) {
      const prev = merged[i];
      if (start - takenTime(prev[prev.length - 1]) > MERGE_WINDOW_MS) break;
      const close = prev.some((a) =>
        group.some(
          (b) =>
            (a.phash &&
              b.phash &&
              popcount(a.phash) >= MERGE_MIN_TEXTURE &&
              popcount(b.phash) >= MERGE_MIN_TEXTURE &&
              hamming(a.phash, b.phash) <= MERGE_DISTANCE) ||
            (!!a.embedding && !!b.embedding && dot(a.embedding, b.embedding) >= EMB_REVISIT),
        ),
      );
      if (close) {
        home = prev;
        break;
      }
    }
    if (home) home.push(...group);
    else merged.push(group);
  }
  return merged;
}

function splitBySimilarity(burst: PhotoMeta[]): PhotoMeta[][] {
  if (burst.length < 2) return [burst];
  const subs: PhotoMeta[][] = [];
  for (const p of burst) {
    // Photos not yet analyzed stay with the first subcluster rather than splitting.
    const home = subs.find(
      (s) =>
        !p.phash ||
        !s[0].phash ||
        hamming(s[0].phash, p.phash) <= SPLIT_DISTANCE ||
        (!!p.embedding && !!s[0].embedding && dot(p.embedding, s[0].embedding) >= EMB_SAME_SUBJECT),
    );
    if (home) home.push(p);
    else subs.push([p]);
  }
  return subs;
}

function pickBest(ps: PhotoMeta[]): string {
  if (ps.length === 1) return ps[0].id;
  const sharp = ps.map((p) => p.sharpness ?? 0);
  const min = Math.min(...sharp);
  const range = Math.max(...sharp) - min || 1;
  // Face-aware weighting kicks in when the burst actually contains people.
  const hasPeople = ps.some((p) => (p.faces?.n ?? 0) > 0);
  let best = ps[0];
  let bestScore = -Infinity;
  for (const p of ps) {
    const sharpNorm = ((p.sharpness ?? 0) - min) / range;
    const exposure = p.exposure ?? 0.5;
    // A photo with no detected faces in a people-burst is likely the one where
    // everyone turned away — score it below any open-eyed shot.
    const face = p.faces ? (p.faces.n > 0 ? p.faces.eyesOpen : 0.4) : 0.5;
    const score = hasPeople
      ? 0.5 * sharpNorm + 0.2 * exposure + 0.3 * face
      : 0.7 * sharpNorm + 0.3 * exposure;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best.id;
}
