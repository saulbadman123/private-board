export type Board = { id: string; title: string; created_at: string; listed?: boolean };
export type BoardSearchResult = { boards: { id: string; title: string; created_at: string }[]; more: boolean };
export type BoardResponse = { board: Board; expiresAt: string };
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) { super(message); this.status = status; this.code = code; }
}
// Fetches a private file (a drawing's stored bytes) through the same authorized route the page uses; never a public or signed URL.
export async function apiBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('Could not connect. Please try again.', 0, 'NETWORK');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(data?.error?.message ?? 'Something went wrong. Please try again.', response.status, data?.error?.code ?? 'UNKNOWN');
  }
  return response.blob();
}
export async function api<T>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    const multipart=input instanceof FormData;
    response = await fetch(path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: input === undefined ? {} : multipart ? { 'X-Board-Request': '1' } : { 'Content-Type': 'application/json', 'X-Board-Request': '1' },
      credentials: 'same-origin', cache: 'no-store', signal,
      ...(input === undefined ? {} : { body: multipart ? input : JSON.stringify(input) })
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('Could not connect. Your information is still here; please try again.', 0, 'NETWORK');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error?.message ?? 'Something went wrong. Please try again.', response.status, data?.error?.code ?? 'UNKNOWN');
  if(data===null)throw new ApiError('The server response could not be confirmed. Please retry the same submission.',503,'UNCERTAIN_RESPONSE');
  return data as T;
}
