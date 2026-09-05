import { describe, expect, it } from 'vitest';
import { distanceKm, mercator } from './geo';

describe('mercator', () => {
  it('maps the origin (0,0) to the center of the unit square', () => {
    const [x, y] = mercator(0, 0);
    expect(x).toBeCloseTo(0.5, 6);
    expect(y).toBeCloseTo(0.5, 6);
  });

  it('maps longitude linearly: +180 and -180 sit at the horizontal edges', () => {
    expect(mercator(0, -180)[0]).toBeCloseTo(0, 6);
    expect(mercator(0, 180)[0]).toBeCloseTo(1, 6);
  });

  it('maps higher latitude to a smaller y (further north = higher on the map)', () => {
    const [, ySouth] = mercator(-10, 0);
    const [, yNorth] = mercator(10, 0);
    expect(yNorth).toBeLessThan(ySouth);
  });

  it('clamps latitude beyond ±85 instead of blowing up (poles are undefined in Mercator)', () => {
    const clamped = mercator(85, 0);
    const beyond = mercator(89, 0);
    expect(beyond[1]).toBeCloseTo(clamped[1], 6);
    expect(Number.isFinite(beyond[1])).toBe(true);
  });
});

describe('distanceKm', () => {
  it('is zero for identical points', () => {
    expect(distanceKm({ lat: 40, lon: -74 }, { lat: 40, lon: -74 })).toBeCloseTo(0, 6);
  });

  it('is symmetric', () => {
    const a = { lat: 51.5074, lon: -0.1278 }; // London
    const b = { lat: 48.8566, lon: 2.3522 }; // Paris
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 6);
  });

  it('matches the known London–Paris great-circle distance (~344km)', () => {
    const london = { lat: 51.5074, lon: -0.1278 };
    const paris = { lat: 48.8566, lon: 2.3522 };
    expect(distanceKm(london, paris)).toBeGreaterThan(330);
    expect(distanceKm(london, paris)).toBeLessThan(360);
  });

  it('one degree of longitude at the equator is about 111km', () => {
    const d = distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(115);
  });
});
