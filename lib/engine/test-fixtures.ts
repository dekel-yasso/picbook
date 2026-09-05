import type { PhotoMeta } from './types';

/** Minimal valid PhotoMeta for engine unit tests, with sane overridable defaults. */
export function makePhoto(overrides: Partial<PhotoMeta> & { id: string; takenAt: number }): PhotoMeta {
  return {
    name: `${overrides.id}.jpg`,
    size: 1_000_000,
    lastModified: overrides.takenAt,
    gps: null,
    thumbWidth: 512,
    thumbHeight: 512,
    status: 'ready',
    addedAt: overrides.takenAt,
    sharpness: 0.5,
    exposure: 0.5,
    ...overrides,
  };
}
