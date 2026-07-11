import { getDB } from './db';
import { RENDITION_MAX, toJpegBlob } from './images';
import type { EngineEvent } from './types';

/**
 * Store print-quality JPEG renditions for the given (id, original file) pairs.
 * Idempotent per id; failures (undecodable originals) are skipped — the PDF
 * falls back to the thumbnail for those.
 */
export async function makeRenditions(
  items: [string, File][],
  emit: (e: EngineEvent) => void,
): Promise<void> {
  const db = await getDB();
  let stored = 0;
  for (const [id, file] of items) {
    if (await db.get('renditions', id)) continue;
    try {
      await db.put('renditions', await toJpegBlob(file, RENDITION_MAX), id);
      stored++;
    } catch {
      // Undecodable original; thumb fallback covers it.
    }
  }
  emit({ type: 'renditions-done', stored });
}
