// Note, title, tag, and caption limits shared by the browser and the server, with the same counting rules on both sides.
// Length is counted in Unicode code points (not UTF-16 units, so an emoji is 1), with a UTF-8 byte cap as a backstop.
export const MAX_NOTE_CHARACTERS = 20000;
export const MAX_NOTE_BYTES = 81920;
export const MAX_TITLE_CHARACTERS = 120;
export const MAX_TAGS = 5;
export const MAX_TAG_CHARACTERS = 24;
export const MAX_CAPTION_CHARACTERS = 280;
const CONTROL = /[\u0000-\u001f\u007f]/;

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
// Same result as [...text].length, without building an array for every keystroke.
export function characterCount(text: string): number {
  let count = text.length;
  for (let i = 0; i < text.length - 1; i++) if (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1))) { count--; i++; }
  return count;
}
// Same result as Buffer.byteLength(text): a lone surrogate is encoded as U+FFFD, three bytes.
export function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isHigh(unit) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
// False for a lone surrogate, which the server rejects.
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (isHigh(unit)) { if (i + 1 < text.length && isLow(text.charCodeAt(i + 1))) i++; else return false; }
    else if (isLow(unit)) return false;
  }
  return true;
}

export type NoteMeasure = { characters: number; bytes: number; overCharacters: number; overBytes: number; wellFormed: boolean; ok: boolean };
export function measureNote(text: string): NoteMeasure {
  const characters = characterCount(text), bytes = byteLength(text), wellFormed = isWellFormed(text);
  const overCharacters = Math.max(0, characters - MAX_NOTE_CHARACTERS), overBytes = Math.max(0, bytes - MAX_NOTE_BYTES);
  return { characters, bytes, overCharacters, overBytes, wellFormed, ok: overCharacters === 0 && overBytes === 0 && wellFormed && !text.includes('\u0000') };
}

export function titleProblem(title: string): string | null {
  const value = title.trim();
  if (CONTROL.test(title)) return 'The title cannot contain control characters.';
  if (characterCount(value) > MAX_TITLE_CHARACTERS) return `Use a title of up to ${MAX_TITLE_CHARACTERS} characters (it is ${characterCount(value)}).`;
  return null;
}
// Splits a comma-separated tag field the way the draft sends it. `problem` explains what the server would reject.
export function parseTagField(text: string): { tags: string[]; problem: string | null } {
  const tags = text.split(',').map(tag => tag.trim()).filter(Boolean);
  if (tags.length > MAX_TAGS) return { tags, problem: `Use up to ${MAX_TAGS} tags (there are ${tags.length}).` };
  if (tags.some(tag => CONTROL.test(tag))) return { tags, problem: 'Tags cannot contain control characters.' };
  const long = tags.find(tag => characterCount(tag.toLowerCase()) > MAX_TAG_CHARACTERS);
  if (long !== undefined) return { tags, problem: `Each tag can be up to ${MAX_TAG_CHARACTERS} characters.` };
  return { tags, problem: null };
}
