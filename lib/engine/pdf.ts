// Client-side print-ready PDF. Generic 8×8in square (576pt) — Blurb-specific
// bleed/trim specs come later, when someone actually prints.
//
// Page design (all deterministic): a subtle background tint derived from the
// page's photos, photos mounted as white-framed prints with a soft shadow,
// and layout variants with uneven splits that alternate page to page. The
// sharpest photo of a page gets the biggest slot.

import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, PDFFont, PDFImage, PDFPage, rgb, StandardFonts } from 'pdf-lib';
import { getDB } from './db';
import { asBlob, RENDITION_MAX, toJpegBlob } from './images';
import type { BookPlan, EngineEvent, PhotoMeta } from './types';

const PAGE = 576;
const MARGIN = 26;
const GUTTER = 12;
const FRAME = 6;
// Collage feel: each print grows past its slot (overlapping neighbours' corners)
// and sits at a slight scattered tilt. The biggest print tilts least.
const OVERLAP = 9;
const TILTS = [-3.5, 2.5, -2, 4, -4.5, 3];
// Print target: 8in at ~250dpi. Best available source wins: this-session
// original → stored keeper rendition → 512px thumb (prints soft).
const IMAGE_MAX = RENDITION_MAX;

export async function renderBookPdf(
  plan: BookPlan,
  files: Map<string, File>,
  emit: (e: EngineEvent) => void,
): Promise<Uint8Array> {
  const db = await getDB();
  const doc = await PDFDocument.create();
  // Titles use Alef (Hebrew + Latin) so non-Latin chapter names actually print;
  // Helvetica is the offline/failure fallback (Latin-1 only).
  let font: PDFFont;
  try {
    doc.registerFontkit(fontkit);
    const fontBytes = await fetch('/fonts/Alef-Bold.ttf').then((r) => {
      if (!r.ok) throw new Error('font fetch failed');
      return r.arrayBuffer();
    });
    font = await doc.embedFont(fontBytes, { subset: true });
  } catch {
    font = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  const total = plan.chapters.reduce((n, c) => n + 1 + c.pages.reduce((m, p) => m + p.photoIds.length, 0), 0);
  let done = 0;

  const metas = new Map<string, PhotoMeta>();
  for (const p of await db.getAll('photos')) metas.set(p.id, p);

  const embed = async (id: string, cropAspect?: number): Promise<PDFImage | null> => {
    const raw = files.get(id) ?? (await db.get('renditions', id)) ?? (await db.get('thumbs', id));
    if (!raw) return null;
    const blob = asBlob(raw);
    const jpegBytes = async (b: Blob) =>
      new Uint8Array(await (await toJpegBlob(b, IMAGE_MAX, cropAspect)).arrayBuffer());
    try {
      return await doc.embedJpg(await jpegBytes(blob));
    } catch {
      // Undecodable original (e.g. HEIC on Chrome): retry with the cached thumb.
      const thumb = await db.get('thumbs', id);
      if (!thumb || thumb === raw) return null;
      try {
        return await doc.embedJpg(await jpegBytes(asBlob(thumb)));
      } catch {
        return null;
      }
    }
  };

  const pageTint = async (id: string): Promise<[number, number, number]> => {
    try {
      const thumb = await db.get('thumbs', id);
      if (!thumb) throw new Error('no thumb');
      const [r, g, b] = await averageColor(asBlob(thumb));
      // Mostly white with a whisper of the photo's palette.
      const mix = (c: number) => 0.9 + 0.1 * c;
      return [mix(r), mix(g), mix(b)];
    } catch {
      return [0.97, 0.96, 0.94]; // warm cream fallback
    }
  };

  let variant = 0;
  for (const chapter of plan.chapters) {
    // Hero page: full-bleed square crop with title + caption on a scrim.
    const heroPage = doc.addPage([PAGE, PAGE]);
    const hero = await embed(chapter.heroId, 1);
    if (hero) heroPage.drawImage(hero, { x: 0, y: 0, width: PAGE, height: PAGE });
    const scrimH = chapter.caption ? 78 : 64;
    heroPage.drawRectangle({ x: 0, y: 0, width: PAGE, height: scrimH, color: rgb(0, 0, 0), opacity: 0.45 });
    if (chapter.caption) {
      drawTextSafe(heroPage, chapter.title, font, 22, MARGIN, 40);
      drawTextSafe(heroPage, chapter.caption, font, 11, MARGIN, 20, 0.8);
    } else {
      drawTextSafe(heroPage, chapter.title, font, 22, MARGIN, 24);
    }
    done++;
    emit({ type: 'book-progress', done, total });

    for (const page of chapter.pages) {
      const pdfPage = doc.addPage([PAGE, PAGE]);
      const [tr, tg, tb] = await pageTint(page.photoIds[0]);
      pdfPage.drawRectangle({ x: 0, y: 0, width: PAGE, height: PAGE, color: rgb(tr, tg, tb) });

      // Biggest cell goes to the sharpest shot.
      const ordered = [...page.photoIds].sort(
        (a, b) => (metas.get(b)?.sharpness ?? 0) - (metas.get(a)?.sharpness ?? 0),
      );
      const aspectOf = (id: string) => {
        const m = metas.get(id);
        return m && m.thumbWidth > 0 && m.thumbHeight > 0 ? m.thumbWidth / m.thumbHeight : 1.5;
      };
      const aspects = ordered.map(aspectOf);
      const cells = layoutCells(ordered.length, variant, aspects);

      // Remaining photos go to the cell whose shape they crop into best.
      const assignment: string[] = [ordered[0]];
      const pool = ordered.slice(1);
      for (let ci = 1; ci < cells.length && pool.length; ci++) {
        const cellAspect = cells[ci].w / cells[ci].h;
        let bestK = 0;
        let bestMismatch = Infinity;
        for (let k = 0; k < pool.length; k++) {
          const mismatch = Math.abs(Math.log(aspectOf(pool[k]) / cellAspect));
          if (mismatch < bestMismatch) {
            bestMismatch = mismatch;
            bestK = k;
          }
        }
        assignment.push(pool.splice(bestK, 1)[0]);
      }

      const single = cells.length === 1;
      for (let i = 0; i < assignment.length; i++) {
        const base = cells[i];
        const cell = single
          ? base
          : { x: base.x - OVERLAP, y: base.y - OVERLAP, w: base.w + 2 * OVERLAP, h: base.h + 2 * OVERLAP };
        // Photos crop to fill their slot — no letterboxed dead space. A lone
        // photo keeps (most of) its own shape instead.
        const cropAspect = single
          ? Math.min(4 / 3, Math.max(3 / 4, aspectOf(assignment[i])))
          : cell.w / cell.h;
        const img = await embed(assignment[i], cropAspect);
        if (img) {
          const scale = Math.min(cell.w / img.width, cell.h / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          const tilt = single
            ? (variant % 2 ? 1.5 : -1.5)
            : TILTS[(variant + i) % TILTS.length] * (i === 0 ? 0.5 : 1);
          drawCollagePrint(pdfPage, img, base.x + base.w / 2, base.y + base.h / 2, w, h, tilt);
        }
        done++;
        emit({ type: 'book-progress', done, total });
      }
      variant++;
    }
    variant++;
  }

  return await doc.save();
}

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Layout variants within the content box, PDF coords (origin bottom-left).
 * Cells are ordered biggest-first. Uneven splits + per-page alternation keep
 * spreads from feeling like a contact sheet.
 */
function layoutCells(count: number, variant: number, aspects: number[]): Cell[] {
  const size = PAGE - 2 * MARGIN;
  const alt = variant % 2 === 1;
  const M = MARGIN;
  const g = GUTTER;

  if (count === 1) {
    return [{ x: M, y: M, w: size, h: size }];
  }

  if (count === 2) {
    const bothPortrait = aspects[0] < 1 && aspects[1] < 1;
    const major = alt ? 0.56 : 0.62;
    if (bothPortrait) {
      const w1 = (size - g) * major;
      const w2 = size - g - w1;
      return [
        { x: M, y: M, w: w1, h: size },
        { x: M + w1 + g, y: M, w: w2, h: size },
      ];
    }
    const h1 = (size - g) * major;
    const h2 = size - g - h1;
    return [
      { x: M, y: M + h2 + g, w: size, h: h1 },
      { x: M, y: M, w: size, h: h2 },
    ];
  }

  if (count === 3) {
    if (alt) {
      // Tall feature on the left, two stacked on the right.
      const w1 = (size - g) * 0.58;
      const w2 = size - g - w1;
      const hh = (size - g) / 2;
      return [
        { x: M, y: M, w: w1, h: size },
        { x: M + w1 + g, y: M + hh + g, w: w2, h: hh },
        { x: M + w1 + g, y: M, w: w2, h: hh },
      ];
    }
    // Wide feature on top, two below.
    const h1 = (size - g) * 0.6;
    const hb = size - g - h1;
    const hw = (size - g) / 2;
    return [
      { x: M, y: M + hb + g, w: size, h: h1 },
      { x: M, y: M, w: hw, h: hb },
      { x: M + hw + g, y: M, w: hw, h: hb },
    ];
  }

  // 4 photos
  if (alt) {
    // Big feature top-left, narrow top-right, two below.
    const h1 = (size - g) * 0.6;
    const hb = size - g - h1;
    const wbig = (size - g) * 0.64;
    const wr = size - g - wbig;
    const hw = (size - g) / 2;
    return [
      { x: M, y: M + hb + g, w: wbig, h: h1 },
      { x: M + wbig + g, y: M + hb + g, w: wr, h: h1 },
      { x: M, y: M, w: hw, h: hb },
      { x: M + hw + g, y: M, w: hw, h: hb },
    ];
  }
  const hw = (size - g) / 2;
  return [
    { x: M, y: M + hw + g, w: hw, h: hw },
    { x: M + hw + g, y: M + hw + g, w: hw, h: hw },
    { x: M, y: M, w: hw, h: hw },
    { x: M + hw + g, y: M, w: hw, h: hw },
  ];
}

/**
 * Photo as a mounted print centered at (cx, cy), tilted by angleDeg:
 * soft shadow, white frame, hairline border, image. pdf-lib rotates around a
 * rect's lower-left corner, so each rect's origin is computed to keep its
 * center fixed under rotation.
 */
function drawCollagePrint(
  page: PDFPage,
  img: PDFImage,
  cx: number,
  cy: number,
  w: number,
  h: number,
  angleDeg: number,
) {
  const rad = (angleDeg * Math.PI) / 180;
  const origin = (rw: number, rh: number) => ({
    x: cx - (rw / 2) * Math.cos(rad) + (rh / 2) * Math.sin(rad),
    y: cy - (rw / 2) * Math.sin(rad) - (rh / 2) * Math.cos(rad),
  });
  const fw = w + 2 * FRAME;
  const fh = h + 2 * FRAME;
  const frameOrigin = origin(fw, fh);
  page.drawRectangle({
    x: frameOrigin.x + 2.5,
    y: frameOrigin.y - 2.5,
    width: fw,
    height: fh,
    rotate: degrees(angleDeg),
    color: rgb(0.2, 0.2, 0.2),
    opacity: 0.16,
  });
  page.drawRectangle({
    x: frameOrigin.x,
    y: frameOrigin.y,
    width: fw,
    height: fh,
    rotate: degrees(angleDeg),
    color: rgb(1, 1, 1),
    borderColor: rgb(0.82, 0.8, 0.78),
    borderWidth: 0.5,
  });
  const imgOrigin = origin(w, h);
  page.drawImage(img, {
    x: imgOrigin.x,
    y: imgOrigin.y,
    width: w,
    height: h,
    rotate: degrees(angleDeg),
  });
}

/** Average color (0..1 RGB) of a small decode of the blob. */
async function averageColor(blob: Blob): Promise<[number, number, number]> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(4, 4);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0, 4, 4);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, 4, 4);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  const n = data.length / 4;
  return [r / n / 255, g / n / 255, b / n / 255];
}

function drawTextSafe(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  x: number,
  y: number,
  brightness = 1,
) {
  try {
    page.drawText(shapeBidi(text), { x, y, size, font, color: rgb(brightness, brightness, brightness) });
  } catch {
    // Fallback font can't encode this text (e.g. Hebrew while offline);
    // skip the title rather than failing the whole book.
  }
}

const HEBREW = /[֐-׿]/;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };

/**
 * PDF text is drawn in visual order with no bidi algorithm, so Hebrew must be
 * pre-shaped (Hebrew has no contextual letterforms, unlike Arabic, so
 * reordering characters is sufficient). Base direction follows the first
 * strongly-directional character.
 */
function shapeBidi(text: string): string {
  if (!HEBREW.test(text)) return text;
  const firstStrong = [...text].find((c) => HEBREW.test(c) || /[A-Za-z]/.test(c));
  if (firstStrong && !HEBREW.test(firstStrong)) {
    // LTR base: reverse each Hebrew run in place.
    return text.replace(/[֐-׿]+/g, (run) => [...run].reverse().join(''));
  }
  // RTL base: reverse everything (mirroring brackets), then restore LTR runs.
  const reversed = [...text]
    .reverse()
    .map((c) => MIRROR[c] ?? c)
    .join('');
  return reversed.replace(/[A-Za-z0-9]+(?:[ .,:\-–—]+[A-Za-z0-9]+)*/g, (run) =>
    [...run].reverse().join(''),
  );
}
