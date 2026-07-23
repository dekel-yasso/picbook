// Client-side print-ready PDF to Blurb's "Small Square 7×7" PDF-to-Book spec
// (from blurb.com/make/pdf_to_book/booksize_calculator, 2026-07):
//   page PDF 495×495pt = trim 486×477 + 9pt bleed on top/bottom/outside only
//   (no bleed on the binding edge); safe inset 18pt from trim, 36pt at the
//   binding; even page count, minimum 20 pages. Odd PDF pages are right-hand
//   (binding on the left), even pages left-hand — margins mirror accordingly.
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

const PAGE_W = 495;
const PAGE_H = 495;
const BLEED = 9;
const TRIM_W = 486;
const TRIM_H = 477;
const SAFE_OUT = 18;
const SAFE_BIND = 36;
const MIN_PAGES = 20;
const GUTTER = 12;
const FRAME = 6;
// Collage feel: each print grows past its slot (overlapping neighbours' corners)
// and sits at a slight scattered tilt. The biggest print tilts least.
const OVERLAP = 9;
const TILTS = [-3.5, 2.5, -2, 4, -4.5, 3];
// Print target: 7in at ~290dpi. Best available source wins: this-session
// original → stored keeper rendition → 512px thumb (prints soft).
const IMAGE_MAX = RENDITION_MAX;

/** Content-safe box for the 1-indexed PDF page (odd = right-hand page). */
function safeBox(pageIndex1: number): Cell {
  const recto = pageIndex1 % 2 === 1;
  return {
    x: recto ? SAFE_BIND : BLEED + SAFE_OUT,
    y: BLEED + SAFE_OUT,
    w: TRIM_W - SAFE_BIND - SAFE_OUT,
    h: TRIM_H - 2 * SAFE_OUT,
  };
}

/** Interior PDF page count including the even/minimum padding Blurb requires. */
export function bookPdfPageCount(plan: BookPlan): number {
  const raw = plan.chapters.reduce((n, c) => n + 1 + c.pages.length, 0);
  let padded = Math.max(MIN_PAGES, raw);
  if (padded % 2) padded++;
  return padded;
}

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
    const heroPage = doc.addPage([PAGE_W, PAGE_H]);
    const heroSafe = safeBox(doc.getPageCount());
    const hero = await embed(chapter.heroId, PAGE_W / PAGE_H);
    if (hero) heroPage.drawImage(hero, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
    const scrimH = chapter.caption ? 96 : 78;
    heroPage.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: scrimH, color: rgb(0, 0, 0), opacity: 0.45 });
    if (chapter.caption) {
      drawTextSafe(heroPage, chapter.title, font, 22, heroSafe.x, 52);
      drawTextSafe(heroPage, chapter.caption, font, 11, heroSafe.x, 32, 0.8);
    } else {
      drawTextSafe(heroPage, chapter.title, font, 22, heroSafe.x, 36);
    }
    done++;
    emit({ type: 'book-progress', done, total });

    for (const page of chapter.pages) {
      const pdfPage = doc.addPage([PAGE_W, PAGE_H]);
      const box = safeBox(doc.getPageCount());
      const [tr, tg, tb] = await pageTint(page.photoIds[0]);
      pdfPage.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(tr, tg, tb) });

      // Biggest cell goes to the sharpest shot.
      const ordered = [...page.photoIds].sort(
        (a, b) => (metas.get(b)?.sharpness ?? 0) - (metas.get(a)?.sharpness ?? 0),
      );
      const aspectOf = (id: string) => {
        const m = metas.get(id);
        return m && m.thumbWidth > 0 && m.thumbHeight > 0 ? m.thumbWidth / m.thumbHeight : 1.5;
      };
      const aspects = ordered.map(aspectOf);
      const cells = layoutCells(ordered.length, variant, aspects, box);

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

  // Blurb requires an even page count and at least MIN_PAGES pages.
  const target = bookPdfPageCount(plan);
  while (doc.getPageCount() < target) {
    const filler = doc.addPage([PAGE_W, PAGE_H]);
    filler.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(0.97, 0.96, 0.94) });
    if (doc.getPageCount() === target) {
      drawTextSafe(filler, 'PicBook', font, 10, PAGE_W / 2 - 20, PAGE_H / 2, 0.62);
    }
  }

  return await doc.save();
}

export type CoverType = 'softcover' | 'imagewrap';

// Cover geometry per binding, from Blurb's calculator (standard paper).
// Spine widths are sampled points with linear interpolation between them
// (±1pt is within binding tolerance). ImageWrap boards are larger than the
// pages, with a 22pt wrap-bleed on all edges.
const COVERS: Record<
  CoverType,
  { panelW: number; coverH: number; bleed: number; spineTable: [number, number][] }
> = {
  softcover: {
    panelW: 486,
    coverH: 495,
    bleed: 9,
    spineTable: [
      [20, 4],
      [40, 9],
      [60, 13],
      [120, 22],
      [200, 36],
    ],
  },
  imagewrap: {
    panelW: 503,
    // Blurb's calculator says 549 but their uploader validates 548 (7.611in);
    // the uploader wins.
    coverH: 548,
    bleed: 22,
    spineTable: [
      [20, 33],
      [100, 41],
      [200, 54],
    ],
  },
};

function spineWidth(pages: number, t: [number, number][]): number {
  if (pages <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (pages <= t[i][0]) {
      const [p0, s0] = t[i - 1];
      const [p1, s1] = t[i];
      return Math.round(s0 + ((pages - p0) * (s1 - s0)) / (p1 - p0));
    }
  }
  return t[t.length - 1][1];
}

/**
 * Softcover wrap PDF (back | spine | front) to the same Blurb spec:
 * height 495, width 2×486 + spine + 9pt bleed each side. Front is the first
 * chapter's hero, full bleed, with the book title on a scrim; spine gets the
 * title when it is wide enough to print legibly.
 */
export async function renderCoverPdf(
  plan: BookPlan,
  files: Map<string, File>,
  title: string,
  cover: CoverType = 'softcover',
): Promise<Uint8Array> {
  const db = await getDB();
  const doc = await PDFDocument.create();
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

  const geo = COVERS[cover];
  const pages = bookPdfPageCount(plan);
  const spine = spineWidth(pages, geo.spineTable);
  const W = 2 * geo.panelW + spine + 2 * geo.bleed;
  const H = geo.coverH;
  const page = doc.addPage([W, H]);
  const frontX = geo.bleed + geo.panelW + spine; // left edge of the front panel's trim
  const frontW = geo.panelW + geo.bleed; // panel + outside bleed

  // Base: muted tone from the hero for back cover and spine.
  let tone: [number, number, number] = [0.16, 0.18, 0.22];
  const heroId = plan.chapters[0]?.heroId;
  try {
    const thumb = heroId ? await db.get('thumbs', heroId) : null;
    if (thumb) {
      const [r, g, b] = await averageColor(asBlob(thumb));
      tone = [r * 0.45, g * 0.45, b * 0.45];
    }
  } catch {
    // keep fallback tone
  }
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(...tone) });

  // Front panel: hero image, full bleed.
  if (heroId) {
    const raw = files.get(heroId) ?? (await db.get('renditions', heroId)) ?? (await db.get('thumbs', heroId));
    if (raw) {
      try {
        const jpeg = new Uint8Array(
          await (await toJpegBlob(asBlob(raw), IMAGE_MAX, frontW / H)).arrayBuffer(),
        );
        const img = await doc.embedJpg(jpeg);
        page.drawImage(img, { x: frontX, y: 0, width: frontW, height: H });
      } catch {
        // front stays toned
      }
    }
  }
  const scrimH = 96;
  page.drawRectangle({ x: frontX, y: 0, width: frontW, height: scrimH, color: rgb(0, 0, 0), opacity: 0.5 });
  drawTextSafe(page, title, font, 24, frontX + SAFE_OUT, 44);

  // Spine text, when the spine can carry it.
  if (spine >= 14) {
    try {
      page.drawText(shapeBidi(title), {
        x: geo.bleed + geo.panelW + spine / 2 + 3.5,
        y: H - geo.bleed - SAFE_OUT - 12,
        size: Math.min(10, spine - 5),
        font,
        color: rgb(1, 1, 1),
        rotate: degrees(-90),
      });
    } catch {
      // skip spine text if the font can't encode it
    }
  }

  // Back panel: quiet — title small, PicBook credit.
  drawTextSafe(page, title, font, 12, geo.bleed + SAFE_OUT, H / 2, 0.9);
  drawTextSafe(page, 'PicBook', font, 8, geo.bleed + SAFE_OUT, H / 2 - 18, 0.55);

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
function layoutCells(count: number, variant: number, aspects: number[], box: Cell): Cell[] {
  const alt = variant % 2 === 1;
  const g = GUTTER;
  const M = box.x;
  const MY = box.y;

  if (count === 1) {
    return [{ x: M, y: MY, w: box.w, h: box.h }];
  }

  if (count === 2) {
    const bothPortrait = aspects[0] < 1 && aspects[1] < 1;
    const major = alt ? 0.56 : 0.62;
    if (bothPortrait) {
      const w1 = (box.w - g) * major;
      const w2 = box.w - g - w1;
      return [
        { x: M, y: MY, w: w1, h: box.h },
        { x: M + w1 + g, y: MY, w: w2, h: box.h },
      ];
    }
    const h1 = (box.h - g) * major;
    const h2 = box.h - g - h1;
    return [
      { x: M, y: MY + h2 + g, w: box.w, h: h1 },
      { x: M, y: MY, w: box.w, h: h2 },
    ];
  }

  if (count === 3) {
    if (alt) {
      // Tall feature on the left, two stacked on the right.
      const w1 = (box.w - g) * 0.58;
      const w2 = box.w - g - w1;
      const hh = (box.h - g) / 2;
      return [
        { x: M, y: MY, w: w1, h: box.h },
        { x: M + w1 + g, y: MY + hh + g, w: w2, h: hh },
        { x: M + w1 + g, y: MY, w: w2, h: hh },
      ];
    }
    // Wide feature on top, two below.
    const h1 = (box.h - g) * 0.6;
    const hb = box.h - g - h1;
    const hw = (box.w - g) / 2;
    return [
      { x: M, y: MY + hb + g, w: box.w, h: h1 },
      { x: M, y: MY, w: hw, h: hb },
      { x: M + hw + g, y: MY, w: hw, h: hb },
    ];
  }

  // 4 photos
  if (alt) {
    // Big feature top-left, narrow top-right, two below.
    const h1 = (box.h - g) * 0.6;
    const hb = box.h - g - h1;
    const wbig = (box.w - g) * 0.64;
    const wr = box.w - g - wbig;
    const hw = (box.w - g) / 2;
    return [
      { x: M, y: MY + hb + g, w: wbig, h: h1 },
      { x: M + wbig + g, y: MY + hb + g, w: wr, h: h1 },
      { x: M, y: MY, w: hw, h: hb },
      { x: M + hw + g, y: MY, w: hw, h: hb },
    ];
  }
  const hw = (box.w - g) / 2;
  const hh = (box.h - g) / 2;
  return [
    { x: M, y: MY + hh + g, w: hw, h: hh },
    { x: M + hw + g, y: MY + hh + g, w: hw, h: hh },
    { x: M, y: MY, w: hw, h: hh },
    { x: M + hw + g, y: MY, w: hw, h: hh },
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
