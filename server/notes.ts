import { createHash } from 'node:crypto';
import { markdownExcerpt } from '../shared/markdown.ts';
import type { NotePayload } from '../shared/contracts.ts';
import { characterCount, MAX_NOTE_BYTES, MAX_NOTE_CHARACTERS, MAX_TAG_CHARACTERS, MAX_TAGS, MAX_TITLE_CHARACTERS } from '../shared/note-limits.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class NoteInputError extends Error {}
export class NoteStoreError extends Error {
  code: 'LOCKED' | 'CONFLICT';
  constructor(code: 'LOCKED' | 'CONFLICT') { super(code); this.code = code; }
}
function validString(value: unknown): value is string { return typeof value === 'string' && !value.includes('\u0000') && Buffer.from(value).toString('utf8') === value; }
export function prepareNote(input: Record<string, unknown>): NotePayload & { hash: string; excerpt: string } {
  if (Object.keys(input).some(key => !['kind','requestId','title','markdown','tags'].includes(key)) || input.kind !== 'note' || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw new NoteInputError('This note submission is invalid.');
  if (!validString(input.markdown) || !input.markdown.trim() || characterCount(input.markdown) > MAX_NOTE_CHARACTERS || Buffer.byteLength(input.markdown) > MAX_NOTE_BYTES) throw new NoteInputError('Write a note of up to 20,000 characters (80 KiB).');
  if (input.title != null && (!validString(input.title) || characterCount(input.title.trim()) > MAX_TITLE_CHARACTERS || /[\u0000-\u001f\u007f]/.test(input.title))) throw new NoteInputError('Use a title of up to 120 characters.');
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS || input.tags.some(t => !validString(t) || !t.trim() || characterCount(t.trim().toLowerCase()) > MAX_TAG_CHARACTERS || /[\u0000-\u001f\u007f]/.test(t)))) throw new NoteInputError('Use up to five tags, each with 1–24 characters.');
  const payload: NotePayload = {
    kind:'note',requestId:input.requestId.toLowerCase(),
    title:typeof input.title === 'string' ? input.title.trim() || null : null,
    markdown:input.markdown.replace(/\r\n?/g,'\n'),
    tags:[...new Set((input.tags as string[] | undefined ?? []).map(t=>t.trim().toLowerCase()))].sort()
  };
  const hash=createHash('sha256').update(JSON.stringify([payload.kind,payload.title,payload.markdown,payload.tags])).digest('hex');
  return {...payload,hash,excerpt:markdownExcerpt(payload.markdown)};
}

