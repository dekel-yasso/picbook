import { describe, expect, it } from 'vitest';
import { clipSecondsExact, dimsForAspect, pickFillPlan, planPhotosOnly } from './clip';
import { clipTiming, DEFAULT_FADE_S, DEFAULT_PHOTO_S } from './clip-timing';
import { makePhoto } from './test-fixtures';

describe('planPhotosOnly', () => {
  it('includes every photo, with no title or map segments', () => {
    const photos = Array.from({ length: 7 }, (_, i) => makePhoto({ id: `p${i}`, takenAt: 0, name: `IMG_${i}.jpg` }));
    const plan = planPhotosOnly(photos);
    expect(plan.photoCount).toBe(7);
    expect(plan.segments).toHaveLength(7);
    expect(plan.segments.every((s) => s.kind === 'photo')).toBe(true);
  });

  it('orders by filename with natural numeric sort (IMG_2 before IMG_10)', () => {
    const photos = [
      makePhoto({ id: 'ten', takenAt: 0, name: 'IMG_10.jpg' }),
      makePhoto({ id: 'two', takenAt: 0, name: 'IMG_2.jpg' }),
      makePhoto({ id: 'one', takenAt: 0, name: 'IMG_1.jpg' }),
    ];
    const ids = planPhotosOnly(photos).segments.map((s) => (s.kind === 'photo' ? s.id : ''));
    expect(ids).toEqual(['one', 'two', 'ten']);
  });

  it('ignores dates entirely — a later-taken file still sorts by its name', () => {
    const photos = [
      makePhoto({ id: 'b', takenAt: 1_000, name: 'b.jpg' }),
      makePhoto({ id: 'a', takenAt: 9_999_999, name: 'a.jpg' }),
    ];
    const ids = planPhotosOnly(photos).segments.map((s) => (s.kind === 'photo' ? s.id : ''));
    expect(ids).toEqual(['a', 'b']);
  });
});

describe('clipTiming', () => {
  it('falls back to the defaults when the plan sets nothing', () => {
    expect(clipTiming({})).toEqual({ photoS: DEFAULT_PHOTO_S, fadeS: DEFAULT_FADE_S });
  });

  it('honors user-set photo and fade seconds within range', () => {
    expect(clipTiming({ photoSeconds: 3, fadeSeconds: 1 })).toEqual({ photoS: 3, fadeS: 1 });
  });

  it('caps the fade well below the photo time so segments never overlap fully', () => {
    const { photoS, fadeS } = clipTiming({ photoSeconds: 1, fadeSeconds: 1.5 });
    expect(fadeS).toBeLessThan(photoS);
  });

  it('clamps out-of-range and non-finite values instead of passing them through', () => {
    expect(clipTiming({ photoSeconds: 999 }).photoS).toBeLessThanOrEqual(6);
    expect(clipTiming({ photoSeconds: NaN }).photoS).toBeGreaterThan(0);
  });
});

describe('clipSecondsExact', () => {
  it('grows with a longer photo time and shrinks with a longer crossfade', () => {
    const plan = planPhotosOnly(Array.from({ length: 5 }, (_, i) => makePhoto({ id: `p${i}`, takenAt: 0 })));
    const base = clipSecondsExact(plan);
    expect(clipSecondsExact({ ...plan, photoSeconds: 3 })).toBeGreaterThan(base);
    expect(clipSecondsExact({ ...plan, fadeSeconds: 1 })).toBeLessThan(base);
  });
});

describe('dimsForAspect', () => {
  it('defaults to a 1080x1080 square', () => {
    expect(dimsForAspect()).toEqual({ width: 1080, height: 1080 });
    expect(dimsForAspect('square')).toEqual({ width: 1080, height: 1080 });
  });

  it('keeps the short side at 1080 for wide and tall', () => {
    expect(dimsForAspect('wide')).toEqual({ width: 1920, height: 1080 });
    expect(dimsForAspect('tall')).toEqual({ width: 1080, height: 1920 });
  });
});

describe('pickFillPlan', () => {
  it('always covers for the square frame shape, regardless of photo orientation', () => {
    // A tall portrait photo into a square frame would otherwise have real slack.
    expect(pickFillPlan('square', 100, 300, 1080, 1080, 'photo-1')).toEqual({ mode: 'cover' });
  });

  it('covers when the photo is a close-enough aspect match (small slack)', () => {
    // A 16:10 photo into a 16:9 wide frame — barely any leftover space.
    const plan = pickFillPlan('wide', 1600, 1000, 1920, 1080, 'photo-1');
    expect(plan.mode).toBe('cover');
  });

  it('picks a travel or repeat treatment for a true orientation mismatch', () => {
    // A tall portrait photo into a wide 16:9 frame — the extreme case.
    const plan = pickFillPlan('wide', 1080, 1920, 1920, 1080, 'photo-1');
    expect(['travel', 'repeat']).toContain(plan.mode);
    expect(plan.axis).toBe('x');
  });

  it('picks the leftover axis matching the frame/photo mismatch direction', () => {
    // A wide landscape photo into a tall 9:16 frame — leftover is on the y axis.
    const plan = pickFillPlan('tall', 1920, 1080, 1080, 1920, 'photo-1');
    expect(plan.axis).toBe('y');
  });

  it('is deterministic for the same seed key (stable across re-renders)', () => {
    const a = pickFillPlan('wide', 1080, 1920, 1920, 1080, 'same-photo-id');
    const b = pickFillPlan('wide', 1080, 1920, 1920, 1080, 'same-photo-id');
    expect(a).toEqual(b);
  });

  it('can produce both travel and repeat across different seed keys', () => {
    const modes = new Set(
      Array.from({ length: 20 }, (_, i) => pickFillPlan('wide', 1080, 1920, 1920, 1080, `photo-${i}`).mode),
    );
    expect(modes.has('travel')).toBe(true);
    expect(modes.has('repeat')).toBe(true);
  });
});
