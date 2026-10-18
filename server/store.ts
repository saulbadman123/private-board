import { createClient } from '@supabase/supabase-js';
import { NoteStoreError } from './notes.ts';
import type { Entry, PostResponse } from '../shared/contracts.ts';
import type {SearchRow} from './search.ts';
import {checksum} from './images.ts';
import type { AppConfig, Board, BoardCredential, BoardSummary, LimitResult, SessionGrant, Store } from './types.ts';

export function createStore(config: AppConfig): Store {
  const db = createClient(config.supabaseUrl, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }) }
  });
  const check = (error: unknown) => { if (error) throw new Error('Database operation failed'); };
  function publicEntry(row:Record<string,unknown>):Entry{
    const base={id:row.id,board_id:row.board_id,kind:row.kind,title:row.title,tags:row.tags,created_at:row.created_at};
    return (row.kind==='note'?{...base,markdown:row.markdown}:{...base,drawing_caption:row.drawing_caption,width:row.width,height:row.height,image_mime:row.image_mime,image_bytes:row.image_bytes}) as Entry;
  }
  const entryColumns='id,board_id,kind,title,markdown,tags,created_at,drawing_caption,width,height,image_mime,image_bytes';
  return {
    async createBoard(input) {
      const { data, error } = await db.rpc('create_board_with_session', {
        p_title: input.title, p_password_hash: input.password_hash, p_token_hash: input.token_hash, p_expires_at: input.expires_at, p_listed: input.listed
      });
      check(error);
      if (!data?.[0]) throw new Error('Missing board result');
      return data[0] as Board;
    },
    async searchBoards(words) {
      const { data, error } = await db.rpc('search_listed_boards', { p_words: words });
      check(error); return (data ?? []) as BoardSummary[];
    },
    async findCredential(boardId) {
      const { data, error } = await db.from('boards').select('id,title,password_hash,created_at,listed').eq('id', boardId).maybeSingle();
      check(error); return data as BoardCredential | null;
    },
    async hasSession(tokenHash) {
      const { data, error } = await db.from('board_sessions').select('board_id').eq('token_hash', tokenHash).gt('expires_at', new Date().toISOString()).limit(1);
      check(error); return !!data?.length;
    },
    async findGrant(tokenHash, boardId) {
      const { data, error } = await db.from('board_sessions').select('expires_at').eq('token_hash', tokenHash).eq('board_id', boardId).gt('expires_at', new Date().toISOString()).maybeSingle();
      check(error); return data as SessionGrant | null;
    },
    async grant(tokenHash, boardId, expiresAt) {
      const { error } = await db.from('board_sessions').upsert({ token_hash: tokenHash, board_id: boardId, expires_at: expiresAt }, { onConflict: 'token_hash,board_id' });
      check(error);
    },
    async revoke(tokenHash, boardId) {
      const { error } = await db.from('board_sessions').delete().eq('token_hash', tokenHash).eq('board_id', boardId);
      check(error);
    },
    async board(boardId) {
      const { data, error } = await db.from('boards').select('id,title,created_at,listed').eq('id', boardId).maybeSingle();
      check(error); return data as Board | null;
    },
    async postNote(input) {
      const {data,error}=await db.rpc('post_note',{
        p_board_id:input.boardId,p_token_hash:input.tokenHash,p_request_id:input.requestId,p_request_hash:input.hash,
        p_title:input.title,p_markdown:input.markdown,p_tags:input.tags,p_excerpt:input.excerpt
      });
      if (error?.code==='42501') throw new NoteStoreError('LOCKED');
      if (error?.code==='P0001') throw new NoteStoreError('CONFLICT');
      check(error);
      if (!data?.[0]) throw new Error('Missing note result');
      return data[0] as PostResponse;
    },
    async entries(boardId,query,cursor) {
      const {data,error}=await db.rpc('search_board_entries',{
        p_board_id:boardId,p_query:query.q,p_kind:query.kind,p_tags:query.tags,p_from:query.from,p_to:query.to,p_sort:query.sort,
        p_at:cursor?.createdAt??null,p_id:cursor?.id??null,p_rank:cursor?.rank??null,p_snapshot:cursor?.snapshot??null
      });
      check(error); return data as SearchRow[];
    },
    async entry(boardId,entryId) {
      const {data,error}=await db.from('entries').select(entryColumns).eq('board_id',boardId).eq('id',entryId).maybeSingle();
      check(error); return data ? publicEntry(data) : null;
    },
    async submission(boardId,requestId){
      const {data,error}=await db.from('entries').select('id,board_id,kind,title,markdown,tags,created_at,drawing_caption,width,height,image_mime,image_bytes,request_hash').eq('board_id',boardId).eq('request_id',requestId).maybeSingle();
      check(error);return data?{entry:publicEntry(data),hash:data.request_hash}:null;
    },
    async putDrawing(objectKey,bytes,mime){
      const {error}=await db.storage.from('drawings').upload(objectKey,bytes,{contentType:mime,upsert:false,cacheControl:'0'});
      if(error){
        // A concurrent upload or a lost acknowledgment can leave identical bytes.
        // Verify instead of overwriting; every other failure remains a failure.
        const existing=await db.storage.from('drawings').download(objectKey);
        if(existing.error||!existing.data||checksum(new Uint8Array(await existing.data.arrayBuffer()))!==checksum(bytes))throw new Error('Drawing storage failed');
      }
    },
    async postDrawing(input){
      const {data,error}=await db.rpc('post_drawing',{
        p_board_id:input.boardId,p_token_hash:input.tokenHash,p_request_id:input.requestId,p_request_hash:input.hash,
        p_title:input.title,p_caption:input.caption,p_tags:input.tags,p_object_key:input.objectKey,
        p_width:input.width,p_height:input.height,p_mime:input.mime,p_bytes:input.bytes,p_sha256:input.sha256
      });
      if(error?.code==='42501')throw new NoteStoreError('LOCKED');
      if(error?.code==='P0001')throw new NoteStoreError('CONFLICT');
      check(error);if(!data?.[0])throw new Error('Missing drawing result');return data[0] as PostResponse;
    },
    async drawingImage(boardId,entryId){
      const {data,error}=await db.from('entries').select('object_key,image_mime,image_bytes,image_sha256').eq('board_id',boardId).eq('id',entryId).eq('kind','drawing').maybeSingle();
      check(error);if(!data)return null;
      const image=await db.storage.from('drawings').download(data.object_key);
      check(image.error);if(!image.data)throw new Error('Missing drawing');
      const bytes=new Uint8Array(await image.data.arrayBuffer());
      if(bytes.length!==data.image_bytes||checksum(bytes)!==data.image_sha256)throw new Error('Drawing integrity check failed');
      return {bytes,mime:data.image_mime};
    },
    async consumeLimit(key, limit, seconds) {
      const { data, error } = await db.rpc('consume_rate_limit', { p_key: key, p_limit: limit, p_window_seconds: seconds });
      check(error);
      if (!data?.[0]) throw new Error('Missing rate limit result');
      return data[0] as LimitResult;
    }
  };
}
