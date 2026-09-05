'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useI18n } from '@/lib/i18n';
import { observeNear } from './thumb';

const PAGE_WIDTH = 480;

/**
 * Swipeable page-by-page preview of a rendered PDF, rasterized on-device.
 * Pages are virtualized — only ones near the visible strip are decoded and
 * held in memory, and released again once scrolled far away. A large book
 * can run to 100+ pages; rendering all of them eagerly (the original design)
 * held every one decoded simultaneously on the main thread, which was enough
 * to crash mobile Safari on big books.
 */
export function PdfPreview({ file }: { file: File }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pdfDoc: PDFDocumentProxy | null = null;
    // A blob URL lets pdf.js range-request pages as needed instead of us
    // reading the whole file into a second full-size ArrayBuffer up front —
    // for a 100+MB book that extra copy was enough to crash mobile Safari
    // shortly after generation finished, even with per-page virtualization.
    const objectUrl = URL.createObjectURL(file);
    (async () => {
      const pdfjs = await import('pdfjs-dist');
      // GlobalWorkerOptions is a shared singleton — another concurrent pdf.js
      // caller (e.g. the page-image export) may already have set a port;
      // reassigning it mid-flight would hang both.
      if (!pdfjs.GlobalWorkerOptions.workerPort) {
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(
          new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
          { type: 'module' },
        );
      }
      const loaded = await pdfjs.getDocument({ url: objectUrl }).promise;
      if (cancelled) {
        loaded.cleanup();
        return;
      }
      pdfDoc = loaded;
      setDoc(loaded);
      setNumPages(loaded.numPages);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      pdfDoc?.cleanup();
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (failed) return null; // preview is a bonus — Save still works
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t('previewSwipe')}</p>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
        {numPages === 0 ? (
          <div className="h-64 w-[78%] max-w-[420px] shrink-0 bg-placeholder" />
        ) : (
          Array.from({ length: numPages }, (_, i) => <PreviewPage key={i} doc={doc} pageNum={i + 1} />)
        )}
      </div>
    </div>
  );
}

function PreviewPage({ doc, pageNum }: { doc: PDFDocumentProxy | null; pageNum: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeNear(el, setNear);
  }, []);

  // Renders while near the visible strip; the cleanup (near flips false, or
  // this unmounts) revokes it again — at most a handful of pages are ever
  // decoded at once, instead of the whole book.
  useEffect(() => {
    if (!near || !doc) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      const page = await doc.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (PAGE_WIDTH / base.width) * (devicePixelRatio || 1) });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (!blob || cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [near, doc, pageNum]);

  return (
    <div
      ref={ref}
      className="aspect-square w-[78%] max-w-[420px] shrink-0 snap-center border border-line"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- transient blob URL
        <img src={url} alt={`Page ${pageNum}`} className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full bg-placeholder" />
      )}
    </div>
  );
}
