export type NotePayload = { kind: 'note'; requestId: string; title: string | null; markdown: string; tags: string[] };
export type NoteEntry = { id: string; board_id: string; kind: 'note'; title: string | null; markdown: string; tags: string[]; created_at: string };
export type DrawingEntry = { id:string;board_id:string;kind:'drawing';title:string|null;drawing_caption:string|null;tags:string[];created_at:string;width:number;height:number;image_mime:'image/png'|'image/webp';image_bytes:number };
export type Entry=NoteEntry|DrawingEntry;
export type EntrySummary = {id:string;board_id:string;kind:'note'|'drawing';title:string|null;tags:string[];created_at:string;excerpt:string;width?:number|null;height?:number|null;drawing_caption?:string|null};
export type EntryPage = { entries: EntrySummary[]; pageCursor: string | null; nextCursor: string | null };
export type PostResponse = { entry: Entry; replayed: boolean };
export type DrawingAttempt={requestId:string;title:string|null;caption:string;tags:string[];blob:Blob};
