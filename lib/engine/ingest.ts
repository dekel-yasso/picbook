import exifr from 'exifr';
import { getDB } from './db';
import { fingerprint, type EngineEvent, type PhotoMeta } from './types';

const THUMB_MAX = 512;
// Small batches keep peak memory bounded: mobile Safari kills the tab around
// 1–1.5GB, and a single 48MP decode is ~192MB.
const BATCH = 2;

// The Ref tags are essential: without GPSLongitudeRef ("W" = negative), every
// western-hemisphere photo gets mirrored east (Boston → Kyrgyzstan).
const EXIF_TAGS = [
  'DateTimeOriginal',
  'CreateDate',
  'GPSLatitude',
  'GPSLongitude',
  'GPSLatitudeRef',
  'GPSLongitudeRef',
  'ExifImageWidth',
  'ExifImageHeight',
];

/** Bump when EXIF/GPS extraction improves; cached photos re-parse on re-import. */
const GPS_VERSION = 2;

export async function ingest(
  files: File[],
  tripId: string,
  emit: (e: EngineEvent) => void,
): Promise<void> {
  const db = await getDB();
  const total = files.length;
  let done = 0;
  let unsupported = 0;

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const metas = await Promise.all(batch.map((file) => ingestOne(file)));
    for (const meta of metas) {
      done++;
      if (meta.status === 'unsupported') unsupported++;
      emit({ type: 'photo', meta, done, total });
    }
  }
  emit({ type: 'ingest-done', done, total, unsupported });

  async function ingestOne(file: File): Promise<PhotoMeta> {
    const id = fingerprint(file);
    // Resumability: photos finished in a previous (possibly killed) session are skipped.
    const cached = await db.get('photos', id);
    if (cached) {
      // Re-importing into a different trip moves the photo there (a photo lives
      // in exactly one trip — the one it was most recently imported to).
      let dirty = (cached.tripId ?? 'default') !== tripId;
      if (dirty) cached.tripId = tripId;
      // Photos ingested by older GPS extraction re-parse EXIF (cheap — no
      // decode) so bad coordinates heal on re-import.
      if ((cached.gpsv ?? 1) < GPS_VERSION) {
        try {
          const exif = await exifr.parse(file, EXIF_TAGS);
          const dt: unknown = exif?.DateTimeOriginal ?? exif?.CreateDate;
          if (dt instanceof Date && !Number.isNaN(dt.getTime())) cached.takenAt = dt.getTime();
          if (typeof exif?.latitude === 'number' && typeof exif?.longitude === 'number') {
            cached.gps = { lat: exif.latitude, lon: exif.longitude };
          }
        } catch {
          // keep whatever we had
        }
        cached.gpsv = GPS_VERSION;
        dirty = true;
      }
      if (dirty) await db.put('photos', cached, id);
      return cached;
    }

    let takenAt: number | null = null;
    let gps: PhotoMeta['gps'] = null;
    // Decode-downscale hint: with the original dimensions known from EXIF, ask
    // the browser to decode straight to thumb size. A 48MP decode is ~190MB;
    // spikes like that are what get the tab killed on iOS mid-import.
    let decodeOpts: ImageBitmapOptions | undefined;
    try {
      const exif = await exifr.parse(file, EXIF_TAGS);
      if (exif) {
        const dt: unknown = exif.DateTimeOriginal ?? exif.CreateDate;
        if (dt instanceof Date && !Number.isNaN(dt.getTime())) takenAt = dt.getTime();
        if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
          gps = { lat: exif.latitude, lon: exif.longitude };
        }
        const ew = Number(exif.ExifImageWidth);
        const eh = Number(exif.ExifImageHeight);
        if (ew > 0 && eh > 0 && Math.max(ew, eh) > THUMB_MAX) {
          const s = THUMB_MAX / Math.max(ew, eh);
          decodeOpts = { resizeWidth: Math.round(ew * s), resizeQuality: 'medium' };
        }
      }
    } catch {
      // EXIF is best-effort; a photo without metadata is still a photo.
    }

    const base = {
      id,
      tripId,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      takenAt,
      gps,
      gpsv: GPS_VERSION,
      addedAt: Date.now(),
    };

    let meta: PhotoMeta;
    try {
      // Browsers that ignore the resize hint return the full bitmap; the
      // canvas step below downscales either way.
      const bitmap = decodeOpts
        ? await createImageBitmap(file, decodeOpts).catch(() => createImageBitmap(file))
        : await createImageBitmap(file);
      const scale = Math.min(1, THUMB_MAX / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const thumb = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      await db.put('thumbs', thumb, id);
      meta = { ...base, thumbWidth: w, thumbHeight: h, status: 'ready' };
    } catch {
      // Typically an undecodable format (e.g. HEIC on Chrome). Recorded so the
      // UI can report it instead of silently dropping photos.
      meta = { ...base, thumbWidth: 0, thumbHeight: 0, status: 'unsupported' };
    }
    await db.put('photos', meta, id);
    return meta;
  }
}
