// Beat-synced cuts: find musical accents in the decoded soundtrack, then nudge
// each photo-change boundary onto the nearest one. Onset detection is a plain
// energy-rise envelope — no tempo grid, so it survives classical rubato and
// works on any genre. Runs on the page right after decodeAudioData.

import type { ClipPlan } from './types';

const HOP_S = 0.023; // ~1024 samples at 44.1kHz
const MIN_GAP_S = 0.25;
/** How far a cut may move to reach a beat. Asymmetric: lengthening a shot
 *  feels better than an early cut. */
const SNAP_BACK_S = 0.45;
const SNAP_FWD_S = 0.6;
const PHOTO_MIN_S = 1.0;
const PHOTO_MAX_S = 2.8;
// Must mirror clip.ts. Duplicated to keep this module free of render imports.
const PHOTO_S = 1.6;
const TITLE_S = 1.4;
const FADE_S = 0.4;

/** Onset times (seconds) of one pass of the track. */
export function detectBeats(channels: Float32Array[], sampleRate: number): number[] {
  if (!channels.length || !channels[0].length) return [];
  const hop = Math.round(HOP_S * sampleRate);
  const n = Math.floor(channels[0].length / hop);
  if (n < 8) return [];

  // Energy envelope over mono downmix.
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const off = i * hop;
    for (const ch of channels) {
      for (let j = 0; j < hop; j++) {
        const v = ch[off + j];
        sum += v * v;
      }
    }
    energy[i] = Math.sqrt(sum / (hop * channels.length));
  }

  // Onset strength: positive energy rise.
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);

  // Candidate peaks above a local adaptive threshold, with their strength
  // relative to the neighborhood.
  const win = Math.round(1.0 / HOP_S);
  const candidates: { t: number; score: number }[] = [];
  for (let i = 2; i < n - 2; i++) {
    const o = onset[i];
    if (o < onset[i - 1] || o < onset[i + 1] || o < onset[i - 2] || o < onset[i + 2]) continue;
    const a = Math.max(0, i - win);
    const b = Math.min(n, i + win);
    let mean = 0;
    for (let j = a; j < b; j++) mean += onset[j];
    mean /= b - a;
    if (o < mean * 1.5 || o < 1e-4) continue;
    candidates.push({ t: i * HOP_S, score: o / (mean + 1e-6) });
  }

  // Keep only the strongest accents — about one per second — so snapping
  // means landing on a real musical hit, not any minor flutter.
  const budget = Math.max(4, Math.round(n * HOP_S * 1.0));
  candidates.sort((x, y) => y.score - x.score);
  const picked: number[] = [];
  for (const c of candidates) {
    if (picked.length >= budget) break;
    if (picked.some((t) => Math.abs(t - c.t) < MIN_GAP_S)) continue;
    picked.push(c.t);
  }
  return picked.sort((x, y) => x - y);
}

/** Repeat one track-pass of beats across the looped soundtrack. */
export function loopBeats(beats: number[], trackSeconds: number, totalSeconds: number): number[] {
  if (!beats.length || trackSeconds <= 0) return beats;
  const out: number[] = [];
  for (let off = 0; off < totalSeconds; off += trackSeconds) {
    for (const b of beats) {
      const t = b + off;
      if (t < totalSeconds) out.push(t);
    }
  }
  return out;
}

/**
 * Nudge photo-segment durations so each visual cut (crossfade midpoint) lands
 * on a nearby beat. Titles and map segments keep their timing.
 * Returns the synced plan plus how many cuts snapped, for diagnostics.
 */
export function syncPlanToBeats(
  plan: ClipPlan,
  beats: number[],
): { plan: ClipPlan; snapped: number; cuts: number } {
  if (!beats.length) return { plan, snapped: 0, cuts: 0 };
  let clock = 0;
  let snapped = 0;
  let cuts = 0;
  const segments = plan.segments.map((seg, i) => {
    const base = seg.kind === 'title' ? TITLE_S : seg.kind === 'map' ? seg.duration : PHOTO_S;
    let duration = base;
    // Only sync photo→anything boundaries, and leave the final fade-out alone.
    if (seg.kind === 'photo' && i < plan.segments.length - 1) {
      cuts++;
      const cut = clock + base - FADE_S / 2;
      let best: number | null = null;
      for (const b of beats) {
        if (b < cut - SNAP_BACK_S) continue;
        if (b > cut + SNAP_FWD_S) break;
        if (best === null || Math.abs(b - cut) < Math.abs(best - cut)) best = b;
      }
      if (best !== null) {
        const d = base + (best - cut);
        if (d >= PHOTO_MIN_S && d <= PHOTO_MAX_S) {
          duration = d;
          snapped++;
        }
      }
    }
    clock += duration - FADE_S;
    return seg.kind === 'photo' ? { ...seg, s: duration } : seg;
  });
  return { plan: { ...plan, segments }, snapped, cuts };
}
