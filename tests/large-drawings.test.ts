import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {MAX_DRAWING_HEIGHT,MAX_DRAWING_WIDTH,PAPER_SIZES} from '../shared/drawing-limits.ts';

const migration=(name:string)=>readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');

test('the shared paper sizes fit the database limit exactly',()=>{
  assert.equal(PAPER_SIZES.large.width,MAX_DRAWING_WIDTH);assert.equal(PAPER_SIZES.large.height,MAX_DRAWING_HEIGHT);
  assert(PAPER_SIZES.standard.width<=MAX_DRAWING_WIDTH&&PAPER_SIZES.standard.height<=MAX_DRAWING_HEIGHT);
  assert.equal(PAPER_SIZES.standard.width/PAPER_SIZES.standard.height,PAPER_SIZES.large.width/PAPER_SIZES.large.height);
});

test('the large-paper migration only widens the dimension checks and keeps existing drawings valid',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;grant usage on schema public,storage to anon,authenticated,service_role;`);
    for(const name of ['202610160001_foundation','202610160002_markdown_notes','202610160003_drawings','202610160004_search_filters','202610160005_board_directory'])await db.exec(await migration(name));
    const board=randomUUID(),password='scrypt$1$131072$8$1$'+'11'.repeat(16)+'$'+'22'.repeat(32);
    await db.query('insert into public.boards(id,title,password_hash) values($1,\'Paper\',$2)',[board,password]);
    const drawing=(width:number,height:number,key:string)=>db.query(`insert into public.entries(board_id,kind,title,drawing_caption,object_key,image_mime,width,height,image_bytes,image_sha256,tags,request_id,request_hash,excerpt)
      values($1,'drawing','Sketch','caption',$4,'image/png',$2,$3,20,repeat('b',64),array[]::text[],gen_random_uuid(),repeat('a',64),'caption')`,[board,width,height,key]);

    await drawing(1024,768,'standard-before.png');
    await assert.rejects(drawing(1600,1200,'large-before.png'),/check constraint/);

    await db.exec(await migration('202610220001_large_drawings'));
    assert.equal((await db.query<{count:number}>("select count(*)::int as count from public.entries where width=1024 and height=768")).rows[0].count,1);
    await drawing(1600,1200,'large.png');await drawing(1024,768,'standard-after.png');await drawing(1,1,'tiny.png');
    for(const [width,height] of [[1601,1200],[1600,1201],[0,768],[1024,0]])await assert.rejects(drawing(width,height,`bad-${width}x${height}.png`),/check constraint/);
    // Notes still cannot carry image columns, and the byte limit is unchanged.
    await assert.rejects(db.query(`insert into public.entries(board_id,kind,markdown,width,request_id,request_hash) values($1,'note','x',10,gen_random_uuid(),repeat('a',64))`,[board]),/check constraint/);
    await assert.rejects(db.query(`insert into public.entries(board_id,kind,object_key,image_mime,width,height,image_bytes,image_sha256,request_id,request_hash) values($1,'drawing','big.png','image/png',10,10,3145729,repeat('b',64),gen_random_uuid(),repeat('a',64))`,[board]),/check constraint/);
  }finally{await db.close();}
});
