import { getDB } from './db';
import { computeFeatures, FEATURES_VERSION } from './features';
import { asBlob } from './images';
import type { EngineEvent } from './types';

// Thumbs are small (≤512px), so analysis can batch wider than ingest.
const BATCH = 8;

/**
 * Compute features for every photo that doesn't have them yet, checkpointing
 * each result. Safe to call repeatedly; a killed session resumes for free.
 */
export async function analyze(emit: (e: EngineEvent) => void): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('photos');
  const todo = all.filter(
    (p) => p.status === 'ready' && (p.phash === undefined || (p.featv ?? 1) < FEATURES_VERSION),
  );
  let done = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (meta) => {
        const thumb = await db.get('thumbs', meta.id);
        if (!thumb) return;
        try {
          Object.assign(meta, await computeFeatures(asBlob(thumb)));
          await db.put('photos', meta, meta.id);
          emit({ type: 'photo-analyzed', meta });
        } catch {
          // Leave the photo unanalyzed; clustering treats missing features leniently.
        }
      }),
    );
    done += batch.length;
    emit({ type: 'analyze-progress', done: Math.min(done, todo.length), total: todo.length });
  }
  emit({ type: 'analyze-done', analyzed: todo.length });
}
