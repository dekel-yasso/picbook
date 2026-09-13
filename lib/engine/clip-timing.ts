// Clip timing defaults + the per-plan overrides the user can set. Kept free of
// render imports so beats.ts (page-side) can share it with clip.ts (worker).

import type { ClipPlan } from './types';

export const DEFAULT_PHOTO_S = 1.6;
export const DEFAULT_FADE_S = 0.4;
export const TITLE_S = 1.4;

export const PHOTO_S_RANGE = { min: 1, max: 6, step: 0.1 } as const;
export const FADE_S_RANGE = { min: 0.1, max: 1.5, step: 0.1 } as const;

/** Resolved photo/crossfade durations for a plan. The fade is capped well
 *  below the photo time so consecutive segments always keep a positive
 *  non-overlapping span. */
export function clipTiming(plan: Pick<ClipPlan, 'photoSeconds' | 'fadeSeconds'>): { photoS: number; fadeS: number } {
  const photoS = clamp(plan.photoSeconds ?? DEFAULT_PHOTO_S, PHOTO_S_RANGE.min, PHOTO_S_RANGE.max);
  const fadeS = clamp(plan.fadeSeconds ?? DEFAULT_FADE_S, FADE_S_RANGE.min, Math.min(FADE_S_RANGE.max, photoS * 0.8));
  return { photoS, fadeS };
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}
