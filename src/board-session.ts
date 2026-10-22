import {api, ApiError} from './api.ts';
import type {BoardResponse} from './api.ts';

type Options = {
  response: BoardResponse;
  surface: HTMLElement;
  cover: HTMLElement;
  signal: AbortSignal;
  expired: (message: string) => void;
};

// An ordinary tab switch is not navigation. Keep the board mounted, but reveal
// it only after a fresh access check. This controller never aborts publication.
export function mountBoardSession({response, surface, cover, signal, expired}: Options) {
  const document = surface.ownerDocument;
  const window = document.defaultView!;
  const status = cover.querySelector<HTMLElement>('[data-access-status]')!;
  const retry = cover.querySelector<HTMLButtonElement>('[data-access-retry]')!;
  let active = true;
  let concealed = false;
  let expiresAt = Date.parse(response.expiresAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let check: AbortController | undefined;
  let revision = 0;
  let pendingActions: (() => void)[] = [];
  let focus: HTMLElement | null = null;
  let selection: Range | null = null;
  let inputSelection: {start: number; end: number; direction: 'forward' | 'backward' | 'none'} | null = null;

  function cancelCheck() {
    revision++;
    check?.abort();
    check = undefined;
  }

  function conceal() {
    if (!concealed) {
      const element = document.activeElement as HTMLElement | null;
      focus = element && surface.contains(element) ? element : null;
      if (focus instanceof window.HTMLTextAreaElement || focus instanceof window.HTMLInputElement) {
        if (focus.selectionStart !== null && focus.selectionEnd !== null) {
          inputSelection = {start: focus.selectionStart, end: focus.selectionEnd, direction: focus.selectionDirection ?? 'none'};
        }
      }
      const selected = document.getSelection();
      if (selected?.rangeCount && surface.contains(selected.getRangeAt(0).commonAncestorContainer)) {
        selection = selected.getRangeAt(0).cloneRange();
        selected.removeAllRanges();
      }
      focus?.blur();
    }
    concealed = true;
    // Visibility preserves geometry/scroll position; inert and aria-hidden also
    // prevent keyboard and assistive-technology access to concealed content.
    surface.classList.add('private-concealed');
    surface.inert = true;
    surface.setAttribute('aria-hidden', 'true');
    cover.hidden = false;
    document.title = 'Private Board';
  }

  function expire() {
    if (!active) return;
    conceal();
    dispose();
    expired('Your access expired. Unlock the board to continue. Your draft is still here.');
  }

  function scheduleExpiry() {
    clearTimeout(timer);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { expire(); return; }
    timer = setTimeout(expire, Math.min(expiresAt - Date.now(), 2_147_483_647));
  }

  function reveal() {
    if (!active || document.hidden) return;
    concealed = false;
    cover.hidden = true;
    surface.classList.remove('private-concealed');
    surface.inert = false;
    surface.removeAttribute('aria-hidden');
    document.title = `${response.board.title} · Private Board`;
    // A publication acknowledged in the background can now present its result.
    // It may navigate, which disposes this controller; never restore stale focus.
    const actions = pendingActions;
    pendingActions = [];
    for (const action of actions) { if (active) action(); }
    if (!active) return;
    if (focus?.isConnected && surface.contains(focus)) {
      focus.focus({preventScroll: true});
      if (inputSelection && (focus instanceof window.HTMLTextAreaElement || focus instanceof window.HTMLInputElement)) {
        focus.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction);
      }
    }
    if (selection?.commonAncestorContainer.isConnected && surface.contains(selection.commonAncestorContainer)) {
      const selected = document.getSelection();
      selected?.removeAllRanges();
      selected?.addRange(selection);
    }
    focus = null; selection = null; inputSelection = null;
  }

  async function recheck() {
    if (!active || document.hidden || check) return;
    conceal();
    // Background timers can be throttled. Check the clock before any reveal.
    if (expiresAt <= Date.now()) { expire(); return; }
    status.textContent = 'Checking access…';
    retry.hidden = true;
    const controller = new AbortController();
    check = controller;
    const version = ++revision;
    // A stalled network must offer a retry rather than trap a concealed view.
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await api<BoardResponse>(`/api/boards/${response.board.id}`, undefined, controller.signal);
      if (!active || version !== revision || document.hidden) return;
      if (controller.signal.aborted) throw new Error('Access check timed out');
      const deadline = Date.parse(result?.expiresAt);
      if (result?.board?.id !== response.board.id || !Number.isFinite(deadline)) {
        throw new Error('Invalid access response');
      }
      expiresAt = deadline;
      scheduleExpiry();
      if (active) reveal();
    } catch (error) {
      if (!active || version !== revision || document.hidden) return;
      if (error instanceof ApiError && error.status === 401) { expire(); return; }
      status.textContent = 'Could not check access. Your place and draft are still here. Retry when connected.';
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (version === revision) check = undefined;
    }
  }

  function visibilityChanged() {
    if (!active) return;
    if (document.hidden) {
      cancelCheck();
      conceal();
      status.textContent = 'Checking access…';
      retry.hidden = true;
    } else if (concealed) {
      void recheck();
    }
  }
  const retryCheck = () => { void recheck(); };
  function dispose() {
    if (!active) return;
    active = false;
    cancelCheck();
    clearTimeout(timer);
    pendingActions = [];
    focus = null; selection = null; inputSelection = null;
    document.removeEventListener('visibilitychange', visibilityChanged);
    retry.removeEventListener('click', retryCheck);
    signal.removeEventListener('abort', dispose);
  }

  document.addEventListener('visibilitychange', visibilityChanged);
  retry.addEventListener('click', retryCheck);
  signal.addEventListener('abort', dispose, {once: true});
  if (signal.aborted) dispose();
  else {
    if (document.hidden) conceal();
    scheduleExpiry();
  }
  return {
    dispose,
    runWhenVisible(action: () => void) {
      if (!active) return;
      if (concealed || document.hidden) pendingActions.push(action);
      else if (expiresAt <= Date.now()) expire();
      else action();
    }
  };
}
