import {createHash} from 'node:crypto';
import {HttpError} from './errors.ts';
import type {EntrySummary} from '../shared/contracts.ts';
import type {FeedQuery} from '../shared/browse.ts';

export type SearchCursor={createdAt:string|null;id:string|null;rank:string|null;snapshot:string};
export type SearchRow=EntrySummary&{rank_key:string|null;snapshot_at:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestamp=(s:unknown):s is string=>typeof s==='string'&&/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(s)&&Number.isFinite(Date.parse(s));
const invalid=()=>new HttpError(400,'QUERY','Check the search filters, dates, or page cursor.');
export function parseFeedQuery(params:URLSearchParams):FeedQuery {
  const allowed=['q','kind','tag','from','to','sort','cursor'];
  if([...params.keys()].some(k=>!allowed.includes(k)||params.getAll(k).length>(k==='tag'?5:1)))throw invalid();
  const q=(params.get('q')??'').trim();
  const kind=params.get('kind')??'all',sort=params.get('sort')??'newest';
  const tags=[...new Set(params.getAll('tag').map(t=>t.trim().toLowerCase()))].sort();
  if([...q].length>200||/[\u0000-\u001f\u007f]/.test(q)||!['all','note','drawing'].includes(kind)||!['newest','oldest','relevance'].includes(sort)||(!q&&sort==='relevance'))throw invalid();
  if(tags.some(t=>!t||[...t].length>24||/[\u0000-\u001f\u007f]/.test(t)))throw invalid();
  const from=params.get('from'),to=params.get('to');
  for(const value of [from,to])if(value!==null&&(!timestamp(value)||new Date(value).toISOString()!==value))throw invalid();
  if(from&&to&&from>=to)throw invalid();
  return {q,kind:kind as FeedQuery['kind'],tags,from,to,sort:sort as FeedQuery['sort']};
}
function fingerprint(query:FeedQuery):string {return createHash('sha256').update(JSON.stringify(query)).digest('base64url');}
export function encodeSearchCursor(boardId:string,query:FeedQuery,row:SearchRow,start=false):string {
  return Buffer.from(JSON.stringify([1,boardId,fingerprint(query),start?null:row.created_at,start?null:row.id,start?null:row.rank_key,row.snapshot_at])).toString('base64url');
}
export function decodeSearchCursor(boardId:string,query:FeedQuery,value:string|null):SearchCursor|null {
  if(value===null)return null;
  try {
    if(!/^[A-Za-z0-9_-]{1,2048}$/.test(value))throw invalid();
    const data:unknown=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if(!Array.isArray(data)||data.length!==7||data[0]!==1||data[1]!==boardId||data[2]!==fingerprint(query)||!timestamp(data[6]))throw invalid();
    if(data[3]===null&&data[4]===null&&data[5]===null)return {createdAt:null,id:null,rank:null,snapshot:data[6]};
    if(!timestamp(data[3])||typeof data[4]!=='string'||!uuid.test(data[4]))throw invalid();
    const rank=data[5];
    if(query.sort==='relevance'?(typeof rank!=='string'||rank.length>64||!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(rank)||!Number.isFinite(Number(rank))||Number(rank)>1e6):rank!==null)throw invalid();
    // Rank and microsecond timestamps stay strings: JS number/Date conversion loses precision.
    return {createdAt:data[3],id:data[4].toLowerCase(),rank,snapshot:data[6]};
  }catch{throw invalid();}
}
