'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Pause, Play, Search, X } from 'lucide-react';
import { encodeSoundtrack, type EncodedSound } from '@/lib/engine/audio';
import { detectBeats, loopBeats, syncPlanToBeats } from '@/lib/engine/beats';
import { clipSeconds, clipSecondsExact, planClip, planPhotosOnly } from '@/lib/engine/clip';
import { DEFAULT_FADE_S, DEFAULT_PHOTO_S, FADE_S_RANGE, PHOTO_S_RANGE } from '@/lib/engine/clip-timing';
import { getDB } from '@/lib/engine/db';
import type { ClipAspect, ClipPlan, ClipTransition, PhotoMeta } from '@/lib/engine/types';
import { useI18n } from '@/lib/i18n';
import { LangToggle } from './lang-toggle';
import { Thumb } from './thumb';

const LENGTHS = [
  { label: 'Short', photos: 20 },
  { label: 'Medium', photos: 40 },
  { label: 'Long', photos: 60 },
] as const;

// The user's own Suno-made songs (full rights) — the app's signature tracks.
const ORIGINALS = [
  { key: 'whereverwego', en: 'Wherever We Go', he: 'Wherever We Go' },
  { key: 'daysremember', en: 'Days to Remember', he: 'Days to Remember' },
  { key: 'findmyway', en: 'Find My Way', he: 'Find My Way' },
  { key: 'neonroads', en: 'Neon Roads', he: 'Neon Roads' },
  { key: 'hallelujah', en: 'Hallelujah for Our Days', he: 'Hallelujah for Our Days' },
  { key: 'notsolongago', en: 'Not So Long Ago', he: 'Not So Long Ago' },
  { key: 'heybrother', en: 'Hey Brother, Hey Sister', he: 'Hey Brother, Hey Sister' },
  { key: 'oneroad', en: 'One Road', he: 'One Road' },
  { key: 'wayhome', en: 'The Way Home', he: 'The Way Home' },
  { key: 'saltsunscreen', en: 'Salt & Sunscreen', he: 'Salt & Sunscreen' },
  { key: 'citylights', en: 'City Lights Run', he: 'City Lights Run' },
  { key: 'higherclouds', en: 'Higher Than the Clouds', he: 'Higher Than the Clouds' },
  { key: 'arewethereyet', en: 'Are We There Yet?', he: 'Are We There Yet?' },
  { key: 'photosgold', en: 'Photos Turn to Gold', he: 'Photos Turn to Gold' },
  { key: 'builtbyyou', en: 'Built by You', he: 'Built by You' },
  { key: 'mywife', en: 'My Wife Is the Best', he: 'My Wife Is the Best' },
  { key: 'outoftokens', en: 'Out of Tokens', he: 'Out of Tokens' },
  { key: 'weathercoming', en: 'Weather Coming', he: 'Weather Coming' },
  { key: 'shelter', en: 'Shelter', he: 'Shelter' },
  { key: 'sloworbit', en: 'Slow Orbit', he: 'Slow Orbit' },
  { key: 'betterdays', en: 'Better Days Are Coming', he: 'Better Days Are Coming' },
  { key: 'sleightofhand', en: 'Sleight of Hand', he: 'Sleight of Hand' },
  { key: 'slowburn', en: 'Slow Burn', he: 'Slow Burn' },
  { key: 'spyglass', en: 'Spyglass', he: 'Spyglass' },
  { key: 'wideeyed', en: 'Wide Eyed', he: 'Wide Eyed' },
  { key: 'quiethouse', en: 'Quiet House', he: 'Quiet House' },
] as const;

// Built-in soundtrack library: public-domain recordings (Musopen), trimmed to
// ~2min in public/music/. Keys double as filenames.
const TRACKS = [
  { key: 'morning', en: 'Grieg — Morning', he: 'גריג — בוקר' },
  { key: 'italian', en: 'Mendelssohn — Italian Symphony', he: 'מנדלסון — הסימפוניה האיטלקית' },
  { key: 'figaro', en: 'Mozart — Figaro Overture', he: 'מוצרט — פתיחת פיגארו' },
  { key: 'vltava', en: 'Smetana — The Moldau', he: 'סמטנה — המולדבה' },
  { key: 'mountainking', en: 'Grieg — Mountain King', he: 'גריג — מלך ההר' },
  { key: 'goldberg', en: 'Bach — Goldberg Variation', he: 'באך — וריאציית גולדברג' },
  { key: 'saltarello', en: 'Mendelssohn — Saltarello', he: 'מנדלסון — סלטרלו' },
  { key: 'mozart40', en: 'Mozart — Symphony No. 40', he: 'מוצרט — סימפוניה 40' },
  { key: 'magicflute', en: 'Mozart — Magic Flute Overture', he: 'מוצרט — פתיחת חליל הקסם' },
  { key: 'hebrides', en: 'Mendelssohn — Hebrides', he: 'מנדלסון — ההברידים' },
  { key: 'anitra', en: "Grieg — Anitra's Dance", he: 'גריג — הריקוד של אניטרה' },
  { key: 'american', en: 'Dvořák — American Quartet', he: 'דבוז׳אק — הרביעייה האמריקאית' },
  { key: 'beethoven5', en: 'Beethoven — Fifth, Finale', he: 'בטהובן — החמישית, פינאלה' },
  { key: 'pastoral', en: 'Beethoven — Pastoral Symphony', he: 'בטהובן — הפסטורלית' },
  { key: 'eroica', en: 'Beethoven — Eroica Scherzo', he: 'בטהובן — סקרצו מתוך ארואיקה' },
  { key: 'upbeat', en: 'Chopin — Grande Valse', he: 'שופן — הוואלס הגדול' },
  { key: 'calm', en: 'Chopin — Nocturne', he: 'שופן — נוקטורן' },
  { key: 'cinematic', en: 'Chopin — Fantaisie-Impromptu', he: 'שופן — פנטזיה-אימפרומפטו' },
] as const;
type MusicKey = 'none' | 'custom' | (typeof TRACKS)[number]['key'] | (typeof ORIGINALS)[number]['key'];
// Cap the decoded PCM we keep around for long custom songs (clips are ≤ ~2.5min).
const CUSTOM_CACHE_SECONDS = 160;

// Trip theme (from the CLIP pass) → suggested Original, used until the user
// picks a track themselves.
const THEME_TRACK: Record<string, MusicKey> = {
  Water: 'saltsunscreen',
  City: 'citylights',
  Landscape: 'higherclouds',
  Night: 'neonroads',
  Animals: 'arewethereyet',
  Art: 'citylights',
};

const ASPECTS: { value: ClipAspect; labelKey: 'aspectSquare' | 'aspectWide' | 'aspectTall' | 'aspectPortrait' }[] = [
  { value: 'square', labelKey: 'aspectSquare' },
  { value: 'wide', labelKey: 'aspectWide' },
  { value: 'tall', labelKey: 'aspectTall' },
  { value: 'portrait', labelKey: 'aspectPortrait' },
];

const TRANSITIONS: { value: ClipTransition; label: string }[] = [
  { value: 'fade', label: 'Fade' },
  { value: 'slide', label: 'Slide' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'mix', label: 'Mix' },
];

interface ClipProps {
  keepers: PhotoMeta[];
  pinnedIds: Set<string>;
  places: Map<string, string>;
  getFile: (id: string) => File | undefined;
  renderClipVideo: (
    plan: ClipPlan,
    files: Map<string, File>,
    sound?: EncodedSound,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  progress: { done: number; total: number; running: boolean };
  onClose: () => void;
}

export function ClipOverlay({ keepers, pinnedIds, places, getFile, renderClipVideo, progress, onClose }: ClipProps) {
  const { lang, t } = useI18n();
  const [length, setLength] = useState<(typeof LENGTHS)[number]['label']>('Medium');
  const [aspect, setAspect] = useState<ClipAspect>('square');
  useEffect(() => {
    const stored = localStorage.getItem('picbook-clip-aspect') as ClipAspect | null;
    if (stored && ASPECTS.some((a) => a.value === stored)) setAspect(stored);
  }, []);
  const pickAspect = useCallback((a: ClipAspect) => {
    setAspect(a);
    localStorage.setItem('picbook-clip-aspect', a);
  }, []);
  // Any subset of the four styles, cycled in order; "Mix" = all four.
  type Style = Exclude<ClipTransition, 'mix'>;
  const STYLES: Style[] = ['fade', 'slide', 'zoom', 'wipe'];
  const [transitions, setTransitions] = useState<Style[]>(STYLES);
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('picbook-clip-transitions') ?? 'null');
      if (Array.isArray(stored)) {
        const valid = stored.filter((s): s is Style => STYLES.includes(s));
        if (valid.length) setTransitions(valid);
      }
    } catch {
      // ignore a corrupt value; defaults stand
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once
  }, []);
  const toggleTransition = useCallback((s: Style) => {
    setTransitions((cur) => {
      // Keep STYLES order so the cycle is predictable; never allow an empty set.
      const next = cur.includes(s) ? cur.filter((x) => x !== s) : STYLES.filter((x) => x === s || cur.includes(x));
      const out = next.length ? next : cur;
      localStorage.setItem('picbook-clip-transitions', JSON.stringify(out));
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- STYLES is constant
  }, []);
  const pickMix = useCallback(() => {
    setTransitions(STYLES);
    localStorage.setItem('picbook-clip-transitions', JSON.stringify(STYLES));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- STYLES is constant
  }, []);
  const isMix = transitions.length === STYLES.length;
  const [music, setMusic] = useState<MusicKey>('whereverwego');
  // Suggest a track that fits the trip's dominant theme — beach trips open
  // with the beach song. An explicit user choice (stored) always wins.
  const suggested = useMemo<MusicKey>(() => {
    const counts = new Map<string, number>();
    let themed = 0;
    for (const p of keepers) {
      if (!p.theme) continue;
      themed++;
      counts.set(p.theme, (counts.get(p.theme) ?? 0) + 1);
    }
    let best: string | null = null;
    let bn = 0;
    for (const [th, n] of counts) {
      if (n > bn) {
        bn = n;
        best = th;
      }
    }
    return (best && bn >= themed * 0.3 && THEME_TRACK[best]) || 'whereverwego';
  }, [keepers]);
  useEffect(() => {
    const stored = localStorage.getItem('picbook-clip-music') as MusicKey | null;
    if (stored && (stored === 'none' || stored === 'custom' || TRACKS.some((tr) => tr.key === stored) || ORIGINALS.some((tr) => tr.key === stored)))
      setMusic(stored);
    else setMusic(suggested);
  }, [suggested]);
  const pickMusic = useCallback((m: MusicKey) => {
    setMusic(m);
    localStorage.setItem('picbook-clip-music', m);
  }, []);
  const [musicOpen, setMusicOpen] = useState(false);
  const closeMusic = useCallback(() => {
    stopPreviewRef.current?.();
    setMusicOpen(false);
  }, []);
  const [customName, setCustomName] = useState<string | null>(null);
  useEffect(() => setCustomName(localStorage.getItem('picbook-clip-custom-name')), []);
  // Pick an audio file from the device; persisted in IndexedDB for next time.
  const pickCustom = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.mp3,.m4a,.aac,.wav';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const db = await getDB();
      await db.put('media', { blob: file, name: file.name }, 'clip-soundtrack');
      localStorage.setItem('picbook-clip-custom-name', file.name);
      setCustomName(file.name);
      pickMusic('custom');
    };
    input.oncancel = () => input.remove();
    document.body.appendChild(input);
    input.click();
  }, [pickMusic]);
  // Online search (Jamendo, CC-BY/BY-SA only; server route holds the API key).
  const [jamQuery, setJamQuery] = useState('');
  const [jamResults, setJamResults] = useState<
    { id: string; name: string; artist: string; duration: number; audio: string; license: string }[] | null
  >(null);
  const [jamBusy, setJamBusy] = useState(false);
  const [jamFetching, setJamFetching] = useState<string | null>(null);
  const searchJamendo = useCallback(async () => {
    const q = jamQuery.trim();
    if (!q) return;
    setJamBusy(true);
    setJamResults(null);
    try {
      const res = await fetch(`/api/music/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setJamResults(data.results ?? []);
    } catch {
      setJamResults([]);
    } finally {
      setJamBusy(false);
    }
  }, [jamQuery]);
  const pickJamendo = useCallback(
    async (hit: { id: string; name: string; artist: string; audio: string; license: string }) => {
      setJamFetching(hit.id);
      try {
        const blob = await fetch(hit.audio).then((r) => {
          if (!r.ok) throw new Error(`fetch ${r.status}`);
          return r.blob();
        });
        const name = `${hit.artist} — ${hit.name}`;
        const credit = `Music: ${hit.artist} — “${hit.name}” · Jamendo (${hit.license || 'CC'})`;
        await (await getDB()).put('media', { blob, name, credit }, 'clip-soundtrack');
        localStorage.setItem('picbook-clip-custom-name', name);
        setCustomName(name);
        pickMusic('custom');
      } catch {
        // leave selection unchanged; the row simply stops spinning
      } finally {
        setJamFetching(null);
      }
    },
    [pickMusic],
  );

  // In-picker listening: one shared <audio>, streaming straight from the URL.
  const stopPreviewRef = useRef<(() => void) | null>(null);
  const previewRef = useRef<{ audio: HTMLAudioElement; url: string | null } | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const stopPreview = useCallback(() => {
    const p = previewRef.current;
    if (p) {
      p.audio.pause();
      if (p.url) URL.revokeObjectURL(p.url);
      previewRef.current = null;
    }
    setPreviewing(null);
  }, []);
  const togglePreview = useCallback(
    async (key: string, streamSrc?: string) => {
      const wasPlaying = previewing === key;
      stopPreview();
      if (wasPlaying) return;
      let src = streamSrc ?? `/music/${key}.mp3`;
      let url: string | null = null;
      if (key === 'custom') {
        const stored = await (await getDB()).get('media', 'clip-soundtrack');
        if (!stored) return;
        src = url = URL.createObjectURL(stored.blob);
      }
      const audio = new Audio(src);
      audio.onended = stopPreview;
      previewRef.current = { audio, url };
      setPreviewing(key);
      audio.play().catch(stopPreview);
    },
    [previewing, stopPreview],
  );
  useEffect(() => stopPreview, [stopPreview]);
  stopPreviewRef.current = stopPreview;
  const currentTrackLabel =
    music === 'none'
      ? t('musicNone')
      : music === 'custom'
        ? `🎵 ${customName ?? t('musicCustom')}`
        : (() => {
            const tr = [...ORIGINALS, ...TRACKS].find((x) => x.key === music);
            return tr ? (lang === 'he' ? tr.he : tr.en) : music;
          })();
  const [beatSync, setBeatSync] = useState(true);
  useEffect(() => setBeatSync(localStorage.getItem('picbook-clip-beatsync') !== '0'), []);
  const toggleBeatSync = useCallback(() => {
    setBeatSync((on) => {
      localStorage.setItem('picbook-clip-beatsync', on ? '0' : '1');
      return !on;
    });
  }, []);
  const [mapsOn, setMapsOn] = useState(true);
  useEffect(() => setMapsOn(localStorage.getItem('picbook-clip-maps') !== '0'), []);
  const toggleMaps = useCallback(() => {
    setMapsOn((on) => {
      localStorage.setItem('picbook-clip-maps', on ? '0' : '1');
      return !on;
    });
  }, []);
  // "Photos only": every keeper in filename order, no title cards or maps —
  // for client jobs where the files carry no dates/GPS.
  const [photosOnly, setPhotosOnly] = useState(false);
  useEffect(() => setPhotosOnly(localStorage.getItem('picbook-clip-photos-only') === '1'), []);
  const togglePhotosOnly = useCallback(() => {
    setPhotosOnly((on) => {
      localStorage.setItem('picbook-clip-photos-only', on ? '0' : '1');
      return !on;
    });
  }, []);
  const [photoS, setPhotoS] = useState(DEFAULT_PHOTO_S);
  const [fadeS, setFadeS] = useState(DEFAULT_FADE_S);
  useEffect(() => {
    const p = Number(localStorage.getItem('picbook-clip-photo-s'));
    const f = Number(localStorage.getItem('picbook-clip-fade-s'));
    if (p > 0) setPhotoS(p);
    if (f > 0) setFadeS(f);
  }, []);
  const pickPhotoS = useCallback((v: number) => {
    setPhotoS(v);
    localStorage.setItem('picbook-clip-photo-s', String(v));
  }, []);
  const pickFadeS = useCallback((v: number) => {
    setFadeS(v);
    localStorage.setItem('picbook-clip-fade-s', String(v));
  }, []);
  const [video, setVideo] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-stage soundtrack trace, shown after rendering so device-specific
  // failures are visible instead of silent.
  const [musicDiag, setMusicDiag] = useState<string | null>(null);

  // Inline playback of the rendered clip, before any share/save.
  const videoUrl = useMemo(() => (video ? URL.createObjectURL(video) : null), [video]);
  useEffect(
    () => () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    },
    [videoUrl],
  );

  const plan = useMemo<ClipPlan>(() => {
    const target = LENGTHS.find((l) => l.label === length)?.photos ?? 40;
    const base = photosOnly
      ? planPhotosOnly(keepers)
      : planClip(keepers, Math.min(target, keepers.length), places, pinnedIds, lang, mapsOn);
    return {
      ...base,
      transition: transitions.length === 1 ? transitions[0] : 'mix',
      transitions,
      aspect,
      photoSeconds: photoS,
      fadeSeconds: fadeS,
    };
  }, [keepers, length, places, pinnedIds, transitions, lang, mapsOn, aspect, photosOnly, photoS, fadeS]);
  const seconds = useMemo(() => clipSeconds(plan), [plan]);
  const photoIds = useMemo(
    () => plan.segments.filter((s) => s.kind === 'photo').map((s) => (s.kind === 'photo' ? s.id : '')),
    [plan],
  );

  const generate = useCallback(async () => {
    stopPreview();
    setError(null);
    setVideo(null);
    const files = new Map<string, File>();
    for (const id of photoIds) {
      const f = getFile(id);
      if (f) files.set(id, f);
    }
    let sound: EncodedSound | undefined;
    let renderPlan: ClipPlan = plan;
    setMusicDiag(null);
    if (music === 'custom') {
      // CC-licensed downloads carry a credit — closes the clip with a card.
      const stored = await (await getDB()).get('media', 'clip-soundtrack');
      if (stored?.credit) {
        renderPlan = {
          ...renderPlan,
          segments: [...renderPlan.segments, { kind: 'title', text: '♪', sub: stored.credit }],
        };
      }
    }
    if (music !== 'none') {
      const diag: string[] = [`♪ ${music === 'custom' ? (customName ?? 'custom') : music}`];
      // Decode → beat-sync → AAC-encode inside one call so the decoded PCM
      // (~60MB of Float32 for a 2.5min track) is unreachable — and collectable —
      // before the video encoder starts. iOS runs the page and the worker in
      // one process with a tight memory ceiling; holding that PCM through a
      // long render is what made the hardware encoder fail mid-clip.
      const prepareSound = async (): Promise<EncodedSound | undefined> => {
        let buf: ArrayBuffer;
        if (music === 'custom') {
          const stored = await (await getDB()).get('media', 'clip-soundtrack');
          if (!stored) throw new Error('no custom track');
          buf = await stored.blob.arrayBuffer();
        } else {
          buf = await fetch(`/music/${music}.mp3`).then((r) => {
            if (!r.ok) throw new Error(`fetch ${r.status}`);
            return r.arrayBuffer();
          });
        }
        diag.push(`fetch ${(buf.byteLength / 1e6).toFixed(1)}MB`);
        const actx = new AudioContext();
        const ab = await actx.decodeAudioData(buf);
        await actx.close();
        const keep = Math.min(ab.length, Math.round(CUSTOM_CACHE_SECONDS * ab.sampleRate));
        const channels = Array.from({ length: ab.numberOfChannels }, (_, i) => ab.getChannelData(i).slice(0, keep));
        const sampleRate = ab.sampleRate;
        diag.push(`decoded ${Math.round(channels[0].length / sampleRate)}s@${sampleRate}`);
        if (beatSync) {
          const trackSeconds = channels[0].length / sampleRate;
          const oneTrack = detectBeats(channels, sampleRate);
          const beats = loopBeats(oneTrack, trackSeconds, clipSecondsExact(renderPlan) + 5);
          const synced = syncPlanToBeats(renderPlan, beats);
          renderPlan = synced.plan;
          diag.push(`beats ${oneTrack.length} · cuts ${synced.snapped}/${synced.cuts} on beat`);
        }
        // AAC-encode here on the page — WebKit lacks AudioEncoder in workers.
        return (await encodeSoundtrack(channels, sampleRate, clipSecondsExact(renderPlan))) ?? undefined;
      };
      try {
        sound = await prepareSound();
        diag.push(
          sound
            ? `encoded ${sound.chunks.length} chunks, desc ${sound.description?.byteLength ?? 0}B`
            : `encode failed (AudioEncoder: ${typeof AudioEncoder !== 'undefined' ? 'yes' : 'no'})`,
        );
      } catch (e) {
        diag.push(`✗ ${e instanceof Error ? e.message : String(e)}`);
        sound = undefined;
      }
      setMusicDiag(diag.join(' · '));
      if (!sound) setError(t('musicFailed'));
    }
    try {
      const bytes = await renderClipVideo(renderPlan, files, sound);
      setVideo(new File([bytes], 'picbook-clip.mp4', { type: 'video/mp4' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [plan, photoIds, getFile, renderClipVideo, music, t]);

  // Kept synchronous inside the tap's user activation so iOS allows share().
  const save = useCallback(() => {
    if (!video) return;
    if (navigator.canShare?.({ files: [video] })) {
      navigator.share({ files: [video] }).catch(() => {});
      return;
    }
    const url = URL.createObjectURL(video);
    const a = document.createElement('a');
    a.href = url;
    a.download = video.name;
    a.click();
    URL.revokeObjectURL(url);
  }, [video]);

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-ground text-ink">
      <div className="flex items-center justify-between border-b-2 border-ink px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2">
          <button onClick={onClose} aria-label={t('close')} className="px-2 py-1">
            <X size={20} strokeWidth={2.25} />
          </button>
          <LangToggle />
        </div>
        <span className="text-[14px] font-extrabold">{t('tripClip')}</span>
        {/* dir="ltr": no adjacent word to anchor bidi ordering, so this
            renders reversed ("S9~") in RTL without it. */}
        <span dir="ltr" className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          ~{seconds}S
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          <div className="flex items-center gap-2">
            {!photosOnly && (
              <div className="flex min-w-0 flex-1 border-2 border-ink text-xs">
                {LENGTHS.map((l, i) => (
                  <button
                    key={l.label}
                    onClick={() => setLength(l.label)}
                    className={`flex-1 px-3 py-2 font-bold ${i > 0 ? 'border-s-2 border-ink' : ''} ${
                      length === l.label ? 'bg-ink text-ground' : 'text-muted'
                    }`}
                  >
                    {l.label === 'Short' ? t('lenShort') : l.label === 'Medium' ? t('lenMedium') : t('lenLong')}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={togglePhotosOnly}
              aria-pressed={photosOnly}
              className={`shrink-0 px-3 py-2 text-xs font-bold ${
                photosOnly ? 'flex-1 bg-accent text-white' : 'border-2 border-ink text-muted'
              }`}
            >
              {t('photosOnly')}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('frameShape')}</span>
            <div className="flex border-2 border-ink text-xs">
              {ASPECTS.map((a, i) => (
                <button
                  key={a.value}
                  onClick={() => pickAspect(a.value)}
                  className={`px-3 py-1.5 font-bold ${i > 0 ? 'border-s-2 border-ink' : ''} ${
                    aspect === a.value ? 'bg-ink text-ground' : 'text-muted'
                  }`}
                >
                  {t(a.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('transition')}</span>
            {TRANSITIONS.map((tr) => {
              const on = tr.value === 'mix' ? isMix : !isMix && transitions.includes(tr.value);
              return (
                <button
                  key={tr.value}
                  aria-pressed={on}
                  onClick={() => (tr.value === 'mix' ? pickMix() : toggleTransition(tr.value))}
                  className={`shrink-0 text-[11px] font-semibold ${
                    on ? 'bg-accent px-2.5 py-1 text-white' : 'border border-line px-[9px] py-[3px] text-muted'
                  }`}
                >
                  {tr.label === 'Fade' ? t('trFade') : tr.label === 'Slide' ? t('trSlide') : tr.label === 'Zoom' ? t('trZoom') : tr.label === 'Wipe' ? t('trWipe') : t('trMix')}
                </button>
              );
            })}
            {!photosOnly && (
              <button
                onClick={toggleMaps}
                className={`shrink-0 text-[11px] font-semibold ${
                  mapsOn
                    ? 'bg-accent px-2.5 py-1 text-white'
                    : 'border border-line px-[9px] py-[3px] text-muted'
                }`}
              >
                {t('mapTransitions')}
              </button>
            )}
          </div>

          {/* Timing sliders: seconds per photo, and crossfade length. */}
          <div className="grid grid-cols-2 gap-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <label className="flex flex-col gap-1">
              <span className="flex justify-between">
                <span>{t('photoSeconds')}</span>
                <span dir="ltr" className="text-ink">{t('secondsShort', { n: photoS.toFixed(1) })}</span>
              </span>
              <input
                type="range"
                min={PHOTO_S_RANGE.min}
                max={PHOTO_S_RANGE.max}
                step={PHOTO_S_RANGE.step}
                value={photoS}
                onChange={(e) => pickPhotoS(Number(e.target.value))}
                className="accent-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="flex justify-between">
                <span>{t('fadeSeconds')}</span>
                <span dir="ltr" className="text-ink">{t('secondsShort', { n: fadeS.toFixed(1) })}</span>
              </span>
              <input
                type="range"
                min={FADE_S_RANGE.min}
                max={FADE_S_RANGE.max}
                step={FADE_S_RANGE.step}
                value={fadeS}
                onChange={(e) => pickFadeS(Number(e.target.value))}
                className="accent-accent"
              />
            </label>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('music')}</span>
            <button
              onClick={() => setMusicOpen(true)}
              className="flex min-w-0 flex-1 items-center justify-between border-2 border-ink bg-white px-3 py-1.5 text-xs font-semibold text-ink"
            >
              <span className="truncate">{currentTrackLabel}</span>
              {lang === 'he' ? (
                <ChevronLeft className="ms-2 shrink-0 text-ink" size={14} strokeWidth={2.25} />
              ) : (
                <ChevronRight className="ms-2 shrink-0 text-ink" size={14} strokeWidth={2.25} />
              )}
            </button>
            <button
              onClick={toggleBeatSync}
              className={`shrink-0 text-[11px] font-semibold ${
                beatSync && music !== 'none'
                  ? 'bg-accent px-2.5 py-1.5 text-white'
                  : 'border border-line px-[9px] py-[5px] text-muted'
              }`}
            >
              {t('beatSync')}
            </button>
          </div>

          {musicOpen && (
            <div className="fixed inset-0 z-[60] flex flex-col bg-ground text-ink">
              <div className="flex items-center justify-between border-b-2 border-ink px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
                <button onClick={closeMusic} aria-label={t('close')} className="px-2 py-1">
                  <X size={20} strokeWidth={2.25} />
                </button>
                <span className="text-[14px] font-extrabold">{t('music')}</span>
                <span className="w-8" />
              </div>
              <div className="flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
                  <div className="flex items-center gap-1.5 overflow-x-auto">
                    <button
                      onClick={() => { stopPreview(); pickMusic('none'); setMusicOpen(false); }}
                      className={`shrink-0 text-[11px] font-semibold ${
                        music === 'none'
                          ? 'bg-accent px-2.5 py-1 text-white'
                          : 'border border-line px-[9px] py-[3px] text-muted'
                      }`}
                    >
                      {t('musicNone')}
                    </button>
                    <button
                      onClick={pickCustom}
                      className={`shrink-0 text-[11px] font-semibold ${
                        music === 'custom'
                          ? 'bg-accent px-2.5 py-1 text-white'
                          : 'border border-line px-[9px] py-[3px] text-muted'
                      }`}
                    >
                      {music === 'custom' && customName
                        ? customName.length > 18
                          ? customName.slice(0, 16) + '…'
                          : customName
                        : t('musicCustom')}
                    </button>
                    {customName && (
                      <button
                        onClick={() => togglePreview('custom')}
                        className="shrink-0 border border-line px-2 py-1 text-muted"
                        aria-label={t('musicPreview')}
                      >
                        {previewing === 'custom' ? (
                          <Pause size={12} strokeWidth={2.25} />
                        ) : (
                          <Play size={12} strokeWidth={2.25} />
                        )}
                      </button>
                    )}
                  </div>
                  <div className="divide-y divide-track border-2 border-ink bg-white">
                    <p className="bg-ink px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-ground">
                      {t('musicOriginals')}
                    </p>
                    {ORIGINALS.map((tr) => (
                      <div key={tr.key} className="flex items-center">
                        <button
                          onClick={() => togglePreview(tr.key)}
                          className={`shrink-0 px-3 py-2.5 ${music === tr.key ? 'text-accent' : 'text-muted'}`}
                          aria-label={t('musicPreview')}
                        >
                          {previewing === tr.key ? (
                            <Pause size={12} strokeWidth={2.25} />
                          ) : (
                            <Play size={12} strokeWidth={2.25} />
                          )}
                        </button>
                        <button
                          onClick={() => { pickMusic(tr.key); closeMusic(); }}
                          className={`flex flex-1 items-center justify-between py-2.5 pe-3 text-start text-[13px] ${
                            music === tr.key ? 'font-extrabold' : 'text-ink'
                          }`}
                        >
                          {lang === 'he' ? tr.he : tr.en}
                          {music === tr.key && <Check className="text-accent" size={14} strokeWidth={2.5} />}
                        </button>
                      </div>
                    ))}
                    <p className="bg-ink px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-ground">
                      {t('musicClassical')}
                    </p>
                    {TRACKS.map((tr) => (
                      <div key={tr.key} className="flex items-center">
                        <button
                          onClick={() => togglePreview(tr.key)}
                          className={`shrink-0 px-3 py-2.5 ${music === tr.key ? 'text-accent' : 'text-muted'}`}
                          aria-label={t('musicPreview')}
                        >
                          {previewing === tr.key ? (
                            <Pause size={12} strokeWidth={2.25} />
                          ) : (
                            <Play size={12} strokeWidth={2.25} />
                          )}
                        </button>
                        <button
                          onClick={() => { pickMusic(tr.key); closeMusic(); }}
                          className={`flex flex-1 items-center justify-between py-2.5 pe-3 text-start text-[13px] ${
                            music === tr.key ? 'font-extrabold' : 'text-ink'
                          }`}
                        >
                          {lang === 'he' ? tr.he : tr.en}
                          {music === tr.key && <Check className="text-accent" size={14} strokeWidth={2.5} />}
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="relative min-w-0 flex-1">
                      <Search
                        className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"
                        size={14}
                        strokeWidth={2.25}
                      />
                      <input
                        value={jamQuery}
                        onChange={(e) => setJamQuery(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && searchJamendo()}
                        placeholder={t('musicSearchPh')}
                        className="w-full border-2 border-ink bg-white ps-8 pe-3 py-2 text-xs outline-none placeholder:text-muted"
                      />
                    </div>
                    <button
                      onClick={searchJamendo}
                      disabled={jamBusy}
                      className="shrink-0 border-2 border-ink px-3 py-2 text-xs font-semibold text-ink"
                    >
                      {jamBusy ? '…' : t('musicSearch')}
                    </button>
                  </div>
                  {jamResults && (
                    <div className="divide-y divide-track border-2 border-ink bg-white">
                      {jamResults.length === 0 && (
                        <p className="px-3 py-2 text-xs text-muted">{t('musicSearchNone')}</p>
                      )}
                      {jamResults.map((hit) => (
                        <div key={hit.id} className="flex items-center">
                          <button
                            onClick={() => togglePreview(`jam:${hit.id}`, hit.audio)}
                            className="shrink-0 px-3 py-2.5 text-muted"
                            aria-label={t('musicPreview')}
                          >
                            {previewing === `jam:${hit.id}` ? (
                              <Pause size={12} strokeWidth={2.25} />
                            ) : (
                              <Play size={12} strokeWidth={2.25} />
                            )}
                          </button>
                          <button
                            onClick={async () => { await pickJamendo(hit); closeMusic(); }}
                            className="min-w-0 flex-1 py-2.5 pe-3 text-start text-sm text-ink"
                          >
                            <span className="block truncate">
                              {jamFetching === hit.id ? '⏳ ' : ''}
                              {hit.artist} — {hit.name}
                            </span>
                            <span className="text-[10px] text-muted">
                              {Math.floor(hit.duration / 60)}:{String(hit.duration % 60).padStart(2, '0')} · {hit.license}
                            </span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {videoUrl && (
            <video
              src={videoUrl}
              controls
              playsInline
              className="w-full bg-black"
              aria-label={t('clipPreview')}
            />
          )}
          <p className="text-xs text-muted">
            {t(photosOnly ? 'clipDescPhotosOnly' : 'clipDesc', { n: plan.photoCount })}
          </p>
          <div className="grid grid-cols-6 gap-1">
            {photoIds.slice(0, 24).map((id) => (
              <Thumb key={id} id={id} alt="" />
            ))}
          </div>
        </div>
      </div>

      <div className="border-t-2 border-ink px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {progress.running && (
            <div className="h-1.5 w-full bg-track">
              <div
                className="h-full bg-ink transition-[width] duration-200"
                style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }}
              />
            </div>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
          {musicDiag && <p className="text-[10px] text-faint">{musicDiag}</p>}
          <div className="flex gap-2">
            <button
              onClick={generate}
              disabled={progress.running || plan.photoCount === 0}
              className="flex-1 border-2 border-ink py-3 text-[13px] font-semibold text-ink disabled:opacity-45"
            >
              {progress.running ? t('rendering') : video ? t('reRender') : t('renderClip')}
            </button>
            {video && !progress.running && (
              <button
                onClick={save}
                className="flex-1 bg-accent py-3 text-[13px] font-semibold text-white"
              >
                {t('saveVideo', { size: (video.size / 1024 / 1024).toFixed(1) })}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
