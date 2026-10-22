// Fixed "New post" disclosure on the board and entry pages: one round button that opens two real
// links. It only navigates to the composer; opening it never creates, erases, or posts anything.
type Options = { container: HTMLElement; boardId: string; navigate: (path: string) => void; drafts: () => { writing: boolean; drawing: boolean } };
const svg = (path: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const PLUS = svg('<path d="M12 5v14M5 12h14"/>');
const PENCIL = svg('<path d="m4 20 1-4L16 5l3 3L8 19z"/><path d="m14 7 3 3"/>');
const BRUSH = svg('<path d="M20 4c-5 1-9 5-10 9l2 2c4-1 8-5 8-11z"/><path d="M9 14c-2 0-4 1-4 4 0 1-1 2-2 2 4 1 8 0 8-4"/>');
const TEXT_ENTRY = 'input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=range]),textarea,[contenteditable=true]';
// How much visible height a keyboard must take before the button steps aside.
const KEYBOARD_PX = 150;

export function mountComposeMenu({ container, boardId, navigate, drafts }: Options): () => void {
  const doc = container.ownerDocument;
  const fab = doc.createElement('div');
  fab.className = 'compose-fab';
  fab.innerHTML = `<div id="compose-menu" class="compose-menu" hidden><a id="go-write" class="compose-choice" href="/b/${boardId}/new?mode=write">${PENCIL}<span></span></a><a id="go-draw" class="compose-choice" href="/b/${boardId}/new?mode=draw">${BRUSH}<span></span></a></div><button id="compose-toggle" class="compose-toggle" type="button" title="New post" aria-label="New post" aria-expanded="false" aria-controls="compose-menu">${PLUS}</button>`;
  const menu = fab.querySelector<HTMLElement>('#compose-menu')!, toggle = fab.querySelector<HTMLButtonElement>('#compose-toggle')!;
  const links = [...fab.querySelectorAll<HTMLAnchorElement>('.compose-choice')];
  function labels() {
    const { writing, drawing } = drafts();
    links[0].lastElementChild!.textContent = writing ? 'Continue note' : 'Write a note';
    links[1].lastElementChild!.textContent = drawing ? 'Continue drawing' : 'Draw';
  }
  function open() { labels(); menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); doc.body.classList.add('compose-open'); }
  function close(refocus = false) {
    if (menu.hidden) return;
    menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); doc.body.classList.remove('compose-open');
    if (refocus) toggle.focus();
  }
  toggle.addEventListener('click', () => { if (menu.hidden) open(); else close(); });
  for (const link of links) link.addEventListener('click', event => {
    // Modified clicks keep the browser's own behavior, so Draw can open in a new tab.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); close(); navigate(link.getAttribute('href')!);
  });
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !menu.hidden) close(fab.contains(doc.activeElement)); };
  const onPointer = (event: Event) => { if (!fab.contains(event.target as Node)) close(); };
  const onLeave = (event: FocusEvent) => { if (event.relatedTarget && !fab.contains(event.relatedTarget as Node)) close(); };
  const onHide = () => { if (doc.hidden) close(); };
  doc.addEventListener('keydown', onKey); doc.addEventListener('pointerdown', onPointer); doc.addEventListener('visibilitychange', onHide);
  fab.addEventListener('focusout', onLeave);

  // On a phone the keyboard shrinks the visual viewport; the button would sit on top of the field being edited.
  const viewport = doc.defaultView?.visualViewport ?? null;
  let baseline = viewport?.height ?? 0, baselineWidth = viewport?.width ?? 0;
  function resized() {
    if (!viewport) return;
    if (Math.abs(viewport.width - baselineWidth) > 1) { baselineWidth = viewport.width; baseline = viewport.height; }
    baseline = Math.max(baseline, viewport.height);
    const covered = viewport.height < baseline - KEYBOARD_PX && !!doc.activeElement?.matches(TEXT_ENTRY);
    fab.hidden = covered;
    if (covered) close();
  }
  viewport?.addEventListener('resize', resized); doc.addEventListener('focusin', resized); doc.addEventListener('focusout', resized);

  labels();
  container.append(fab);
  container.classList.add('with-compose'); doc.body.classList.add('has-compose');
  return () => {
    doc.removeEventListener('keydown', onKey); doc.removeEventListener('pointerdown', onPointer); doc.removeEventListener('visibilitychange', onHide);
    viewport?.removeEventListener('resize', resized); doc.removeEventListener('focusin', resized); doc.removeEventListener('focusout', resized);
    fab.remove(); container.classList.remove('with-compose'); doc.body.classList.remove('has-compose', 'compose-open');
  };
}
