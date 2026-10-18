import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import { digestToken, hashPassword, newToken } from '../server/crypto.ts';
import { MemoryStore } from './memory-store.ts';
import type { AppConfig } from '../server/types.ts';

const config: AppConfig = { origin: 'https://board.example', supabaseUrl: 'https://test.supabase.co', secretKey: 'test-only', rateSecret: 'a'.repeat(64), production: true };
const path = (id: string, action = '') => `/api/boards/${id}${action ? `/${action}` : ''}`;
const req = (url: string, options: {body?:unknown;cookie?:string;origin?:string;site?:string;ip?:string} = {}) => new Request(config.origin + url, {
  method: options.body === undefined ? 'GET' : 'POST',
  headers: { origin: options.origin ?? config.origin, 'sec-fetch-site': options.site ?? 'same-origin', 'x-board-request':'1', 'content-type':'application/json', 'x-vercel-forwarded-for':options.ip ?? '203.0.113.1', ...(options.cookie ? { cookie: options.cookie } : {}) },
  ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
});
const cookie = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];

test('complete board flow enforces isolation, expiry, lock, and anonymous safe responses', async () => {
  let now = Date.now(); const store = new MemoryStore(() => now); const app = createApp(store, config, () => now);
  const password = 'twelve safe words together';
  const created = await app(req('/api/boards', { body: { title:'First board', password } }));
  assert.equal(created.status, 201);
  assert.match(created.headers.get('set-cookie')!, /__Host-board_session=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  assert.match(created.headers.get('cache-control')!, /no-store/);
  const result = await created.json(); const first = result.board.id; const firstCookie = cookie(created);
  assert.deepEqual(Object.keys(result.board).sort(), ['created_at','id','listed','title']);
  assert(!JSON.stringify(result).includes(password));
  assert.equal((await app(req(path(first)))).status, 401);
  assert.equal((await app(req(path(first), { cookie:firstCookie }))).status, 200);
  const secondResponse = await app(req('/api/boards', { body:{ title:'Second board', password:'a different passphrase here' } }));
  const second = (await secondResponse.json()).board.id;
  assert.equal((await app(req(path(second), { cookie:firstCookie }))).status, 401);
  const wrong = await app(req(path(second,'unlock'), { cookie:firstCookie, body:{ password } }));
  const missing = await app(req(path(randomUUID(),'unlock'), { body:{password} }));
  assert.equal(wrong.status, 401); assert.equal(missing.status, 401); assert.deepEqual(await wrong.json(), await missing.json());
  const opened = await app(req(path(second,'unlock'), { cookie:firstCookie, body:{password:'a different passphrase here'} }));
  assert.equal(opened.status, 200); assert.equal(cookie(opened), firstCookie);
  assert.equal((await app(req(path(second), {cookie:firstCookie}))).status, 200);
  assert.equal((await app(req(path(first,'lock'), {cookie:firstCookie,body:{}}))).status, 200);
  assert.equal((await app(req(path(first), {cookie:firstCookie}))).status, 401);
  assert.equal((await app(req(path(second), {cookie:firstCookie}))).status, 200);
  now += 8 * 86400000;
  assert.equal((await app(req(path(second), {cookie:firstCookie}))).status, 401);
  assert(![...store.grants.keys()].some(k => k.includes(firstCookie.split('=')[1])));
});

test('cross-origin, same-site sibling, missing CSRF header and bad content types fail before writes', async () => {
  const store = new MemoryStore(); const app = createApp(store, config); const data={title:'Test',password:'some long password'};
  for (const options of [{origin:'https://evil.example'},{site:'same-site'}]) {
    assert.equal((await app(req('/api/boards',{body:data,...options}))).status,403);
  }
  const noHeader = req('/api/boards',{body:data}); noHeader.headers.delete('x-board-request');
  assert.equal((await app(noHeader)).status,403);
  const text=req('/api/boards',{body:data}); text.headers.set('content-type','text/plain');
  assert.equal((await app(text)).status,415); assert.equal(store.credentials.size,0);
});

test('input sizes, malformed cookies, and caller-supplied session tokens are rejected', async () => {
  const store = new MemoryStore(); const app = createApp(store, config);
  for (const data of [{title:'',password:'a long enough password'},{title:'Test',password:'short'},{title:'Test',password:'x'.repeat(300)},{title:'Test',password:'valid long password',token:'chosen'}]) {
    assert.equal((await app(req('/api/boards',{body:data}))).status,400);
  }
  assert.equal((await app(req('/api/boards',{body:{title:'x'.repeat(5000),password:'long enough password'}}))).status,413);
  for(const malformed of ['__Host-board_session=bad','__Host-board_session='+newToken()+'; __Host-board_session='+newToken()]) {
    assert.equal((await app(req(path(randomUUID()),{cookie:malformed}))).status,401);
  }
  const attackerChosen = `__Host-board_session=${newToken()}`;
  const created=await app(req('/api/boards',{body:{title:'Test',password:'long enough password'},cookie:attackerChosen}));
  assert.equal(created.status,201); assert.notEqual(cookie(created),attackerChosen);
});

test('distributed limiter fails closed and does not leak IP addresses into bucket keys', async () => {
  const store=new MemoryStore(); const app=createApp(store,config);
  store.blocked=true;
  const blocked=await app(req('/api/boards',{body:{title:'Test',password:'long enough password'}}));
  assert.equal(blocked.status,429); assert.equal(blocked.headers.get('retry-after'),'60'); assert.equal(store.credentials.size,0);
  assert(store.rateCalls.every(k=>/^[a-f0-9]{64}$/.test(k)));
  store.blocked=false;store.unavailable=true;
  assert.equal((await app(req('/api/boards',{body:{title:'Test',password:'long enough password'}}))).status,503);
});

test('production requires the trusted platform IP header, not arbitrary x-forwarded-for', async () => {
  const store=new MemoryStore();const app=createApp(store,config);
  const request=req('/api/boards',{body:{title:'Test',password:'long enough password'}});
  request.headers.delete('x-vercel-forwarded-for'); request.headers.set('x-forwarded-for','203.0.113.123');
  assert.equal((await app(request)).status,503);
});

test('entry mutations other than posting fail closed', async () => {
  const app=createApp(new MemoryStore(),config);
  const id=randomUUID();
  for(const method of ['PATCH','PUT','DELETE']) assert.equal((await app(new Request(config.origin+path(id),{method}))).status,405);
  assert.equal((await app(req(path(id)+'/entries'))).status,401);
  for(const method of ['PATCH','PUT','DELETE'])assert.equal((await app(new Request(config.origin+path(id)+'/entries/'+randomUUID(),{method}))).status,405);
});

test('sessions store only hashes of random tokens', async () => {
  const store=new MemoryStore(); const app=createApp(store,config);
  const token=newToken(),id=randomUUID();
  store.credentials.set(id,{id,title:'Hidden title',created_at:new Date().toISOString(),password_hash:await hashPassword('valid long password')});
  await store.grant(digestToken(token),id,new Date(Date.now()+10000).toISOString());
  const r=await app(req(path(id),{cookie:`__Host-board_session=${token}`}));
  assert.equal(r.status,200);assert(!JSON.stringify(await r.json()).includes(token));
});

test('configuration rejects exposed-origin mistakes and insecure production URLs', () => {
  const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SECRET_KEY:'test',APP_ORIGIN:config.origin,RATE_LIMIT_SECRET:config.rateSecret,VERCEL:'1'};
  assert.equal(readConfig(env).origin,config.origin);
  assert.throws(()=>readConfig({...env,APP_ORIGIN:config.origin+'/path'}));
  assert.throws(()=>readConfig({...env,APP_ORIGIN:'http://example.com'}));
  assert.throws(()=>readConfig({...env,RATE_LIMIT_SECRET:'short'}));
  assert.throws(()=>readConfig({}));
});
