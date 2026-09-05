import { describe, expect, it } from 'vitest';
import { dot, hamming } from './features';

describe('dot', () => {
  it('returns 1 for identical unit vectors', () => {
    expect(dot([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(dot([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(dot([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
});

describe('hamming', () => {
  it('is zero for identical hashes', () => {
    expect(hamming('ff00ff00ff00ff00', 'ff00ff00ff00ff00')).toBe(0);
  });

  it('counts differing bits', () => {
    // 0x0 vs 0x1 differ in exactly 1 bit.
    expect(hamming('0000000000000000', '0000000000000001')).toBe(1);
    // 0x0 vs 0xf differ in 4 bits.
    expect(hamming('0000000000000000', '000000000000000f')).toBe(4);
  });

  it('is symmetric', () => {
    const a = 'a1b2c3d4e5f60718';
    const b = '0011223344556677';
    expect(hamming(a, b)).toBe(hamming(b, a));
  });

  it('is at most 64 for full 64-bit hashes', () => {
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });
});
