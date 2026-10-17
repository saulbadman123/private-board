import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.ts';
import {MemoryStore} from './memory-store.ts';
import {digestToken,newToken} from '../server/crypto.ts';
import {prepareNote} from '../server/notes.ts';
import {NoteDraft} from '../src/drafts.ts';
import type {AppConfig} from '../server/types.ts';

const config:AppConfig={origin:'https://board.example',supabaseUrl:'https://test.supabase.co',secretKey:'test',rateSecret:'x'.repeat(64),production:true};
async function fixture(){
  const store=new MemoryStore();const boardId=randomUUID(),other=randomUUID(),token=newToken();
  for(const id of [boardId,other])store.credentials.set(id,{id,title:'Private',password_hash:'unused',created_at:new Date().toISOString()});
  await store.grant(digestToken(token),boardId,new Date(Date.now()+86400000).toISOString());
  const app=createApp(store,config);
  const send=(path:string,body?:unknown,cookie=true,method?:string)=>app(new Request(config.origin+path,{
    method:method??(body===undefined?'GET':'POST'),
    headers:{'origin':config.origin,'sec-fetch-site':'same-origin','x-board-request':'1','x-vercel-forwarded-for':'203.0.113.1','content-type':'application/json',...(cookie?{cookie:`__Host-board_session=${token}`}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  }));
  const payload={kind:'note',requestId:randomUUID(),title:'A thought',markdown:'# Hello\n\nA **permanent** thought.',tags:['Ideas']};
  return {store,boardId,other,token,send,payload,path:`/api/boards/${boardId}/entries`};
}

test('notes survive new reads, have safe summaries, and stay scoped to the board',async()=>{
  const f=await fixture();const response=await f.send(f.path,f.payload);assert.equal(response.status,201);
  const posted=await response.json();assert.equal(posted.replayed,false);assert.equal(posted.entry.markdown,f.payload.markdown);assert.deepEqual(posted.entry.tags,['ideas']);
  assert(!JSON.stringify(posted).includes('request_hash'));assert(!JSON.stringify(posted).includes(f.token));
  const detail=await f.send(`${f.path}/${posted.entry.id}`);assert.equal(detail.status,200);assert.deepEqual((await detail.json()).entry,posted.entry);
  const page=await(await f.send(f.path)).json();assert.equal(page.entries.length,1);assert.equal(page.entries[0].excerpt,'Hello A permanent thought.');assert(!('markdown' in page.entries[0]));assert.equal(page.nextCursor,null);
  assert.equal((await f.send(f.path,undefined,false)).status,401);
  assert.equal((await f.send(`/api/boards/${f.other}/entries/${posted.entry.id}`)).status,401);
  await f.store.grant(digestToken(f.token),f.other,new Date(Date.now()+60000).toISOString());
  assert.equal((await f.send(`/api/boards/${f.other}/entries/${posted.entry.id}`)).status,404);
});

test('lost response and simultaneous retries create one note, changed payload conflicts',async()=>{
  const f=await fixture();f.store.failAfterWrite=true;
  assert.equal((await f.send(f.path,f.payload)).status,503);
  const retried=await f.send(f.path,f.payload);assert.equal(retried.status,200);assert.equal((await retried.json()).replayed,true);assert.equal(f.store.notes.size,1);
  const responses=await Promise.all(Array.from({length:5},()=>f.send(f.path,f.payload)));
  assert(responses.every(r=>r.status===200));assert.equal(f.store.notes.size,1);
  assert.equal((await f.send(f.path,{...f.payload,markdown:'Different'})).status,409);
  assert.equal((await f.send(f.path,{...f.payload,requestId:randomUUID()})).status,201);assert.equal(f.store.notes.size,2);
});

test('posted note validation rejects oversized, empty, malformed and unsupported input',async()=>{
  const f=await fixture();
  for(const replacement of [{markdown:'  \n\t'},{markdown:'x'.repeat(20001)},{title:'x'.repeat(121)},{tags:Array(6).fill('x')},{tags:['x'.repeat(25)]},{kind:'drawing'},{requestId:'invalid'},{markdown:'bad\u0000input'},{markdown:'bad\ud800'},{board_id:f.other}]){
    assert.equal((await f.send(f.path,{...f.payload,...replacement})).status,400,JSON.stringify(Object.keys(replacement)));
  }
  assert.equal((await f.send(f.path,{...f.payload,markdown:'x'.repeat(140000)})).status,413);
  const large=await f.send(f.path,{...f.payload,markdown:'😀'.repeat(20000)});assert.equal(large.status,201);
});

test('pagination has no duplicates for equal timestamps and rejects cross-board cursors',async()=>{
  const f=await fixture();f.store.now=()=>1760000000000;
  for(let i=0;i<45;i++)assert.equal((await f.send(f.path,{...f.payload,requestId:randomUUID(),markdown:`Note ${i}`})).status,201);
  let cursor:string|null=null;const ids=new Set<string>();let total=0;
  do{
    const response=await f.send(f.path+(cursor?`?cursor=${cursor}`:''));assert.equal(response.status,200);
    const page=await response.json();for(const entry of page.entries){assert(!ids.has(entry.id));ids.add(entry.id);total++;}
    cursor=page.nextCursor;
  }while(cursor);
  assert.equal(total,45);
  const first=await(await f.send(f.path)).json();
  await f.store.grant(digestToken(f.token),f.other,new Date(Date.now()+86400000).toISOString());
  assert.equal((await f.send(`/api/boards/${f.other}/entries?cursor=${first.nextCursor}`)).status,400);
  assert.equal((await f.send(f.path+'?cursor=bad')).status,400);
});

test('normalization makes equivalent metadata retries identical',()=>{
  const base={kind:'note',requestId:randomUUID(),markdown:'line\r\nnext',title:' Title ',tags:[' B ','a','a']};
  const a=prepareNote(base),b=prepareNote({...base,markdown:'line\nnext',title:'Title',tags:['a','b']});assert.equal(a.hash,b.hash);
});

test('draft freezes the original submission during uncertain retries and resets only on confirmation',()=>{
  const draft=new NoteDraft();draft.markdown='Original';draft.tags='idea';
  const first=draft.begin();first.markdown='Caller mutation';
  draft.failed('Network failed');const retry=draft.begin();assert.equal(retry.markdown,'Original');assert.equal(retry.requestId,first.requestId);
  assert(draft.hasContent());draft.saved();assert.equal(draft.hasContent(),false);draft.markdown='Next';assert.notEqual(draft.begin().requestId,first.requestId);
  draft.failed('Invalid tags',true);assert.equal(draft.attempt,null);assert.equal(draft.markdown,'Next');
});
