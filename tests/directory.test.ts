import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.ts';
import { parseDirectoryQuery } from '../server/directory.ts';
import { MemoryStore } from './memory-store.ts';
import { mountDirectory } from '../src/directory.ts';
import type { AppConfig } from '../server/types.ts';

const config: AppConfig = { origin: 'https://board.example', supabaseUrl: 'https://test.supabase.co', secretKey: 'test-only', rateSecret: 'd'.repeat(64), production: true };
const post = (body: unknown) => new Request(config.origin + '/api/boards', { method: 'POST', headers: { origin: config.origin, 'sec-fetch-site': 'same-origin', 'x-board-request': '1', 'content-type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.5' }, body: JSON.stringify(body) });
const find = (query: string, ip = '203.0.113.6') => new Request(config.origin + '/api/boards' + query, { headers: { 'x-vercel-forwarded-for': ip } });
const passphrase = 'sixteen chars or more here';

async function listedBoard(app: ReturnType<typeof createApp>, title: string, listed: boolean) {
  const response = await app(post({ title, password: passphrase, listed }));
  assert.equal(response.status, 201);
  return (await response.json()).board as { id: string; title: string; listed: boolean };
}

test('boards are unlisted by default; listing is a boolean that needs a 16-character password', async () => {
  const store = new MemoryStore(), app = createApp(store, config);
  const plain = await app(post({ title: 'Plain', password: 'twelve chars!' }));
  assert.equal(plain.status, 201); assert.equal((await plain.json()).board.listed, false);
  const listed = await listedBoard(app, 'Public name', true);
  assert.equal(listed.listed, true);
  for (const data of [{ title: 'T', password: 'only fifteen ch', listed: true }, { title: 'T', password: passphrase, listed: 'yes' }, { title: 'T', password: passphrase, listed: 1 }, { title: 'T', password: passphrase, unlisted: true }]) {
    assert.equal((await app(post(data))).status, 400);
  }
  assert.equal(store.credentials.size, 2);
});

test('search finds only listed boards by word prefix and exposes nothing else', async () => {
  const store = new MemoryStore(), app = createApp(store, config);
  const garden = await listedBoard(app, 'Garden notes', true);
  await listedBoard(app, 'Garden secrets', false);
  await listedBoard(app, 'Kitchen', true);
  const response = await app(find('?q=gar'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control')!, /private, no-store/);
  assert.equal(response.headers.get('set-cookie'), null);
  const body = await response.json();
  assert.deepEqual(body.boards.map((b: { id: string }) => b.id), [garden.id]);
  assert.deepEqual(Object.keys(body.boards[0]).sort(), ['created_at', 'id', 'title']);
  assert.equal(body.more, false);
  assert.deepEqual((await (await app(find('?q=notes%20gar'))).json()).boards.length, 1);
  assert.deepEqual((await (await app(find('?q=nothing'))).json()).boards, []);
  assert(!JSON.stringify(body).includes('password'));
});

test('search input is validated and reduced to plain words', async () => {
  for (const query of ['', '?q=', '?q=a', '?q=%20%20', '?q=!!', '?q=a%20b', '?q=gar&x=1', '?q=a&q=b', `?q=${'x'.repeat(81)}`, '?q=bad%00text']) {
    assert.throws(() => parseDirectoryQuery(new URL('https://x.example/api/boards' + query).searchParams), /Enter a board|Search with/, query);
  }
  assert.deepEqual(parseDirectoryQuery(new URLSearchParams({ q: `Gar:* & !x'\\ gar "den"` })), ['gar', 'x', 'den']);
  assert.deepEqual(parseDirectoryQuery(new URLSearchParams({ q: 'one two three four five six seven' })), ['one', 'two', 'three', 'four', 'five']);
  assert.equal(parseDirectoryQuery(new URLSearchParams({ q: 'ab' + 'c'.repeat(60) }))[0].length, 40);
  const store = new MemoryStore(), app = createApp(store, config);
  assert.equal((await app(find('?q=a'))).status, 400);
  assert.equal((await app(find(''))).status, 400);
  assert.equal(store.searches.length, 0);
  assert.equal((await app(find("?q=%22%3B%20drop%20table%20boards%3B%20--"))).status, 200);
  assert.deepEqual(store.searches.at(-1), ['drop', 'table', 'boards']);
});

test('search shows at most 20 boards, reports more, and fails closed when limited or unavailable', async () => {
  const store = new MemoryStore(), app = createApp(store, config);
  for (let i = 0; i < 22; i++) {
    const id = randomUUID();
    store.credentials.set(id, { id, title: `Shared board ${i}`, password_hash: 'x', created_at: new Date(Date.now() + i).toISOString(), listed: true });
  }
  const body = await (await app(find('?q=shared'))).json();
  assert.equal(body.boards.length, 20); assert.equal(body.more, true);
  store.blocked = true;
  const limited = await app(find('?q=shared'));
  assert.equal(limited.status, 429); assert(limited.headers.get('retry-after'));
  store.blocked = false; store.unavailable = true;
  assert.equal((await app(find('?q=shared'))).status, 503);
  assert(store.rateCalls.every(key => /^[a-f0-9]{64}$/.test(key)));
});

test('search is read-only: other methods and mutations of /api/boards stay closed', async () => {
  const app = createApp(new MemoryStore(), config);
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await app(new Request(config.origin + '/api/boards', { method }))).status, 405);
  const crossSite = new Request(config.origin + '/api/boards', { method: 'POST', headers: { origin: 'https://evil.example', 'x-board-request': '1', 'content-type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.5' }, body: '{}' });
  assert.equal((await app(crossSite)).status, 403);
});

test('PostgreSQL directory: only listed boards, inert input, and boards stay immutable except delisting', async t => {
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
  const create = async (title: string, listed?: boolean) => (await db.query<{ id: string; listed: boolean }>(
    listed === undefined ? `select * from public.create_board_with_session($1,$2,$3,now()+interval '7 days')` : `select * from public.create_board_with_session($1,$2,$3,now()+interval '7 days',$4)`,
    listed === undefined ? [title, hash, 'a'.repeat(64)] : [title, hash, 'a'.repeat(64), listed])).rows[0];
  const search = async (words: string[]) => {
    await db.exec('set role service_role');
    try { return (await db.query<{ id: string; title: string }>('select * from public.search_listed_boards($1)', [words])).rows; } finally { await db.exec('reset role'); }
  };
  const defaulted = await create('Default board'), garden = await create('Garden notes', true), hidden = await create('Garden hidden', false);
  assert.equal(defaulted.listed, false); assert.equal(garden.listed, true);

  await t.test('returns listed boards only, by prefix, without hashes', async () => {
    assert.deepEqual((await search(['gar'])).map(r => r.id), [garden.id]);
    assert.deepEqual((await search(['GARDEN', 'not'])).map(r => r.id), [garden.id]);
    assert.deepEqual(await search(['hidden']), []);
    assert.deepEqual(Object.keys((await search(['gar']))[0]).sort(), ['created_at', 'id', 'title']);
  });
  await t.test('quotes, operators and SQL stay inert', async () => {
    for (const word of ["it's", 'a\\b', "x'); drop table public.boards; --", '&', '!', ':*', '|', '(', '<->']) await search([word, 'gar']);
    assert.equal((await db.query<{ n: number }>('select count(*)::int as n from public.boards')).rows[0].n, 3);
    assert.deepEqual((await search(['gar', "o'neil"])).map(r => r.id), []);
  });
  await t.test('word count is bounded', async () => {
    await db.exec('set role service_role');
    try {
      await assert.rejects(db.query('select * from public.search_listed_boards($1)', [[]]), /Invalid search/);
      await assert.rejects(db.query('select * from public.search_listed_boards($1)', [['a', 'b', 'c', 'd', 'e', 'f']]), /Invalid search/);
    } finally { await db.exec('reset role'); }
  });
  await t.test('browser roles cannot search, create, or read boards', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(db.query('select * from public.search_listed_boards($1)', [['gar']]), /permission denied/);
        await assert.rejects(db.query(`select * from public.create_board_with_session($1,$2,$3,now()+interval '7 days',true)`, ['No', hash, 'b'.repeat(64)]), /permission denied/);
        await assert.rejects(db.query('select title_search, listed from public.boards'), /permission denied/);
      } finally { await db.exec('reset role'); }
    }
  });
  await t.test('the runtime role cannot change listing; the operator can only delist', async () => {
    await db.exec('set role service_role');
    try {
      await assert.rejects(db.exec(`update public.boards set listed=true where id='${hidden.id}'`), /permission denied/);
      await assert.rejects(db.exec(`update public.boards set listed=false where id='${garden.id}'`), /permission denied/);
    } finally { await db.exec('reset role'); }
    await assert.rejects(db.exec(`update public.boards set listed=true where id='${hidden.id}'`), /immutable except for delisting/);
    await assert.rejects(db.exec(`update public.boards set title='Renamed' where id='${garden.id}'`), /immutable except for delisting/);
    await assert.rejects(db.exec(`update public.boards set listed=false, title='Renamed' where id='${garden.id}'`), /immutable except for delisting/);
    await assert.rejects(db.exec(`delete from public.boards where id='${hidden.id}'`), /immutable except for delisting/);
    await assert.rejects(db.exec('truncate public.boards cascade'), /immutable except for delisting/);
    await db.exec(`update public.boards set listed=false where id='${garden.id}'`);
    assert.deepEqual(await search(['gar']), []);
    await assert.rejects(db.exec(`update public.boards set listed=true where id='${garden.id}'`), /immutable except for delisting/);
  });
  await t.test('results are capped at 21 rows', async () => {
    for (let i = 0; i < 25; i++) await create(`Capacity test ${i}`, true);
    assert.equal((await search(['capacity'])).length, 21);
  });
});

// Minimal browser environment, as in editor.test.ts.
function environment() {
  const dom = new JSDOM('<!doctype html><div id="box"></div>', { url: 'https://board.example', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location, DOMException: dom.window.DOMException })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  const oldFetch = globalThis.fetch;
  return { dom, root: dom.window.document.querySelector<HTMLElement>('#box')!, restore() { globalThis.fetch = oldFetch; for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } dom.window.close(); } };
}
async function until(condition: () => boolean) { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('UI condition did not settle'); }

test('home search waits for 2 characters, cancels stale requests, and renders titles as text', async () => {
  const env = environment(); const urls: string[] = []; const signals: (AbortSignal | null | undefined)[] = [];
  const navigated: string[] = [], opened: string[] = [];
  const hostile = '<img src=x onerror=alert(1)> Garden', id = randomUUID();
  let resolveOld: ((value: Response) => void) | undefined;
  let dispose = () => {};
  try {
    globalThis.fetch = async (url, init) => {
      urls.push(String(url)); signals.push(init?.signal);
      if (String(url).endsWith('q=old')) return new Promise<Response>(resolve => { resolveOld = resolve; });
      return Response.json({ boards: [{ id, title: hostile, created_at: new Date().toISOString() }], more: false });
    };
    dispose = mountDirectory(env.root, { navigate: path => { navigated.push(path); }, opened: (boardId, title) => { opened.push(`${boardId}|${title}`); } });
    const input = env.root.querySelector<HTMLInputElement>('#board-find')!;
    const type = (value: string) => { input.value = value; input.dispatchEvent(new env.dom.window.Event('input')); };
    type('g'); await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(urls.length, 0); assert.match(env.root.querySelector('#find-status')!.textContent!, /at least 2/);
    type('old'); await until(() => !!resolveOld);
    type('gar'); assert(signals[0]?.aborted);
    resolveOld!(Response.json({ boards: [{ id: randomUUID(), title: 'Stale board', created_at: new Date().toISOString() }], more: false }));
    await until(() => !!env.root.querySelector('#find-results a'));
    assert.doesNotMatch(env.root.querySelector('#find-results')!.textContent!, /Stale board/);
    assert.equal(env.root.querySelector('#find-results img'), null);
    assert.equal(env.root.querySelector('.find-name')!.textContent, hostile);
    assert.equal(urls.at(-1), '/api/boards?q=gar');
    env.root.querySelector<HTMLAnchorElement>('#find-results a')!.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    assert.deepEqual(navigated, [`/b/${id}`]); assert.deepEqual(opened, [`${id}|${hostile}`]);
  } finally { dispose(); env.restore(); }
});

test('home search explains empty results and failures', async () => {
  const env = environment(); let mode: 'empty' | 'limited' | 'down' = 'empty'; let dispose = () => {};
  try {
    globalThis.fetch = async () => {
      if (mode === 'empty') return Response.json({ boards: [], more: false });
      if (mode === 'limited') return Response.json({ error: { code: 'RATE_LIMIT', message: 'Please wait a little before trying again.' } }, { status: 429 });
      throw new Error('offline');
    };
    dispose = mountDirectory(env.root, { navigate: () => {}, opened: () => {} });
    const input = env.root.querySelector<HTMLInputElement>('#board-find')!, status = env.root.querySelector<HTMLElement>('#find-status')!;
    const submit = () => env.root.querySelector('#find-form')!.dispatchEvent(new env.dom.window.Event('submit', { cancelable: true }));
    input.value = 'nothing'; submit(); await until(() => /No listed boards/.test(status.textContent!));
    mode = 'limited'; input.value = 'limited'; submit(); await until(() => /Please wait/.test(status.textContent!)); assert.equal(status.getAttribute('role'), 'alert');
    mode = 'down'; input.value = 'offline'; submit(); await until(() => /Could not connect/.test(status.textContent!));
  } finally { dispose(); env.restore(); }
});
