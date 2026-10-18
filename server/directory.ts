import { HttpError } from './errors.ts';

// Validates the public board-name search. Only letters and digits survive, so no
// query syntax can reach the database; the SQL function quotes each word again.
export function parseDirectoryQuery(params: URLSearchParams): string[] {
  if ([...params.keys()].some(key => key !== 'q') || params.getAll('q').length !== 1) throw new HttpError(400, 'QUERY', 'Enter a board name to search for.');
  const raw = params.get('q')!.trim();
  const length = [...raw].length;
  if (length < 2 || length > 80 || /[\u0000-\u001f\u007f]/.test(raw)) throw new HttpError(400, 'QUERY', 'Search with 2 to 80 characters.');
  const words = [...new Set((raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(word => [...word].slice(0, 40).join('')))].slice(0, 5);
  if (!words.some(word => [...word].length >= 2)) throw new HttpError(400, 'QUERY', 'Search with at least one word of 2 or more letters.');
  return words;
}
