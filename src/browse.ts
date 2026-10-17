import {browseParams,emptyBrowse} from '../shared/browse.ts';
import type {BrowseState} from '../shared/browse.ts';

// Browsing preferences stay in memory, never page URLs, localStorage, or analytics.
const states=new Map<string,BrowseState>();
export function clearBrowse(boardId:string){states.delete(boardId);}
export function mountBrowse(boardId:string,before:HTMLElement,changed:(debounce:boolean)=>void){
  let state=states.get(boardId);if(!state){state=emptyBrowse();states.set(boardId,state);}
  const current=state;
  const root=document.createElement('section');root.className='browse';root.setAttribute('aria-label','Find entries');
  root.innerHTML=`<div class="search-field" role="search"><label for="board-search">Find a thought</label><input id="board-search" type="search" maxlength="200" placeholder="Search this board…" autocomplete="off" aria-describedby="search-help"/><small id="search-help">Matches all words in notes, titles, tags, and drawing descriptions.</small></div><details id="feed-filters"><summary>Filters & sort <span id="active-filters"></span></summary><div class="filter-grid"><div class="filter-field"><label for="filter-kind">Content</label><select id="filter-kind"><option value="all">Notes & drawings</option><option value="note">Notes only</option><option value="drawing">Drawings only</option></select></div><div class="filter-field"><label for="filter-sort">Order</label><select id="filter-sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="relevance">Most relevant</option></select></div><div class="filter-field"><label for="filter-from">From date</label><input id="filter-from" type="date" min="1900-01-01" max="9998-12-31"/></div><div class="filter-field"><label for="filter-to">Through date</label><input id="filter-to" type="date" min="1900-01-01" max="9998-12-31"/></div><div class="filter-field filter-wide"><label for="filter-tags">Tags</label><input id="filter-tags" placeholder="ideas, reminders" autocomplete="off" aria-describedby="filter-tags-help"/><small id="filter-tags-help">Up to five, separated by commas. Entries must have every selected tag.</small></div></div><p class="filter-help">Dates use your local time zone. Relevance is available when searching.</p></details><div class="filter-actions"><span id="filter-summary"></span><button class="text-button" type="button" id="clear-filters" hidden>Clear filters</button></div><p id="filter-error" class="form-error" role="alert" hidden></p>`;
  before.before(root);
  const input=(id:string)=>root.querySelector<HTMLInputElement>(`#${id}`)!;
  const search=input('board-search'),tags=input('filter-tags'),from=input('filter-from'),to=input('filter-to');
  const kind=root.querySelector<HTMLSelectElement>('#filter-kind')!,sort=root.querySelector<HTMLSelectElement>('#filter-sort')!;
  const clear=root.querySelector<HTMLButtonElement>('#clear-filters')!,details=root.querySelector<HTMLDetailsElement>('#feed-filters')!;
  const error=root.querySelector<HTMLElement>('#filter-error')!;
  function filtered(){return !!(current.q.trim()||current.tags.trim()||current.from||current.to||current.kind!=='all');}
  function sync(){
    if(!current.q.trim()&&current.sort==='relevance')current.sort='newest';
    search.value=current.q;tags.value=current.tags;from.value=current.from;to.value=current.to;kind.value=current.kind;sort.value=current.sort;
    sort.querySelector<HTMLOptionElement>('[value=relevance]')!.disabled=!current.q.trim();
    const count=Number(current.kind!=='all')+Number(!!current.tags.trim())+Number(!!(current.from||current.to));
    root.querySelector('#active-filters')!.textContent=count?`(${count})`:'';
    clear.hidden=!filtered()&&current.sort==='newest';
    root.querySelector('#filter-summary')!.textContent=filtered()?'Showing matching entries':'All entries';
  }
  function update(debounce:boolean){error.hidden=true;sync();changed(debounce);}
  search.addEventListener('input',()=>{current.q=search.value;update(true);});
  // Enter and the browser's search clear button can submit immediately.
  search.addEventListener('search',()=>{current.q=search.value;update(false);});
  search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();update(false);}});
  tags.addEventListener('input',()=>{current.tags=tags.value;update(true);});
  from.addEventListener('change',()=>{current.from=from.value;update(false);});
  to.addEventListener('change',()=>{current.to=to.value;update(false);});
  kind.addEventListener('change',()=>{current.kind=kind.value as BrowseState['kind'];update(false);});
  sort.addEventListener('change',()=>{current.sort=sort.value as BrowseState['sort'];update(false);});
  clear.addEventListener('click',()=>{Object.assign(current,emptyBrowse());update(false);});
  if(current.kind!=='all'||current.tags||current.from||current.to||current.sort!=='newest')details.open=true;
  sync();
  return {
    filtered,
    params(){try{const params=browseParams(current);error.hidden=true;return params;}catch(cause){error.textContent=cause instanceof Error?cause.message:'Check the filters.';error.hidden=false;throw cause;}},
    addTag(tag:string){
      const values=current.tags.split(',').map(t=>t.trim().toLowerCase()).filter(Boolean);
      if(!values.includes(tag)){if(values.length>=5){error.textContent='Clear a tag before adding another.';error.hidden=false;return;}values.push(tag);}
      current.tags=values.join(', ');details.open=true;update(false);
    }
  };
}
