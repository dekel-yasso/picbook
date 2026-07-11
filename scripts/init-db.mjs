// One-time schema setup. Run after provisioning Neon:
//   DATABASE_URL=postgres://... node scripts/init-db.mjs
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL first');
  process.exit(1);
}
const sql = neon(url);

await sql`
  create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    email text unique not null,
    password_hash text not null,
    created_at timestamptz not null default now()
  )
`;
await sql`
  create table if not exists trip_docs (
    user_id uuid not null references users(id) on delete cascade,
    trip_id text not null,
    doc jsonb not null,
    updated_at bigint not null,
    primary key (user_id, trip_id)
  )
`;
console.log('schema ready');
