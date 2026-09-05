import { describe, expect, it } from 'vitest';
import { clusterPhotos, isKeeper, takenTime } from './cluster';
import { makePhoto } from './test-fixtures';

describe('takenTime', () => {
  it('prefers takenAt over lastModified', () => {
    const p = makePhoto({ id: 'a', takenAt: 100, lastModified: 999 });
    expect(takenTime(p)).toBe(100);
  });

  it('falls back to lastModified when takenAt is null', () => {
    const p = makePhoto({ id: 'a', takenAt: 100 });
    p.takenAt = null;
    p.lastModified = 999;
    expect(takenTime(p)).toBe(999);
  });
});

describe('clusterPhotos', () => {
  it('keeps far-apart photos as singleton clusters', () => {
    const photos = [
      makePhoto({ id: 'a', takenAt: 0 }),
      makePhoto({ id: 'b', takenAt: 60 * 60 * 1000 }), // 1 hour later
      makePhoto({ id: 'c', takenAt: 2 * 60 * 60 * 1000 }),
    ];
    const clusters = clusterPhotos(photos);
    expect(clusters).toHaveLength(3);
    for (const c of clusters) expect(c.photos).toHaveLength(1);
  });

  it('groups photos taken within the burst gap into one cluster', () => {
    const photos = [
      makePhoto({ id: 'a', takenAt: 0 }),
      makePhoto({ id: 'b', takenAt: 5_000 }),
      makePhoto({ id: 'c', takenAt: 10_000 }),
    ];
    const clusters = clusterPhotos(photos);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].photos.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('splits a time-burst into separate subclusters when hashes diverge', () => {
    // Two photos of one subject (identical hash) shot back-to-back with the
    // camera then swung to something completely different (inverted hash).
    const photos = [
      makePhoto({ id: 'a', takenAt: 0, phash: '0000000000000000' }),
      makePhoto({ id: 'b', takenAt: 1_000, phash: '0000000000000000' }),
      makePhoto({ id: 'c', takenAt: 2_000, phash: 'ffffffffffffffff' }),
    ];
    const clusters = clusterPhotos(photos);
    expect(clusters).toHaveLength(2);
  });

  it('excludes unsupported photos', () => {
    const photos = [makePhoto({ id: 'a', takenAt: 0, status: 'unsupported' })];
    expect(clusterPhotos(photos)).toHaveLength(0);
  });

  it('picks the sharper, better-exposed photo as bestId within a burst', () => {
    const photos = [
      makePhoto({ id: 'blurry', takenAt: 0, sharpness: 0.1, exposure: 0.5 }),
      makePhoto({ id: 'sharp', takenAt: 1_000, sharpness: 0.9, exposure: 0.5 }),
    ];
    const [cluster] = clusterPhotos(photos);
    expect(cluster.bestId).toBe('sharp');
  });

  it('prefers open eyes when sharpness is a tie once a burst contains people', () => {
    // pickBest rank-normalizes sharpness within the cluster, so equal
    // sharpness cancels that term out entirely and the face score decides.
    const photos = [
      makePhoto({ id: 'eyes-closed', takenAt: 0, sharpness: 0.7, faces: { n: 1, eyesOpen: 0 } }),
      makePhoto({ id: 'eyes-open', takenAt: 1_000, sharpness: 0.7, faces: { n: 1, eyesOpen: 1 } }),
    ];
    const [cluster] = clusterPhotos(photos);
    expect(cluster.bestId).toBe('eyes-open');
  });
});

describe('isKeeper', () => {
  const photos = [makePhoto({ id: 'a', takenAt: 0 }), makePhoto({ id: 'b', takenAt: 1_000 })];
  const [cluster] = clusterPhotos(photos);

  it('treats an explicit "keep" or "book" decision as a keeper regardless of cluster', () => {
    const decisions = new Map([['a', 'keep' as const]]);
    expect(isKeeper(photos[0], cluster, decisions)).toBe(true);
  });

  it('treats an explicit "reject" decision as not a keeper even if it is the best pick', () => {
    const decisions = new Map([[cluster.bestId, 'reject' as const]]);
    const best = photos.find((p) => p.id === cluster.bestId)!;
    expect(isKeeper(best, cluster, decisions)).toBe(false);
  });

  it('defaults to the cluster best-pick when there is no explicit decision', () => {
    const best = photos.find((p) => p.id === cluster.bestId)!;
    const other = photos.find((p) => p.id !== cluster.bestId)!;
    expect(isKeeper(best, cluster, new Map())).toBe(true);
    expect(isKeeper(other, cluster, new Map())).toBe(false);
  });
});
