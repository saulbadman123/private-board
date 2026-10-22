import { api, ApiError } from './api.ts';
import type { PostResponse } from '../shared/contracts.ts';
import type { NoteDraft } from './drafts.ts';
import { characterCount, MAX_NOTE_CHARACTERS, measureNote, parseTagField, titleProblem } from '../shared/note-limits.ts';
import { splitAt, startOfNextPost, stepBoundaries, suggestSplit } from './note-overflow.ts';
import type { Boundary, BoundaryKind, Split } from './note-overflow.ts';
import { copyText } from './export.ts';

export type NoteComposerOptions = {
  host: HTMLElement; boardId: string; draft: NoteDraft; signal: AbortSignal;
  alive: () => boolean; navigate: (path: string) => void; toast: (message: string) => void;
  denied: (error: unknown) => boolean; finish: (result: PostResponse, message: string) => void;
  renderPreview: (target: HTMLElement, source: string) => void; cancelPreview: () => void;
};
const formats = [['Bold', 'bold'], ['Italic', 'italic'], ['List', 'list'], ['Link', 'link'], ['Code', 'code']] as const;
const LIMIT = MAX_NOTE_CHARACTERS.toLocaleString();
const count = (text: string) => characterCount(text).toLocaleString();
const kindLabel: Record<BoundaryKind, string> = {
  paragraph: 'paragraph break', line: 'line break', sentence: 'end of a sentence', word: 'space between words',
  hard: 'cut at the limit, because no break was found', trailing: 'end of the text'
};

// The note form: Markdown editor with Edit/Preview, optional title and tags, live length feedback, and recovery for a note that
// is too long (review a suggested split, keep one remainder, post it as the next note).
export function mountNoteComposer(options: NoteComposerOptions): () => void {
  const { host, boardId, draft, signal, alive, navigate, toast, denied, finish, renderPreview, cancelPreview } = options;
  host.innerHTML = `<form id="note-form"><section id="continue-panel" class="side-panel" aria-labelledby="continue-title" tabindex="-1" hidden><h3 id="continue-title">Saved. The rest is waiting.</h3><p id="continue-text"></p><div class="panel-actions"><button id="continue-remainder" type="button" class="primary">Continue with remaining text</button></div></section><div class="editor-tabs" role="tablist" aria-label="Note editor"><button type="button" id="write-tab" role="tab" aria-selected="true" aria-controls="write-panel">Edit</button><button type="button" id="preview-tab" role="tab" aria-selected="false" tabindex="-1" aria-controls="preview-panel">Preview</button></div><div id="write-panel" role="tabpanel" aria-labelledby="write-tab"><div class="format-toolbar" aria-label="Formatting helpers">${formats.map(([label, type]) => `<button type="button" data-format="${type}" aria-label="Insert ${label.toLowerCase()} formatting">${label}</button>`).join('')}</div><label class="sr-only" for="note-body">Your note in Markdown</label><textarea id="note-body" name="markdown" placeholder="What would you like to leave here?" required spellcheck="true" aria-describedby="note-help note-count"></textarea><div class="editor-hint"><span id="note-help">Markdown welcome. Plain words, too.</span></div></div><div id="preview-panel" role="tabpanel" aria-labelledby="preview-tab" hidden><div id="note-preview" class="markdown"></div></div><div id="note-status" class="note-status"><p id="note-count" class="note-count"></p><div id="over-actions" class="panel-actions" hidden><button id="review-split" type="button" class="secondary">Review split</button><button id="copy-overflow" type="button" class="secondary">Copy remaining text</button></div></div><p id="note-live" class="sr-only" role="status" aria-live="polite"></p><section id="split-review" class="side-panel" aria-labelledby="split-title" tabindex="-1" hidden><h3 id="split-title" tabindex="-1">Review split</h3><p id="split-summary"></p><p id="split-warning" class="form-error" hidden></p><div class="panel-actions"><button id="split-earlier" type="button" class="secondary">Cut earlier</button><button id="split-later" type="button" class="secondary">Cut later</button></div><div class="split-parts"><div><label for="split-first">First part, posted first</label><textarea id="split-first" readonly rows="7"></textarea></div><div><label for="split-rest">Remaining text, kept for the next post</label><textarea id="split-rest" readonly rows="7"></textarea></div></div><p id="split-note" class="small-note" hidden></p><div class="panel-actions"><button id="use-first" type="button" class="primary">Use first part</button><button id="split-copy" type="button" class="secondary">Copy remaining text</button><button id="split-close" type="button" class="secondary">Keep editing</button></div></section><section id="remainder-panel" class="side-panel" aria-labelledby="remainder-title" tabindex="-1" hidden><h3 id="remainder-title" tabindex="-1">Remaining text</h3><p id="remainder-summary"></p><label class="sr-only" for="remainder-text">Remaining text</label><textarea id="remainder-text" readonly rows="5"></textarea><div class="panel-actions"><button id="remainder-copy" type="button" class="secondary">Copy all remaining text</button><button id="undo-split" type="button" class="secondary">Undo split</button></div></section><details id="note-details"><summary>Title & tags <span>(optional)</span></summary><div class="metadata-fields"><div class="field"><label for="note-title">Title</label><input id="note-title" name="title" placeholder="A few words to find it later" aria-describedby="title-error"/><small id="title-error" class="field-error" hidden></small></div><div class="field"><label for="note-tags">Tags</label><input id="note-tags" name="tags" placeholder="ideas, reminders" aria-describedby="tag-help tags-error"/><small id="tag-help">Up to five tags, separated by commas.</small><small id="tags-error" class="field-error" hidden></small></div></div></details><div class="draft-row"><p id="draft-state"></p><div class="draft-actions"><button id="copy-draft" type="button" class="text-button">Copy draft</button><button id="discard-draft" type="button" class="text-button">Discard draft</button></div></div><p id="attempt-hint" class="soft-notice" hidden>Checking the same submission. Keep this tab open and use Retry to avoid posting it twice.</p><p id="form-hint" class="form-hint" hidden></p><p id="post-error" class="form-error" role="alert" hidden></p><div class="post-row"><p>Posts are permanent.<br/><span>Check before posting.</span></p><button id="post-note" class="primary" type="submit" aria-describedby="form-hint">Post note <span aria-hidden="true">↗</span></button></div></form>`;
  const $ = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const form = $<HTMLFormElement>('#note-form'), textarea = $<HTMLTextAreaElement>('#note-body');
  const titleInput = $<HTMLInputElement>('#note-title'), tagsInput = $<HTMLInputElement>('#note-tags');
  const post = $<HTMLButtonElement>('#post-note'), errorBox = $('#post-error'), attemptHint = $('#attempt-hint'), preview = $('#note-preview'), live = $('#note-live');
  const tabs = [$<HTMLButtonElement>('#write-tab'), $<HTMLButtonElement>('#preview-tab')];
  const review = { panel: $('#split-review'), first: $<HTMLTextAreaElement>('#split-first'), rest: $<HTMLTextAreaElement>('#split-rest'), summary: $('#split-summary'), warning: $('#split-warning'), note: $('#split-note'), use: $<HTMLButtonElement>('#use-first'), earlier: $<HTMLButtonElement>('#split-earlier'), later: $<HTMLButtonElement>('#split-later') };
  const remainder = { panel: $('#remainder-panel'), text: $<HTMLTextAreaElement>('#remainder-text'), summary: $('#remainder-summary'), undo: $<HTMLButtonElement>('#undo-split') };
  const cont = { panel: $('#continue-panel'), text: $('#continue-text') };
  textarea.value = draft.markdown; titleInput.value = draft.title; tagsInput.value = draft.tags;
  if (draft.title || draft.tags) $<HTMLDetailsElement>('#note-details').open = true;
  let current: { source: string; split: Split; steps: Boundary[] } | null = null;   // the split under review
  let wasOver = false;
  const announce = (message: string) => { live.textContent = message; };

  function problems() {
    return { title: titleProblem(titleInput.value), tags: parseTagField(tagsInput.value).problem };
  }
  const invalid = (input: HTMLElement, on: boolean) => { if (on) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); };
  function field(input: HTMLInputElement, message: HTMLElement, text: string | null) {
    message.hidden = !text; message.textContent = text ?? '';
    invalid(input, !!text);
  }
  function render() {
    const frozen = !!draft.attempt, value = textarea.value, size = measureNote(value), over = value !== '' && !size.ok;
    const { title, tags } = problems(), blocked = !!(title || tags);
    textarea.readOnly = frozen; titleInput.readOnly = frozen; tagsInput.readOnly = frozen;
    form.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(button => { button.disabled = frozen; });
    // Length feedback sits outside the Edit and Preview panels, so it is visible in both.
    $('#note-count').textContent = `${size.characters.toLocaleString()} / ${LIMIT} characters${size.overCharacters ? ` — ${size.overCharacters.toLocaleString()} over the limit.` : size.overBytes ? ' — over the 80 KiB size limit.' : !size.wellFormed ? ' — contains a character that cannot be saved.' : ''}`;
    $('#note-count').classList.toggle('over', over);
    invalid(textarea, over);
    $('#over-actions').hidden = frozen || size.overCharacters === 0;
    // Announce only when the note crosses the limit, never on every keystroke.
    if (over !== wasOver) { wasOver = over; announce(over ? `The note is ${size.overCharacters.toLocaleString()} characters over the limit. Review split is available.` : 'The note is within the limit.'); }
    field(titleInput, $('#title-error'), title); field(tagsInput, $('#tags-error'), tags);
    if (title || tags) $<HTMLDetailsElement>('#note-details').open = true;
    post.disabled = draft.pending || (!draft.attempt && (!value.trim() || over || blocked));
    post.textContent = draft.pending ? 'Posting…' : draft.attempt ? 'Retry posting' : 'Post note ↗';
    form.setAttribute('aria-busy', String(draft.pending));
    attemptHint.hidden = !frozen;
    errorBox.textContent = draft.error; errorBox.hidden = !draft.error;
    const hint = frozen || !value.trim() ? '' : over ? `Bring the note down to ${LIMIT} characters to post it, or review the split above.` : blocked ? 'Fix the title or tags to post this note.' : '';
    $('#form-hint').textContent = hint; $('#form-hint').hidden = !hint;
    // Draft feedback: where the text lives, and the two ways out of it.
    const holding = !frozen && !draft.pending && draft.hasContent();
    $('#draft-state').textContent = holding ? 'Draft kept in this tab only. It is not saved or synced.' : '';
    $('#copy-draft').hidden = !holding || !value.trim(); $<HTMLButtonElement>('#discard-draft').hidden = !holding;
    // Remaining text and the saved first part.
    const waiting = draft.remainder.trim() !== '';
    remainder.panel.hidden = !waiting;
    if (waiting) {
      remainder.text.value = draft.remainder;
      remainder.summary.textContent = `${count(draft.remainder)} characters wait here for the next post. They are kept in this tab only: not saved, not synced, and lost if the tab is reloaded or closed.`;
    }
    remainder.undo.hidden = !draft.split || frozen;
    cont.panel.hidden = !(draft.continuation && waiting);
    if (draft.continuation && waiting) {
      cont.text.replaceChildren(document.createTextNode('Saved permanently. '));
      const link = document.createElement('a'); link.href = `/b/${boardId}/e/${draft.continuation.entryId}`; link.textContent = 'View note ↗';
      link.addEventListener('click', event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigate(link.getAttribute('href')!); } });
      cont.text.append(link, document.createTextNode(` ${count(draft.remainder)} characters are still waiting to be posted. Nothing is posted until you choose to.`));
    }
    $<HTMLButtonElement>('#continue-remainder').disabled = frozen;
    $<HTMLButtonElement>('#discard-draft').disabled = frozen;
    review.use.disabled = frozen || (!!current && current.split.kind !== 'trailing' && waiting);
  }

  // ----- Editing
  function edited(bodyChanged = true) {
    draft.markdown = textarea.value; draft.title = titleInput.value; draft.tags = tagsInput.value; draft.error = '';
    if (bodyChanged && current) closeReview();   // the text changed under the review; it would be stale
    render();
  }
  textarea.addEventListener('input', () => edited(true));
  // The title and tags are not part of what is being split, so changing them leaves an open review alone.
  for (const input of [titleInput, tagsInput]) input.addEventListener('input', () => edited(false));
  function selectTab(index: number) {
    tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
    $('#write-panel').hidden = index !== 0; $('#preview-panel').hidden = index !== 1;
    cancelPreview();
    if (index === 1) { if (textarea.value.trim()) renderPreview(preview, textarea.value); else preview.textContent = 'Your formatted note will appear here.'; }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(i));
    tab.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - i; selectTab(index); tabs[index].focus(); } });
  });
  form.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(button => button.addEventListener('click', () => {
    if (draft.attempt) return;
    const start = textarea.selectionStart, end = textarea.selectionEnd, selection = textarea.value.slice(start, end), kind = button.dataset.format;
    const wraps: Record<string, [string, string, string]> = { bold: ['**', '**', 'bold text'], italic: ['_', '_', 'italic text'], link: ['[', '](https://example.com)', 'link text'], code: ['`', '`', 'code'] };
    let insert: string;
    if (kind === 'list') insert = (selection || 'First item\nSecond item').split('\n').map(line => `- ${line}`).join('\n');
    else { const [left, right, fallback] = wraps[kind!]; insert = left + (selection || fallback) + right; }
    textarea.setRangeText(insert, start, end, 'select'); textarea.focus(); textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }));

  // ----- Too long: review a split, keep one remainder
  function showSplit(split: Split) {
    if (!current) return;
    current.split = split;
    const next = startOfNextPost(split.rest), trailing = split.kind === 'trailing';
    // The remainder is shown (and copied) without the blank lines that separated it from the first part.
    review.first.value = split.first; review.rest.value = trailing ? '' : next;
    review.summary.textContent = trailing
      ? `Only trailing spaces or blank lines are over the limit. Removing them leaves ${count(split.first)} characters.`
      : `The first part is ${count(split.first)} characters and the remaining text is ${count(next)}. The cut is at a ${kindLabel[split.kind]}. Nothing has been changed yet.`;
    review.warning.hidden = split.safe;
    review.warning.textContent = split.safe ? '' : 'This cut falls inside a code block, table, link, or code span, so the formatting of the two parts may break. Use Cut earlier or Cut later to move it, or edit the first part afterwards.';
    review.use.textContent = trailing ? 'Remove trailing whitespace' : 'Use first part';
    review.earlier.hidden = review.later.hidden = trailing;
    review.earlier.disabled = !current.steps.some(boundary => boundary.pos < split.pos);
    review.later.disabled = !current.steps.some(boundary => boundary.pos > split.pos);
    const waiting = draft.remainder.trim() !== '';
    review.note.hidden = !waiting || trailing; review.note.textContent = waiting ? 'Other remaining text is already waiting. Continue with it or copy it first, then split this note.' : '';
    render();
  }
  function openReview() {
    const source = textarea.value, split = suggestSplit(source);
    if (!split) return;
    current = { source, split, steps: stepBoundaries(source) };
    review.panel.hidden = false; showSplit(split);
    $('#split-title').focus();
  }
  function closeReview(refocus = false) {
    current = null; review.panel.hidden = true;
    if (refocus) $('#review-split').focus();
  }
  function move(direction: -1 | 1) {
    if (!current) return;
    const here = current.split.pos;
    const target = direction < 0 ? [...current.steps].reverse().find(boundary => boundary.pos < here) : current.steps.find(boundary => boundary.pos > here);
    if (target) showSplit(splitAt(current.source, target));
  }
  async function copyRemainder(fallback: HTMLTextAreaElement, text: string) {
    if (await copyText(text)) { toast('Remaining text copied.'); return; }
    fallback.hidden = false; fallback.focus(); fallback.select(); toast('Could not copy automatically. The text is selected: press Ctrl+C (Cmd+C on a Mac).');
  }
  $('#review-split').addEventListener('click', openReview);
  $('#copy-overflow').addEventListener('click', () => {
    const split = suggestSplit(textarea.value);
    if (!split || split.kind === 'trailing') return;
    // The review panel holds the selectable text if the clipboard refuses.
    openReview(); void copyRemainder(review.rest, review.rest.value);
  });
  review.earlier.addEventListener('click', () => move(-1)); review.later.addEventListener('click', () => move(1));
  $('#split-close').addEventListener('click', () => { closeReview(true); announce('Split review closed. Your note is unchanged.'); });
  $('#split-copy').addEventListener('click', () => { if (current && current.split.kind !== 'trailing') void copyRemainder(review.rest, review.rest.value); });
  review.use.addEventListener('click', () => {
    if (!current || draft.attempt) return;
    const { source, split } = current;
    if (split.kind === 'trailing') { textarea.value = split.first; closeReview(); edited(true); textarea.focus(); return; }
    const rest = startOfNextPost(split.rest);
    if (!draft.useFirstPart(source, split.first, rest)) { showSplit(split); return; }
    textarea.value = split.first; closeReview(); render();
    announce(`The first part is now in the editor. ${count(rest)} characters wait for the next post. Nothing has been posted yet.`);
    $('#remainder-title').focus();
  });
  $('#remainder-copy').addEventListener('click', () => void copyRemainder(remainder.text, draft.remainder));
  remainder.undo.addEventListener('click', () => {
    if (!draft.split || draft.attempt) return;
    if (textarea.value !== draft.split.first && !window.confirm('Undo the split? Your edits to the first part will be replaced by the original text.')) return;
    if (draft.undoSplit()) { textarea.value = draft.markdown; render(); announce('Split undone. The original text is back in the editor.'); textarea.focus(); }
  });
  $('#continue-remainder').addEventListener('click', () => {
    if (draft.attempt) return;
    if (textarea.value.trim() && !window.confirm('Replace what is in the editor with the remaining text? The current text will be lost.')) return;
    if (!draft.continueWithRemainder()) return;
    textarea.value = draft.markdown; titleInput.value = draft.title; tagsInput.value = draft.tags;
    selectTab(0); render(); textarea.focus();
    announce(`The remaining ${count(draft.markdown)} characters are now the draft. Edit it, then post when you are ready.`);
  });
  $('#copy-draft').addEventListener('click', async () => {
    if (await copyText(textarea.value)) { toast('Draft copied.'); return; }
    selectTab(0); textarea.focus(); textarea.select(); toast('Could not copy automatically. The draft is selected: press Ctrl+C (Cmd+C on a Mac).');
  });
  $('#discard-draft').addEventListener('click', () => {
    if (draft.attempt || draft.pending) return;
    const extra = draft.remainder.trim() ? ' and the remaining text' : '';
    if (!window.confirm(`Discard this draft${extra}? This cannot be undone.`)) return;
    draft.discard(); textarea.value = ''; titleInput.value = ''; tagsInput.value = ''; preview.replaceChildren(); closeReview(); selectTab(0); render();
    announce('Draft discarded.'); textarea.focus();
  });

  // ----- Posting
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (draft.pending || (!draft.attempt && !draft.markdown.trim())) return;
    if (!draft.attempt) {
      const size = measureNote(textarea.value), { title, tags } = problems();
      if (!size.ok) { draft.error = `Keep this note within ${LIMIT} characters (80 KiB).`; render(); return; }
      if (title || tags) { render(); return; }
    }
    const payload = draft.begin(); draft.pending = true; draft.error = ''; render();
    try {
      const result = await api<PostResponse>(`/api/boards/${boardId}/entries`, payload, signal);
      if (!result?.entry || result.entry.board_id !== boardId || result.entry.kind !== 'note' || typeof result.entry.id !== 'string' || result.entry.markdown !== payload.markdown.replace(/\r\n?/g, '\n')) throw new ApiError('Posting could not be confirmed. Retry to check the same submission.', 503, 'UNCERTAIN_RESPONSE');
      draft.saved(result.entry.id);
      if (!alive()) return;
      textarea.value = ''; titleInput.value = ''; tagsInput.value = ''; preview.replaceChildren(); closeReview(); selectTab(0);
      if (draft.continuation) {
        // Text is still waiting: stay here so the next part is an explicit choice, not an automatic post.
        render(); toast(result.replayed ? 'That part was already saved. No duplicate was posted.' : 'Part posted. The rest is waiting here.');
        cont.panel.focus(); announce(`Saved permanently. ${count(draft.remainder)} characters are still waiting to be posted.`);
      } else {
        render(); finish(result, result.replayed ? 'Your note was already saved. No duplicate was posted.' : 'Note posted. It’s here to stay.');
      }
    } catch (error) {
      const definitive = error instanceof ApiError && [400, 409, 413, 415, 422].includes(error.status);
      draft.failed(error instanceof DOMException && error.name === 'AbortError' ? 'Posting was interrupted. Retry to check the same submission.' : error instanceof Error ? error.message : 'Please try again.', definitive);
      if (alive()) { render(); denied(error); }
    } finally { draft.pending = false; if (alive()) render(); }
  });
  render();
  return () => { cancelPreview(); };
}
