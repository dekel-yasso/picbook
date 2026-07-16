import { analyze } from './analyze';
import { renderClip } from './clip';
import { embedAll } from './embed';
import { facesAll } from './faces';
import { ingest } from './ingest';
import { renderBookPdf } from './pdf';
import { makeRenditions } from './renditions';
import type { EngineEvent, EngineRequest } from './types';

const post = (e: EngineEvent) => self.postMessage(e);

let analyzing = false;
let analyzePending = false;

// Serializes analyze passes; if one is requested while another runs (e.g. an
// ingest finishes mid-pass), a fresh pass runs after to pick up the new photos.
async function runAnalyze() {
  if (analyzing) {
    analyzePending = true;
    return;
  }
  analyzing = true;
  try {
    do {
      analyzePending = false;
      await analyze(post);
    } while (analyzePending);
  } finally {
    analyzing = false;
  }
}

let embedding = false;
async function runEmbed() {
  if (embedding) return;
  embedding = true;
  try {
    await embedAll(post);
    // Faces ride the same opt-in: scan whatever the embed pass just covered.
    await facesAll(post);
  } finally {
    embedding = false;
  }
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'ingest') {
      await ingest(msg.files, msg.tripId, post);
      await runAnalyze();
    } else if (msg.type === 'analyze') {
      await runAnalyze();
    } else if (msg.type === 'embed') {
      await runEmbed();
    } else if (msg.type === 'renditions') {
      await makeRenditions(msg.items, post);
    } else if (msg.type === 'book') {
      const bytes = await renderBookPdf(msg.plan, new Map(msg.files), post);
      const buffer = bytes.buffer as ArrayBuffer;
      // Cast around TS resolving self.postMessage to the Window overload here.
      const postTransfer = self.postMessage as (m: EngineEvent, t: Transferable[]) => void;
      postTransfer({ type: 'book-done', bytes: buffer }, [buffer]);
    } else if (msg.type === 'clip') {
      const bytes = await renderClip(msg.plan, new Map(msg.files), post, msg.audio);
      const buffer = bytes.buffer as ArrayBuffer;
      const postTransfer = self.postMessage as (m: EngineEvent, t: Transferable[]) => void;
      postTransfer({ type: 'clip-done', bytes: buffer }, [buffer]);
    }
  } catch (err) {
    post({ type: 'engine-error', message: err instanceof Error ? err.message : String(err) });
  }
};
