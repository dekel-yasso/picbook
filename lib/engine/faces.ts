// On-device face analysis via MediaPipe FaceLandmarker (~4MB, one-time,
// cached). Blendshapes give per-eye blink scores, so burst best-picks can
// avoid the shot where someone blinked. Photos never leave the device.

import { getDB } from './db';
import { asBlob } from './images';
import type { EngineEvent, PhotoMeta } from './types';

export const FACES_VERSION = 1;

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

interface FaceScanner {
  scan: (blob: Blob) => Promise<PhotoMeta['faces']>;
}

let scannerPromise: Promise<FaceScanner> | null = null;

function loadScanner(): Promise<FaceScanner> {
  if (!scannerPromise) {
    scannerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      const landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: 'IMAGE',
        numFaces: 5,
        outputFaceBlendshapes: true,
      });
      return {
        async scan(blob: Blob) {
          const bitmap = await createImageBitmap(blob);
          try {
            const result = landmarker.detect(bitmap);
            const faces = result.faceBlendshapes ?? [];
            if (!faces.length) return { n: 0, eyesOpen: 1 };
            let openSum = 0;
            for (const face of faces) {
              const byName = new Map(face.categories.map((c) => [c.categoryName, c.score]));
              const blink = Math.max(byName.get('eyeBlinkLeft') ?? 0, byName.get('eyeBlinkRight') ?? 0);
              openSum += 1 - blink;
            }
            return { n: faces.length, eyesOpen: openSum / faces.length };
          } finally {
            bitmap.close();
          }
        },
      };
    })();
    scannerPromise.catch(() => {
      scannerPromise = null; // allow retry after a failed download
    });
  }
  return scannerPromise;
}

/** Scan every ready photo that hasn't been face-scanned yet; checkpoint each. */
export async function facesAll(emit: (e: EngineEvent) => void): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('photos');
  const todo = all.filter((p) => p.status === 'ready' && (p.facev ?? 0) < FACES_VERSION);
  if (!todo.length) {
    emit({ type: 'faces-done', scanned: 0 });
    return;
  }
  const scanner = await loadScanner();
  let done = 0;
  let scanned = 0;
  for (const meta of todo) {
    const thumb = await db.get('thumbs', meta.id);
    if (thumb) {
      try {
        meta.faces = await scanner.scan(asBlob(thumb));
        meta.facev = FACES_VERSION;
        await db.put('photos', meta, meta.id);
        emit({ type: 'photo-analyzed', meta });
        scanned++;
      } catch {
        // Skip; a later pass can retry this photo.
      }
    }
    done++;
    if (done % 5 === 0 || done === todo.length) {
      emit({ type: 'faces-progress', done, total: todo.length });
    }
  }
  emit({ type: 'faces-done', scanned });
}
