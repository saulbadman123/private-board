import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import { digestToken, hashPassword, newToken } from '../server/crypto.ts';
import { MemoryStore } from './memory-store.ts';
import type { AppConfig } from '../server/types.ts';

const config: AppConfig = { origin: 'https://board.example', supabaseUrl: 'https://test.supabase.co', secretKey: 'test-only', rateSecret: 'r'.repeat(64), production: true };

async function fixture(overrides: Partial<AppConfig> = {}) {
  const store = new MemoryStore(), id = randomUUID(), token = newToken();
  store.credentials.set(id, { id, title: 'Private', password_hash: await hashPassword('long enough password'), created_at: new Date().toISOString() });
  await store.grant(digestToken(token), id, new Date(Date.now() + 86400000).toISOString());
  const app = createApp(store, { ...config, ...overrides });
  const path = `/api/boards/${id}/entries`;
  function request(url: string, body?: unknown, withCookie = true) {
    return new Request(config.origin + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: config.origin, 'sec-fetch-site': 'same-origin', 'x-board-request': '1', 'content-type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.9', ...(withCookie ? { cookie: `__Host-board_session=${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  const note = (requestId: string, markdown: string) => ({ kind: 'note', requestId, markdown });
  return { store, id, token, app, path, request, note };
}

test('simultaneous identical submissions create exactly one entry and every caller gets it', async () => {
  const f = await fixture(); const requestId = randomUUID();
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.app(f.request(f.path, f.note(requestId, 'Same words')))));
  assert.equal(f.store.notes.size, 1);
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 7);
  const ids = new Set((await Promise.all(responses.map(r => r.json()))).map(body => body.entry.id));
  assert.equal(ids.size, 1);
});

test('simultaneous different content under one submission ID keeps only the first and reports conflicts', async () => {
  const f = await fixture(); const requestId = randomUUID();
  const responses = await Promise.all(['first', 'second', 'third'].map(text => f.app(f.request(f.path, f.note(requestId, text)))));
  assert.equal(f.store.notes.size, 1);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409, 409]);
  const winner = [...f.store.notes.values()][0];
  const read = await f.app(f.request(`${f.path}/${winner.id}`));
  assert.equal((await read.json()).entry.markdown, winner.markdown);
});

test('capacity switch pauses creation and posting but keeps unlock and reads working', async () => {
  const f = await fixture({ writesDisabled: true });
  const create = await f.app(f.request('/api/boards', { title: 'New', password: 'long enough password' }, false));
  assert.equal(create.status, 503); assert.equal((await create.json()).error.code, 'READ_ONLY'); assert.equal(create.headers.get('retry-after'), '300');
  assert.equal(f.store.credentials.size, 1);
  const post = await f.app(f.request(f.path, f.note(randomUUID(), 'Blocked')));
  assert.equal(post.status, 503); assert.equal((await post.json()).error.code, 'READ_ONLY'); assert.equal(f.store.notes.size, 0);
  assert.equal((await f.app(f.request(f.path))).status, 200);
  assert.equal((await f.app(f.request(`/api/boards/${f.id}`))).status, 200);
  const unlock = await f.app(f.request(`/api/boards/${f.id}/unlock`, { password: 'long enough password' }, false));
  assert.equal(unlock.status, 200);
});

test('unauthenticated callers still get 401 before any capacity detail, and writes resume when re-enabled', async () => {
  const paused = await fixture({ writesDisabled: true });
  assert.equal((await paused.app(paused.request(paused.path, paused.note(randomUUID(), 'x'), false))).status, 401);
  const open = await fixture({ writesDisabled: false });
  assert.equal((await open.app(open.request(open.path, open.note(randomUUID(), 'x')))).status, 201);
});

test('WRITES_DISABLED accepts only 0 or 1', () => {
  const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'test', APP_ORIGIN: config.origin, RATE_LIMIT_SECRET: config.rateSecret, VERCEL: '1' };
  assert.equal(readConfig(env).writesDisabled, false);
  assert.equal(readConfig({ ...env, WRITES_DISABLED: '0' }).writesDisabled, false);
  assert.equal(readConfig({ ...env, WRITES_DISABLED: '1' }).writesDisabled, true);
  assert.throws(() => readConfig({ ...env, WRITES_DISABLED: 'true' }));
});

test('every kind of private response is uncacheable, sniff-proof and same-origin only', async () => {
  const f = await fixture(); const missing = randomUUID();
  const responses = await Promise.all([
    f.app(f.request(`/api/boards/${f.id}`)),
    f.app(f.request(f.path)),
    f.app(f.request(`${f.path}/${missing}`)),
    f.app(f.request(f.path, f.note(randomUUID(), 'Cache check'))),
    f.app(f.request(`/api/boards/${f.id}`, undefined, false)),
    f.app(f.request(`/api/boards/${missing}/unlock`, { password: 'wrong password here' }, false)),
    f.app(f.request('/not-api')),
    f.app(new Request(config.origin + `/api/boards/${f.id}`, { method: 'DELETE' }))
  ]);
  assert.deepEqual(responses.map(r => r.status), [200, 200, 404, 201, 401, 401, 404, 405]);
  for (const response of responses) {
    assert.match(response.headers.get('cache-control')!, /private, no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
    assert.match(response.headers.get('vary')!, /cookie/i);
  }
});

test('backend failures are logged generically and never echo credentials or bodies', async t => {
  const f = await fixture(); const logged = t.mock.method(console, 'error', () => {});
  const secret = 'hunter2-super-secret-password';
  f.store.postNote = async () => { throw new Error(`insert failed for ${secret}`); };
  const response = await f.app(f.request(f.path, f.note(randomUUID(), `Body containing ${secret}`)));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert(!text.includes(secret));
  assert.equal(logged.mock.calls.length, 1);
  const output = JSON.stringify(logged.mock.calls.map(call => call.arguments.map(String)));
  assert(!output.includes(secret)); assert(!output.includes(f.token));
});

test('an unavailable limiter blocks every write and unlock path without touching content', async () => {
  const f = await fixture(); f.store.unavailable = true;
  assert.equal((await f.app(f.request(f.path, f.note(randomUUID(), 'x')))).status, 503);
  assert.equal((await f.app(f.request(`/api/boards/${f.id}/unlock`, { password: 'long enough password' }, false))).status, 503);
  assert.equal((await f.app(f.request('/api/boards', { title: 'T', password: 'long enough password' }, false))).status, 503);
  assert.equal(f.store.notes.size, 0); assert.equal(f.store.credentials.size, 1);
});

test('a grant that expires between sessions cannot post, and a lost commit acknowledgment replays the saved note', async () => {
  const f = await fixture(); const requestId = randomUUID();
  f.store.failAfterWrite = true;
  assert.equal((await f.app(f.request(f.path, f.note(requestId, 'Saved once')))).status, 503);
  assert.equal(f.store.notes.size, 1);
  const retry = await f.app(f.request(f.path, f.note(requestId, 'Saved once')));
  assert.equal(retry.status, 200); assert.equal((await retry.json()).replayed, true); assert.equal(f.store.notes.size, 1);
  f.store.grants.clear();
  assert.equal((await f.app(f.request(f.path, f.note(randomUUID(), 'After expiry')))).status, 401);
  assert.equal(f.store.notes.size, 1);
});
