import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

async function migrated() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant usage on schema public, storage to anon, authenticated, service_role;
    grant all on storage.objects to anon, authenticated, service_role;
  `);
  for (const name of ['202610160001_foundation', '202610160002_markdown_notes', '202610160003_drawings', '202610160004_search_filters', '202610160005_board_directory']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  const hash = 'scrypt$1$131072$8$1$' + '11'.repeat(16) + '$' + '22'.repeat(32);
  const board = await db.query<{ id: string }>(`select * from public.create_board_with_session($1,$2,$3,now()+interval '7 days')`, ['Private', hash, 'a'.repeat(64)]);
  const id = board.rows[0].id;
  await db.query(`insert into public.entries(board_id,kind,markdown,request_id,request_hash) values ($1,'note','Keep me',gen_random_uuid(),$2)`, [id, 'b'.repeat(64)]);
  return { db, id };
}
const count = async (db: PGlite, table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;

test('scheduled cleanup removes only long-expired access state and never content', async () => {
  const { db, id } = await migrated();
  await db.query(`insert into public.board_sessions(token_hash,board_id,expires_at) values ($1,$2,now()-interval '2 days')`, ['c'.repeat(64), id]);
  await db.query(`insert into public.rate_limit_buckets(key,window_start,expires_at,count) values ($1,now()-interval '3 days',now()-interval '2 days',1)`, ['d'.repeat(64)]);
  await db.query(`insert into public.rate_limit_buckets(key,window_start,expires_at,count) values ($1,now(),now()+interval '1 hour',1)`, ['e'.repeat(64)]);
  await db.exec('set role service_role');
  try { await db.exec('select public.cleanup_access_state()'); } finally { await db.exec('reset role'); }
  assert.equal(await count(db, 'board_sessions'), 1);
  assert.equal(await count(db, 'rate_limit_buckets'), 1);
  assert.equal(await count(db, 'entries'), 1);
  assert.equal(await count(db, 'boards'), 1);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try { await assert.rejects(db.exec('select public.cleanup_access_state()'), /permission denied/); } finally { await db.exec('reset role'); }
  }
});

test('post-restore script ends every session, keeps all content, and is valid SQL', async () => {
  const { db, id } = await migrated();
  await db.query(`insert into public.board_sessions(token_hash,board_id,expires_at) values ($1,$2,now()+interval '1 day')`, ['f'.repeat(64), id]);
  assert.equal(await count(db, 'board_sessions'), 2);
  const results = await db.exec(await readFile(new URL('../supabase/ops/after-restore.sql', import.meta.url), 'utf8'));
  assert.equal(await count(db, 'board_sessions'), 0);
  assert.equal(await count(db, 'rate_limit_buckets'), 0);
  assert.equal(await count(db, 'entries'), 1);
  assert.equal(await count(db, 'boards'), 1);
  const summary = results.find(result => result.fields.some(field => field.name === 'notes'));
  assert.equal(summary?.rows[0]?.notes, 1);
  const triggers = results.find(result => result.fields.some(field => field.name === 'tgname'));
  assert(triggers?.rows.some(row => row.tgname === 'immutable_entries'));
});
