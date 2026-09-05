import { describe, expect, it } from 'vitest';
import { applyBookOverrides, planBook } from './book';
import { makePhoto } from './test-fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** `count` photos spread an hour apart, starting at `dayIndex` days from epoch. */
function dayOfPhotos(dayIndex: number, count: number, prefix = `d${dayIndex}`): ReturnType<typeof makePhoto>[] {
  return Array.from({ length: count }, (_, i) =>
    makePhoto({ id: `${prefix}-${i}`, takenAt: dayIndex * DAY_MS + i * HOUR_MS }),
  );
}

describe('planBook', () => {
  it('groups photos into one chapter per day', () => {
    const photos = [...dayOfPhotos(0, 5), ...dayOfPhotos(1, 5), ...dayOfPhotos(2, 5)];
    const plan = planBook(photos, 12);
    expect(plan.chapters).toHaveLength(3);
  });

  it('never exceeds the requested target', () => {
    const photos = [...dayOfPhotos(0, 20), ...dayOfPhotos(1, 20), ...dayOfPhotos(2, 20)];
    for (const target of [3, 8, 15, 30]) {
      const plan = planBook(photos, target);
      expect(plan.photoCount).toBeLessThanOrEqual(target);
    }
  });

  it('gives every day at least one photo when the budget allows it', () => {
    // 6 days, plenty of photos each, generous target — no day should be starved.
    const photos = [0, 1, 2, 3, 4, 5].flatMap((d) => dayOfPhotos(d, 10));
    const plan = planBook(photos, 24);
    expect(plan.chapters).toHaveLength(6);
    for (const c of plan.chapters) {
      const count = 1 + c.pages.reduce((n, p) => n + p.photoIds.length, 0);
      expect(count).toBeGreaterThan(0);
    }
  });

  it('always includes pinned photos even on a zero-quota day', () => {
    // A lightly-photographed day that would normally get quota 0 under a tiny target...
    const busyDay = dayOfPhotos(0, 50);
    const quietDay = dayOfPhotos(1, 1);
    const pinnedId = quietDay[0].id;
    const plan = planBook([...busyDay, ...quietDay], 3, undefined, new Set([pinnedId]));
    const allIds = plan.chapters.flatMap((c) => [c.heroId, ...c.pages.flatMap((p) => p.photoIds)]);
    expect(allIds).toContain(pinnedId);
  });

  it('never selects more photos for a day than it has', () => {
    const photos = dayOfPhotos(0, 2);
    const plan = planBook(photos, 100);
    expect(plan.photoCount).toBe(2);
  });

  it('paginates in groups of at most 4 and avoids a lonely last page', () => {
    // 9 non-hero photos: naive chunks of 4 would end 4/4/1 — the orphan should
    // be pulled from the previous page instead, giving 4/3/2.
    const photos = dayOfPhotos(0, 10);
    const plan = planBook(photos, 10);
    const pages = plan.chapters[0].pages;
    for (const p of pages) expect(p.photoIds.length).toBeLessThanOrEqual(4);
    expect(pages[pages.length - 1].photoIds.length).not.toBe(1);
  });

  it('merges consecutive same-place days into a date-range chapter when the budget is tight', () => {
    // 10 days in the same city; a small target can't afford each day's floor,
    // so they should collapse into one chapter instead of 10 starved ones.
    const photos = Array.from({ length: 10 }, (_, d) => dayOfPhotos(d, 3)).flat();
    const places = new Map(Array.from({ length: 10 }, (_, d) => [new Date(d * DAY_MS).toDateString(), 'Paris']));
    const plan = planBook(photos, 8, places);
    expect(plan.chapters).toHaveLength(1);
    expect(plan.chapters[0].title).toContain('Paris');
  });

  it('keeps one chapter per day for a short trip even if every day shares a place', () => {
    const photos = [...dayOfPhotos(0, 10), ...dayOfPhotos(1, 10)];
    const places = new Map([
      [new Date(0).toDateString(), 'Rome'],
      [new Date(DAY_MS).toDateString(), 'Rome'],
    ]);
    // Generous target: both days can afford their floor, so no merge is needed.
    const plan = planBook(photos, 20, places);
    expect(plan.chapters).toHaveLength(2);
  });

  it('titles Hebrew chapters with the Hebrew day word', () => {
    const plan = planBook(dayOfPhotos(0, 5), 5, undefined, undefined, 'he');
    expect(plan.chapters[0].title).toContain('יום');
  });
});

describe('applyBookOverrides', () => {
  it('returns the same plan when there are no overrides', () => {
    const plan = planBook(dayOfPhotos(0, 5), 5);
    expect(applyBookOverrides(plan, {})).toBe(plan);
  });

  it('swaps the hero photo at slot 0', () => {
    const plan = planBook(dayOfPhotos(0, 5), 5);
    const chapterKey = plan.chapters[0].key;
    const originalHero = plan.chapters[0].heroId;
    const replacement = 'swapped-in-photo';
    const next = applyBookOverrides(plan, { [`${chapterKey}:0`]: replacement });
    expect(next.chapters[0].heroId).toBe(replacement);
    expect(next.chapters[0].heroId).not.toBe(originalHero);
  });

  it('ignores an override for a slot that no longer exists', () => {
    const plan = planBook(dayOfPhotos(0, 5), 5);
    const chapterKey = plan.chapters[0].key;
    const next = applyBookOverrides(plan, { [`${chapterKey}:999`]: 'nope' });
    expect(next.chapters[0]).toEqual(plan.chapters[0]);
  });
});
