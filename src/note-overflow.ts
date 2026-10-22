import { characterCount, MAX_NOTE_CHARACTERS } from '../shared/note-limits.ts';

// Suggests where to cut a note that is over the limit. A cut is a position in the text: `first` is everything before it and
// `rest` everything from it on, so first + rest is always exactly the original (nothing is trimmed, repaired, or summarized).
// A cut prefers a paragraph break, then a line break, a sentence end, a word gap, and only then a hard cut; it never lands
// inside a fenced code block, table, link, or code span when another cut is available, and never splits a character.
export type BoundaryKind = 'paragraph' | 'line' | 'sentence' | 'word' | 'hard' | 'trailing';
export type Boundary = { pos: number; kind: BoundaryKind; safe: boolean };
export type Split = Boundary & { first: string; rest: string };
const RANK: Record<BoundaryKind, number> = { paragraph: 0, line: 1, sentence: 2, word: 3, hard: 4, trailing: 5 };
type Range = [number, number];

// UTF-16 index just after the first `limit` code points, or the end of the text if it is shorter.
export function indexAfter(text: string, limit: number): number {
  let count = 0, i = 0;
  while (i < text.length && count < limit) { i += text.codePointAt(i)! > 0xffff ? 2 : 1; count++; }
  return i;
}

// Markdown the cut must not run through.
function unsafeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const lines = text.split('\n'), starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  let fence: { char: string; length: number; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) { ranges.push([fence.start, starts[i] + line.length]); fence = null; }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = { char: open[1][0], length: open[1].length, start: starts[i] };
  }
  if (fence) ranges.push([fence.start, text.length]);
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].includes('|') || !lines[i - 1].includes('|') || !separator.test(lines[i])) continue;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].includes('|') && lines[end + 1].trim() !== '') end++;
    ranges.push([starts[i - 1], starts[end] + lines[end].length]);
    i = end;
  }
  for (const pattern of [/!?\[[^\]\n]*\]\([^)\n]*\)/g, /`[^`\n]+`/g]) for (const match of text.matchAll(pattern)) ranges.push([match.index!, match.index! + match[0].length]);
  return ranges;
}
const inside = (pos: number, ranges: Range[]) => ranges.some(([start, end]) => pos > start && pos < end);
const isSpace = (character: string) => /\s/.test(character);

// Paragraph, line, and sentence boundaries up to `maxCut`, in order. A boundary is where the first part would end, so it
// always follows a visible character; whitespace stays with the rest.
function strongBoundaries(text: string, maxCut: number, ranges: Range[]): Boundary[] {
  const found = new Map<number, BoundaryKind>();
  const add = (pos: number, kind: BoundaryKind) => {
    if (pos <= 0 || pos > maxCut || isSpace(text[pos - 1])) return;
    const known = found.get(pos);
    if (known === undefined || RANK[kind] < RANK[known]) found.set(pos, kind);
  };
  for (const match of text.matchAll(/\r?\n(?:[ \t]*\r?\n)+/g)) add(match.index!, 'paragraph');
  for (const match of text.matchAll(/\r?\n/g)) add(match.index!, 'line');
  for (const match of text.matchAll(/[.!?…。！？]["'”’)\]]*(?=\s)/g)) add(match.index! + match[0].length, 'sentence');
  return [...found].map(([pos, kind]) => ({ pos, kind, safe: !inside(pos, ranges) })).sort((a, b) => a.pos - b.pos);
}
// The last space between words that is safe to cut at, and (only if it is later) the last one that is not, so a cut through a
// link or code span is offered only when nothing safe is close enough.
function wordBoundaries(text: string, maxCut: number, ranges: Range[]): Boundary[] {
  let unsafe: Boundary | null = null;
  for (let pos = Math.min(maxCut, text.length - 1); pos > 0; pos--) {
    if (!isSpace(text[pos]) || isSpace(text[pos - 1])) continue;
    if (!inside(pos, ranges)) return [...(unsafe ? [unsafe] : []), { pos, kind: 'word', safe: true }];
    unsafe ??= { pos, kind: 'word', safe: false };
  }
  return unsafe ? [unsafe] : [];
}
// Never between the halves of a surrogate pair, and (where the browser can tell) never inside a grapheme cluster such as an emoji sequence.
function characterBoundary(text: string, maxCut: number): number {
  let cut = Math.min(maxCut, text.length);
  const low = text.charCodeAt(cut), high = text.charCodeAt(cut - 1);
  if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) cut--;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const base = Math.max(0, cut - 100);
    let best = 0;
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(base, cut + 100))) {
      const end = base + part.index + part.segment.length;
      if (end > cut) break;
      best = end;
    }
    if (best > 0) cut = best;
  }
  return Math.max(1, cut);
}

export function splitAt(text: string, boundary: Boundary): Split {
  return { ...boundary, first: text.slice(0, boundary.pos), rest: text.slice(boundary.pos) };
}
// The boundaries a reader can step between with Earlier/Later (word gaps and hard cuts are only ever the starting suggestion).
export function stepBoundaries(text: string, limit = MAX_NOTE_CHARACTERS): Boundary[] {
  return strongBoundaries(text, indexAfter(text, limit), unsafeRanges(text));
}

// null when the text already fits.
export function suggestSplit(text: string, limit = MAX_NOTE_CHARACTERS): Split | null {
  const maxCut = indexAfter(text, limit);
  if (maxCut >= text.length) return null;
  const trimmed = text.trimEnd();
  if (characterCount(trimmed) <= limit) return splitAt(text, { pos: trimmed.length, kind: 'trailing', safe: true });
  const ranges = unsafeRanges(text);
  const all = [...strongBoundaries(text, maxCut, ranges), ...wordBoundaries(text, maxCut, ranges)];
  // A first part under half the limit is not a useful post, so a sizeable cut wins even if it is not the strongest kind of boundary.
  const minimum = Math.floor(maxCut / 2);
  const best = (list: Boundary[]) => [...list].sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.pos - a.pos)[0];
  const sizeable = all.filter(boundary => boundary.pos >= minimum);
  const safe = sizeable.filter(boundary => boundary.safe);
  if (safe.length) return splitAt(text, best(safe));
  // No safe cut of a useful size: propose one that runs through Markdown (flagged), before settling for a tiny first part.
  if (sizeable.length) return splitAt(text, best(sizeable));
  const early = all.filter(boundary => boundary.safe).sort((a, b) => b.pos - a.pos)[0];
  if (early) return splitAt(text, early);
  const pos = characterBoundary(text, maxCut);
  return splitAt(text, { pos, kind: 'hard', safe: !inside(pos, ranges) });
}

// What the next post starts with: the rest, minus the blank lines that separated it from the first part.
export function startOfNextPost(rest: string): string {
  return rest.replace(/^(?:[ \t]*\r?\n)+/, '');
}
