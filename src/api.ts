export type Board = { id: string; title: string; created_at: string };
export type BoardResponse = { board: Board; expiresAt: string };
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) { super(message); this.status = status; this.code = code; }
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
