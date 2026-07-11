// Per-photo visual features, computed from the cached 512px thumbnail.
// All classical CV — no models, no network.

/** Bump when the algorithms below change; analyze re-runs on photos with an older version. */
export const FEATURES_VERSION = 2;

export interface Features {
  /** 64-bit dHash as 16 hex chars. */
  phash: string;
  /** Variance of Laplacian; higher = sharper. Comparable across photos because all thumbs share a max dimension. */
  sharpness: number;
  /** 0..1; penalizes clipped highlights/shadows and off-center mean brightness. */
  exposure: number;
  featv: number;
}

export async function computeFeatures(thumb: Blob): Promise<Features> {
  const bitmap = await createImageBitmap(thumb);
  const { width, height } = bitmap;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);

  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4;
    gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }

  bitmap.close();

  return {
    phash: dHash(gray, width, height),
    sharpness: centerWeightedSharpness(gray, width, height),
    exposure: exposureScore(gray),
    featv: FEATURES_VERSION,
  };
}

// The subject is usually near the center; whole-frame Laplacian variance
// rewards busy backgrounds instead. Weight the central 60% region heavily.
function centerWeightedSharpness(g: Float32Array, w: number, h: number): number {
  const full = varianceOfLaplacian(g, w, h, 1, 1, w - 1, h - 1);
  const cx0 = Math.max(1, Math.round(w * 0.2));
  const cy0 = Math.max(1, Math.round(h * 0.2));
  const cx1 = Math.min(w - 1, Math.round(w * 0.8));
  const cy1 = Math.min(h - 1, Math.round(h * 0.8));
  const center = varianceOfLaplacian(g, w, h, cx0, cy0, cx1, cy1);
  return 0.65 * center + 0.35 * full;
}

/** Dot product of two L2-normalized embeddings = cosine similarity. */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Hamming distance between two dHash hex strings (0..64). */
export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let d = 0;
  while (x) {
    d += Number(x & 1n);
    x >>= 1n;
  }
  return d;
}

// dHash over a box-averaged 9x8 grid. Averaging every source pixel (rather
// than drawImage's single-step downscale) keeps the hash stable under blur
// and noise, so burst shots of the same scene hash close together. The dead
// zone keeps low-contrast comparisons (flat sky, smooth gradients) from
// becoming noise-driven coin flips: a bit is set only on a meaningful step.
const DHASH_DEAD_ZONE = 2;

function dHash(g: Float32Array, w: number, h: number): string {
  const grid = boxResize(g, w, h, 9, 8);
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const step = grid[y * 9 + x] - grid[y * 9 + x + 1];
      bits = (bits << 1n) | (step > DHASH_DEAD_ZONE ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function boxResize(g: Float32Array, w: number, h: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) sum += g[y * w + x];
      }
      out[ty * tw + tx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function varianceOfLaplacian(
  g: Float32Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function exposureScore(gray: Float32Array): number {
  let low = 0;
  let high = 0;
  let sum = 0;
  for (const v of gray) {
    if (v <= 8) low++;
    else if (v >= 247) high++;
    sum += v;
  }
  const n = gray.length;
  const clipPenalty = Math.min(1, (low / n) * 4) * 0.5 + Math.min(1, (high / n) * 4) * 0.5;
  const meanPenalty = Math.min(1, Math.abs(sum / n / 255 - 0.45) * 2);
  return Math.max(0, 1 - 0.6 * clipPenalty - 0.4 * meanPenalty);
}
