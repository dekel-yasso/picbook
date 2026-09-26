# PicBook — session handoff

Written 2026-09-26 to continue in a fresh session. Read this first; it covers
what the app is, how it ships, what changed recently and why, and what's open.
(The separate music/DKL distribution work lives in `MUSIC_HANDOFF.md`.)

## What PicBook is

Browser-first PWA (Next.js 16, App Router, Turbopack) for culling travel photos
on-device and turning keepers into a printable photo book (PDF) or a trip clip
(MP4 with music). Everything runs client-side: IndexedDB (`idb`) for photos /
thumbs / renditions, a Web Worker (`lib/engine/worker.ts`) for heavy work,
OffscreenCanvas + WebCodecs for video, `pdf-lib` + `pdfjs-dist` for books.
Live at **https://picbook.company** (custom domain) and
https://picbook-six.vercel.app. Users: the owner (Dekel), his father (needs
Hebrew), and a friend who makes clips for clients.

Primary test device is an **iPhone (Safari / home-screen PWA)**. Chromium in
the local Browser pane cannot reproduce iOS-specific memory or WebCodecs
behaviour — several bugs below only showed on the phone.

## Repo conventions

- `AGENTS.md`/`CLAUDE.md`: this Next.js is newer than training data — read
  `node_modules/next/dist/docs/` before relying on Next APIs.
- No comments unless the *why* is non-obvious. Engine code (`lib/engine/*`)
  stays pure and i18n-agnostic; UI strings go through `t()` from
  `lib/i18n-strings.ts` (en + he). A vitest test enforces en/he key parity.
- Localized UI hydrates from localStorage *after* mount (defaults on SSR) —
  the `react-hooks/set-state-in-effect` lint errors on those lines are a known,
  accepted baseline (10 in `app/clip.tsx`, a few in `app/page.tsx`,
  `app/review.tsx`, `app/account.tsx`). Don't "fix" them; compare counts
  before/after when linting.
- Bare numeric text in RTL (e.g. `1 / 6`, `~29S`) needs `dir="ltr"` on the
  span or the bidi algorithm reverses it.

## Build / test / ship procedure (do exactly this)

```bash
npx tsc --noEmit && npm test && npm run build      # gates
gh auth switch --hostname github.com --user dekel-yasso
git add <specific files>                           # never -A: see junk below
git commit -m "..."                                # end with Co-Authored-By line
git -c credential.https://github.com.username=dekel-yasso push
vercel deploy --prod --yes                          # also aliases picbook.company
curl -s https://picbook.company/api/version         # {"build":"..."} must be new
gh auth switch --hostname github.com --user dekely-altius   # ALWAYS switch back
```

- Two GitHub accounts: `dekely-altius` (work, default) and `dekel-yasso`
  (owns this repo). `gh auth switch` alone is **not** enough — `~/.gitconfig`
  hardcodes `credential.https://github.com.username=dekely-altius`, hence the
  `-c` override on push. Details in memory file `git-account-switching`.
- **Vercel: never create/modify domains or projects via CLI** (user
  instruction). Read-only CLI (`vercel inspect`, `deploy`) is fine; anything
  else → guide the user through the dashboard.
- The Vercel CLI (v54, old) sometimes loses its status poll with
  `ETIMEDOUT` after the deployment is already Ready — check with
  `vercel inspect <dpl_id>` / the version endpoint before redeploying.
- Working tree junk that must stay **unstaged/uncommitted**:
  `public/music/shelter.mp3` (modified, unrelated), `MUSIC_HANDOFF.md`
  (untracked; the music project's own handoff — keep it, don't commit it
  unless asked), `PicBook UI Recreation Review.zip`,
  `WhatsApp Image 2026-07-25 ….jpeg`.

## Tests

`npm test` → vitest, `lib/**/*.test.ts`, 64 tests, ~200 ms. Covers
`book.ts` (chapter planning, quotas, day-merge, pagination), `cluster.ts`
(bursts, best-pick), `clip.ts` (`dimsForAspect`, `pickFillPlan`,
`planPhotosOnly`), `clip-timing.ts`, `geo.ts`, `features.ts`, and en/he
string parity + placeholder consistency. Fixtures: `lib/engine/test-fixtures.ts`
(`makePhoto`). No UI/e2e tests — deliberately (canvas/worker/IDB heavy).

For browser checks in the local Browser pane, seed photos straight into
IndexedDB (`picbook` v6, stores `photos`/`thumbs`, out-of-line keys) with
canvas-generated JPEGs; space `takenAt` ≥ 10 min apart or burst clustering
collapses them to one keeper. `localStorage.setItem('picbook-onboarded','1')`
skips onboarding; `picbook-lang` = `he` switches language. Clean up with
`indexedDB.deleteDatabase('picbook'); localStorage.clear()`.

## What shipped recently (newest first) and why

- **fe0d9ae** Photos only mode is unmistakable: Length control dims instead
  of disappearing, toggle shows "✓ Photos only"; inline warning above 300
  photos (count + minutes + how to shrink).
- **c275d0a** Long-clip survival on iOS: no inline `<video>` preview above
  200 MB (loading a 615 MB blob into the player crashed the page); screen
  wake-lock during render (screen lock suspended the page → "Encoding task
  did not complete"); one-render-at-a-time guard.
- **072d45d** Audio-encoder backpressure (15k AudioData frames were queued
  unbounded on a 25-min clip) and **streamed fragmented MP4** for clips over
  5 min via mp4-muxer `StreamTarget` → Blob folded every ~8 MB (in-memory
  MP4 would be ~1 GB). `renderClip` now returns a `Blob`; `clip-done`
  carries `blob`. Short clips keep the in-memory/`fastStart` path.
- **c81b4cf** Permanent crash-surviving **diagnostics log**
  (`lib/engine/diag.ts`, localStorage ring buffer; worker emits `diag`
  events). Clip pipeline logs settings, soundtrack trace, render config, a
  heartbeat every 10 s, result/failure. Viewer: Account & sync →
  "Diagnostics log" (Show / Copy / Clear). Ask the user to paste it after any
  phone crash — it has solved every crash since.
- **2819758 / ebf52cd** VideoEncoder error callback was `throw e` (never
  catchable) → stashed and checked per frame; stage tags on every render
  error (`[frame N/M] …`, `[muxer.finalize] …`); encoder queue capped at 2
  with a full drain every keyframe; decoded soundtrack PCM scoped so it's
  collectable before video encode.
- **bd54488** Transitions multi-select (any subset of Fade/Slide/Zoom/Wipe;
  Mix = all); new **3:4** frame (1080×1440).
- **020e00a** **Photos only** clip mode (`planPhotosOnly`: every keeper,
  natural filename order, no title/map segments) for the friend's client
  jobs; **Photo** (1–6 s) and **Transition** (0.1–1.5 s) sliders with
  defaults 1.6/0.4 (`lib/engine/clip-timing.ts`, shared with beat-sync).
- **cf16a92 / 1fcf8df** Language toggle (`app/lang-toggle.tsx`) in the main
  header (between title and Add photos) and in reviewer/book/clip headers.
- **ddb01bb** Hebrew audit fixes: default trip name translated at display
  (`myPhotosTrip`), `dir="ltr"` on bare counters.
- **422d3d5** Vitest introduced.
- Earlier this run: PDF preview virtualization (`observeNear` needed a
  horizontal check), redundant byte copies removed, service-worker reload
  deferred while an overlay is open, burst mode made opt-in, Wide/Tall clip
  frames with Travel/Repeat fills for mismatched photos, `picbook.company`
  domain (registry delegation saga, resolved on Vercel's side).

## Clip pipeline map (for the next bug)

`app/clip.tsx` `generate()` → `prepareSound()` (fetch/decode MP3 →
`detectBeats`/`syncPlanToBeats` → `encodeSoundtrack` in `lib/engine/audio.ts`,
main thread because WebKit lacks AudioEncoder in workers) → `renderClipVideo`
→ worker `renderClip` in `lib/engine/clip.ts` (timeline → per-frame draw on
OffscreenCanvas → `VideoFrame` → `VideoEncoder` → mp4-muxer; audio chunks
muxed at the end). Plan comes from `planClip` (trip mode, reuses `planBook`)
or `planPhotosOnly`. Settings persist in localStorage keys `picbook-clip-*`.

## Known limits / open items

- A 669-photo Photos-only clip = ~26 min, ~615 MB, ~9 min render on iPhone.
  It now completes, but that's an edge case — the warning steers users away.
  Long clips are **fragmented MP4**; iOS plays it, but confirm that saving
  to the Photos app accepts it (not yet verified by the user).
- Wake lock needs iOS 16.4+ and a user gesture (Render tap qualifies).
- The friend hasn't done a real client run yet; the intended flow: one trip
  per client → Add photos → Clip → Photos only → settings → Render → Save.
- "Your track…" (custom music upload) exists inside the Music picker; the
  user briefly asked for it as if missing — may want it more prominent.
- Description text still says "Square 1080p" in trip mode regardless of
  frame shape (cosmetic).
- Father's Hebrew usage: everything audited OK; a real run-through pending.
- Dev server is started via `.claude/launch.json` (`picbook-dev`, port 3000).

## Memory files worth reading (`~/.claude/projects/-Users-dekelyasso-dev-private-picbook/memory/`)

`git-account-switching.md` (push procedure), `dkl-artist-name.md`,
`suno-workflow-preferences.md`, `picbook-music-sources.md` — the last three
are for the music project.
