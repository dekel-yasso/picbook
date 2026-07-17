import { NextRequest, NextResponse } from 'next/server';

// Jamendo track search, proxied so the client ID stays server-side.
// Only CC-BY / CC-BY-SA results (ccnd=false&ccnc=false): licenses that allow
// syncing into a video, with attribution — the clip adds a credit card.

export interface MusicHit {
  id: string;
  name: string;
  artist: string;
  duration: number;
  audio: string;
  license: string;
}

const BASE = 'https://api.jamendo.com/v3.0/tracks/';

interface JamendoResponse {
  results?: {
    id: string;
    name: string;
    artist_name: string;
    duration: number;
    audio: string;
    license_ccurl?: string;
  }[];
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 80);
  if (!q) return NextResponse.json({ results: [] });
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: 'not configured' }, { status: 500 });

  const common = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    limit: '12',
    audioformat: 'mp32',
    include: 'licenses',
    ccnd: 'false',
    ccnc: 'false',
    durationbetween: '45_420',
    boost: 'popularity_total',
  });
  // Free text rarely matches Jamendo's fulltext index; fuzzy tags usually do.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).join('+');
  const attempts = [`fuzzytags=${encodeURIComponent(words)}`, `search=${encodeURIComponent(q)}`];

  try {
    // Jamendo throttles bursts (HTTP 200 with an empty/failed payload), so
    // each attempt gets one retry after a short pause.
    for (const attempt of attempts) {
      let data: JamendoResponse | null = null;
      for (let tries = 0; tries < 2 && !(data?.results?.length); tries++) {
        if (tries > 0) await new Promise((r) => setTimeout(r, 500));
        const res = await fetch(`${BASE}?${common}&${attempt}`, { next: { revalidate: 0 } });
        if (res.ok) data = (await res.json()) as JamendoResponse;
      }
      if (!data) continue;
      const results: MusicHit[] = (data.results ?? [])
        .filter((t) => t.audio)
        .map((t) => ({
          id: t.id,
          name: t.name,
          artist: t.artist_name,
          duration: t.duration,
          audio: t.audio,
          license: `CC ${((t.license_ccurl ?? '')
            .replace(/^https?:\/\/creativecommons.org\/licenses\//, '')
            .split('/')[0] || 'BY')
            .toUpperCase()}`,
        }));
      if (results.length) return NextResponse.json({ results });
    }
    return NextResponse.json({ results: [] });
  } catch {
    return NextResponse.json({ error: 'search failed' }, { status: 502 });
  }
}
