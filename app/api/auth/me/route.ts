import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/auth';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    return NextResponse.json({ email: session.email });
  } catch {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
}
