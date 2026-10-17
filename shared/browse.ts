export type FeedSort = 'newest' | 'oldest' | 'relevance';
export type FeedQuery = { q:string; kind:'all'|'note'|'drawing'; tags:string[]; from:string|null; to:string|null; sort:FeedSort };
export type BrowseState = { q:string; kind:FeedQuery['kind']; tags:string; from:string; to:string; sort:FeedSort };
export function emptyBrowse():BrowseState { return {q:'',kind:'all',tags:'',from:'',to:'',sort:'newest'}; }
export function localBoundary(value:string,nextDay=false):string|null {
  if(!value)return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('Choose a valid calendar date.');
  const [year,month,day]=value.split('-').map(Number);
  if(year<1900||year>9998)throw new Error('Choose a year between 1900 and 9998.');
  const date=new Date(year,month-1,day);
  if(date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day)throw new Error('Choose a valid calendar date.');
  // Calendar arithmetic, not +24 hours: daylight-saving days can be shorter or longer.
  return (nextDay?new Date(year,month-1,day+1):date).toISOString();
}
export function browseParams(state:BrowseState):URLSearchParams {
  const params=new URLSearchParams();
  const q=state.q.trim();if(q)params.set('q',q);
  if(state.kind!=='all')params.set('kind',state.kind);
  const tags=[...new Set(state.tags.split(',').map(t=>t.trim().toLowerCase()).filter(Boolean))].sort();
  if(tags.length>5||tags.some(t=>[...t].length>24))throw new Error('Filter by up to five tags, each up to 24 characters.');
  for(const tag of tags)params.append('tag',tag);
  if(state.from&&state.to&&state.from>state.to)throw new Error('The end date must be on or after the start date.');
  const from=localBoundary(state.from),to=localBoundary(state.to,true);
  if(from)params.set('from',from);if(to)params.set('to',to);
  if(state.sort!=='newest'&&(state.sort!=='relevance'||q))params.set('sort',state.sort);
  return params;
}
