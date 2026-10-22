import { ApiError } from './api.ts';
import type { BoardResponse } from './api.ts';

// Lifecycle of an unlocked board while the tab is hidden and shown again. It decides what
// to do; the host (main.ts) owns the DOM, routing, and timers. Nothing here touches the
// document, so it can be tested with a fake host.
export type SessionHost = {
  check(boardId: string, signal: AbortSignal): Promise<BoardResponse>;
  conceal(): void;
  reveal(response: BoardResponse): void;
  failed(message: string): void;
  gate(boardId: string, message: string): void;
  remount(): void;
  now(): number;
};
type State = 'idle' | 'visible' | 'concealed' | 'checking' | 'failed';
export const EXPIRED_MESSAGE = 'Your access expired. Enter the password to open this board again.';
export const CHECK_FAILED_MESSAGE = 'Could not check access.';
// After this long hidden, the board is rebuilt from scratch instead of restored in place.
export const MAX_HIDDEN_MS = 30 * 60 * 1000;

export function createBoardSession(host: SessionHost, { maxHiddenMs = MAX_HIDDEN_MS } = {}) {
  let state: State = 'idle';
  let boardId = '', expiresAt = 0, hiddenAt: number | null = null;
  let attempt = 0, controller: AbortController | undefined;
  let queue: { boardId: string; run: () => void }[] = [];

  function cancelCheck() { attempt++; controller?.abort(); controller = undefined; }
  function flush() {
    const ready = queue.filter(item => item.boardId === boardId);
    queue = [];
    for (const item of ready) item.run();
  }
  async function check() {
    cancelCheck();
    state = 'checking';
    const mine = attempt, id = boardId, own = controller = new AbortController();
    let response: BoardResponse;
    try {
      response = await host.check(id, own.signal);
      if (response.board.id !== id) throw new Error('Unexpected board');
    } catch (error) {
      if (mine !== attempt) return;
      controller = undefined;
      if (error instanceof ApiError && error.status === 401) { state = 'idle'; host.gate(id, ''); return; }
      state = 'failed'; host.failed(CHECK_FAILED_MESSAGE); return;
    }
    if (mine !== attempt) return;
    controller = undefined;
    expiresAt = Date.parse(response.expiresAt);
    if (!(host.now() < expiresAt)) { state = 'idle'; host.gate(id, EXPIRED_MESSAGE); return; }
    state = 'visible'; hiddenAt = null;
    host.reveal(response);
    flush();
  }

  return {
    state: () => state,
    // A board is on screen (or concealed in place); false while idle.
    active: () => state !== 'idle',
    // Private content was just rendered. Pass visible=false when the tab is already hidden.
    show(id: string, expires: string, visible = true) {
      cancelCheck();
      boardId = id; expiresAt = Date.parse(expires);
      if (!visible) { state = 'concealed'; hiddenAt = host.now(); host.conceal(); return; }
      state = 'visible'; hiddenAt = null;
      flush();
    },
    // Route change, gate, lock, or page teardown: nothing from an older check may land later.
    stop() { cancelCheck(); state = 'idle'; hiddenAt = null; },
    hidden() {
      if (state === 'idle') return;
      cancelCheck();
      if (state === 'visible') { hiddenAt = host.now(); host.conceal(); }
      state = 'concealed';
    },
    resumed() {
      if (state !== 'concealed') return;
      if (!(host.now() < expiresAt)) { state = 'idle'; host.gate(boardId, EXPIRED_MESSAGE); return; }
      if (hiddenAt !== null && host.now() - hiddenAt > maxHiddenMs) { state = 'idle'; host.remount(); return; }
      void check();
    },
    retry() { if (state === 'failed') void check(); },
    // Runs now while the board is visible; otherwise after the next successful reveal or unlock
    // of the same board. A user-driven navigation or Lock discards what is waiting.
    defer(id: string, run: () => void) {
      if (state === 'visible' && id === boardId) run();
      else queue.push({ boardId: id, run });
    },
    discardDeferred() { queue = []; }
  };
}

// DOM side of concealing: the board stays mounted, but is invisible, inert, and out of the
// accessibility tree, so selection, scroll, and half-typed text survive a tab switch.
export function createConcealer(root: HTMLElement) {
  let cover: HTMLElement | null = null, focused: Element | null = null;
  const main = () => root.querySelector<HTMLElement>('#main');
  function message(text: string, retry?: () => void) {
    const doc = root.ownerDocument;
    if (!cover?.isConnected) { cover = doc.createElement('div'); cover.className = 'resume-cover'; cover.setAttribute('role', 'status'); root.append(cover); }
    const line = doc.createElement('p'); line.textContent = text;
    cover.replaceChildren(line);
    if (retry) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Retry';
      button.addEventListener('click', retry); cover.append(button);
    }
  }
  return {
    conceal() {
      const target = main();
      if (!target) return;
      const active = root.ownerDocument.activeElement;
      if (!target.classList.contains('concealed')) focused = active && target.contains(active) ? active : null;
      target.classList.add('concealed'); target.toggleAttribute('inert', true);
      message('Checking access…');
    },
    failed(text: string, retry: () => void) { message(text, () => { message('Checking access…'); retry(); }); },
    reveal() {
      cover?.remove(); cover = null;
      const target = main(), previous = focused as HTMLElement | null; focused = null;
      if (!target) return;
      target.classList.remove('concealed'); target.toggleAttribute('inert', false);
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    },
    // The whole root was replaced; forget the old elements.
    reset() { cover = null; focused = null; }
  };
}
