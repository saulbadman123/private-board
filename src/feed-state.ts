// Where the reader was in the feed, so returning from an entry or the composer lands in the same place.
// Held in memory only, per board: it holds page cursors and an entry id, never entry content. Cleared on Lock.
export type FeedAnchor = { id: string; top: number };
export type FeedView = { cursors: (string | null)[]; page: number; anchor: FeedAnchor | null; scrollTop: number };
const views = new Map<string, FeedView>();
export function saveFeed(boardId: string, view: FeedView) { views.set(boardId, view); }
export function feedView(boardId: string): FeedView | null { return views.get(boardId) ?? null; }
export function clearFeed(boardId: string) { views.delete(boardId); }
