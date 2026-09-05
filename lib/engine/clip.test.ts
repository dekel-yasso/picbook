import { describe, expect, it } from 'vitest';
import { dimsForAspect, pickFillPlan } from './clip';

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
