import type { Entry, PostResponse } from '../shared/contracts.ts';
import type { SearchCursor, SearchRow } from './search.ts';
import type { FeedQuery } from '../shared/browse.ts';
export type Board = { id: string; title: string; created_at: string; listed?: boolean };
export type BoardSummary = { id: string; title: string; created_at: string };
export type BoardCredential = Board & { password_hash: string };
export type SessionGrant = { expires_at: string };
export type LimitResult = { allowed: boolean; retry_after: number };

export interface Store {
  createBoard(input: { title: string; password_hash: string; token_hash: string; expires_at: string; listed: boolean }): Promise<Board>;
  searchBoards(words: string[]): Promise<BoardSummary[]>;
  findCredential(boardId: string): Promise<BoardCredential | null>;
  hasSession(tokenHash: string): Promise<boolean>;
  findGrant(tokenHash: string, boardId: string): Promise<SessionGrant | null>;
  grant(tokenHash: string, boardId: string, expiresAt: string): Promise<void>;
  revoke(tokenHash: string, boardId: string): Promise<void>;
  board(boardId: string): Promise<Board | null>;
  consumeLimit(key: string, limit: number, seconds: number): Promise<LimitResult>;
  postNote(input: {boardId:string; tokenHash:string; requestId:string; hash:string; title:string|null; markdown:string; tags:string[]; excerpt:string}): Promise<PostResponse>;
  entries(boardId: string, query: FeedQuery, cursor: SearchCursor | null): Promise<SearchRow[]>;
  entry(boardId: string, entryId: string): Promise<Entry | null>;
  submission(boardId:string,requestId:string):Promise<{entry:Entry;hash:string}|null>;
  putDrawing(objectKey:string,bytes:Uint8Array,mime:string):Promise<void>;
  postDrawing(input:DrawingInsert):Promise<PostResponse>;
  drawingImage(boardId:string,entryId:string):Promise<{bytes:Uint8Array;mime:string}|null>;
}
export type DrawingInsert={boardId:string;tokenHash:string;requestId:string;hash:string;title:string|null;caption:string|null;tags:string[];objectKey:string;width:number;height:number;mime:'image/png'|'image/webp';bytes:number;sha256:string};

export type AppConfig = { supabaseUrl: string; secretKey: string; origin: string; rateSecret: string; production: boolean; writesDisabled?: boolean };
