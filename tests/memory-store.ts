import { randomUUID } from 'node:crypto';
import type { BoardCredential, LimitResult, Store } from '../server/types.ts';
import type { NoteEntry, DrawingEntry, PostResponse } from '../shared/contracts.ts';
import type {DrawingInsert} from '../server/types.ts';
import {checksum} from '../server/images.ts';
import type {SearchCursor,SearchRow} from '../server/search.ts';
import type {FeedQuery} from '../shared/browse.ts';
import { NoteStoreError } from '../server/notes.ts';

// Test fixture only. No in-memory database is selectable by the application.
export class MemoryStore implements Store {
  credentials = new Map<string, BoardCredential>();
  grants = new Map<string, string>();
  notes=new Map<string,NoteEntry & {requestId:string;hash:string;excerpt:string}>();
  failAfterWrite=false;
  drawings=new Map<string,DrawingEntry & {requestId:string;hash:string;excerpt:string;objectKey:string;sha256:string}>();
  files=new Map<string,{bytes:Uint8Array;mime:string}>();
  failBeforeDrawingInsert=false;failAfterUpload=false;revokeAfterUpload=false;putCalls=0;
  rateCalls: string[] = [];
  blocked = false;
  unavailable = false;
  now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  async searchBoards(words: string[]) {
    if (this.unavailable) throw new Error('offline');
    this.searches.push(words);
    return [...this.credentials.values()].filter(b => b.listed && words.every(w => (b.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).some(t => t.startsWith(w))))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 21).map(({ id, title, created_at }) => ({ id, title, created_at }));
  }
  searches: string[][] = [];
  async createBoard(input: {title:string;password_hash:string;token_hash:string;expires_at:string;listed:boolean}) {
    const board = { id: randomUUID(), title: input.title, password_hash: input.password_hash, created_at: new Date(this.now()).toISOString(), listed: input.listed };
    this.credentials.set(board.id, board); await this.grant(input.token_hash, board.id, input.expires_at);
    const { password_hash: _, ...safe } = board; return safe;
  }
  async findCredential(id: string) { return this.credentials.get(id) ?? null; }
  async hasSession(token: string) { return [...this.grants].some(([k, v]) => k.startsWith(`${token}|`) && Date.parse(v) > this.now()); }
  async findGrant(token: string, id: string) { const expires_at = this.grants.get(`${token}|${id}`); return expires_at && Date.parse(expires_at) > this.now() ? { expires_at } : null; }
  async grant(token: string, id: string, expires: string) { this.grants.set(`${token}|${id}`, expires); }
  async revoke(token: string, id: string) { this.grants.delete(`${token}|${id}`); }
  async board(id: string) { const item = this.credentials.get(id); if (!item) return null; const { password_hash: _, ...safe } = item; return safe; }
  async consumeLimit(key: string): Promise<LimitResult> { if (this.unavailable) throw new Error('offline'); this.rateCalls.push(key); return { allowed: !this.blocked, retry_after: 60 }; }
  async postNote(input:Parameters<Store['postNote']>[0]):Promise<PostResponse> {
    if(!await this.findGrant(input.tokenHash,input.boardId))throw new NoteStoreError('LOCKED');
    const key=`${input.boardId}|${input.requestId}`;
    if(this.drawings.has(key))throw new NoteStoreError('CONFLICT');
    const previous=this.notes.get(key);
    if(previous&&previous.hash!==input.hash)throw new NoteStoreError('CONFLICT');
    const stored=previous??{id:randomUUID(),board_id:input.boardId,kind:'note' as const,title:input.title,markdown:input.markdown,tags:input.tags,created_at:new Date(this.now()).toISOString(),requestId:input.requestId,hash:input.hash,excerpt:input.excerpt};
    this.notes.set(key,stored);
    if(this.failAfterWrite){this.failAfterWrite=false;throw new Error('Response lost after commit');}
    const {requestId:_,hash:__,excerpt:___,...entry}=stored;
    return {entry,replayed:!!previous};
  }
  async entries(boardId:string,query:FeedQuery,cursor:SearchCursor|null):Promise<SearchRow[]> {
    const snapshot=cursor?.snapshot??new Date(this.now()).toISOString();
    const terms=query.q.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
    return [...this.notes.values(),...this.drawings.values()].filter(n=>{
      const text=[n.title,n.kind==='note'?n.markdown:n.drawing_caption,...n.tags].join(' ').toLowerCase();
      const words:string[]=text.match(/[\p{L}\p{N}]+/gu)??[];
      return n.board_id===boardId&&n.created_at<=snapshot&&(!query.q||(terms.length>0&&terms.every(t=>words.includes(t))))
        &&(query.kind==='all'||n.kind===query.kind)&&query.tags.every(t=>n.tags.includes(t))&&(!query.from||n.created_at>=query.from)&&(!query.to||n.created_at<query.to);
    }).map(n=>({id:n.id,board_id:n.board_id,kind:n.kind,title:n.title,tags:n.tags,created_at:n.created_at,excerpt:n.excerpt,...(n.kind==='drawing'?{width:n.width,height:n.height,drawing_caption:n.drawing_caption}:{}),rank_key:query.sort==='relevance'?'0.1':null,snapshot_at:snapshot}))
      .filter(n=>!cursor?.createdAt||(query.sort==='oldest'?(n.created_at>cursor.createdAt||(n.created_at===cursor.createdAt&&n.id>cursor.id!)):(n.created_at<cursor.createdAt||(n.created_at===cursor.createdAt&&n.id<cursor.id!))))
      .sort((a,b)=>(query.sort==='oldest'?1:-1)*(a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))).slice(0,21);
  }
  async entry(boardId:string,entryId:string){
    const note=[...this.notes.values(),...this.drawings.values()].find(n=>n.board_id===boardId&&n.id===entryId);
    if(!note)return null;return this.safeEntry(note);
  }
  private safeEntry(note:(NoteEntry|DrawingEntry)&{requestId:string;hash:string;excerpt:string}){
    const common={id:note.id,board_id:note.board_id,kind:note.kind,title:note.title,tags:note.tags,created_at:note.created_at};
    return (note.kind==='note'?{...common,kind:'note' as const,markdown:note.markdown}:{...common,kind:'drawing' as const,drawing_caption:note.drawing_caption,width:note.width,height:note.height,image_mime:note.image_mime,image_bytes:note.image_bytes});
  }
  async submission(boardId:string,requestId:string){const value=this.notes.get(`${boardId}|${requestId}`)??this.drawings.get(`${boardId}|${requestId}`);return value?{entry:this.safeEntry(value),hash:value.hash}:null;}
  async putDrawing(objectKey:string,bytes:Uint8Array,mime:string){
    this.putCalls++;const previous=this.files.get(objectKey);if(previous&&checksum(previous.bytes)!==checksum(bytes))throw new Error('Cannot overwrite');
    this.files.set(objectKey,{bytes:new Uint8Array(bytes),mime});
    if(this.revokeAfterUpload){this.revokeAfterUpload=false;this.grants.clear();}
    if(this.failAfterUpload){this.failAfterUpload=false;throw new Error('Upload acknowledgment lost');}
  }
  async postDrawing(input:DrawingInsert):Promise<PostResponse>{
    if(!await this.findGrant(input.tokenHash,input.boardId))throw new NoteStoreError('LOCKED');
    if(this.failBeforeDrawingInsert){this.failBeforeDrawingInsert=false;throw new Error('DB unavailable');}
    const key=`${input.boardId}|${input.requestId}`;
    const old=this.drawings.get(key)??this.notes.get(key);if(old&&(old.kind!=='drawing'||old.hash!==input.hash))throw new NoteStoreError('CONFLICT');
    const value=old&&old.kind==='drawing'?old:{id:randomUUID(),board_id:input.boardId,kind:'drawing' as const,title:input.title,drawing_caption:input.caption,tags:input.tags,created_at:new Date(this.now()).toISOString(),width:input.width,height:input.height,image_mime:input.mime,image_bytes:input.bytes,objectKey:input.objectKey,sha256:input.sha256,requestId:input.requestId,hash:input.hash,excerpt:input.caption??''};
    this.drawings.set(key,value);
    if(this.failAfterWrite){this.failAfterWrite=false;throw new Error('Lost commit acknowledgment');}
    return {entry:this.safeEntry(value),replayed:!!old};
  }
  async drawingImage(boardId:string,entryId:string){
    const drawing=[...this.drawings.values()].find(n=>n.board_id===boardId&&n.id===entryId);if(!drawing)return null;
    const file=this.files.get(drawing.objectKey);if(!file||checksum(file.bytes)!==drawing.sha256)throw new Error('Missing or corrupt image');
    return file;
  }
}
