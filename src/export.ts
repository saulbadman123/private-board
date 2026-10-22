// Getting content out of the page: the clipboard and file downloads. Both are explicit user actions.

// Copies text. When the clipboard is unavailable or refused, the caller's own read-only text box (if given) is focused and
// selected so the person can press Ctrl/Cmd+C; returns false in that case so the caller can say so.
export async function copyText(text: string, fallback?: HTMLTextAreaElement | HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallback) { fallback.value = text; fallback.hidden = false; fallback.focus(); fallback.select(); }
    return false;
  }
}

// Saves a blob as a file through a temporary link. The object URL lives only for the click.
export function saveBlob(blob: Blob, filename: string) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url; link.download = filename; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export const extensionFor = (mime: string) => mime === 'image/webp' ? 'webp' : 'png';
