import { neon } from '@neondatabase/serverless';

/** Lazily-created Neon client; throws a friendly error when not provisioned yet. */
export function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Cloud sync is not configured yet (missing DATABASE_URL)');
  return neon(url);
}
