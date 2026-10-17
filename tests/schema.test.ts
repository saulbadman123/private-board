import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('migration executes on PostgreSQL and enforces grants, RLS, append-only entries, and atomic functions', async t => {
  const db = new PGlite();
  // Minimal stand-in for Supabase-managed objects. Their HTTP API is covered by
  // the opt-in live test; this test exercises actual PostgreSQL semantics.
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant usage on schema public, storage to anon, authenticated, service_role;
    grant all on storage.objects to anon, authenticated, service_role;
  `);
  try {
    await db.exec(await readFile(new URL('../supabase/migrations/202610160001_foundation.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202610160002_markdown_notes.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202610160003_drawings.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202610160004_search_filters.sql', import.meta.url), 'utf8'));
    const tables = ['boards','entries','board_sessions','rate_limit_buckets'];
    const hash='scrypt$1$131072$8$1$'+'11'.repeat(16)+'$'+'22'.repeat(32);
    const token='a'.repeat(64), requestHash='b'.repeat(64);
    const board=await db.query<{id:string}>(`select * from public.create_board_with_session($1,$2,$3,now()+interval '7 days')`,['Private',hash,token]);
    const id=board.rows[0].id;
    assert.equal((await db.query<{count:number}>('select count(*)::int as count from public.board_sessions')).rows[0].count,1);

    await t.test('ordinary client roles cannot select, insert, mutate, or invoke privileged RPCs', async () => {
      for (const role of ['anon','authenticated']) {
        for (const table of tables) {
          const permissions=await db.query<{allowed:boolean}>('select has_table_privilege($1,$2,\'SELECT,INSERT,UPDATE,DELETE,TRUNCATE\') as allowed',[role,`public.${table}`]);
          assert.equal(permissions.rows[0].allowed,false,`${role}.${table}`);
        }
        await db.exec(`set role ${role}`);
        try {
          await assert.rejects(db.query('select * from public.boards'),/permission denied/);
          await assert.rejects(db.query(`select * from public.consume_rate_limit($1,1,60)`,['c'.repeat(64)]),/permission denied/);
          await assert.rejects(db.query(`select * from public.create_board_with_session($1,$2,$3,now()+interval '7 days')`,['No',hash,token]),/permission denied/);
        } finally { await db.exec('reset role'); }
      }
      const rls=await db.query<{count:number}>("select count(*)::int as count from pg_class where relname=any($1::text[]) and relrowsecurity",[tables]);
      assert.equal(rls.rows[0].count,4);
    });

    await t.test('runtime can append but cannot update, delete or truncate', async () => {
      await db.exec('set role service_role');
      try {
        await db.query(`insert into public.entries(board_id,kind,markdown,request_id,request_hash,tags) values ($1,'note','A permanent note',gen_random_uuid(),$2,array['idea'])`,[id,requestHash]);
        for (const sql of ['update public.entries set markdown=\'changed\'','delete from public.entries','truncate public.entries']) await assert.rejects(db.exec(sql),/permission denied/);
        const rows=await db.query<{markdown:string;search_document:string}>('select markdown,search_document from public.entries');
        assert.equal(rows.rows[0].markdown,'A permanent note'); assert(rows.rows[0].search_document.includes('permanent'));
      } finally { await db.exec('reset role'); }
      // Guardrails still catch accidental privileged content mutations.
      await assert.rejects(db.exec("update public.entries set markdown='changed'"),/immutable/);
      await assert.rejects(db.exec('delete from public.entries'),/immutable/);
      await assert.rejects(db.exec('truncate public.entries'),/immutable/);
      await assert.rejects(db.query('delete from public.boards where id=$1',[id]),/foreign key/);
    });

    await t.test('constraints reject malformed entries and repeated request identifiers', async () => {
      await assert.rejects(db.query(`insert into public.entries(board_id,kind,markdown,request_id,request_hash) values($1,'drawing','bad',gen_random_uuid(),$2)`,[id,requestHash]),/check constraint/);
      await assert.rejects(db.query(`insert into public.entries(board_id,kind,markdown,request_id,request_hash,tags) values($1,'note','bad',gen_random_uuid(),$2,array['TOO LONG OR UPPERCASE'])`,[id,requestHash]),/Invalid tags/);
      const rid='00000000-0000-4000-8000-000000000001';
      await db.query(`insert into public.entries(board_id,kind,markdown,request_id,request_hash) values($1,'note','Retry',$2,$3)`,[id,rid,requestHash]);
      await assert.rejects(db.query(`insert into public.entries(board_id,kind,markdown,request_id,request_hash) values($1,'note','Retry',$2,$3)`,[id,rid,requestHash]),/unique constraint/);
    });

    await t.test('rate counter is atomic and blocks after the configured limit', async () => {
      await db.exec('set role service_role');
      try {
        const key='c'.repeat(64);
        const calls=await Promise.all(Array.from({length:8},()=>db.query<{allowed:boolean}>('select * from public.consume_rate_limit($1,3,3600)',[key])));
        assert.equal(calls.filter(r=>r.rows[0].allowed).length,3);
      } finally { await db.exec('reset role'); }
    });

    await t.test('private drawing denial survives a permissive browser storage policy', async () => {
      await db.exec(`insert into storage.objects(bucket_id,name) values('drawings','private.webp'); create policy accidental_public_access on storage.objects for all to anon,authenticated using(true) with check(true);`);
      assert.equal((await db.query<{public:boolean}>("select public from storage.buckets where id='drawings'")).rows[0].public,false);
      for (const role of ['anon','authenticated']) {
        await db.exec(`set role ${role}`);
        try {
          assert.equal((await db.query('select * from storage.objects')).rows.length,0);
          await assert.rejects(db.exec("insert into storage.objects(bucket_id,name) values('drawings','bad.png')"),/row-level security/);
        } finally { await db.exec('reset role'); }
      }
    });

    await t.test('failed session insertion rolls back board creation', async () => {
      const before=await db.query<{n:number}>('select count(*)::int as n from public.boards');
      await assert.rejects(db.query(`select * from public.create_board_with_session($1,$2,$3,now()+interval '7 days')`,['Uncommitted',hash,'invalid']),/check constraint/);
      const after=await db.query<{n:number}>('select count(*)::int as n from public.boards');
      assert.equal(before.rows[0].n,after.rows[0].n);
    });
    await t.test('note RPC rechecks sessions, returns one canonical note, and rejects conflicting retries',async()=>{
      const request='00000000-0000-4000-8000-000000000002';
      const args=[id,token,request,requestHash,'Title','RPC note',['idea'],'RPC note'];
      const sql='select * from public.post_note($1,$2,$3,$4,$5,$6,$7,$8)';
      for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(db.query(sql,args),/permission denied/);}finally{await db.exec('reset role');}}
      await db.exec('set role service_role');
      try{
        const first=await db.query<{entry:{id:string;markdown:string};replayed:boolean}>(sql,args);assert.equal(first.rows[0].replayed,false);
        const retries=await Promise.all(Array.from({length:4},()=>db.query<{entry:{id:string};replayed:boolean}>(sql,args)));
        assert(retries.every(r=>r.rows[0].replayed&&r.rows[0].entry.id===first.rows[0].entry.id));
        await assert.rejects(db.query(sql,[...args.slice(0,5),'Changed',...args.slice(6)]),/Submission conflict/);
        await assert.rejects(db.query(sql,[id,'f'.repeat(64),...args.slice(2)]),/Board locked/);
        await db.query('delete from public.board_sessions where board_id=$1 and token_hash=$2',[id,token]);
        await assert.rejects(db.query(sql,args),/Board locked/);
      }finally{await db.exec('reset role');}
    });
    await t.test('drawing RPC requires a stored private object and session, remains append-only, and joins the feed',async()=>{
      const request='00000000-0000-4000-8000-000000000003',sha='d'.repeat(64),key=`${id}/${request}/${sha}.png`;
      await db.query('insert into public.board_sessions(token_hash,board_id,expires_at) values($1,$2,now()+interval \'1 day\')',[token,id]);
      const sql='select * from public.post_drawing($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)';
      const args=[id,token,request,requestHash,'Sketch','A drawing',['idea'],key,1024,768,'image/png',200,sha];
      await assert.rejects(db.query(sql,args),/not stored/);
      await db.query("insert into storage.objects(bucket_id,name) values('drawings',$1)",[key]);
      for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(db.query(sql,args),/permission denied/);await assert.rejects(db.query('select * from public.list_board_entries($1)',[id]),/permission denied/);}finally{await db.exec('reset role');}}
      await db.exec('set role service_role');
      try{
        const first=await db.query<{entry:{id:string;kind:string;object_key?:string};replayed:boolean}>(sql,args);assert.equal(first.rows[0].replayed,false);assert.equal(first.rows[0].entry.kind,'drawing');assert(!first.rows[0].entry.object_key);
        const replay=await db.query<{entry:{id:string};replayed:boolean}>(sql,args);assert(replay.rows[0].replayed);assert.equal(replay.rows[0].entry.id,first.rows[0].entry.id);
        await assert.rejects(db.query(sql,[...args.slice(0,5),'Different',...args.slice(6)]),/Submission conflict/);
        const feed=await db.query<{kind:string}>('select * from public.list_board_entries($1)',[id]);assert(feed.rows.some(e=>e.kind==='note'));assert(feed.rows.some(e=>e.kind==='drawing'));
        await assert.rejects(db.query('update public.entries set drawing_caption=\'changed\' where id=$1',[first.rows[0].entry.id]),/permission denied/);
      }finally{await db.exec('reset role');}
    });
  } finally { await db.close(); }
});
