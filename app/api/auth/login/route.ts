import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { createSession } from '@/lib/server/auth';
import { sql } from '@/lib/server/db';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sign in — or create the account on first use of an email. */
export async function POST(req: Request) {
  try {
    const { email, password } = (await req.json()) as { email?: string; password?: string };
    const normalized = email?.trim().toLowerCase() ?? '';
    if (!EMAIL_RE.test(normalized)) {
      return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 });
    }
    if (!password || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const db = sql();
    const rows = (await db`select id, password_hash from users where email = ${normalized}`) as {
      id: string;
      password_hash: string;
    }[];

    if (rows.length > 0) {
      const ok = await bcrypt.compare(password, rows[0].password_hash);
      if (!ok) return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
      await createSession(rows[0].id, normalized);
      return NextResponse.json({ email: normalized, created: false });
    }

    const hash = await bcrypt.hash(password, 10);
    const inserted = (await db`
      insert into users (email, password_hash) values (${normalized}, ${hash}) returning id
    `) as { id: string }[];
    await createSession(inserted[0].id, normalized);
    return NextResponse.json({ email: normalized, created: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sign-in failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
