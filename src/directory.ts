import { api, ApiError } from './api.ts';
import type { BoardSearchResult } from './api.ts';

type Options = { navigate: (path: string) => void; opened: (id: string, title: string) => void; initialQuery?: string };

// Searches only boards whose creators chose to list them. Titles are rendered as text.
export function mountDirectory(container: HTMLElement, { navigate, opened, initialQuery = '' }: Options): () => void {
  container.innerHTML = `<form id="find-form" role="search"><h2>Find a board.</h2><p class="muted">Search by name. Only boards their creators chose to list appear here.</p><div class="field"><label for="board-find">Board name</label><input id="board-find" type="search" maxlength="80" placeholder="Search board names…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="find-status"/></div><p id="find-status" class="find-status" role="status"></p><ul id="find-results" class="find-results" aria-label="Matching boards"></ul><p class="fine-print">Have a private link? Open it in your address bar. You’ll enter the password next.</p></form>`;
  const input = container.querySelector<HTMLInputElement>('#board-find')!;
  const status = container.querySelector<HTMLElement>('#find-status')!;
  const results = container.querySelector<HTMLUListElement>('#find-results')!;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, version = 0, active = true;
  const cancel = () => { version++; controller?.abort(); if (timer) clearTimeout(timer); };

  async function search() {
    cancel();
    const query = input.value.trim();
    results.replaceChildren(); status.removeAttribute('role'); status.setAttribute('role', 'status');
    if ([...query].length < 2) { status.textContent = query ? 'Keep typing — at least 2 characters.' : ''; return; }
    const mine = ++version; controller = new AbortController();
    status.textContent = 'Searching…';
    try {
      const found = await api<BoardSearchResult>(`/api/boards?${new URLSearchParams({ q: query })}`, undefined, controller.signal);
      if (!active || mine !== version) return;
      if (!found.boards.length) { status.textContent = 'No listed boards match. Private boards don’t appear here; open them from their link.'; return; }
      status.textContent = `${found.boards.length}${found.more ? '+' : ''} ${found.boards.length === 1 ? 'board' : 'boards'} found${found.more ? '. Refine your search to narrow it.' : '.'}`;
      for (const board of found.boards) {
        const item = document.createElement('li'), link = document.createElement('a');
        link.href = `/b/${board.id}`;
        const name = document.createElement('span'); name.className = 'find-name'; name.textContent = board.title;
        const created = document.createElement('span'); created.className = 'find-date'; created.textContent = new Date(board.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' });
        link.append(name, created);
        link.addEventListener('click', e => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault(); opened(board.id, board.title); navigate(link.getAttribute('href')!);
        });
        item.append(link); results.append(item);
      }
    } catch (error) {
      if (!active || mine !== version || (error instanceof DOMException && error.name === 'AbortError')) return;
      status.setAttribute('role', 'alert');
      status.textContent = error instanceof ApiError ? error.message : 'Search failed. Please try again.';
    }
  }
  input.addEventListener('input', () => { cancel(); timer = setTimeout(() => void search(), 250); });
  container.querySelector('#find-form')!.addEventListener('submit', e => { e.preventDefault(); void search(); });
  if (initialQuery) { input.value = initialQuery; void search(); }
  return () => { active = false; cancel(); };
}
