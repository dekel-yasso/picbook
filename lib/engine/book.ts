// Book planning: chapters by day, hero page per chapter, deterministic grid
// pages. Pure functions — the UI replans live as the user moves the size slider.
//
// The photo budget is allocated per day (proportional, minimum 1 while the
// target allows) so quiet days still appear in the book, then best-X selection
// runs within each day with a tight diversity window.

import { SCENE_CAPTIONS_HE, type Lang } from '../i18n-strings';
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
  pinnedIds?: Set<string>,
  lang: Lang = 'en',
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

  // Long trips (a week+) read poorly as one chapter per calendar day — a
  // multi-day stay in one place ends up with a title card per day and one
  // starved photo each. Merge consecutive days that share the same place
  // into a single date-range chapter instead; single-city or no-GPS trips
  // are unaffected since no two consecutive days ever share a place there.
  interface DayGroup {
    keys: string[];
    photos: PhotoMeta[];
    place?: string;
  }
  const groups: DayGroup[] = [];
  for (const [key, photos] of days) {
    const place = places?.get(key) || undefined;
    const prev = groups[groups.length - 1];
    if (place && prev?.place === place) {
      prev.keys.push(key);
      prev.photos.push(...photos);
    } else {
      groups.push({ keys: [key], photos, place });
    }
  }

  const quotas = allocate(
    groups.map((g) => g.photos.length),
    Math.min(target, sorted.length),
  );

  let dayNumber = 0;
  const chapters: BookChapter[] = [];
  for (let i = 0; i < groups.length; i++) {
    dayNumber++;
    const { keys, photos, place } = groups[i];
    // User's must-haves always make it in — even on days whose quota is 0.
    const pinned = pinnedIds ? photos.filter((p) => pinnedIds.has(p.id)) : [];
    const quota = Math.max(quotas[i], pinned.length);
    if (quota === 0) continue;
    const chosen = selectBest(photos, quota, {
      timeScaleMs: DAY_TIME_SCALE_MS,
      seeds: pinned,
    }).sort((a, b) => takenTime(a) - takenTime(b));

    // Hero: sharpest well-exposed shot of the chapter.
    let hero = chosen[0];
    let heroScore = -Infinity;
    for (const p of chosen) {
      const s = (p.sharpness ?? 0) * (0.5 + 0.5 * (p.exposure ?? 0.5));
      if (s > heroScore) {
        heroScore = s;
        hero = p;
      }
    }
    const rawScene = sceneCaption(chosen);
    const scene = rawScene && lang === 'he' ? (SCENE_CAPTIONS_HE[rawScene] ?? rawScene) : rawScene;
    const dayWord = lang === 'he' ? 'יום' : 'Day';
    const spansMultipleDays = keys.length > 1;
    const dateLabel = spansMultipleDays
      ? formatDayRange(takenTime(photos[0]), takenTime(photos[photos.length - 1]), lang)
      : formatDay(takenTime(photos[0]), lang);
    chapters.push({
      key: keys[0],
      title:
        place && spansMultipleDays
          ? `${dateLabel} — ${place}`
          : place
            ? `${dayWord} ${dayNumber} — ${place}`
            : `${dayWord} ${dayNumber} — ${dateLabel}`,
      caption:
        [!spansMultipleDays && place ? dateLabel : null, scene].filter(Boolean).join(' · ') ||
        undefined,
      heroId: hero.id,
      pages: paginate(chosen.filter((p) => p.id !== hero.id).map((p) => p.id)),
    });
  }

  return { chapters, photoCount: chapters.reduce((n, c) => n + 1 + c.pages.reduce((m, p) => m + p.photoIds.length, 0), 0) };
}

// Every chapter gets at least this many photos when the budget allows —
// a lonely hero page reads like an afterthought.
const DAY_FLOOR = 3;

/**
 * Split `target` across days by the SQUARE ROOT of their photo counts (big
 * days lead, but 150-vs-6 becomes ~5:1 instead of 25:1), capped by each day's
 * count, with a floor of DAY_FLOOR (falling back to 1) when the target allows.
 */
function allocate(counts: number[], target: number): number[] {
  const weights = counts.map((c) => Math.sqrt(c));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const quotas = counts.map(() => 0);
  let sum = 0;

  const floors = counts.map((c) => Math.min(c, DAY_FLOOR));
  const floorsSum = floors.reduce((a, b) => a + b, 0);
  if (target >= floorsSum) {
    for (let i = 0; i < counts.length; i++) {
      quotas[i] = floors[i];
      sum += floors[i];
    }
  } else if (target >= counts.length) {
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
      const deficit = (weights[i] / totalWeight) * target - quotas[i];
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

function formatDay(t: number, lang: Lang): string {
  return new Date(t).toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** "Jul 5 – Jul 9" for a multi-day chapter spent in one place. */
function formatDayRange(t0: number, t1: number, lang: Lang): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const locale = lang === 'he' ? 'he-IL' : 'en-US';
  const a = new Date(t0).toLocaleDateString(locale, opts);
  const b = new Date(t1).toLocaleDateString(locale, opts);
  return `${a} – ${b}`;
}
