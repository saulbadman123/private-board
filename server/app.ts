import { isIP } from 'node:net';
import { digestToken, hashPassword, HashBusyError, newToken, rateKey, verifyPassword } from './crypto.ts';
import type { AppConfig, Store } from './types.ts';
import { prepareNote, NoteInputError, NoteStoreError } from './notes.ts';
import {parseFeedQuery,decodeSearchCursor,encodeSearchCursor} from './search.ts';
import {HttpError} from './errors.ts';
import {postDrawing} from './drawings.ts';
import {parseDirectoryQuery} from './directory.ts';

const WEEK = 7 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECURITY = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Vary': 'Cookie', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...SECURITY, ...extra } });
}
export function unavailable(): Response { return json({ error: { code: 'NOT_CONFIGURED', message: 'The board service is not configured yet.' } }, 503); }

function cookieName(config: AppConfig): string { return config.production || config.origin.startsWith('https:') ? '__Host-board_session' : 'board_session_dev'; }
function readToken(request: Request, config: AppConfig): string | null {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName(config)}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(cookieName(config).length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
function sessionCookie(token: string, config: AppConfig): string {
  return `${cookieName(config)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${WEEK}${cookieName(config).startsWith('__Host-') ? '; Secure' : ''}`;
}
function guardOrigin(request: Request, config: AppConfig): void {
  const site = request.headers.get('sec-fetch-site');
  if (request.headers.get('origin') !== config.origin || request.headers.get('x-board-request') !== '1' || (site !== null && site !== 'same-origin')) {
    throw new HttpError(403, 'FORBIDDEN', 'This request is not allowed.');
  }
}
async function body(request: Request, maxBytes=4096): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'CONTENT_TYPE', 'Send JSON data.');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new HttpError(413, 'TOO_LARGE', 'This request is too large.');
  const reader = request.body?.getReader();
  let text = '';
  if (reader) {
    const chunks: Uint8Array[] = []; let count = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > maxBytes) { await reader.cancel(); throw new HttpError(413, 'TOO_LARGE', 'This request is too large.'); }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError(400, 'INVALID_JSON', 'Check the submitted information.'); }
}
function readOnly(): HttpError {
  return new HttpError(503, 'READ_ONLY', 'New posts are paused while storage capacity is expanded. Your draft is still here; try again later.', 300);
}
function password(value: unknown, creating: boolean, minimum = 12): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 || value.length === 0 || (creating && [...value].length < minimum)) {
    throw new HttpError(400, 'PASSWORD', creating ? `Use at least ${minimum} characters, up to 256 bytes.` : 'Enter your board password.');
  }
  return value;
}
function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'TITLE', 'Use a board name of 1–80 characters.');
  return value.trim();
}

export function createApp(store: Store, config: AppConfig, clock: () => number = Date.now) {
  // Vercel overwrites x-vercel-forwarded-for. Never trust arbitrary x-forwarded-for.
  function clientIp(request: Request): string {
    if (!config.production) return 'local-development';
    const ip = request.headers.get('x-vercel-forwarded-for')?.trim();
    if (!ip || !isIP(ip)) throw new HttpError(503, 'UNAVAILABLE', 'Access checks are temporarily unavailable.');
    return ip;
  }
  async function limit(purpose: string, subject: string, count: number, seconds: number) {
    const key = rateKey(config.rateSecret, purpose, subject, new Date(clock()).toISOString().slice(0, 10));
    const result = await store.consumeLimit(key, count, seconds);
    if (!result.allowed) throw new HttpError(429, 'RATE_LIMIT', 'Please wait a little before trying again.', result.retry_after);
  }
  async function browserSession(request: Request): Promise<string> {
    const existing = readToken(request, config);
    return existing && await store.hasSession(digestToken(existing)) ? existing : newToken();
  }
  return async function handle(request: Request): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'OPTIONS') throw new HttpError(403, 'FORBIDDEN', 'This request is not allowed.');
      const creating = pathname === '/api/boards';
      const match = /^\/api\/boards\/([^/]+)(?:\/(unlock|lock))?$/.exec(pathname);
      const entriesMatch=/^\/api\/boards\/([^/]+)\/entries(?:\/([^/]+)(\/image)?)?$/.exec(pathname);
      if (!creating && ((!match && !entriesMatch) || !UUID.test((match ?? entriesMatch)![1]) || (entriesMatch?.[2] && !UUID.test(entriesMatch[2])))) throw new HttpError(404, 'NOT_FOUND', 'This page is unavailable.');
      const boardId = (match ?? entriesMatch)?.[1].toLowerCase();
      const action = match?.[2];
      const collection=!!entriesMatch && !entriesMatch[2];
      const allowed=collection ? ['GET','POST'] : creating ? ['GET','POST'] : action ? ['POST'] : ['GET'];
      if (!allowed.includes(request.method)) return json({ error: { code: 'METHOD', message: 'This action is not available.' } }, 405, { Allow: allowed.join(', ') });
      const method=request.method;
      if (method === 'POST') guardOrigin(request, config);
      const ip = clientIp(request);
      await limit('api-ip', ip, 300, 60);

      if (creating && method === 'GET') {
        // Public name lookup. Only boards whose creators chose to list them can match.
        await limit('directory', ip, 30, 60);
        await limit('directory-global', 'deployment', 3000, 60);
        const rows = await store.searchBoards(parseDirectoryQuery(new URL(request.url).searchParams));
        return json({ boards: rows.slice(0, 20).map(({ id, title, created_at }) => ({ id, title, created_at })), more: rows.length > 20 });
      }
      if (creating) {
        if (config.writesDisabled) throw readOnly();
        await limit('create', ip, 5, 3600);
        await limit('create-global', 'deployment', 500, 3600);
        const input = await body(request);
        if (Object.keys(input).some(k => !['title','password','listed'].includes(k))) throw new HttpError(400, 'FIELDS', 'Unexpected information.');
        if (input.listed !== undefined && typeof input.listed !== 'boolean') throw new HttpError(400, 'FIELDS', 'Unexpected information.');
        const listed = input.listed === true;
        const boardTitle = title(input.title); const secret = password(input.password, true, listed ? 16 : 12);
        const hashed = await hashPassword(secret);
        const token = await browserSession(request);
        const expiresAt = new Date(clock() + WEEK * 1000).toISOString();
        const board = await store.createBoard({ title: boardTitle, password_hash: hashed, token_hash: digestToken(token), expires_at: expiresAt, listed });
        return json({ board, expiresAt }, 201, { 'Set-Cookie': sessionCookie(token, config) });
      }
      if (action === 'unlock') {
        await limit('unlock-ip', ip, 30, 600);
        await limit('unlock-board-ip', `${ip}|${boardId}`, 10, 600);
        await limit('unlock-board', boardId!, 200, 600);
        await limit('unlock-global', 'deployment', 2000, 600);
        const input = await body(request);
        if (Object.keys(input).some(k => k !== 'password')) throw new HttpError(400, 'FIELDS', 'Unexpected information.');
        const secret = password(input.password, false);
        const credential = await store.findCredential(boardId!);
        if (!await verifyPassword(secret, credential?.password_hash ?? null)) throw new HttpError(401, 'ACCESS_DENIED', 'Unable to open this board. Check the link and password.');
        const token = await browserSession(request);
        const expiresAt = new Date(clock() + WEEK * 1000).toISOString();
        await store.grant(digestToken(token), boardId!, expiresAt);
        const { password_hash: _, ...board } = credential!;
        return json({ board, expiresAt }, 200, { 'Set-Cookie': sessionCookie(token, config) });
      }

      const token = readToken(request, config);
      if (!token) throw new HttpError(401, 'LOCKED', 'Enter the board password to continue.');
      // The rate bucket is board-scoped. Revoke is deliberately idempotent.
      if (action === 'lock') {
        await limit('lock', `${digestToken(token)}|${boardId}`, 30, 60);
        await store.revoke(digestToken(token), boardId!);
        return json({ locked: true });
      }
      const grant = await store.findGrant(digestToken(token), boardId!);
      if (!grant || Date.parse(grant.expires_at) <= clock()) throw new HttpError(401, 'LOCKED', 'Enter the board password to continue.');
      if (collection && method==='POST') {
        if (config.writesDisabled) throw readOnly();
        await limit('post',`${digestToken(token)}|${boardId}`,10,60);
        await limit('post-board',boardId!,100,60);
        await limit('post-global','deployment',1000,60);
        if(/^multipart\/form-data(?:\s*;|$)/i.test(request.headers.get('content-type')??'')){
          const result=await postDrawing(request,store,boardId!,digestToken(token));
          return json(result,result.replayed?200:201);
        }
        const note=prepareNote(await body(request,128*1024));
        const result=await store.postNote({boardId:boardId!,tokenHash:digestToken(token),requestId:note.requestId,hash:note.hash,title:note.title,markdown:note.markdown,tags:note.tags,excerpt:note.excerpt});
        return json(result,result.replayed ? 200 : 201);
      }
      await limit('read', `${digestToken(token)}|${boardId}`, 120, 60);
      if (collection) {
        const params=new URL(request.url).searchParams;
        const query=parseFeedQuery(params);
        const cursor=decodeSearchCursor(boardId!,query,params.get('cursor'));
        const rows=await store.entries(boardId!,query,cursor);
        const entries=rows.slice(0,20).map(({rank_key:_,snapshot_at:__,...entry})=>entry);
        return json({entries,pageCursor:params.get('cursor')??(rows[0]?encodeSearchCursor(boardId!,query,rows[0],true):null),nextCursor:rows.length>20 ? encodeSearchCursor(boardId!,query,rows[19]) : null});
      }
      if (entriesMatch?.[2]) {
        if(entriesMatch[3]){
          const image=await store.drawingImage(boardId!,entriesMatch[2].toLowerCase());
          if(!image)throw new HttpError(404,'NOT_FOUND','This drawing is unavailable.');
          return new Response(image.bytes as BodyInit,{headers:{...SECURITY,'Content-Type':image.mime,'Content-Length':String(image.bytes.byteLength),'Content-Disposition':`inline; filename="drawing.${image.mime==='image/webp'?'webp':'png'}"`}});
        }
        const entry=await store.entry(boardId!,entriesMatch[2].toLowerCase());
        if (!entry) throw new HttpError(404,'NOT_FOUND','This entry is unavailable.');
        return json({entry});
      }
      const board = await store.board(boardId!);
      if (!board) throw new HttpError(401, 'LOCKED', 'Enter the board password to continue.');
      return json({ board, expiresAt: grant.expires_at });
    } catch (error) {
      if (error instanceof NoteInputError) return json({error:{code:'NOTE_INPUT',message:error.message}},400);
      if (error instanceof NoteStoreError) return json({error:{code:error.code,message:error.code==='LOCKED' ? 'Enter the board password to continue.' : 'This submission ID already belongs to another note. The saved note has not changed.'}},error.code==='LOCKED' ? 401 : 409);
      if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status, error.retryAfter ? { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfter))) } : {});
      if (error instanceof HashBusyError) return json({ error: { code: 'BUSY', message: 'Please try again in a moment.' } }, 503, { 'Retry-After': '2' });
      // No request bodies, credentials, provider error details, or cookies in logs/responses.
      console.error('Private Board: backend operation failed');
      return json({ error: { code: 'UNAVAILABLE', message: 'The board service is temporarily unavailable. Please try again.' } }, 503);
    }
  };
}
