// Shared image re-encoding: decode anything the browser can, optionally
// crop to a target aspect ratio (w/h), cap the long edge, re-encode as JPEG.

/** Normalized (0..1) region of the source image that a crop should keep in
 *  frame — the detected faces' union bbox, when there are any. */
export interface CropFocus {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function toJpegBlob(
  blob: Blob,
  maxDim: number,
  cropAspect?: number,
  focus?: CropFocus,
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (cropAspect && cropAspect > 0) {
    // Center the crop window on the focus region (if any) instead of the
    // frame's geometric center, then clamp to bounds — keeps faces from
    // being sliced off when the target aspect is narrower than the source.
    const fcx = focus ? (focus.x + focus.w / 2) * bitmap.width : sw / 2;
    const fcy = focus ? (focus.y + focus.h / 2) * bitmap.height : sh / 2;
    if (sw / sh > cropAspect) {
      const newSw = sh * cropAspect;
      sx = Math.min(Math.max(0, fcx - newSw / 2), sw - newSw);
      sw = newSw;
    } else {
      const newSh = sw / cropAspect;
      sy = Math.min(Math.max(0, fcy - newSh / 2), sh - newSh);
      sh = newSh;
    }
  }
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

/** Long edge of stored keeper renditions — enough for an 8in print page. */
export const RENDITION_MAX = 2048;

/**
 * Thumbs may be stored as Blobs (native ingest) or raw ArrayBuffers (backup
 * import — iOS WebKit's IndexedDB is unreliable with batched Blob writes).
 */
export function asBlob(value: Blob | ArrayBuffer): Blob {
  return value instanceof Blob ? value : new Blob([value], { type: 'image/jpeg' });
}
