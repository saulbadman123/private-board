import { Marked } from 'marked';
import type { Token } from 'marked';
import { escapeHtml } from './escape.ts';
export function safeLink(href: string): string | null {
  try { const url = new URL(href); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

const parser = new Marked({
  gfm: true, breaks: false, async: false,
  renderer: {
    html({ text }) { return escapeHtml(text); },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = safeLink(href);
      return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${text}</a>` : text;
    },
    image({ href, text }) {
      const safe = safeLink(href);
      const label = escapeHtml(text || 'Image link');
      return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${label} (image)</a>` : label;
    },
    checkbox({ checked }) { return `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? 'Completed' : 'Not completed'} task" />`; }
  }
});

// Must pass through the browser sanitizer before insertion as HTML.
export function parsedMarkdown(markdown: string): string { return parser.parse(markdown, { async: false }); }

export function markdownExcerpt(markdown: string): string {
  function plain(token: Token): string {
    if (token.type === 'space' || token.type === 'hr') return ' ';
    if (token.type === 'list') return token.items.map(plain).join(' ');
    if (token.type === 'table') return [...token.header, ...token.rows.flat()].map(cell => cell.tokens.map(plain).join('')).join(' ');
    if ('tokens' in token && Array.isArray(token.tokens)) return token.tokens.map(plain).join('');
    if ('text' in token && typeof token.text === 'string') return token.text;
    return ' ';
  }
  return [...parser.lexer(markdown).map(plain).join(' ').replace(/\s+/g, ' ').trim()].slice(0, 600).join('');
}
