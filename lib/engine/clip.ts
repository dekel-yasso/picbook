// Trip clip: keepers → 1080×1080 silent .mp4, rendered frame-by-frame on an
// OffscreenCanvas (Ken Burns pan/zoom, crossfades, day-title cards) and
// encoded with the browser's hardware H.264 encoder (WebCodecs). All local.

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { planBook } from './book';
import { getDB } from './db';
import { distanceKm, drawMapFrame, loadLand, type GeoPoint } from './geo';
import { asBlob } from './images';
import type { ClipPlan, ClipSegment, ClipTransition, EngineEvent, PhotoMeta } from './types';

const SIZE = 1080;
const FPS = 30;
const PHOTO_S = 1.6;
const TITLE_S = 1.4;
const FADE_S = 0.4;
const BITRATE = 5_000_000;
// Enough resolution for 1080 output; renditions (2048px) downscale, thumbs upscale soft.
const DECODE_MAX = 1600;

// A day counts as "moved" when its median location shifts more than this.
const MOVE_KM = 25;

/** Reuses the book planner: same day structure, quotas, titles, and pins.
 *  With maps on, travel days get a flight-map segment before their title. */
export function planClip(
  keepers: PhotoMeta[],
  target: number,
  places?: Map<string, string>,
  pinnedIds?: Set<string>,
  lang?: import('../i18n-strings').Lang,
  withMaps = true,
): ClipPlan {
  const book = planBook(keepers, target, places, pinnedIds, lang);
  const byId = new Map(keepers.map((p) => [p.id, p]));
  const segments: ClipSegment[] = [];
  let photoCount = 0;
  let prevLoc: GeoPoint | null = null;
  let prevName: string | undefined;
  let isFirstLocated = true;

  for (const chapter of book.chapters) {
    const ids = [chapter.heroId, ...chapter.pages.flatMap((p) => p.photoIds)];
    const loc = medianLocation(ids.map((id) => byId.get(id)).filter((p): p is PhotoMeta => !!p));
    const name = places?.get(chapter.key);

    if (withMaps && loc) {
      if (isFirstLocated) {
        segments.push({ kind: 'map', from: null, to: loc, toName: name, duration: 2.6 });
        isFirstLocated = false;
      } else if (prevLoc && distanceKm(prevLoc, loc) > MOVE_KM) {
        const dist = distanceKm(prevLoc, loc);
        segments.push({
          kind: 'map',
          from: prevLoc,
          to: loc,
          fromName: prevName,
          toName: name,
          duration: 2.4 + Math.min(1.4, (dist / 4000) * 1.4),
        });
      }
      prevLoc = loc;
      prevName = name;
    }

    segments.push({ kind: 'title', text: chapter.title, sub: chapter.caption });
    for (const id of ids) {
      segments.push({ kind: 'photo', id });
      photoCount++;
    }
  }
  return { segments, photoCount };
}

function medianLocation(photos: PhotoMeta[]): GeoPoint | null {
  const pts = photos.filter((p) => p.gps);
  if (!pts.length) return null;
  const lats = pts.map((p) => p.gps!.lat).sort((a, b) => a - b);
  const lons = pts.map((p) => p.gps!.lon).sort((a, b) => a - b);
  return { lat: lats[Math.floor(lats.length / 2)], lon: lons[Math.floor(lons.length / 2)] };
}

function segSeconds(seg: ClipSegment): number {
  return seg.kind === 'title' ? TITLE_S : seg.kind === 'map' ? seg.duration : PHOTO_S;
}

export function clipSeconds(plan: ClipPlan): number {
  return Math.round(plan.segments.reduce((s, seg) => s + segSeconds(seg) - FADE_S, FADE_S));
}

interface Timed {
  seg: ClipSegment;
  start: number; // seconds
  duration: number;
}

export async function renderClip(
  plan: ClipPlan,
  files: Map<string, File>,
  emit: (e: EngineEvent) => void,
  audio?: { channels: Float32Array[]; sampleRate: number },
): Promise<Uint8Array> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('Video export needs a newer browser (WebCodecs is unavailable here)');
  }
  // Soundtrack only where the browser can AAC-encode; otherwise render silent.
  const soundtrack =
    audio && audio.channels.length > 0 && typeof AudioEncoder !== 'undefined' ? audio : null;
  const codec = await pickCodec();
  const db = await getDB();
  // Land silhouettes for map segments (cached after first fetch; null offline).
  const land = plan.segments.some((s) => s.kind === 'map') ? await loadLand() : null;

  // Timeline with FADE_S overlap between consecutive segments.
  const timeline: Timed[] = [];
  let clock = 0;
  for (const seg of plan.segments) {
    const duration = segSeconds(seg);
    timeline.push({ seg, start: clock, duration });
    clock += duration - FADE_S;
  }
  const totalSeconds = clock + FADE_S;
  const totalFrames = Math.ceil(totalSeconds * FPS);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: SIZE, height: SIZE },
    ...(soundtrack
      ? {
          audio: {
            codec: 'aac' as const,
            sampleRate: soundtrack.sampleRate,
            numberOfChannels: soundtrack.channels.length,
          },
        }
      : {}),
    fastStart: 'in-memory',
  });
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      throw e;
    },
  });
  encoder.configure({ codec, width: SIZE, height: SIZE, bitrate: BITRATE, framerate: FPS });

  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');

  // Keep at most two decoded photos alive (current + fading-in next).
  const bitmaps = new Map<number, ImageBitmap | null>();
  const ensureBitmap = async (idx: number) => {
    if (bitmaps.has(idx)) return;
    const seg = timeline[idx]?.seg;
    if (!seg || seg.kind !== 'photo') {
      bitmaps.set(idx, null);
      return;
    }
    const source =
      files.get(seg.id) ?? (await db.get('renditions', seg.id)) ?? (await db.get('thumbs', seg.id));
    if (!source) {
      bitmaps.set(idx, null);
      return;
    }
    try {
      const full = await createImageBitmap(asBlob(source));
      const scale = Math.min(1, DECODE_MAX / Math.max(full.width, full.height));
      if (scale < 1) {
        const small = await createImageBitmap(full, {
          resizeWidth: Math.round(full.width * scale),
        });
        full.close();
        bitmaps.set(idx, small);
      } else {
        bitmaps.set(idx, full);
      }
    } catch {
      bitmaps.set(idx, null);
    }
  };
  const dropBitmapsBefore = (idx: number) => {
    for (const [k, bmp] of bitmaps) {
      if (k < idx) {
        bmp?.close();
        bitmaps.delete(k);
      }
    }
  };

  const drawSegment = async (idx: number, t: number, alpha: number) => {
    const { seg, duration } = timeline[idx];
    ctx.globalAlpha = alpha;
    if (seg.kind === 'title') {
      drawTitleCard(ctx, seg);
    } else if (seg.kind === 'map') {
      drawMapFrame(ctx, SIZE, land, seg, Math.max(0, Math.min(1, t / duration)));
    } else {
      await ensureBitmap(idx);
      const bmp = bitmaps.get(idx);
      if (bmp) {
        const p = Math.min(1, t / duration);
        // Alternate zoom direction and pan drift per segment for variety.
        const zoomIn = idx % 2 === 0;
        const zoom = zoomIn ? 1.05 + 0.12 * p : 1.17 - 0.12 * p;
        const drift = 0.015 * (idx % 3 === 0 ? 1 : -1);
        drawCover(ctx, bmp, zoom, drift * p, drift * 0.6 * p);
      } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, SIZE, SIZE);
      }
    }
    ctx.globalAlpha = 1;
  };

  const style = plan.transition ?? 'mix';
  const MIX_ORDER: Exclude<ClipTransition, 'mix'>[] = ['fade', 'slide', 'zoom', 'wipe'];
  const ease = (x: number) => x * x * (3 - 2 * x); // smoothstep

  let active = 0;
  for (let f = 0; f < totalFrames; f++) {
    const time = f / FPS;
    while (active + 1 < timeline.length && time >= timeline[active].start + timeline[active].duration) {
      active++;
      dropBitmapsBefore(active);
    }
    const cur = timeline[active];
    const next = timeline[active + 1];

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (!next || time < next.start) {
      await drawSegment(active, time - cur.start, 1);
    } else {
      const p = Math.min(1, (time - next.start) / FADE_S);
      const kind = style === 'mix' ? MIX_ORDER[active % MIX_ORDER.length] : style;
      const e = ease(p);
      const tCur = time - cur.start;
      const tNext = time - next.start;
      switch (kind) {
        case 'slide': // push: both move left together
          ctx.save();
          ctx.translate(-e * SIZE, 0);
          await drawSegment(active, tCur, 1);
          ctx.restore();
          ctx.save();
          ctx.translate((1 - e) * SIZE, 0);
          await drawSegment(active + 1, tNext, 1);
          ctx.restore();
          break;
        case 'zoom': {
          // zoom-through: current grows toward the camera and dissolves
          await drawSegment(active + 1, tNext, 1);
          const s = 1 + 0.25 * e;
          ctx.save();
          ctx.translate(SIZE / 2, SIZE / 2);
          ctx.scale(s, s);
          ctx.translate(-SIZE / 2, -SIZE / 2);
          await drawSegment(active, tCur, 1 - e);
          ctx.restore();
          break;
        }
        case 'wipe': // next photo revealed left-to-right
          await drawSegment(active, tCur, 1);
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, e * SIZE, SIZE);
          ctx.clip();
          await drawSegment(active + 1, tNext, 1);
          ctx.restore();
          break;
        default: // fade
          await drawSegment(active, tCur, 1);
          await drawSegment(active + 1, tNext, p);
      }
    }

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((f * 1_000_000) / FPS),
      duration: Math.round(1_000_000 / FPS),
    });
    encoder.encode(frame, { keyFrame: f % (FPS * 2) === 0 });
    frame.close();

    // Backpressure: don't let encode queue balloon memory.
    while (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (f % 15 === 0 || f === totalFrames - 1) {
      emit({ type: 'clip-progress', done: f + 1, total: totalFrames });
    }
  }

  await encoder.flush();
  encoder.close();
  for (const bmp of bitmaps.values()) bmp?.close();

  // Soundtrack: loop/trim the PCM to the clip length with a fade-in/out,
  // AAC-encode, and let the muxer interleave it with the video track.
  if (soundtrack) {
    const { channels, sampleRate } = soundtrack;
    const ch = channels.length;
    const srcLen = channels[0].length;
    const total = Math.ceil(totalSeconds * sampleRate);
    const fadeIn = Math.round(0.3 * sampleRate);
    const fadeOut = Math.min(total, Math.round(1.5 * sampleRate));
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => {
        throw e;
      },
    });
    audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels: ch,
      bitrate: 128_000,
    });
    const CHUNK = 4800;
    for (let off = 0; off < total; off += CHUNK) {
      const n = Math.min(CHUNK, total - off);
      const data = new Float32Array(ch * n);
      for (let c = 0; c < ch; c++) {
        const src = channels[c];
        for (let i = 0; i < n; i++) {
          const gi = off + i;
          let v = src[gi % srcLen]; // loop if the clip outlasts the track
          if (gi < fadeIn) v *= gi / fadeIn;
          const fromEnd = total - gi;
          if (fromEnd < fadeOut) v *= fromEnd / fadeOut;
          data[c * n + i] = v;
        }
      }
      const frame = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: n,
        numberOfChannels: ch,
        timestamp: Math.round((off / sampleRate) * 1_000_000),
        data,
      });
      audioEncoder.encode(frame);
      frame.close();
    }
    await audioEncoder.flush();
    audioEncoder.close();
  }

  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}

async function pickCodec(): Promise<string> {
  const candidates = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];
  for (const codec of candidates) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec,
        width: SIZE,
        height: SIZE,
        bitrate: BITRATE,
        framerate: FPS,
      });
      if (supported) return codec;
    } catch {
      // try the next profile
    }
  }
  throw new Error('This browser cannot encode H.264 video');
}

function drawCover(
  ctx: OffscreenCanvasRenderingContext2D,
  bmp: ImageBitmap,
  zoom: number,
  panX: number,
  panY: number,
) {
  const scale = Math.max(SIZE / bmp.width, SIZE / bmp.height) * zoom;
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.drawImage(bmp, (SIZE - w) / 2 + panX * SIZE, (SIZE - h) / 2 + panY * SIZE, w, h);
}

function drawTitleCard(ctx: OffscreenCanvasRenderingContext2D, seg: { text: string; sub?: string }) {
  const g = ctx.createLinearGradient(0, 0, 0, SIZE);
  g.addColorStop(0, '#101418');
  g.addColorStop(1, '#1c2430');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#f5f5f4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Canvas applies proper bidi shaping natively, so Hebrew titles just work.
  ctx.font = '600 64px system-ui, sans-serif';
  ctx.fillText(seg.text, SIZE / 2, SIZE / 2 - (seg.sub ? 28 : 0), SIZE - 120);
  if (seg.sub) {
    ctx.fillStyle = 'rgba(245,245,244,0.65)';
    ctx.font = '400 34px system-ui, sans-serif';
    ctx.fillText(seg.sub, SIZE / 2, SIZE / 2 + 42, SIZE - 160);
  }
}
