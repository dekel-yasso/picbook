# PicBook — Design Notes (v0)

*Distilled from the initial brainstorm, July 2026. No code exists yet.*

## The idea

Travel photos pile up: hundreds of near-identical shots, hours of manual sorting.
PicBook is an engine that:

1. **Finds duplicates & near-duplicates** — and picks the best shot of each cluster
2. **Picks the best X photos** on request — high quality *and* diverse, not 50 shots of one sunset
3. **Organizes by theme** — for travel, primarily by day + place
4. **Suggests a print-ready book** — chapters, layouts, exportable PDF

Guiding constraint: **almost zero AI cost.** No per-photo API calls. Classical
algorithms + small local models only; one optional LLM garnish at the end.

## Core architecture decision: browser-first

**All heavy processing runs in the user's browser. Vercel (free tier) only serves
the app.** Photos never leave the device.

Why this beats server-side:
- Free Vercel can't do server-side photo processing (function time/memory limits,
  250MB bundles, no GPU, 100GB bandwidth, no persistent storage).
- No upload of multi-GB camera rolls — local disk speed instead.
- Privacy story writes itself: "your photos never leave your device."
- Zero marginal cost per user, unlimited scale.
- The user's laptop is *stronger* than any free server tier (a free Render box at
  512MB RAM OOMs on a single 48MP decode; browser WebGPU beats its CPU).

**Decision on servers:** start pure Vercel. A small server (Render etc.) is NOT an
escape valve for heavy compute — free tiers are weaker than user laptops. If real
server needs appear later (accounts/sync, print-service webhooks, LLM proxy for
captions, reverse geocoding), they all fit in Vercel's free API routes anyway.
If heavy server compute is ever truly needed → paid GPU tier (Modal/Replicate),
not free Render.

## The pipeline (all client-side, in a Web Worker)

```
scan folder → EXIF → hash → quality score → embed → cluster → review UI → book → PDF
```

### 1. Duplicates / near-duplicates
- **Perceptual hashing** (pHash/dHash) — catches bursts, re-saves, slight crops. Zero AI.
- **EXIF time clustering** — travel shots of the same subject are seconds apart;
  time-gap clustering catches ~90% of "8 shots of this temple." Zero AI.
- **CLIP embeddings** (local, quantized ~50MB via transformers.js + WebGPU) —
  catches same-scene shots pHash misses.

### 2. Best-of-cluster (quality scoring, classical CV)
- Sharpness: variance of Laplacian
- Exposure: histogram analysis (not blown / not dark)
- Faces: detection, eyes-open, size/centering (MediaPipe WASM)
- Optional: NIMA-style local aesthetic model to approximate "emotional best"
- Human tap-to-override in the review UI is the real safety net

### 3. Best X photos
Quality score + **maximal marginal relevance**: repeatedly pick the highest-quality
photo that is also far (time / embedding distance) from photos already picked.
Diversity baked in, zero extra AI.

### 4. Themes
- **Primary (zero AI): EXIF time + GPS.** Days → chapters; GPS clusters →
  reverse-geocoded place names ("Day 3 — Kyoto"). For travel this is what people
  want ~80% of the time.
- **Secondary: content themes** (food / landscape / people / architecture) via the
  same local CLIP embeddings scored against a fixed label list. Free, offline.

### 5. Book
- Deterministic layout rules: hero image per chapter (top score), orientation-aware
  templates, 2–4 photos per spread, full-bleed for standouts.
- Output: high-res PDF with bleed/trim margins matching print-service specs (Blurb
  or local print shop). Generated client-side, downloaded locally.
- **Only genuine LLM use in the product:** chapter titles / short captions
  ("Morning in the old city"). ~20 tiny calls per book via one Vercel API route,
  or user types titles. Optional.

## Recommended stack

| Layer | Choice | Notes |
|---|---|---|
| App framework | Next.js (App Router) on Vercel free | Mostly static; familiar from RecipeSnap |
| App shell | Installable PWA | Manifest + service worker + `navigator.storage.persist()`; this is the "native app" for v1 |
| Heavy compute | Web Worker(s) | Keep UI responsive; clean engine interface so it *could* move server-side someday |
| File access | `PhotoSource` abstraction | Folder picker (File System Access API) on desktop Chrome/Edge; multi-select photo picker (`<input type=file>`) on iOS/Android/Safari |
| EXIF | `exifr` | Fast pure JS; time + GPS are the backbone |
| Hashing / CV scoring | Canvas pixel ops or OpenCV.js (WASM) | pHash, Laplacian sharpness, histograms |
| Faces | MediaPipe (WASM) | Face detect, eyes-open |
| Embeddings / themes | `transformers.js` + quantized CLIP | ~50MB one-time download (HF CDN, free), cached; WebGPU-accelerated |
| Clustering / ranking | Plain TypeScript | Time-gap + hamming + cosine clustering; MMR for best-X |
| PDF | `pdf-lib` | Print-ready export, client-side |
| Local persistence | IndexedDB | Cache hashes/embeddings/scores so re-runs are instant |
| Captions (optional) | One Vercel API route → Claude Haiku | Pennies per book |

## Mobile support (decided July 2026) — first-class, via installable PWA

Supersedes the original "desktop-browser-first" caveat. Mobile is a primary target;
the delivery vehicle is the same web app, installable as a PWA (manifest + service
worker). No native app for v1. What this forces on the architecture:

- **Ingestion:** no File System Access API on iOS, and no "photo folder" concept on
  phones anyway. A `PhotoSource` abstraction with two implementations: recursive
  folder picker (desktop Chrome/Edge) and multi-select photo picker
  (`<input type="file" multiple>` — the iOS/Android path).
- **HEIC:** iPhones shoot HEIC. v1: accept `image/*` and rely on Safari's native
  HEIC decode; photos that fail to decode are counted and reported as unsupported.
  A WASM decoder (libheif) is the upgrade path if this bites in practice.
- **Memory discipline:** mobile Safari kills tabs around 1–1.5GB. Decode in small
  batches, downscale immediately, never hold more than a couple of full decodes at
  once. (This also makes desktop faster — not wasted work.)
- **Resumability:** iOS suspends/kills backgrounded tabs, so the pipeline must
  never depend on finishing in one sitting. Every per-photo result (EXIF, thumb,
  hash, score, embedding) is checkpointed to IndexedDB as it completes; reopening
  the app resumes instead of restarting. The single most important mobile-driven
  requirement.
- **Storage:** Safari evicts IndexedDB after ~7 days of non-use unless the app is
  an installed PWA; also request `navigator.storage.persist()`.
- **Models:** WebGPU is available on iOS 26+ Safari and Android Chrome; keep the
  transformers.js WASM fallback and use a smaller quantized CLIP on phones.
  Embeddings are progressive enhancement — time + pHash clustering works without
  them.
- **Review UI is touch-first** (swipe keep/reject, tap-to-zoom, thumb-reachable
  controls); desktop is the enhancement, not the other way around.

## Known caveats
- First-run model download (~50MB) needs a progress bar; smaller model on mobile.
- Big libraries = minutes of local compute → Web Worker + progress UI + resumable
  checkpoints mandatory.
- Old laptops/phones will feel it; that's the accepted trade.
- Multi-selecting ~2,000 photos through the iOS picker is untested territory —
  validate early on a real device.

## Persistence roadmap (books, editing, accounts)

Key data-model insight: **a book is not the photos.** It's a small JSON document —
chapters, layouts, captions, and *references* to photos (path + fingerprint).
A few hundred KB. The multi-GB photo library stays on the user's device.

Build the book editor against a **repository interface** (save/load/list books)
from day one; swap implementations underneath without touching the editor.

### Stage 1 — local-first (zero backend)
- Books stored in IndexedDB alongside cached hashes/embeddings/scores.
- Export/import a `.picbook` JSON file → backup + moving between own machines.
- File System Access API can persist folder permission grants (Chrome), so
  re-opening a book usually doesn't require re-picking the photo folder.
- Weakness accepted: books reference local files; another device can't show images.

### Stage 2 — accounts + sync (when earned)
- The RecipeSnap recipe verbatim: **NextAuth + Neon Postgres + Vercel API routes**,
  all free tier. Thin CRUD moving small JSON — lives in the same Next.js deploy
  (a second FastAPI service isn't worth hosting for ~200 lines of glue).
- Schema: `users`, `books` (JSONB book document), optionally `book_versions`
  for cross-session undo.

### Cross-device photos (the hard part hiding in "save the books")
1. **Accept it (v1/v2):** editable only on the machine with the photos; other
   devices get read-only previews.
2. **Store renditions (eventual landing spot):** on save, upload only the *chosen*
   photos (~60 images at print resolution) to blob storage. First real money in
   the product — Vercel Blob free tier is small; Cloudflare R2 is the cheap answer.
   Culling-before-upload keeps the bill tiny.
3. **Full library sync:** Google Photos territory — don't build it.

## Open product questions
1. How much does the user steer? Fully automatic + override screen, or guided flow
   (approve clusters → approve picks → approve layout)? **The review screen is where
   the product lives or dies.**
2. **Decided (July 2026):** culling alone is v1 — smaller to build, already
   valuable, and the most mobile-natural piece. The book is v2.
3. **Decided (July 2026):** generic A4/square PDF spec first; add Blurb specs when
   someone actually prints.
