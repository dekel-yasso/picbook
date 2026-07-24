// Rasterize a rendered book PDF to one JPEG per page and zip them — for
// print sites that don't accept a ready PDF (most Israeli photo-album
// editors) and only take individual images.

import { zipSync } from 'fflate';

const TARGET_PX = 2000; // long edge, ~285dpi at a 7in page — plenty for print

export async function exportPagesAsZip(file: File): Promise<Blob> {
  const pdfjs = await import('pdfjs-dist');
  // GlobalWorkerOptions is a shared singleton — PdfPreview may already have set
  // a port for its own in-flight render. Reassigning it here would clobber
  // that and hang both callers, so only set one if none exists yet.
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(
      new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
      { type: 'module' },
    );
  }
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const zipInput: Record<string, Uint8Array> = {};
  try {
    const digits = String(doc.numPages).length;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = TARGET_PX / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdf.js types canvas as HTMLCanvasElement; OffscreenCanvas works at runtime
      await page.render({ canvas: canvas as any, canvasContext: ctx as any, viewport }).promise;
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      const name = `page-${String(i).padStart(digits, '0')}.jpg`;
      zipInput[name] = new Uint8Array(await blob.arrayBuffer());
    }
  } finally {
    await doc.cleanup();
  }
  const zipped = zipSync(zipInput, { level: 6 });
  return new Blob([zipped], { type: 'application/zip' });
}
