import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../server/app.ts';
import {digestToken,newToken} from '../server/crypto.ts';
import {parseFeedQuery,decodeSearchCursor,encodeSearchCursor} from '../server/search.ts';
import type {SearchCursor,SearchRow} from '../server/search.ts';
import type {FeedQuery} from '../shared/browse.ts';
import {browseParams,emptyBrowse,localBoundary} from '../shared/browse.ts';
import {MemoryStore} from './memory-store.ts';

test('local date bounds include complete calendar days across DST, including a skipped midnight',()=>{
  const original=process.env.TZ;
  try{
    process.env.TZ='America/New_York';
    assert.equal(localBoundary('2024-03-10'),'2024-03-10T05:00:00.000Z');
    assert.equal(localBoundary('2024-03-10',true),'2024-03-11T04:00:00.000Z');
    assert.equal(Date.parse(localBoundary('2024-11-03',true)!)-Date.parse(localBoundary('2024-11-03')!),25*3600000);
    process.env.TZ='America/Sao_Paulo';
    assert.equal(localBoundary('2018-11-04'),'2018-11-04T03:00:00.000Z');
    assert.equal(localBoundary('2018-11-04',true),'2018-11-05T02:00:00.000Z');
    assert.throws(()=>localBoundary('2024-02-30'));
    assert.throws(()=>browseParams({...emptyBrowse(),from:'2026-02-02',to:'2026-02-01'}));
    const params=browseParams({...emptyBrowse(),q:' thought ',tags:' Ideas, ideas, work ',sort:'relevance'});
    assert.equal(params.get('q'),'thought');assert.deepEqual(params.getAll('tag'),['ideas','work']);
  }finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
});

test('search validation and cursors bind every filter while preserving exact ranks and timestamps',()=>{
  const board=randomUUID(),id=randomUUID(),query=parseFeedQuery(new URLSearchParams('q=word&sort=relevance&tag=B&tag=a&kind=note'));
  const row:SearchRow={id,board_id:board,kind:'note',title:null,tags:[],excerpt:'',created_at:'2026-10-16T12:34:56.123456+00:00',rank_key:'0.12345679',snapshot_at:'2026-10-16T12:35:00.987654+00:00'};
  const encoded=encodeSearchCursor(board,query,row),decoded=decodeSearchCursor(board,query,encoded)!;
  const start=decodeSearchCursor(board,query,encodeSearchCursor(board,query,row,true))!;
  assert.equal(start.createdAt,null);assert.equal(start.id,null);assert.equal(start.rank,null);assert.equal(start.snapshot,row.snapshot_at);
  assert.equal(decoded.createdAt,row.created_at);assert.equal(decoded.rank,row.rank_key);assert.equal(decoded.snapshot,row.snapshot_at);
  for(const patch of [{q:'other'},{sort:'oldest'},{kind:'drawing'},{tags:['different']},{from:'2026-10-15T00:00:00.000Z'},{to:'2026-10-17T00:00:00.000Z'}])assert.throws(()=>decodeSearchCursor(board,{...query,...patch} as FeedQuery,encoded));
  assert.throws(()=>decodeSearchCursor(randomUUID(),query,encoded));
  for(const input of ['q=a&q=b','kind=nope','sort=arbitrary','sort=relevance','tag=','from=bad','from=2026-02-30T00:00:00.000Z','from=2026-10-17T00:00:00.000Z&to=2026-10-16T00:00:00.000Z','cursor=a&cursor=b','unexpected=1',`q=${'x'.repeat(201)}`,`tag=${'x'.repeat(25)}`,'tag=a&tag=b&tag=c&tag=d&tag=e&tag=f'])assert.throws(()=>parseFeedQuery(new URLSearchParams(input)),input);
});

test('search API authorizes before querying and rejects filter-changed cursors without leaking internals',async()=>{
  const store=new MemoryStore(),board=randomUUID(),other=randomUUID(),token=newToken(),hash=digestToken(token);
  await store.grant(hash,board,new Date(Date.now()+86400000).toISOString());
  const app=createApp(store,{origin:'https://board.example',production:false,supabaseUrl:'https://test.supabase.co',secretKey:'test',rateSecret:'x'.repeat(64)});
  const path=`https://board.example/api/boards/${board}/entries`;
  const get=(url=path,cookie=true)=>app(new Request(url,{headers:cookie?{cookie:`__Host-board_session=${token}`}:{}}));
  const stamp=Date.now()-1000;store.now=()=>stamp;
  for(let i=0;i<45;i++)await store.postNote({boardId:board,tokenHash:hash,requestId:randomUUID(),hash:'a'.repeat(64),title:'Thought',markdown:'A word to find',tags:['idea'],excerpt:'A word to find'});
  assert.equal((await get(path+'?q=word',false)).status,401);
  assert.equal((await get(path.replace(board,other)+'?q=word')).status,401);
  const first=await(await get(path+'?q=word&tag=idea')).json();assert.equal(first.entries.length,20);assert(first.nextCursor);
  assert(!('rank_key' in first.entries[0]));assert(!('snapshot_at' in first.entries[0]));assert(!('markdown' in first.entries[0]));
  assert.equal((await get(path+`?q=other&tag=idea&cursor=${first.nextCursor}`)).status,400);
  assert.equal((await get(path+`?q=word&tag=idea&cursor=${first.nextCursor}`)).status,200);
  store.now=()=>stamp+500;
  await store.postNote({boardId:board,tokenHash:hash,requestId:randomUUID(),hash:'a'.repeat(64),title:'Later',markdown:'word',tags:['idea'],excerpt:'Later'});
  const back=await(await get(path+`?q=word&tag=idea&cursor=${first.pageCursor}`)).json();
  assert.deepEqual(back.entries,first.entries);
  assert.equal((await(await get(path+'?q=absent')).json()).entries.length,0);
  await store.revoke(hash,board);assert.equal((await get(path+'?q=word')).status,401);
});

test('PostgreSQL search indexes, exact relevance cursors, date/type/tag filters, and concurrent inserts',async t=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;grant usage on schema public,storage to anon,authenticated,service_role;`);
    for(const file of ['202610160001_foundation.sql','202610160002_markdown_notes.sql','202610160003_drawings.sql','202610160004_search_filters.sql','202610160005_board_directory.sql'])await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
    const password='scrypt$1$131072$8$1$'+'11'.repeat(16)+'$'+'22'.repeat(32),board=randomUUID(),other=randomUUID();
    await db.query('insert into public.boards(id,title,password_hash) values($1,\'Search\',$3),($2,\'Other\',$3)',[board,other,password]);
    // A single statement intentionally gives all 63 entries the same timestamp.
    await db.query(`insert into public.entries(board_id,kind,title,markdown,tags,request_id,request_hash,excerpt)
      select $1,'note','Search fixture',repeat('alpha beta ',(g%7)+1),array['idea','work'],gen_random_uuid(),repeat('a',64),'alpha beta'
      from generate_series(1,63) g`,[board]);
    await db.query(`insert into public.entries(board_id,kind,title,drawing_caption,object_key,image_mime,width,height,image_bytes,image_sha256,tags,request_id,request_hash,excerpt)
      values($1,'drawing','Sketch','alpha beta drawing','private-key.png','image/png',1024,768,20,repeat('b',64),array['idea'],gen_random_uuid(),repeat('a',64),'alpha beta drawing')`,[board]);
    await db.query(`insert into public.entries(board_id,kind,markdown,request_id,request_hash) values($1,'note','alpha beta other board',gen_random_uuid(),repeat('a',64))`,[other]);
    const search=async(query:FeedQuery,cursor:SearchCursor|null=null)=>{
      const result=await db.query<SearchRow>(`select id,board_id,kind,title,tags,created_at::text,excerpt,width,height,drawing_caption,rank_key,snapshot_at::text
        from public.search_board_entries($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[board,query.q,query.kind,query.tags,query.from,query.to,query.sort,cursor?.createdAt??null,cursor?.id??null,cursor?.rank??null,cursor?.snapshot??null]);
      return result.rows;
    };
    const defaults=parseFeedQuery(new URLSearchParams());
    await t.test('browser roles cannot invoke search RPCs; runtime results contain summaries only',async()=>{
      for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(db.query('select * from public.search_board_entries($1)',[board]),/permission denied/);}finally{await db.exec('reset role');}}
      await db.exec('set role service_role');
      try{const result=await search(defaults);assert.equal(result.length,21);assert(result.every(r=>r.board_id===board));assert(!('object_key' in result[0]));assert(!('markdown' in result[0]));}finally{await db.exec('reset role');}
      const indexes=await db.query<{indexdef:string}>("select indexdef from pg_indexes where tablename='entries'");
      assert(indexes.rows.some(r=>r.indexdef.includes('gin (search_document)')));assert(indexes.rows.some(r=>r.indexdef.includes('gin (tags)')));
    });
    await t.test('all-word search covers drawing descriptions, exact tags and half-open dates',async()=>{
      assert.equal((await search({...defaults,q:'ALPHA beta',kind:'drawing'})).length,1);
      assert.equal((await search({...defaults,q:'work',kind:'note',tags:['idea','work']})).length,21);
      assert.equal((await search({...defaults,tags:['idea','work'],kind:'drawing'})).length,0);
      assert.equal((await search({...defaults,q:'alph'})).length,0);
      assert.equal((await search({...defaults,q:'alpha absent'})).length,0);
      assert.equal((await search({...defaults,q:'---!!!'})).length,0);
      assert.equal((await search({...defaults,q:"'); drop table entries; --"})).length,0);
      const row=(await search({...defaults,kind:'drawing'}))[0];
      assert.equal((await search({...defaults,kind:'drawing',from:row.created_at})).length,1);
      assert.equal((await search({...defaults,kind:'drawing',to:row.created_at})).length,0);
    });
    await t.test('all sort modes traverse equal timestamps without duplicates; relevance floats round-trip exactly',async()=>{
      for(const sort of ['newest','oldest','relevance'] as const){
        const query={...defaults,q:'alpha beta',kind:'note' as const,sort};let cursor:SearchCursor|null=null;
        const ids=new Set<string>();let previous:SearchRow|undefined;
        do{
          const rows=await search(query,cursor);assert(rows.length<=21);
          for(const row of rows.slice(0,20)){
            assert(!ids.has(row.id),`${sort} repeated ${row.id}`);ids.add(row.id);
            if(previous){
              if(sort==='relevance')assert(Number(previous.rank_key)>=Number(row.rank_key));
              if(sort!=='relevance'||previous.rank_key===row.rank_key)assert(sort==='oldest'?previous.id<row.id:previous.id>row.id);
            }
            previous=row;
          }
          cursor=rows.length>20?decodeSearchCursor(board,query,encodeSearchCursor(board,query,rows[19])):null;
        }while(cursor);
        assert.equal(ids.size,63);
      }
    });
    await t.test('a later post does not change an ongoing pagination snapshot; refresh sees it',async()=>{
      const first=await search(defaults),cursor=decodeSearchCursor(board,defaults,encodeSearchCursor(board,defaults,first[19]))!;
      const start=decodeSearchCursor(board,defaults,encodeSearchCursor(board,defaults,first[0],true))!;
      const inserted=await db.query<{id:string}>(`insert into public.entries(board_id,kind,markdown,request_id,request_hash) values($1,'note','New concurrent thought',gen_random_uuid(),repeat('a',64)) returning id`,[board]);
      const ids=new Set(first.slice(0,20).map(r=>r.id));let next:SearchCursor|null=cursor;
      while(next){const rows=await search(defaults,next);for(const row of rows.slice(0,20)){assert(!ids.has(row.id));ids.add(row.id);}next=rows.length>20?decodeSearchCursor(board,defaults,encodeSearchCursor(board,defaults,rows[19])):null;}
      assert.equal(ids.size,64);assert(!ids.has(inserted.rows[0].id));assert((await search(defaults)).some(r=>r.id===inserted.rows[0].id));
      assert.deepEqual((await search(defaults,start)).map(r=>r.id),first.map(r=>r.id));
    });
  }finally{await db.close();}
});
