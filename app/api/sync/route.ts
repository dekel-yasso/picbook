import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';

// A trip bundle is a small JSON doc: trip meta, photo metas (no embeddings),
// decisions, and the book. Photos themselves never leave the device.
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const db = sql();
    const rows = (await db`
      select doc, updated_at from trip_docs where user_id = ${session.userId}
    `) as { doc: unknown; updated_at: string }[];
    return NextResponse.json({
      bundles: rows.map((r) => ({ ...(r.doc as object), updatedAt: Number(r.updated_at) })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const tripId = new URL(req.url).searchParams.get('tripId');
    if (!tripId) return NextResponse.json({ error: 'Missing tripId' }, { status: 400 });
    const db = sql();
    await db`delete from trip_docs where user_id = ${session.userId} and trip_id = ${tripId}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const { bundles } = (await req.json()) as {
      bundles?: { trip?: { id?: string }; updatedAt?: number }[];
    };
    if (!Array.isArray(bundles)) {
      return NextResponse.json({ error: 'Missing bundles' }, { status: 400 });
    }
    const db = sql();
    let stored = 0;
    for (const bundle of bundles) {
      const tripId = bundle.trip?.id;
      const updatedAt = bundle.updatedAt;
      if (!tripId || typeof updatedAt !== 'number') continue;
      const json = JSON.stringify(bundle);
      if (json.length > MAX_BUNDLE_BYTES) continue;
      // Last write wins per trip doc.
      await db`
        insert into trip_docs (user_id, trip_id, doc, updated_at)
        values (${session.userId}, ${tripId}, ${json}::jsonb, ${updatedAt})
        on conflict (user_id, trip_id)
        do update set doc = excluded.doc, updated_at = excluded.updated_at
        where trip_docs.updated_at < excluded.updated_at
      `;
      stored++;
    }
    return NextResponse.json({ stored });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
