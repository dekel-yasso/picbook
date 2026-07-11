// Shared image re-encoding: decode anything the browser can, optionally
// center-crop to a target aspect ratio (w/h), cap the long edge, re-encode as JPEG.

export async function toJpegBlob(blob: Blob, maxDim: number, cropAspect?: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (cropAspect && cropAspect > 0) {
    if (sw / sh > cropAspect) {
      const newSw = sh * cropAspect;
      sx = (sw - newSw) / 2;
      sw = newSw;
    } else {
      const newSh = sw / cropAspect;
      sy = (sh - newSh) / 2;
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
