import './styles.css';
import './notes.css';
import './drawing.css';
import './browse.css';
import { api, ApiError } from './api.ts';
import type { BoardResponse } from './api.ts';
import { cycleTheme, getTheme } from './theme.ts';
import { mountBoard } from './board.ts';
import { mountDirectory } from './directory.ts';
import { clearDraft, hasDrafts, hasDraftsFor } from './drafts.ts';
import { createBoardSession, createConcealer, EXPIRED_MESSAGE } from './board-session.ts';

const root = document.querySelector<HTMLDivElement>('#app')!;
const concealer = createConcealer(root);
const boardPattern = /^\/b\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/e\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})|\/(new))?\/?$/i;
let request: AbortController | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout>;
let generation = 0;
let currentBoard: string | null = null;
let disposeBoard: (()=>void) | undefined;
// Set when the user opens a board from search results, so the gate can name it. Listed titles are public.
let knownBoard: { id: string; title: string } | null = null;
const paths = {
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/>',
  arrow: '<path d="m5 12 14 0m-5-5 5 5-5 5"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  theme: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  book: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18m4-12h4m-4 4h4"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};
function icon(name: keyof typeof paths, cls = ''): string { return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`; }
function escape(value: string): string { return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
function toast(message: string) {
  const target = document.querySelector<HTMLDivElement>('#toast')!;
  target.textContent = message; target.classList.add('visible'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => target.classList.remove('visible'), 3500);
}
function navigate(path: string) { session.discardDeferred(); history.pushState({}, '', path); void route(); }
let rendered = false;
// `view` lets the stylesheet give feed, reader, and composer pages their own widths.
function frame(content: string, wide = false, view = '') {
  root.innerHTML = `<header class="site-header"><a class="brand" href="/" aria-label="Private Board home">${icon('book')}<span>private board<span class="brand-dot">.</span></span></a><button id="theme" class="icon-button" aria-label="Change theme">${icon('theme')}</button></header><main id="main" tabindex="-1" class="${wide ? 'board-main' : 'home-main'}"${view ? ` data-view="${view}"` : ''}>${content}</main><footer class="site-footer"><span>A little space, kept between you.</span><span>${icon('lock')} No accounts. Just a password.</span></footer>`;
  root.querySelector<HTMLAnchorElement>('.brand')!.addEventListener('click', e => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate('/'); } });
  const button = root.querySelector<HTMLButtonElement>('#theme')!;
  const label = () => { button.title = `Theme: ${getTheme()}. Click to change.`; button.setAttribute('aria-label', button.title); };
  label(); button.addEventListener('click', () => { cycleTheme(); label(); });
  // After the first screen, moving to a new page moves keyboard and screen-reader focus to it (not on first load, which would skip the header).
  if (rendered) root.querySelector<HTMLElement>('#main')!.focus({ preventScroll: true });
  rendered = true;
}
function passwordField(id: string, creating: boolean): string {
  return `<div class="field"><label for="${id}">Board password</label><div class="password-wrap"><input id="${id}" name="password" type="password" autocomplete="${creating ? 'new-password' : 'current-password'}" required ${creating ? 'minlength="12"' : ''} aria-describedby="password-hint"/><button type="button" class="show-password" aria-controls="${id}" aria-pressed="false">Show</button></div><small id="password-hint">${creating ? 'At least 12 characters. A few memorable words work well.' : 'The same password everyone on this board uses.'}</small></div>`;
}
function wirePassword() {
  const button = root.querySelector<HTMLButtonElement>('.show-password');
  button?.addEventListener('click', () => {
    const input = root.querySelector<HTMLInputElement>(`#${button.getAttribute('aria-controls')}`)!;
    const showing = input.type === 'password'; input.type = showing ? 'text' : 'password';
    button.textContent = showing ? 'Hide' : 'Show'; button.setAttribute('aria-pressed', String(showing));
  });
}
function formError(form: HTMLFormElement, message: string) {
  const el = form.querySelector<HTMLElement>('.form-error')!; el.textContent = message; el.hidden = false;
}
function busy(form: HTMLFormElement, state: boolean) {
  const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  button.disabled = state; form.setAttribute('aria-busy', String(state));
  button.querySelector('.button-label')!.textContent = state ? 'Please wait…' : button.dataset.label!;
}
function clearSecrets(form: HTMLFormElement) { const input = form.querySelector<HTMLInputElement>('[name="password"]'); if (input) input.value = ''; }

function home() {
  knownBoard = null;
  frame(`<section class="intro"><div class="eyebrow"><span class="tiny-dot"></span> A quiet corner of the internet</div><h1>Good thoughts<br/>deserve a place<br/><span>to stay.</span></h1><p class="intro-copy">A private space for shared notes and sketches.<br class="desktop-break"/> Open a board, pass along the password, make it yours.</p><div class="principles"><span>${icon('lock')} Private by password</span><span>${icon('check')} No sign-up</span></div></section><section class="access-panel" aria-label="Board access"><div class="panel-tabs" role="tablist" aria-label="Choose board action"><button id="open-tab" role="tab" aria-selected="true" aria-controls="access-content">Find a board</button><button id="create-tab" role="tab" aria-selected="false" aria-controls="access-content" tabindex="-1">Create a board</button></div><div id="access-content" role="tabpanel" aria-labelledby="open-tab"></div></section>`);
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  // Non-secret input survives switching tabs (in memory only). The password is never kept.
  const kept = { find: '', title: '', listed: false };
  let creating = false;
  function keep() {
    kept.find = root.querySelector<HTMLInputElement>('#board-find')?.value ?? kept.find;
    const title = root.querySelector<HTMLInputElement>('#board-title'), listed = root.querySelector<HTMLInputElement>('#board-listed');
    if (title && listed) { kept.title = title.value; kept.listed = listed.checked; }
  }
  function select(index: number) {
    // A creation already sent could complete after a switch, so the tabs stay put until it ends.
    if (creating) return;
    keep();
    tabs.forEach((t, i) => { t.setAttribute('aria-selected', String(i === index)); t.tabIndex = i === index ? 0 : -1; });
    const content = root.querySelector<HTMLElement>('#access-content')!; content.setAttribute('aria-labelledby', tabs[index].id);
    disposeBoard?.(); disposeBoard = undefined;
    if (index === 1) {
      content.innerHTML = `<form id="create-form"><h2>A space of your own.</h2><p class="muted">Give it a name and a password. That’s all.</p><div class="field"><label for="board-title">Board name</label><input id="board-title" name="title" placeholder="A place for our ideas" maxlength="80" autocomplete="off" required/></div>${passwordField('create-password', true)}<div class="list-option"><label><input id="board-listed" name="listed" type="checkbox"/> List in search</label><small>Anyone can find this board’s name. What’s inside stays private. This can’t be changed later.</small></div><div class="soft-notice">Keep your link and password somewhere safe. There’s no account to recover them.</div><p class="form-error" role="alert" hidden></p><button class="primary" type="submit" data-label="Create board"><span class="button-label">Create board</span>${icon('arrow')}</button><p class="fine-print">Shared anonymously. Made to stay.</p></form>`;
      wirePassword();
      const form = root.querySelector<HTMLFormElement>('#create-form')!;
      const listedBox = form.querySelector<HTMLInputElement>('#board-listed')!, passwordInput = form.querySelector<HTMLInputElement>('#create-password')!;
      const applyListed = () => {
        passwordInput.minLength = listedBox.checked ? 16 : 12;
        form.querySelector('#password-hint')!.textContent = listedBox.checked ? 'Listed boards need at least 16 characters. Four or more random words work well.' : 'At least 12 characters. A few memorable words work well.';
      };
      listedBox.addEventListener('change', applyListed);
      form.querySelector<HTMLInputElement>('#board-title')!.value = kept.title; listedBox.checked = kept.listed; applyListed();
      form.addEventListener('submit', async e => {
        e.preventDefault(); const myGeneration = generation; busy(form, true); form.querySelector<HTMLElement>('.form-error')!.hidden = true;
        creating = true; tabs.forEach(t => { t.disabled = true; });
        try {
          const data = new FormData(form);
          const response = await api<BoardResponse>('/api/boards', { title: data.get('title'), password: data.get('password'), listed: listedBox.checked }, request!.signal);
          clearSecrets(form);
          if (myGeneration !== generation) return;
          history.pushState({}, '', `/b/${response.board.id}`);
          currentBoard = response.board.id; showBoard(response); toast('Board created. Keep the link and password safe.');
        } catch (error) { if (myGeneration === generation && !(error instanceof DOMException && error.name === 'AbortError')) formError(form, error instanceof Error ? error.message : 'Please try again.'); }
        finally { creating = false; tabs.forEach(t => { t.disabled = false; }); busy(form, false); }
      });
    } else {
      disposeBoard = mountDirectory(content, { navigate, initialQuery: kept.find, opened: (id, title) => { knownBoard = { id, title }; } });
    }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i));
    tab.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 1 - i; select(next); tabs[next].focus(); } });
  });
  select(0);
}

function gate(boardId: string, errorMessage = '') {
  disposeBoard?.();disposeBoard=undefined;clearTimeout(expiryTimer);
  generation++;request?.abort();request=new AbortController();
  session.stop();concealer.reset(); document.title = 'Unlock board · Private Board';
  frame(`<section class="gate"><div class="gate-symbol">${icon('lock')}</div><div class="eyebrow">A space between you</div><h1>This board is private.</h1>${knownBoard?.id === boardId ? `<p class="gate-board">${escape(knownBoard.title)}</p>` : ''}<p class="muted gate-copy">Have the password? You’re in the right place.</p><form id="unlock-form">${passwordField('unlock-password', false)}<p class="form-error" role="alert" ${errorMessage ? '' : 'hidden'}>${escape(errorMessage)}</p><button class="primary" type="submit" data-label="Unlock board"><span class="button-label">Unlock board</span>${icon('arrow')}</button></form><a class="text-link" href="/" id="back-home">Back to home</a></section>`);
  wirePassword();
  root.querySelector<HTMLAnchorElement>('#back-home')!.addEventListener('click', e => { e.preventDefault(); navigate('/'); });
  const form = root.querySelector<HTMLFormElement>('#unlock-form')!;
  form.addEventListener('submit', async e => {
    e.preventDefault(); const myGeneration = generation; busy(form, true); form.querySelector<HTMLElement>('.form-error')!.hidden = true;
    try {
      const response = await api<BoardResponse>(`/api/boards/${boardId}/unlock`, { password: new FormData(form).get('password') }, request!.signal);
      clearSecrets(form); if (myGeneration === generation) showBoard(response);
    } catch (error) { if (myGeneration === generation && !(error instanceof DOMException && error.name === 'AbortError')) formError(form, error instanceof Error ? error.message : 'Please try again.'); }
    finally { busy(form, false); }
  });
}

function showBoard(response: BoardResponse) {
  disposeBoard?.();
  clearTimeout(expiryTimer); concealer.reset(); currentBoard = response.board.id;
  document.title = `${response.board.title} · Private Board`;
  const match = location.pathname.match(boardPattern);
  const view = match?.[2] ? 'read' : match?.[3] ? 'compose' : 'feed';
  frame(`<section class="board-header"><div class="board-title"><h1>${escape(response.board.title)}</h1><p class="privacy-line">${icon('lock')} Private · password required${response.board.listed ? ' · Listed in search' : ''}</p></div><div class="board-actions"><button id="copy-link" class="secondary" aria-label="Copy board link">${icon('link')}<span class="action-label">Copy link</span></button><button id="lock-board" class="icon-button" aria-label="Lock this board" title="Lock this board">${icon('lock')}</button></div></section><div id="board-content"></div>`, true, view);
  disposeBoard=mountBoard({container:root.querySelector<HTMLElement>('#board-content')!,response,entryId:match?.[2]?.toLowerCase(),view:match?.[3]?'compose':'feed',mode:composeMode(),modeChanged:mode=>history.replaceState(history.state,'',`${location.pathname}?mode=${mode}`),signal:request!.signal,navigate,expired:message=>gate(response.board.id,message),toast,whenVisible:action=>session.defer(response.board.id,action)});
  root.querySelector<HTMLButtonElement>('#copy-link')!.addEventListener('click', async () => {
    const url = `${location.origin}/b/${response.board.id}`;
    try { await navigator.clipboard.writeText(url); toast('Board link copied. Share the password separately.'); }
    catch { window.prompt('Copy your board link:', url); }
  });
  root.querySelector<HTMLButtonElement>('#lock-board')!.addEventListener('click', async e => {
    // Locking is the one action that deliberately discards unsent drafts, so say so first.
    if (hasDraftsFor(response.board.id) && !window.confirm('This board has text or a drawing you have not posted. Locking discards it on this browser. Lock anyway?')) return;
    const myGeneration = generation;
    const button = e.currentTarget as HTMLButtonElement; button.disabled = true;
    session.discardDeferred();
    try {
      await api(`/api/boards/${response.board.id}/lock`, {}, request!.signal);
      if (myGeneration !== generation) return;
      wipe(response.board.id);clearTimeout(expiryTimer); gate(response.board.id); toast('Board locked on this browser.');
    } catch (error) {
      if (myGeneration !== generation) return;
      // Wipe content even when the network cannot confirm revocation; be candid.
      wipe(response.board.id);gate(response.board.id, 'Content hidden, but locking could not be confirmed. Reconnect and unlock, then lock again.');
    }
  });
  scheduleExpiry(response.board.id, response.expiresAt);
  // Last, because it may run a post-confirmation that was waiting for this board to be shown.
  session.show(response.board.id, response.expiresAt, !document.hidden);
}
// Dispose first: the feed saves its reading position when it goes away, and Lock must clear that too.
function wipe(boardId: string) { disposeBoard?.(); disposeBoard = undefined; clearDraft(boardId); }
// /b/{id}/new?mode=write|draw opens that mode; plain /new keeps the mode last used. Anything else is ignored.
function composeMode(): 'write' | 'draw' | undefined {
  const mode = new URLSearchParams(location.search).get('mode');
  return mode === 'write' || mode === 'draw' ? mode : undefined;
}
function scheduleExpiry(boardId: string, expiresAt: string) {
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => gate(boardId, EXPIRED_MESSAGE), Math.max(0, Date.parse(expiresAt) - Date.now()));
}

async function route() {
  disposeBoard?.();disposeBoard=undefined;
  generation++; const myGeneration = generation;
  request?.abort(); request = new AbortController(); clearTimeout(expiryTimer); session.stop(); concealer.reset();
  currentBoard = null; document.title = 'Private Board';
  if (location.pathname === '/') { home(); return; }
  const match = location.pathname.match(boardPattern);
  if (!match) { frame('<section class="gate"><h1>A wrong turn.</h1><p class="muted">Check your board link, or use the name above to return home.</p></section>'); return; }
  const id = match[1].toLowerCase(); currentBoard = id;
  frame('<section class="gate loading" role="status"><span class="loading-dot"></span><p>Opening your space…</p></section>');
  try { const response = await api<BoardResponse>(`/api/boards/${id}`, undefined, request.signal); if (myGeneration === generation) showBoard(response); }
  catch (error) {
    if (myGeneration !== generation) return;
    if (error instanceof ApiError) gate(id, error.status === 401 ? '' : error.message);
    else if (!(error instanceof DOMException && error.name === 'AbortError')) gate(id, 'Could not open this board. Please try again.');
  }
}

// Ordinary tab hide conceals the mounted board in place and rechecks access on return.
// Leaving the page (pagehide) still tears everything down; a long absence rebuilds the board.
const session = createBoardSession({
  check: (id, signal) => api<BoardResponse>(`/api/boards/${id}`, undefined, signal),
  conceal: () => { document.title = 'Private Board'; concealer.conceal(); },
  reveal: response => {
    concealer.reveal(); document.title = `${response.board.title} · Private Board`;
    scheduleExpiry(response.board.id, response.expiresAt);
  },
  failed: message => concealer.failed(message, () => session.retry()),
  gate,
  remount: () => void route(),
  now: Date.now
});
// The feed restores its own reading position, so the browser must not also try to restore scroll on Back.
try { history.scrollRestoration = 'manual'; } catch { /* not supported */ }
window.addEventListener('popstate', () => { session.discardDeferred(); void route(); });
window.addEventListener('pageshow', e => { if (e.persisted) void route(); });
function teardown() {
  if (!session.active()) return;
  session.stop();generation++;request?.abort();disposeBoard?.();disposeBoard=undefined;clearTimeout(expiryTimer);
  root.replaceChildren();concealer.reset();document.title='Private Board';
}
window.addEventListener('pagehide',teardown);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) session.hidden();
  else if (session.active()) session.resumed();
  else if (currentBoard && root.childElementCount === 0) void route();
});
window.addEventListener('beforeunload',e=>{if(hasDrafts()){e.preventDefault();e.returnValue='';}});
void route();
