// Trip clip: keepers → 1080×1080 silent .mp4, rendered frame-by-frame on an
// OffscreenCanvas (Ken Burns pan/zoom, crossfades, day-title cards) and
// encoded with the browser's hardware H.264 encoder (WebCodecs). All local.

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { planBook } from './book';
import { getDB } from './db';
import { distanceKm, drawMapFrame, loadLand, type GeoPoint } from './geo';
import { asBlob } from './images';
import type { ClipAspect, ClipPlan, ClipSegment, ClipTransition, EngineEvent, PhotoMeta } from './types';

const FPS = 30;
const PHOTO_S = 1.6;
const TITLE_S = 1.4;
const FADE_S = 0.4;
const BITRATE = 5_000_000;
// Enough resolution for 1080 output; renditions (2048px) downscale, thumbs upscale soft.
const DECODE_MAX = 1600;

/** Output pixel dimensions per frame shape. The shorter side is always 1080,
 *  so every layout constant tuned against the old square SIZE (margins, font
 *  sizes) still reads correctly — only the long axis grows. */
function dimsForAspect(aspect: ClipAspect = 'square'): { width: number; height: number } {
  switch (aspect) {
    case 'wide':
      return { width: 1920, height: 1080 };
    case 'tall':
      return { width: 1080, height: 1920 };
    default:
      return { width: 1080, height: 1080 };
  }
}

/** A photo whose orientation doesn't match the frame (a portrait shot in a
 *  wide frame, or the reverse) gets a different treatment than a normal
 *  cover-crop + Ken Burns pan — see pickFillPlan. */
interface FillPlan {
  mode: 'cover' | 'travel' | 'repeat';
  axis?: 'x' | 'y';
}

// Below this fraction of leftover space, a mismatch isn't worth a special
// treatment — just cover-crop it like anything else. This is the same
// fraction a normal cover-crop would lose off the photo (e.g. a common 3:2
// photo loses ~16% cropped into 16:9 — unremarkable; a 4:3 photo loses 25%,
// worth the fill treatment; a true portrait/landscape flip loses 55%+).
const MISMATCH_SLACK = 0.2;

function pickFillPlan(aspect: ClipAspect, bmpW: number, bmpH: number, width: number, height: number, seedKey: string): FillPlan {
  // Square keeps its original, already-shipped cover-crop behavior — this
  // treatment only kicks in for the new wide/tall frame shapes.
  if (aspect === 'square') return { mode: 'cover' };
  const scale = Math.min(width / bmpW, height / bmpH);
  const w = bmpW * scale;
  const h = bmpH * scale;
  const leftoverX = (width - w) / width;
  const leftoverY = (height - h) / height;
  const slack = Math.max(leftoverX, leftoverY);
  if (slack < MISMATCH_SLACK) return { mode: 'cover' };
  const axis = leftoverX > leftoverY ? 'x' : 'y';
  // Deterministic per-photo pick (stable across re-renders) instead of a
  // fresh Math.random() call, so "Re-render" doesn't reshuffle the look.
  let hash = 0;
  for (let i = 0; i < seedKey.length; i++) hash = (hash * 31 + seedKey.charCodeAt(i)) | 0;
  return { mode: (hash & 1) === 0 ? 'travel' : 'repeat', axis };
}

// A day counts as "moved" when its median location shifts more than this.
const MOVE_KM = 25;

const ease = (x: number) => x * x * (3 - 2 * x); // smoothstep

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
  return seg.kind === 'title' ? TITLE_S : seg.kind === 'map' ? seg.duration : (seg.s ?? PHOTO_S);
}

export function clipSeconds(plan: ClipPlan): number {
  return Math.round(clipSecondsExact(plan));
}

/** Unrounded duration — the soundtrack is encoded to this, so its fade-out
 *  ends exactly with the video even after beat-sync nudges the cuts. */
export function clipSecondsExact(plan: ClipPlan): number {
  return plan.segments.reduce((s, seg) => s + segSeconds(seg) - FADE_S, FADE_S);
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
  sound?: import('./audio').EncodedSound,
): Promise<Uint8Array> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('Video export needs a newer browser (WebCodecs is unavailable here)');
  }
  const { width, height } = dimsForAspect(plan.aspect);
  const soundtrack = sound && sound.chunks.length > 0 ? sound : null;
  const codec = await pickCodec(width, height);
  const db = await getDB();
  // Land silhouettes for map segments (cached after first fetch; null offline).
  const land = plan.segments.some((s) => s.kind === 'map') ? await loadLand() : null;
  // Face boxes, so Ken Burns pans/zooms don't slice faces off-frame.
  const metas = new Map<string, PhotoMeta>();
  for (const p of await db.getAll('photos')) metas.set(p.id, p);

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
    video: { codec: 'avc', width, height },
    ...(soundtrack
      ? {
          audio: {
            codec: 'aac' as const,
            sampleRate: soundtrack.sampleRate,
            numberOfChannels: soundtrack.numberOfChannels,
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
  encoder.configure({ codec, width, height, bitrate: BITRATE, framerate: FPS });

  const canvas = new OffscreenCanvas(width, height);
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
      drawTitleCard(ctx, width, height, seg);
    } else if (seg.kind === 'map') {
      drawMapFrame(ctx, width, height, land, seg, Math.max(0, Math.min(1, t / duration)));
    } else {
      await ensureBitmap(idx);
      const bmp = bitmaps.get(idx);
      if (bmp) {
        const p = Math.min(1, t / duration);
        const fill = pickFillPlan(plan.aspect ?? 'square', bmp.width, bmp.height, width, height, seg.id);
        if (fill.mode === 'travel') {
          drawTravel(ctx, bmp, width, height, fill.axis!, p, idx % 2 === 1);
        } else if (fill.mode === 'repeat') {
          drawRepeat(ctx, bmp, width, height, fill.axis!, p);
        } else {
          // Alternate zoom direction and pan drift per segment for variety.
          const zoomIn = idx % 2 === 0;
          const zoom = zoomIn ? 1.05 + 0.12 * p : 1.17 - 0.12 * p;
          const drift = 0.015 * (idx % 3 === 0 ? 1 : -1);
          drawCover(ctx, bmp, width, height, zoom, drift * p, drift * 0.6 * p, metas.get(seg.id)?.faceBox);
        }
      } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, width, height);
      }
    }
    ctx.globalAlpha = 1;
  };

  const style = plan.transition ?? 'mix';
  const MIX_ORDER: Exclude<ClipTransition, 'mix'>[] = ['fade', 'slide', 'zoom', 'wipe'];

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
    ctx.fillRect(0, 0, width, height);
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
          ctx.translate(-e * width, 0);
          await drawSegment(active, tCur, 1);
          ctx.restore();
          ctx.save();
          ctx.translate((1 - e) * width, 0);
          await drawSegment(active + 1, tNext, 1);
          ctx.restore();
          break;
        case 'zoom': {
          // zoom-through: current grows toward the camera and dissolves
          await drawSegment(active + 1, tNext, 1);
          const s = 1 + 0.25 * e;
          ctx.save();
          ctx.translate(width / 2, height / 2);
          ctx.scale(s, s);
          ctx.translate(-width / 2, -height / 2);
          await drawSegment(active, tCur, 1 - e);
          ctx.restore();
          break;
        }
        case 'wipe': // next photo revealed left-to-right
          await drawSegment(active, tCur, 1);
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, e * width, height);
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

  // Soundtrack: chunks were AAC-encoded on the main thread; just mux them.
  if (soundtrack) {
    const meta: EncodedAudioChunkMetadata = {
      decoderConfig: {
        codec: 'mp4a.40.2',
        sampleRate: soundtrack.sampleRate,
        numberOfChannels: soundtrack.numberOfChannels,
        ...(soundtrack.description ? { description: soundtrack.description } : {}),
      },
    };
    // Drop any audio past the video's end (the last AAC frame can overshoot).
    const limit = totalSeconds * 1_000_000;
    let first = true;
    for (const chunk of soundtrack.chunks) {
      if (chunk.timestamp > limit) break;
      muxer.addAudioChunkRaw(chunk.data, chunk.type, chunk.timestamp, chunk.duration, first ? meta : undefined);
      first = false;
    }
  }

  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}

async function pickCodec(width: number, height: number): Promise<string> {
  const candidates = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];
  for (const codec of candidates) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
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
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
  focus?: PhotoMeta['faceBox'],
) {
  const scale = Math.max(width / bmp.width, height / bmp.height) * zoom;
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  // Center the cover-fit on the focus region (if any), clamped so the image
  // still fully covers the frame — keeps faces from sliding off-canvas.
  let ox = (width - w) / 2;
  let oy = (height - h) / 2;
  if (focus) {
    const fx = (focus.x + focus.w / 2) * w;
    const fy = (focus.y + focus.h / 2) * h;
    ox = Math.min(0, Math.max(width - w, width / 2 - fx));
    oy = Math.min(0, Math.max(height - h, height / 2 - fy));
  }
  ctx.drawImage(bmp, ox + panX * width, oy + panY * height, w, h);
}

/** Whole, uncropped photo sized to fill the constrained axis — used by both
 *  travel and repeat so neither ever crops a mismatched photo. */
function containSize(bmp: ImageBitmap, width: number, height: number) {
  const scale = Math.min(width / bmp.width, height / bmp.height);
  return { w: bmp.width * scale, h: bmp.height * scale, scale };
}

/** Fills the whole frame with a blurred, darkened, zoomed-in cover-crop of
 *  the same photo, standing in for flat black behind travel/repeat — keeps
 *  the leftover space from reading as empty without competing for attention
 *  with the sharp foreground print. */
function drawBlurredBackdrop(ctx: OffscreenCanvasRenderingContext2D, bmp: ImageBitmap, width: number, height: number) {
  // Extra zoom hides the softened edges a blur would otherwise leave visible
  // at the frame border.
  const scale = Math.max(width / bmp.width, height / bmp.height) * 1.15;
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  const blur = Math.round(Math.min(width, height) * 0.045);
  ctx.save();
  ctx.filter = `blur(${blur}px) brightness(0.5) saturate(1.05)`;
  ctx.drawImage(bmp, (width - w) / 2, (height - h) / 2, w, h);
  ctx.restore();
}

/** The whole photo glides once from one edge of the leftover axis to the
 *  other over the segment's duration — no cropping, nothing duplicated. */
function drawTravel(
  ctx: OffscreenCanvasRenderingContext2D,
  bmp: ImageBitmap,
  width: number,
  height: number,
  axis: 'x' | 'y',
  p: number,
  reverse: boolean,
) {
  drawBlurredBackdrop(ctx, bmp, width, height);
  const { w, h } = containSize(bmp, width, height);
  const e = ease(reverse ? 1 - p : p);
  if (axis === 'x') {
    const inset = width * 0.03;
    const x = inset + (width - w - inset * 2) * e;
    ctx.drawImage(bmp, x, (height - h) / 2, w, h);
  } else {
    const inset = height * 0.03;
    const y = inset + (height - h - inset * 2) * e;
    ctx.drawImage(bmp, (width - w) / 2, y, w, h);
  }
}

/** The same whole photo pops in twice, anchored at the two ends of the
 *  leftover axis, staggered — fills the frame with rhythm instead of motion. */
function drawRepeat(
  ctx: OffscreenCanvasRenderingContext2D,
  bmp: ImageBitmap,
  width: number,
  height: number,
  axis: 'x' | 'y',
  p: number,
) {
  drawBlurredBackdrop(ctx, bmp, width, height);
  const { w, h } = containSize(bmp, width, height);
  const popIn = (amt: number) => Math.max(0, Math.min(1, amt));
  const popA = ease(popIn(p / 0.18));
  const popB = ease(popIn((p - 0.3) / 0.18));

  const drawCopy = (amt: number, atEnd: boolean) => {
    if (amt <= 0) return;
    let x: number;
    let y: number;
    if (axis === 'x') {
      const inset = width * 0.03;
      x = atEnd ? width - w - inset : inset;
      y = (height - h) / 2;
    } else {
      const inset = height * 0.03;
      x = (width - w) / 2;
      y = atEnd ? height - h - inset : inset;
    }
    const s = 0.88 + 0.12 * amt;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.save();
    ctx.globalAlpha *= amt;
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
    ctx.drawImage(bmp, x, y, w, h);
    ctx.restore();
  };
  drawCopy(popA, false);
  drawCopy(popB, true);
}

function drawTitleCard(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  seg: { text: string; sub?: string },
) {
  // Modernist poster card: solid navy field, flush-start white title under a
  // short underline bar, uppercase sub-line — mirrors flush-start for Hebrew.
  // Margins/font sizes are tuned to the 1080 short side, so they read the
  // same in square and tall; wide just gives the text more room to breathe.
  ctx.fillStyle = '#1f3d5c';
  ctx.fillRect(0, 0, width, height);

  const isRtl = /[֐-׿]/.test(seg.text);
  const margin = 96;
  const x = isRtl ? width - margin : margin;
  const maxWidth = width - margin * 2;
  ctx.textAlign = isRtl ? 'right' : 'left';
  ctx.textBaseline = 'middle';

  const barW = 64;
  const barY = height / 2 - (seg.sub ? 86 : 66);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(isRtl ? x - barW : x, barY, barW, 5);

  ctx.fillStyle = '#ffffff';
  // Canvas applies proper bidi shaping natively, so Hebrew titles just work.
  ctx.font = '800 62px Archivo, system-ui, sans-serif';
  ctx.fillText(seg.text, x, height / 2 - (seg.sub ? 20 : 0), maxWidth);
  if (seg.sub) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '700 26px Archivo, system-ui, sans-serif';
    ctx.fillText(seg.sub.toUpperCase(), x, height / 2 + 46, maxWidth);
  }
}
