import type { NotePayload,DrawingAttempt } from '../shared/contracts.ts';
import {clearBrowse} from './browse.ts';

export class NoteDraft {
  mode:'write'|'draw'='write';
  title=''; markdown=''; tags='';
  attempt: NotePayload | null=null;
  pending=false;
  error='';
  hasContent(): boolean { return !!(this.title.trim() || this.markdown.trim() || this.tags.trim() || this.attempt); }
  begin(): NotePayload {
    this.attempt ??= {kind:'note',requestId:crypto.randomUUID(),title:this.title.trim() || null,markdown:this.markdown,tags:this.tags.split(',').map(t=>t.trim()).filter(Boolean)};
    // Callers get a copy; a retry always uses the frozen original content.
    return structuredClone(this.attempt);
  }
  failed(message: string, definitive=false) {
    this.pending=false;this.error=message;
    if (definitive) this.attempt=null;
  }
  saved() { this.title='';this.markdown='';this.tags='';this.attempt=null;this.pending=false;this.error=''; }
}
const drafts=new Map<string,NoteDraft>();
export class DrawingDraft{
  canvas:HTMLCanvasElement|null=null;
  ink=false;title='';caption='';tags='';color='#222824';size=6;tool:'pen'|'eraser'='pen';
  pending=false;error='';attempt:DrawingAttempt|null=null;
  hasContent(){return this.ink||!!(this.title.trim()||this.caption.trim()||this.tags.trim()||this.attempt);}
  begin(blob:Blob):DrawingAttempt{
    this.attempt??={requestId:crypto.randomUUID(),title:this.title.trim()||null,caption:this.caption.trim(),tags:this.tags.split(',').map(t=>t.trim()).filter(Boolean),blob};
    return {...this.attempt,tags:[...this.attempt.tags]};
  }
  failed(message:string,definitive=false){this.pending=false;this.error=message;if(definitive)this.attempt=null;}
  saved(){this.pending=false;this.error='';this.attempt=null;this.title='';this.caption='';this.tags='';this.ink=false;this.canvas?.getContext('2d')?.clearRect(0,0,1024,768);const ctx=this.canvas?.getContext('2d');if(ctx){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1024,768);}}
}
const drawingDrafts=new Map<string,DrawingDraft>();
export function drawingDraftFor(boardId:string){let draft=drawingDrafts.get(boardId);if(!draft){draft=new DrawingDraft();drawingDrafts.set(boardId,draft);}return draft;}
export function draftFor(boardId: string): NoteDraft { let d=drafts.get(boardId);if (!d) {d=new NoteDraft();drafts.set(boardId,d);} return d; }
export function clearDraft(boardId: string) { drafts.delete(boardId);drawingDrafts.delete(boardId);clearBrowse(boardId); }
export function hasDrafts(): boolean { return [...drafts.values(),...drawingDrafts.values()].some(d=>d.hasContent()); }
