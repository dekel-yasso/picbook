// Book planning: chapters by day, hero page per chapter, deterministic grid
// pages. Pure functions — the UI replans live as the user moves the size slider.
//
// The photo budget is allocated per day (proportional, minimum 1 while the
// target allows) so quiet days still appear in the book, then best-X selection
// runs within each day with a tight diversity window.

import { takenTime } from './cluster';
import { dot } from './features';
import { selectBest } from './select';
import type { BookChapter, BookPlan, PhotoMeta } from './types';
import sceneData from './scene-embeddings.json';

const PAGE_MAX = 4;
// Within a single day, shots 45min apart are already "different moments".
const DAY_TIME_SCALE_MS = 45 * 60 * 1000;
// Minimum CLIP agreement before a scene caption is claimed for a day.
const SCENE_MIN_SCORE = 0.2;

export function planBook(
  keepers: PhotoMeta[],
  target: number,
  places?: Map<string, string>,
): BookPlan {
  const sorted = [...keepers].sort((a, b) => takenTime(a) - takenTime(b));
  const byDay = new Map<string, PhotoMeta[]>();
  for (const p of sorted) {
    const key = new Date(takenTime(p)).toDateString();
    const list = byDay.get(key);
    if (list) list.push(p);
    else byDay.set(key, [p]);
  }

  const days = [...byDay.entries()];
  const quotas = allocate(days.map(([, ps]) => ps.length), Math.min(target, sorted.length));

  let dayNumber = 0;
  const chapters: BookChapter[] = [];
  for (let i = 0; i < days.length; i++) {
    dayNumber++;
    if (quotas[i] === 0) continue;
    const [key, photos] = days[i];
    const chosen = selectBest(photos, quotas[i], { timeScaleMs: DAY_TIME_SCALE_MS }).sort(
      (a, b) => takenTime(a) - takenTime(b),
    );

    // Hero: sharpest well-exposed shot of the day.
    let hero = chosen[0];
    let heroScore = -Infinity;
    for (const p of chosen) {
      const s = (p.sharpness ?? 0) * (0.5 + 0.5 * (p.exposure ?? 0.5));
      if (s > heroScore) {
        heroScore = s;
        hero = p;
      }
    }
    const place = places?.get(key);
    const scene = sceneCaption(chosen);
    chapters.push({
      key,
      title: place ? `Day ${dayNumber} — ${place}` : `Day ${dayNumber} — ${formatDay(takenTime(photos[0]))}`,
      caption: [place ? formatDay(takenTime(photos[0])) : null, scene].filter(Boolean).join(' · ') || undefined,
      heroId: hero.id,
      pages: paginate(chosen.filter((p) => p.id !== hero.id).map((p) => p.id)),
    });
  }

  return { chapters, photoCount: chapters.reduce((n, c) => n + 1 + c.pages.reduce((m, p) => m + p.photoIds.length, 0), 0) };
}

/**
 * Split `target` across days proportionally to their photo counts, capped by
 * each day's count, with a minimum of 1 per day when the target is big enough.
 */
function allocate(counts: number[], target: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  const quotas = counts.map(() => 0);
  let sum = 0;
  if (target >= counts.length) {
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > 0) {
        quotas[i] = 1;
        sum++;
      }
    }
  }
  while (sum < target) {
    let best = -1;
    let bestDeficit = -Infinity;
    for (let i = 0; i < counts.length; i++) {
      if (quotas[i] >= counts[i]) continue;
      const deficit = (counts[i] / total) * target - quotas[i];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = i;
      }
    }
    if (best < 0) break;
    quotas[best]++;
    sum++;
  }
  return quotas;
}

/** Best-matching scene phrase for a day, voted by the mean CLIP embedding of its photos. */
function sceneCaption(photos: PhotoMeta[]): string | null {
  const embedded = photos.filter((p) => p.embedding);
  if (!embedded.length) return null;
  const dim = embedded[0].embedding!.length;
  const mean = new Array<number>(dim).fill(0);
  for (const p of embedded) for (let i = 0; i < dim; i++) mean[i] += p.embedding![i];
  const norm = Math.hypot(...mean) || 1;
  for (let i = 0; i < dim; i++) mean[i] /= norm;

  let best = -1;
  let bestScore = SCENE_MIN_SCORE;
  for (let i = 0; i < sceneData.embeddings.length; i++) {
    const s = dot(mean, sceneData.embeddings[i]);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best >= 0 ? sceneData.captions[best] : null;
}

function paginate(ids: string[]): { photoIds: string[] }[] {
  const pages: { photoIds: string[] }[] = [];
  for (let i = 0; i < ids.length; i += PAGE_MAX) {
    pages.push({ photoIds: ids.slice(i, i + PAGE_MAX) });
  }
  // Avoid a lonely last photo when the previous page can spare one.
  const n = pages.length;
  if (n >= 2 && pages[n - 1].photoIds.length === 1 && pages[n - 2].photoIds.length === PAGE_MAX) {
    pages[n - 1].photoIds.unshift(pages[n - 2].photoIds.pop() as string);
  }
  return pages;
}

function formatDay(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
