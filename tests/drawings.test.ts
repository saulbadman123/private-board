import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {createApp} from '../server/app.ts';
import {digestToken,newToken} from '../server/crypto.ts';
import {optimizeDrawing,checksum} from '../server/images.ts';
import {MemoryStore} from './memory-store.ts';
import type {AppConfig} from '../server/types.ts';

const config:AppConfig={origin:'https://board.example',supabaseUrl:'https://test.supabase.co',secretKey:'test',rateSecret:'s'.repeat(64),production:true};
async function image(){return sharp({create:{width:64,height:48,channels:4,background:{r:30,g:80,b:150,alpha:.7}}}).png().toBuffer();}
async function fixture(){
  const store=new MemoryStore(),id=randomUUID(),other=randomUUID(),token=newToken(),requestId=randomUUID(),bytes=await image();
  for(const boardId of [id,other])store.credentials.set(boardId,{id:boardId,title:'Private',password_hash:'unused',created_at:new Date().toISOString()});
  await store.grant(digestToken(token),id,new Date(Date.now()+86400000).toISOString());
  const app=createApp(store,config),path=`/api/boards/${id}/entries`;
  function form(overrides:Record<string,string|Blob>={}){
    const data=new FormData();for(const [key,value]of Object.entries({kind:'drawing',requestId,title:'Sketch',caption:'A blue square',tags:'["art"]',image:new Blob([bytes],{type:'image/png'}),...overrides}))data.set(key,value);return data;
  }
  function request(url:string,data?:FormData,cookie=true,origin=config.origin){return new Request(config.origin+url,{method:data?'POST':'GET',headers:{origin,'x-board-request':'1','sec-fetch-site':'same-origin','x-vercel-forwarded-for':'203.0.113.1',...(cookie?{cookie:`__Host-board_session=${token}`}:{})},...(data?{body:data}:{})});}
  return {store,id,other,token,bytes,path,requestId,form,request,app};
}

test('validated drawings join notes and private image URLs require the correct board session',async()=>{
  const f=await fixture();const posted=await f.app(f.request(f.path,f.form()));assert.equal(posted.status,201);
  const {entry}=await posted.json();assert.equal(entry.kind,'drawing');assert.equal(entry.width,64);assert.equal(entry.height,48);assert(!('object_key'in entry));
  const page=await(await f.app(f.request(f.path))).json();assert.equal(page.entries[0].kind,'drawing');
  const detail=await(await f.app(f.request(`${f.path}/${entry.id}`))).json();assert.deepEqual(detail.entry,entry);
  const url=`${f.path}/${entry.id}/image`;
  const result=await f.app(f.request(url));assert.equal(result.status,200);assert.match(result.headers.get('content-type')!,/^image\/(png|webp)$/);assert.match(result.headers.get('cache-control')!,/no-store/);assert(!result.headers.get('location'));
  const pixels=await sharp(Buffer.from(await result.arrayBuffer())).raw().toBuffer();assert(pixels.length>0);
  assert.equal((await f.app(f.request(url,undefined,false))).status,401);
  const otherUrl=`/api/boards/${f.other}/entries/${entry.id}/image`;
  assert.equal((await f.app(f.request(otherUrl))).status,401);
  await f.store.grant(digestToken(f.token),f.other,new Date(Date.now()+60000).toISOString());
  assert.equal((await f.app(f.request(otherUrl))).status,404);
});

test('upload or insertion failures retain one object and retry safely; lost commit returns the saved drawing',async()=>{
  for(const failure of ['failAfterUpload','failBeforeDrawingInsert','failAfterWrite'] as const){
    const f=await fixture();f.store[failure]=true;
    assert.equal((await f.app(f.request(f.path,f.form()))).status,503,failure);
    assert.equal(f.store.files.size,1);const calls=f.store.putCalls;
    const retry=await f.app(f.request(f.path,f.form()));assert([200,201].includes(retry.status));
    assert.equal(f.store.files.size,1);assert.equal(f.store.drawings.size,1);
    if(failure==='failAfterWrite')assert.equal(f.store.putCalls,calls);
    const repeat=await f.app(f.request(f.path,f.form()));assert.equal(repeat.status,200);assert.equal((await repeat.json()).replayed,true);
    assert.equal((await f.app(f.request(f.path,f.form({caption:'Changed metadata'})))).status,409);
    assert.equal(f.store.files.size,1);
  }
});

test('revocation after upload prevents publication and retry after unlocking reuses the image',async()=>{
  const f=await fixture();f.store.revokeAfterUpload=true;
  assert.equal((await f.app(f.request(f.path,f.form()))).status,401);assert.equal(f.store.drawings.size,0);assert.equal(f.store.files.size,1);
  await f.store.grant(digestToken(f.token),f.id,new Date(Date.now()+60000).toISOString());
  assert.equal((await f.app(f.request(f.path,f.form()))).status,201);assert.equal(f.store.files.size,1);
});

test('multipart rejects duplicate fields, untrusted paths, oversized bodies, and cross-origin writes',async()=>{
  const f=await fixture();const duplicate=f.form();duplicate.append('requestId',randomUUID());
  assert.equal((await f.app(f.request(f.path,duplicate))).status,400);
  assert.equal((await f.app(f.request(f.path,f.form({objectKey:'somewhere'})))).status,400);
  assert.equal((await f.app(f.request(f.path,f.form({caption:'x'.repeat(281)})))).status,400);
  assert.equal((await f.app(f.request(f.path,f.form(),true,'https://evil.example'))).status,403);
  assert.equal((await f.app(f.request(f.path,f.form(),false))).status,401);
  const oversized=f.request(f.path,f.form());oversized.headers.set('content-length','4000000');assert.equal((await f.app(oversized)).status,413);
  assert.equal(f.store.files.size,0);
});

test('image validation blocks corrupt files, SVG, animation, format mismatches, large dimensions and byte limits',async()=>{
  const png=await image();
  for(const [data,mime]of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),'image/png'],[Buffer.from('not a png'),'image/png'],[png,'image/webp']] as const)await assert.rejects(optimizeDrawing(data,mime),{status:400});
  const tooWide=await sharp({create:{width:1025,height:10,channels:3,background:'white'}}).png().toBuffer();await assert.rejects(optimizeDrawing(tooWide,'image/png'),{status:400});
  await assert.rejects(optimizeDrawing(Buffer.alloc(3*1024*1024+1),'image/png'),{status:413});
  const animated=Buffer.concat([png.subarray(0,8),Buffer.from([0,0,0,0]),Buffer.from('acTL'),Buffer.alloc(4),png.subarray(8)]);await assert.rejects(optimizeDrawing(animated,'image/png'),/Animated/);
  const webp=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBPANIM'),Buffer.alloc(4)]);await assert.rejects(optimizeDrawing(webp,'image/webp'),/Animated/);
});

test('optimization is lossless over opaque white and removes metadata',async()=>{
  const source=await sharp({create:{width:128,height:96,channels:4,background:{r:20,g:60,b:130,alpha:.5}}}).withMetadata().png().toBuffer();
  const optimized=await optimizeDrawing(source,'image/png');
  const expected=await sharp(source).flatten({background:'#fff'}).toColourspace('srgb').removeAlpha().raw().toBuffer();
  const actual=await sharp(optimized.bytes).removeAlpha().raw().toBuffer();assert.deepEqual(actual,expected);
  const metadata=await sharp(optimized.bytes).metadata();assert(!metadata.exif);assert(!metadata.icc);assert.equal(checksum(optimized.bytes),optimized.sha256);assert(optimized.bytes.length<source.length);
});

test('image reads fail closed on corrupted stored bytes and image routes cannot mutate',async()=>{
  const f=await fixture();const {entry}=await(await f.app(f.request(f.path,f.form()))).json();const url=`${f.path}/${entry.id}/image`;
  const file=[...f.store.files.values()][0];file.bytes[0]^=255;
  assert.equal((await f.app(f.request(url))).status,503);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await f.app(new Request(config.origin+url,{method}))).status,405);
});
