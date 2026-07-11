// On-device CLIP image embeddings via transformers.js (WASM, quantized).
// The text side never ships: theme label embeddings are precomputed into
// theme-embeddings.json by scripts/gen-theme-embeddings.mjs.

import { getDB } from './db';
import { dot } from './features';
import { asBlob } from './images';
import type { EngineEvent } from './types';
import themeData from './theme-embeddings.json';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';

interface ClipModel {
  embed: (blob: Blob) => Promise<number[]>;
}

let modelPromise: Promise<ClipModel> | null = null;

function loadModel(emit: (e: EngineEvent) => void): Promise<ClipModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      // Code-split: transformers.js (~1MB of JS) loads only when embedding is enabled.
      const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await import(
        '@huggingface/transformers'
      );
      // Progress is dominated by the one big weights file; report its percent.
      const progress_callback = (p: { status?: string; progress?: number; file?: string }) => {
        if (p.status === 'progress' && typeof p.progress === 'number' && p.file?.endsWith('.onnx')) {
          emit({ type: 'embed-progress', phase: 'download', done: Math.round(p.progress), total: 100 });
        }
      };
      const processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
      const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback,
      });
      return {
        async embed(blob: Blob) {
          const image = await RawImage.fromBlob(blob);
          const inputs = await processor(image);
          const { image_embeds } = await model(inputs);
          const raw = Array.from(image_embeds.data as Float32Array);
          const norm = Math.hypot(...raw) || 1;
          return raw.map((v) => v / norm);
        },
      };
    })();
    modelPromise.catch(() => {
      modelPromise = null; // allow retry after a failed download
    });
  }
  return modelPromise;
}

function bestTheme(embedding: number[]): string {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < themeData.embeddings.length; i++) {
    const s = dot(embedding, themeData.embeddings[i]);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return themeData.labels[best];
}

/** Embed every ready photo that doesn't have an embedding yet; checkpoint each. */
export async function embedAll(emit: (e: EngineEvent) => void): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('photos');
  const todo = all.filter((p) => p.status === 'ready' && !p.embedding);
  if (!todo.length) {
    emit({ type: 'embed-done', embedded: 0 });
    return;
  }
  const model = await loadModel(emit);
  let done = 0;
  let embedded = 0;
  for (const meta of todo) {
    const thumb = await db.get('thumbs', meta.id);
    if (thumb) {
      try {
        meta.embedding = await model.embed(asBlob(thumb));
        meta.theme = bestTheme(meta.embedding);
        await db.put('photos', meta, meta.id);
        emit({ type: 'photo-analyzed', meta });
        embedded++;
      } catch {
        // Skip; a later pass can retry this photo.
      }
    }
    done++;
    if (done % 4 === 0 || done === todo.length) {
      emit({ type: 'embed-progress', phase: 'embed', done, total: todo.length });
    }
  }
  emit({ type: 'embed-done', embedded });
}
