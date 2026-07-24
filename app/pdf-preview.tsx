'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';

const PAGE_WIDTH = 480;

/** Swipeable page-by-page preview of a rendered PDF, rasterized on-device. */
export function PdfPreview({ file }: { file: File }) {
  const { t } = useI18n();
  const [pages, setPages] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
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
      const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      for (let i = 1; i <= doc.numPages; i++) {
        if (cancelled) break;
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (PAGE_WIDTH / base.width) * (devicePixelRatio || 1) });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) break;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (!blob) continue;
        urls.push(URL.createObjectURL(blob));
        if (!cancelled) setPages([...urls]);
      }
      await doc.cleanup();
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [file]);

  if (failed) return null; // preview is a bonus — Save still works
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-neutral-500">{t('previewSwipe')}</p>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
        {pages.map((url, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- transient blob URLs
          <img
            key={url}
            src={url}
            alt={`Page ${i + 1}`}
            className="w-[78%] max-w-[420px] shrink-0 snap-center rounded-lg border border-neutral-500/30 shadow-sm"
          />
        ))}
        {pages.length === 0 && (
          <div className="h-64 w-[78%] max-w-[420px] shrink-0 animate-pulse rounded-lg bg-neutral-500/20" />
        )}
      </div>
    </div>
  );
}
