import { NextResponse } from 'next/server';

/** The deployed build stamp; clients compare against their own inlined one. */
export async function GET() {
  return NextResponse.json(
    { build: process.env.NEXT_PUBLIC_BUILD ?? 'dev' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
