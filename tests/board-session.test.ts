import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {registerHooks} from 'node:module';
import {mountBoardSession} from '../src/board-session.ts';
import {mountBoard, clearBoardReceipt} from '../src/board.ts';
import {clearDraft, draftFor, drawingDraftFor} from '../src/drafts.ts';

const settled = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('UI did not settle');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function environment() {
  const dom = new JSDOM('<!doctype html><div id="app"><main><div id="private-surface"><div id="board"></div></div><section id="cover" hidden><p data-access-status role="status"></p><button data-access-retry hidden>Retry</button></section></main></div><div id="toast"></div>', {url: 'https://board.example', pretendToBeVisual: true});
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, matchMedia: () => ({matches: false, addEventListener() {}}), navigator: dom.window.navigator, Event: dom.window.Event, DOMException: dom.window.DOMException, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)})) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, writable: true, configurable: true});
  }
  let hidden = false;
  Object.defineProperty(dom.window.document, 'hidden', {get: () => hidden});
  const root = document.querySelector<HTMLElement>('#board')!;
  const surface = document.querySelector<HTMLElement>('#private-surface')!;
  const cover = document.querySelector<HTMLElement>('#cover')!;
  const oldFetch = globalThis.fetch;
  const id = randomUUID();
  const response = {board: {id, title: 'Private title', created_at: new Date().toISOString()}, expiresAt: new Date(Date.now() + 60_000).toISOString()};
  const controller = new AbortController();
  let expired = 0;
  let session: ReturnType<typeof mountBoardSession> | undefined;
  let disposeBoard = () => {};
  const paths: string[] = [];
  return {
    dom, root, surface, cover, id, response, controller, paths,
    get expired() { return expired; },
    get session() { return session!; },
    visibility(value: boolean) { hidden = value; document.dispatchEvent(new dom.window.Event('visibilitychange')); },
    start(view?: 'feed' | 'compose') {
      if (view) disposeBoard = mountBoard({container: root, view, response, signal: controller.signal, navigate: path => paths.push(path), expired: () => { expired++; }, toast: () => {}, afterAccess: action => session?.runWhenVisible(action)});
      session = mountBoardSession({response, surface, cover, signal: controller.signal, expired: () => { expired++; }});
    },
    restore() {
      session?.dispose(); disposeBoard(); clearDraft(id); clearBoardReceipt(id); globalThis.fetch = oldFetch;
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
      dom.window.close();
    }
  };
}

test('tab return retains the editor DOM, selection and preview without aborting its route', async () => {
  const env = environment();
  const access = deferred<Response>();
  let checks = 0;
  try {
    globalThis.fetch = async () => { checks++; return access.promise; };
    env.start('compose');
    const textarea = env.root.querySelector<HTMLTextAreaElement>('#note-body')!;
    textarea.value = 'Keep my selected words'; textarea.dispatchEvent(new Event('input'));
    textarea.focus(); textarea.setSelectionRange(5, 16, 'backward'); textarea.scrollTop = 40;
    env.visibility(true);
    assert.equal(env.surface.inert, true); assert.equal(env.surface.getAttribute('aria-hidden'), 'true');
    assert(env.surface.classList.contains('private-concealed')); assert.equal(document.title, 'Private Board');
    assert.equal(env.controller.signal.aborted, false); assert.equal(checks, 0);
    env.visibility(false); env.visibility(false);
    assert.equal(checks, 1); assert.equal(env.cover.hidden, false);
    access.resolve(Response.json(env.response)); await until(() => env.cover.hidden === true);
    assert.equal(env.root.querySelector('#note-body'), textarea);
    assert.equal(textarea.value, 'Keep my selected words'); assert.equal(textarea.scrollTop, 40);
    assert.equal(document.activeElement, textarea); assert.equal(textarea.selectionStart, 5); assert.equal(textarea.selectionEnd, 16);
    assert.equal(textarea.selectionDirection, 'backward'); assert.equal(env.surface.inert, false);
    assert.equal(document.title, 'Private title · Private Board');
    env.root.querySelector<HTMLButtonElement>('#preview-tab')!.click();
    globalThis.fetch = async () => Response.json(env.response);
    env.visibility(true); env.visibility(false); await until(() => env.cover.hidden === true);
    assert.equal(env.root.querySelector('#note-body'), textarea);
    assert.equal(env.root.querySelector('#preview-tab')!.getAttribute('aria-selected'), 'true');
    assert.equal(env.root.querySelector<HTMLElement>('#write-panel')!.hidden, true);
  } finally { env.restore(); }
});

test('a paginated feed stays on page two and does not reread entries on tab return', async () => {
  const env = environment(); let reads = 0, checks = 0;
  try {
    globalThis.fetch = async url => {
      if (String(url).endsWith('/entries') || String(url).includes('/entries?')) {
        reads++;
        return Response.json({entries: [{id: randomUUID(), board_id: env.id, kind: 'note', title: `Page ${reads}`, excerpt: 'Keep this place', tags: [], created_at: new Date().toISOString()}], pageCursor: null, nextCursor: reads === 1 ? 'page-two' : null});
      }
      checks++; return Response.json(env.response);
    };
    env.start('feed'); await until(() => !!env.root.querySelector('.note-card'));
    env.root.querySelector<HTMLButtonElement>('#next-page')!.click();
    await until(() => /Page 2/.test(env.root.querySelector('#feed-status')!.textContent!));
    const card = env.root.querySelector('.note-card');
    env.visibility(true); env.visibility(false); await until(() => env.cover.hidden === true);
    assert.equal(env.root.querySelector('.note-card'), card); assert.equal(reads, 2); assert.equal(checks, 1);
    assert.match(env.root.querySelector('#feed-status')!.textContent!, /Page 2/);
  } finally { env.restore(); }
});

test('a note can finish in the background; its success navigation waits for access', async () => {
  const env = environment(), post = deferred<Response>(), access = deferred<Response>();
  let sent: Record<string, unknown> = {}, postSignal: AbortSignal | null | undefined;
  try {
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') { sent = JSON.parse(String(init.body)); postSignal = init.signal; return post.promise; }
      return access.promise;
    };
    env.start('compose');
    const textarea = env.root.querySelector<HTMLTextAreaElement>('#note-body')!;
    textarea.value = 'A background post'; textarea.dispatchEvent(new Event('input'));
    env.root.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    env.visibility(true);
    assert.equal(postSignal?.aborted, false);
    post.resolve(Response.json({entry: {id: randomUUID(), board_id: env.id, kind: 'note', markdown: sent.markdown}, replayed: false}));
    await until(() => !draftFor(env.id).pending);
    assert.equal(draftFor(env.id).markdown, ''); assert.deepEqual(env.paths, []);
    env.visibility(false); assert.deepEqual(env.paths, []);
    access.resolve(Response.json(env.response)); await until(() => env.paths.length === 1);
    assert.deepEqual(env.paths, [`/b/${env.id}`]);
  } finally { env.restore(); }
});

test('a lost background response retains the frozen note and retries its original request ID', async () => {
  const env = environment(), post = deferred<Response>();
  const sent: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)); sent.push(payload);
        if (sent.length === 1) return post.promise;
        return Response.json({entry: {id: randomUUID(), board_id: env.id, kind: 'note', markdown: payload.markdown}, replayed: true});
      }
      return Response.json(env.response);
    };
    env.start('compose');
    const textarea = env.root.querySelector<HTMLTextAreaElement>('#note-body')!;
    textarea.value = 'Keep the exact attempt'; textarea.dispatchEvent(new Event('input'));
    const submit = () => env.root.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    submit(); env.visibility(true); post.reject(new Error('Lost response after saving'));
    await until(() => !draftFor(env.id).pending);
    assert.equal(textarea.readOnly, true); assert.equal(draftFor(env.id).attempt?.requestId, sent[0].requestId);
    env.visibility(false); await until(() => env.cover.hidden === true);
    assert.equal(sent.length, 1); // Returning never automatically republishes.
    submit(); await until(() => env.paths.length === 1);
    assert.deepEqual(sent[0], sent[1]);
  } finally { env.restore(); }
});

test('drawing strokes finish on hide and uploads keep their canvas and request alive', async () => {
  const env = environment(), post = deferred<Response>();
  const captures = new Set<number>(); let dots = 0; let postSignal: AbortSignal | null | undefined;
  const context = {fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() { dots++; }, fill() {}};
  Object.defineProperty(env.dom.window.HTMLCanvasElement.prototype, 'getContext', {value: () => context});
  Object.defineProperty(env.dom.window.HTMLCanvasElement.prototype, 'toBlob', {value: (callback: (blob: Blob) => void) => callback(new Blob(['drawing'], {type: 'image/png'}))});
  try {
    globalThis.fetch = async (_url, init) => { if (init?.method === 'POST') { postSignal = init.signal; return post.promise; } return Response.json(env.response); };
    env.start('compose'); env.root.querySelector<HTMLButtonElement>('#mode-draw')!.click();
    await until(() => !!env.root.querySelector('canvas'));
    const canvas = env.root.querySelector('canvas')!;
    canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 512, height: 384, right: 512, bottom: 384, x: 0, y: 0, toJSON() {}});
    canvas.setPointerCapture = id => { captures.add(id); };
    canvas.hasPointerCapture = id => captures.has(id);
    canvas.releasePointerCapture = id => { captures.delete(id); };
    const event = new Event('pointerdown', {cancelable: true});
    Object.assign(event, {pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 120}); canvas.dispatchEvent(event);
    env.visibility(true); assert.equal(captures.size, 0); assert.equal(dots, 1);
    env.visibility(false); await until(() => env.cover.hidden === true);
    assert.equal(env.root.querySelector('canvas'), canvas); assert.equal(drawingDraftFor(env.id).ink, true);
    env.root.querySelector('#drawing-form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    await until(() => !!postSignal); env.visibility(true); assert.equal(postSignal?.aborted, false);
    post.resolve(Response.json({entry: {id: randomUUID(), board_id: env.id, kind: 'drawing'}, replayed: false}));
    await until(() => !drawingDraftFor(env.id).pending); assert.deepEqual(env.paths, []);
    env.visibility(false); await until(() => env.paths.length === 1);
  } finally { env.restore(); }
});

test('offline checks keep content concealed and Retry restores the original view', async () => {
  const env = environment(); let calls = 0;
  try {
    globalThis.fetch = async () => { if (++calls === 1) throw new Error('offline'); return Response.json(env.response); };
    env.start('compose'); const original = env.root.querySelector('#note-body');
    env.visibility(true); env.visibility(false);
    const retry = env.cover.querySelector<HTMLButtonElement>('button')!;
    await until(() => !retry.hidden);
    assert.equal(env.expired, 0); assert.equal(env.surface.inert, true); assert.equal(env.cover.hidden, false);
    assert.match(env.cover.textContent!, /Could not check access/);
    retry.click(); await until(() => env.cover.hidden === true);
    assert.equal(env.root.querySelector('#note-body'), original); assert.equal(calls, 2);
  } finally { env.restore(); }
});

test('rapid visibility changes ignore stale checks; route disposal cannot reveal private content', async () => {
  const env = environment(); const requests: {result: ReturnType<typeof deferred<Response>>; signal: AbortSignal | null | undefined}[] = [];
  try {
    globalThis.fetch = async (_url, init) => { const result = deferred<Response>(); requests.push({result, signal: init?.signal}); return result.promise; };
    env.start(); env.visibility(true); env.visibility(false);
    env.visibility(true); assert.equal(requests[0].signal?.aborted, true);
    env.visibility(false); assert.equal(requests.length, 2);
    requests[0].result.resolve(Response.json(env.response)); await settled(); assert.equal(env.cover.hidden, false);
    let ran = false; env.session.runWhenVisible(() => { ran = true; });
    env.controller.abort(); requests[1].result.resolve(Response.json(env.response)); await settled();
    assert.equal(requests[1].signal?.aborted, true); assert.equal(env.surface.inert, true); assert.equal(ran, false);
  } finally { env.restore(); }
});

test('401 expires the view and an invalid board response never reveals it', async () => {
  const env = environment(); let calls = 0;
  try {
    globalThis.fetch = async () => ++calls === 1 ? Response.json({...env.response, board: {...env.response.board, id: randomUUID()}}) : Response.json({error: {code: 'LOCKED'}}, {status: 401});
    env.start(); env.visibility(true); env.visibility(false);
    const retry = env.cover.querySelector<HTMLButtonElement>('button')!;
    await until(() => !retry.hidden); assert.equal(env.surface.inert, true); assert.equal(env.expired, 0);
    retry.click(); await until(() => env.expired === 1);
    assert.equal(env.cover.hidden, false); assert.equal(env.surface.inert, true);
    env.visibility(true); env.visibility(false); assert.equal(calls, 2);
  } finally { env.restore(); }
});

test('initially hidden views stay concealed and expired access never reaches the network', async () => {
  const env = environment(); let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json(env.response); };
    env.response.expiresAt = new Date(Date.now() - 1).toISOString();
    env.visibility(true); env.start();
    assert.equal(env.surface.inert, true); assert.equal(document.title, 'Private Board');
    assert.equal(env.expired, 1); env.visibility(false); await settled(); assert.equal(calls, 0);
  } finally { env.restore(); }
});

test('resume checks the clock even when the background expiry timer has not fired', t => {
  const env = environment(); let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json(env.response); };
    env.start(); env.visibility(true);
    t.mock.method(Date, 'now', () => Date.parse(env.response.expiresAt) + 1);
    env.visibility(false);
    assert.equal(env.expired, 1); assert.equal(calls, 0);
    assert.equal(env.surface.inert, true); assert.equal(env.cover.hidden, false);
  } finally { env.restore(); }
});

test('actual app routing retains the composer on tab return but disposes it for pagehide', async () => {
  const env = environment(); let checks = 0;
  // Node executes the real entrypoint; only CSS loading is stubbed. The browser
  // styles still go through Vite's production build in npm run verify.
  const hooks = registerHooks({load(url, context, nextLoad) {
    if (url.endsWith('.css')) return {format: 'module', source: '', shortCircuit: true};
    return nextLoad(url, context);
  }});
  try {
    history.replaceState({}, '', `/b/${env.id}/new`);
    globalThis.fetch = async () => { checks++; return Response.json(env.response); };
    const entry = new URL('../src/main.ts', import.meta.url); entry.searchParams.set('test', env.id);
    await import(entry.href);
    await until(() => !!document.querySelector('#note-body'));
    const textarea = document.querySelector<HTMLTextAreaElement>('#note-body')!;
    const surface = document.querySelector<HTMLElement>('#private-surface')!;
    const app = document.querySelector('#app')!;
    textarea.value = 'Survive a real visibility event'; textarea.dispatchEvent(new Event('input'));
    env.visibility(true);
    assert.equal(document.querySelector('#note-body'), textarea); assert.equal(surface.inert, true);
    assert(app.childElementCount > 0);
    env.visibility(false); await until(() => !surface.inert);
    assert.equal(checks, 2); assert.equal(document.querySelector('#note-body'), textarea);
    assert.equal(document.querySelector('.loading'), null);
    window.dispatchEvent(new env.dom.window.PageTransitionEvent('pagehide', {persisted: true}));
    assert.equal(app.childElementCount, 0);
    window.dispatchEvent(new env.dom.window.PageTransitionEvent('pageshow', {persisted: true}));
    await until(() => !!document.querySelector('#note-body'));
    assert.notEqual(document.querySelector('#note-body'), textarea);
    assert.equal(document.querySelector<HTMLTextAreaElement>('#note-body')!.value, 'Survive a real visibility event');
    assert.equal(checks, 3);
    window.dispatchEvent(new env.dom.window.PageTransitionEvent('pagehide'));
  } finally { hooks.deregister(); env.restore(); }
});
