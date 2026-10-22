import type { NotePayload,DrawingAttempt } from '../shared/contracts.ts';
import {clearBrowse} from './browse.ts';
import {clearFeed} from './feed-state.ts';
import {DrawingHistory} from './drawing-history.ts';
import {parseTagField} from '../shared/note-limits.ts';

export class NoteDraft {
  mode:'write'|'draw'='write';
  title=''; markdown=''; tags='';
  attempt: NotePayload | null=null;
  pending=false;
  error='';
  // Long-note recovery, held in this tab only. `remainder` is text still waiting for a post of its own; `split` exists between
  // "Use first part" and a confirmed post, so the split can be undone; `continuation` appears once the first part is saved.
  remainder='';
  split: {source:string;first:string} | null=null;
  continuation: {entryId:string;title:string;tags:string} | null=null;
  hasContent(): boolean { return !!(this.title.trim() || this.markdown.trim() || this.tags.trim() || this.attempt || this.remainder.trim()); }
  begin(): NotePayload {
    this.attempt ??= {kind:'note',requestId:crypto.randomUUID(),title:this.title.trim() || null,markdown:this.markdown,tags:parseTagField(this.tags).tags};
    // Callers get a copy; a retry always uses the frozen original content.
    return structuredClone(this.attempt);
  }
  failed(message: string, definitive=false) {
    this.pending=false;this.error=message;
    if (definitive) this.attempt=null;
  }
  // The post is confirmed. Remaining text is never dropped: it waits for an explicit "Continue".
  saved(entryId?: string) {
    this.continuation=this.remainder.trim()&&entryId?{entryId,title:this.title,tags:this.tags}:null;
    this.title='';this.markdown='';this.tags='';this.attempt=null;this.pending=false;this.error='';this.split=null;
  }
  // Replace the draft with the first part of a split and keep the rest. Refused while other remaining text is waiting.
  useFirstPart(source: string, first: string, rest: string): boolean {
    if (this.remainder.trim()||this.attempt) return false;
    this.split={source,first};this.markdown=first;this.remainder=rest;this.error='';
    return true;
  }
  // Only before anything was posted or sent.
  undoSplit(): boolean {
    if (!this.split||this.attempt) return false;
    this.markdown=this.split.source;this.remainder='';this.split=null;this.error='';
    return true;
  }
  // The remaining text becomes the next editable draft, with a fresh request ID when it is posted.
  continueWithRemainder(): boolean {
    if (this.attempt||!this.remainder.trim()) return false;
    this.markdown=this.remainder;this.title=this.continuation?.title??'';this.tags=this.continuation?.tags??'';
    this.remainder='';this.continuation=null;this.split=null;this.error='';
    return true;
  }
  discard() {
    this.title='';this.markdown='';this.tags='';this.remainder='';this.split=null;this.continuation=null;this.error='';
    if (!this.pending) this.attempt=null;
  }
}
const drafts=new Map<string,NoteDraft>();
export class DrawingDraft{
  canvas:HTMLCanvasElement|null=null;
  // Undo/redo belongs to the draft, so it survives switching to Write and back.
  history=new DrawingHistory();
  ink=false;title='';caption='';tags='';color='#222824';size=6;tool:'pen'|'eraser'='pen';
  pending=false;error='';attempt:DrawingAttempt|null=null;
  hasContent(){return this.ink||!!(this.title.trim()||this.caption.trim()||this.tags.trim()||this.attempt);}
  begin(blob:Blob):DrawingAttempt{
    this.attempt??={requestId:crypto.randomUUID(),title:this.title.trim()||null,caption:this.caption.trim(),tags:this.tags.split(',').map(t=>t.trim()).filter(Boolean),blob};
    return {...this.attempt,tags:[...this.attempt.tags]};
  }
  failed(message:string,definitive=false){this.pending=false;this.error=message;if(definitive)this.attempt=null;}
  saved(){
    this.pending=false;this.error='';this.attempt=null;this.title='';this.caption='';this.tags='';this.ink=false;this.history.reset();
    const ctx=this.canvas?.getContext('2d');if(this.canvas&&ctx){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,this.canvas.width,this.canvas.height);}
  }
}
const drawingDrafts=new Map<string,DrawingDraft>();
export function drawingDraftFor(boardId:string){let draft=drawingDrafts.get(boardId);if(!draft){draft=new DrawingDraft();drawingDrafts.set(boardId,draft);}return draft;}
export function draftFor(boardId: string): NoteDraft { let d=drafts.get(boardId);if (!d) {d=new NoteDraft();drafts.set(boardId,d);} return d; }
export function clearDraft(boardId: string) { drafts.delete(boardId);drawingDrafts.delete(boardId);clearBrowse(boardId);clearFeed(boardId); }
export function hasDraftsFor(boardId: string): boolean { return !!(drafts.get(boardId)?.hasContent()||drawingDrafts.get(boardId)?.hasContent()); }
export function hasDrafts(): boolean { return [...drafts.values(),...drawingDrafts.values()].some(d=>d.hasContent()); }
