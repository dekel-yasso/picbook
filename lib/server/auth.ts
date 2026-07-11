import { jwtVerify, SignJWT } from 'jose';
import { cookies } from 'next/headers';

const COOKIE = 'pb_session';
const MAX_AGE_S = 60 * 60 * 24 * 30;

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('Cloud sync is not configured yet (missing AUTH_SECRET)');
  return new TextEncoder().encode(s);
}

export interface Session {
  userId: string;
  email: string;
}

export async function createSession(userId: string, email: string): Promise<void> {
  const jwt = await new SignJWT({ email })
    .setSubject(userId)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_S,
    path: '/',
  });
}

export async function getSession(): Promise<Session | null> {
  const cookie = (await cookies()).get(COOKIE);
  if (!cookie?.value) return null;
  try {
    const { payload } = await jwtVerify(cookie.value, secret());
    if (!payload.sub || typeof payload.email !== 'string') return null;
    return { userId: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
