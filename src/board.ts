import { api, ApiError } from './api.ts';
import type { BoardResponse } from './api.ts';
import type { Entry, EntryPage, EntrySummary, PostResponse } from '../shared/contracts.ts';
import { escapeHtml } from '../shared/escape.ts';
import { draftFor, drawingDraftFor } from './drafts.ts';
import {mountBrowse} from './browse.ts';

export type BoardView='feed'|'compose';
type Options={container:HTMLElement;response:BoardResponse;entryId?:string;view?:BoardView;signal:AbortSignal;navigate:(path:string)=>void;expired:(message:string)=>void;toast:(message:string)=>void;afterAccess?:(action:()=>void)=>void;};
const formats=[['Bold','bold'],['Italic','italic'],['List','list'],['Link','link'],['Code','code']] as const;
// Hand-off from the composer page to the board page. Held in memory only, never in the URL.
let justPosted:{boardId:string;result:PostResponse}|null=null;
export function clearBoardReceipt(boardId:string){if(justPosted?.boardId===boardId)justPosted=null;}
function date(value: string) { return new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}); }
function tagsMarkup(tags: string[]) { return tags.length ? `<div class="entry-tags">${tags.map(t=>`<span>#${escapeHtml(t)}</span>`).join('')}</div>` : ''; }
function internalLink(el: HTMLAnchorElement, navigate: Options['navigate']) {
  el.addEventListener('click',e=>{if (!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey&&e.button===0){e.preventDefault();navigate(el.getAttribute('href')!);}});
}

export function mountBoard(options: Options): () => void {
  const {container,response,signal,navigate,expired,toast}=options;
  const boardId=response.board.id;
  let active=true;let feedVersion=0;let previewVersion=0;
  let feedRequest:AbortController|undefined,searchTimer:ReturnType<typeof setTimeout>|undefined;
  const cancelFeed=()=>{feedVersion++;feedRequest?.abort();if(searchTimer)clearTimeout(searchTimer);};
  signal.addEventListener('abort',cancelFeed,{once:true});
  let disposeDrawing:(()=>void)|undefined;
  const alive=()=>active&&!signal.aborted;
  function drawingMarkup(entry:{id:string;title:string|null;drawing_caption?:string|null;width?:number|null;height?:number|null}){
    return `<div class="drawing-frame"><img class="private-drawing" src="/api/boards/${boardId}/entries/${entry.id}/image" width="${entry.width??1024}" height="${entry.height??768}" alt="${escapeHtml(entry.drawing_caption||entry.title||'Anonymous drawing')}" loading="lazy" decoding="async"/><p class="image-error" hidden>Drawing could not load. <button type="button" class="text-button image-retry">Retry image</button></p></div>`;
  }
  function wireImages(target:HTMLElement){
    target.querySelectorAll<HTMLElement>('.drawing-frame').forEach(frame=>{
      const image=frame.querySelector<HTMLImageElement>('img')!,error=frame.querySelector<HTMLElement>('.image-error')!;
      image.addEventListener('error',()=>{if(alive()){image.hidden=true;error.hidden=false;}});
      image.addEventListener('load',()=>{if(alive()){image.hidden=false;error.hidden=true;}});
      frame.querySelector<HTMLButtonElement>('.image-retry')!.addEventListener('click',()=>{error.hidden=true;const src=image.src;image.removeAttribute('src');image.hidden=false;image.src=src;});
    });
  }
  const fail=(error: unknown):string=>error instanceof Error ? error.message : 'Please try again.';
  function denied(error: unknown): boolean {
    if (error instanceof ApiError&&error.status===401) { expired('Your access expired. Unlock the board to continue. Your draft is still here.');return true; }
    return false;
  }
  async function markdown(target: HTMLElement, source: string, version: number) {
    target.textContent='Preparing preview…';
    try {const {renderMarkdown}=await import('./markdown.ts');if(alive()&&version===previewVersion) renderMarkdown(target,source);}
    catch {if(alive()&&version===previewVersion)target.textContent='Preview could not load. Switch back to Write or try again.';}
  }

  if (options.entryId) {
    container.innerHTML=`<a id="back-board" class="text-link" href="/b/${boardId}">← Back to board</a><div id="entry-content" role="status" class="entry-loading">Opening note…</div>`;
    internalLink(container.querySelector<HTMLAnchorElement>('#back-board')!,navigate);
    const target=container.querySelector<HTMLElement>('#entry-content')!;
    void (async()=>{
      try {
        const {entry}=await api<{entry:Entry}>(`/api/boards/${boardId}/entries/${options.entryId}`,undefined,signal);
        if(!alive())return;
        target.removeAttribute('role');
        target.innerHTML=`<article class="entry-full"><div class="entry-meta"><span>${entry.kind==='drawing'?'DRAWING':'NOTE'} · ${escapeHtml(date(entry.created_at))}</span><span>Permanent</span></div>${entry.title?`<h2 class="entry-title">${escapeHtml(entry.title)}</h2>`:''}${entry.kind==='drawing'?drawingMarkup(entry)+(entry.drawing_caption?`<p class="drawing-caption">${escapeHtml(entry.drawing_caption)}</p>`:''):'<div class="markdown entry-markdown"></div>'}${tagsMarkup(entry.tags)}<div class="entry-footer"><button id="copy-entry" class="secondary" type="button">Copy entry link</button><span>Shared anonymously</span></div></article>`;
        if(entry.kind==='note')void markdown(target.querySelector<HTMLElement>('.entry-markdown')!,entry.markdown,++previewVersion);
        else wireImages(target);
        target.querySelector<HTMLButtonElement>('#copy-entry')!.addEventListener('click',async()=>{
          const url=`${location.origin}/b/${boardId}/e/${entry.id}`;
          try {await navigator.clipboard.writeText(url);toast('Entry link copied. The board password is still required.');}
          catch {window.prompt('Copy this entry link:',url);}
        });
      } catch(error){if(alive()&&!denied(error)){target.setAttribute('role','alert');target.textContent=fail(error);}}
    })();
    return ()=>{active=false;signal.removeEventListener('abort',cancelFeed);};
  }

  const draft=draftFor(boardId);

  if (options.view==='compose') {
    // A background acknowledgement survives an intervening unlock gate. It is
    // already saved; return to its feed receipt rather than offer another post.
    if(justPosted?.boardId===boardId)queueMicrotask(()=>{if(alive()){const show=()=>navigate(`/b/${boardId}`);if(options.afterAccess)options.afterAccess(show);else show();}});
    container.innerHTML=`<a id="back-board" class="text-link" href="/b/${boardId}">← Back to board</a><section class="composer" aria-label="Write a note"><div class="composer-heading"><div><h2>Leave a thought.</h2><p>Something small. Something worth keeping.</p></div></div><div id="composer-body"><form id="note-form"><div class="editor-tabs" role="tablist" aria-label="Note editor"><button type="button" id="write-tab" role="tab" aria-selected="true" aria-controls="write-panel">Write</button><button type="button" id="preview-tab" role="tab" aria-selected="false" tabindex="-1" aria-controls="preview-panel">Preview</button></div><div id="write-panel" role="tabpanel" aria-labelledby="write-tab"><div class="format-toolbar" aria-label="Formatting helpers">${formats.map(([label,type])=>`<button type="button" data-format="${type}" aria-label="Insert ${label.toLowerCase()} formatting">${label}</button>`).join('')}</div><label class="sr-only" for="note-body">Your note in Markdown</label><textarea id="note-body" name="markdown" placeholder="What would you like to leave here?" required spellcheck="true" aria-describedby="note-help note-count"></textarea><div class="editor-hint"><span id="note-help">Markdown welcome. Plain words, too.</span><span id="note-count"></span></div></div><div id="preview-panel" role="tabpanel" aria-labelledby="preview-tab" hidden><div id="note-preview" class="markdown"></div></div><details id="note-details"><summary>Title & tags <span>(optional)</span></summary><div class="metadata-fields"><div class="field"><label for="note-title">Title</label><input id="note-title" name="title" maxlength="120" placeholder="A few words to find it later"/></div><div class="field"><label for="note-tags">Tags</label><input id="note-tags" name="tags" placeholder="ideas, reminders" aria-describedby="tag-help"/><small id="tag-help">Up to five tags, separated by commas.</small></div></div></details><p id="attempt-hint" class="soft-notice" hidden>Checking the same submission. Keep this tab open and use Retry to avoid posting it twice.</p><p id="post-error" class="form-error" role="alert" hidden></p><div class="post-row"><p>Posts are permanent.<br/><span>Check before posting.</span></p><button id="post-note" class="primary" type="submit">Post note <span aria-hidden="true">↗</span></button></div></form></div></section>`;
    const back=container.querySelector<HTMLAnchorElement>('#back-board')!;
    back.addEventListener('click',e=>{
      if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||e.button!==0)return;
      e.preventDefault();
      if((draft.pending||drawingDraftFor(boardId).pending)&&!window.confirm('A post is still being sent. Leave anyway? Your draft keeps a Retry button.'))return;
      navigate(back.getAttribute('href')!);
    });
    const form=container.querySelector<HTMLFormElement>('#note-form')!;
    const writeComposer=container.querySelector<HTMLElement>('.composer')!;
    writeComposer.id='write-composer';writeComposer.setAttribute('role','tabpanel');writeComposer.setAttribute('aria-labelledby','mode-write');
    const modes=document.createElement('div');modes.className='composer-modes';modes.setAttribute('role','tablist');modes.setAttribute('aria-label','Entry type');
    modes.innerHTML='<button type="button" id="mode-write" role="tab" aria-controls="write-composer" aria-selected="true">Write</button><button type="button" id="mode-draw" role="tab" aria-controls="draw-composer" aria-selected="false" tabindex="-1">Draw</button>';
    writeComposer.before(modes);
    const drawComposer=document.createElement('section');drawComposer.id='draw-composer';drawComposer.className='composer';drawComposer.hidden=true;drawComposer.setAttribute('role','tabpanel');drawComposer.setAttribute('aria-labelledby','mode-draw');writeComposer.after(drawComposer);
    const modeTabs=[modes.querySelector<HTMLButtonElement>('#mode-write')!,modes.querySelector<HTMLButtonElement>('#mode-draw')!];
    let drawingMounted=false,drawingLoading=false;
    const finish=(result:PostResponse,message:string)=>{
      justPosted={boardId,result};
      const show=()=>{if(alive()){toast(message);navigate(`/b/${boardId}`);}};
      if(options.afterAccess)options.afterAccess(show);else show();
    };
    function selectMode(mode:'write'|'draw'){
      draft.mode=mode;writeComposer.hidden=mode!=='write';drawComposer.hidden=mode!=='draw';
      modeTabs.forEach((tab,index)=>{const selected=(mode==='write'?0:1)===index;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;});
      if(mode==='draw'&&!drawingMounted&&!drawingLoading){
        drawingLoading=true;drawComposer.textContent='Opening drawing paper…';
        void import('./drawing-editor.ts').then(({mountDrawing})=>{
          if(!alive())return;
          disposeDrawing=mountDrawing({boardId,container:drawComposer,signal,expired,posted:result=>finish(result,result.replayed?'Your drawing was already saved. No duplicate was posted.':'Drawing posted. It’s here to stay.')});drawingMounted=true;
        }).catch(error=>{if(alive())drawComposer.textContent=error instanceof Error?error.message:'The drawing tool could not load. Switch to Write and back to retry.';}).finally(()=>{drawingLoading=false;});
      }
    }
    modeTabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectMode(index===0?'write':'draw'));tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-index;selectMode(next===0?'write':'draw');modeTabs[next].focus();}});});
    const textarea=form.querySelector<HTMLTextAreaElement>('#note-body')!;
    const titleInput=form.querySelector<HTMLInputElement>('#note-title')!;
    const tagsInput=form.querySelector<HTMLInputElement>('#note-tags')!;
    const post=form.querySelector<HTMLButtonElement>('#post-note')!;
    const errorBox=form.querySelector<HTMLElement>('#post-error')!;
    const attemptHint=form.querySelector<HTMLElement>('#attempt-hint')!;
    const preview=form.querySelector<HTMLElement>('#note-preview')!;
    const tabs=[form.querySelector<HTMLButtonElement>('#write-tab')!,form.querySelector<HTMLButtonElement>('#preview-tab')!];
    textarea.value=draft.markdown;titleInput.value=draft.title;tagsInput.value=draft.tags;
    if(draft.title||draft.tags)form.querySelector<HTMLDetailsElement>('#note-details')!.open=true;
    function syncState() {
      const frozen=!!draft.attempt;
      textarea.readOnly=frozen;titleInput.readOnly=frozen;tagsInput.readOnly=frozen;
      form.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(b=>{b.disabled=frozen;});
      post.disabled=draft.pending||(!draft.markdown.trim()&&!draft.attempt);
      post.textContent=draft.pending?'Posting…':draft.attempt?'Retry posting':'Post note ↗';
      form.setAttribute('aria-busy',String(draft.pending));
      attemptHint.hidden=!frozen;
      errorBox.textContent=draft.error;errorBox.hidden=!draft.error;
      form.querySelector<HTMLElement>('#note-count')!.textContent=`${[...textarea.value].length.toLocaleString()} / 20,000`;
    }
    for(const field of [textarea,titleInput,tagsInput])field.addEventListener('input',()=>{
      draft.markdown=textarea.value;draft.title=titleInput.value;draft.tags=tagsInput.value;draft.error='';syncState();
    });
    function selectTab(index:number) {
      tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;});
      form.querySelector<HTMLElement>('#write-panel')!.hidden=index!==0;
      form.querySelector<HTMLElement>('#preview-panel')!.hidden=index!==1;
      const version=++previewVersion;
      if(index===1){if(textarea.value.trim())void markdown(preview,textarea.value,version);else preview.textContent='Your formatted note will appear here.';}
    }
    tabs.forEach((tab,i)=>{
      tab.addEventListener('click',()=>selectTab(i));
      tab.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const index=e.key==='Home'?0:e.key==='End'?1:1-i;selectTab(index);tabs[index].focus();}});
    });
    form.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(button=>button.addEventListener('click',()=>{
      if(draft.attempt)return;
      const start=textarea.selectionStart,end=textarea.selectionEnd,selection=textarea.value.slice(start,end);
      const kind=button.dataset.format;
      const wraps:Record<string,[string,string,string]>={bold:['**','**','bold text'],italic:['_','_','italic text'],link:['[','](https://example.com)','link text'],code:['`','`','code']};
      let insert:string;
      if(kind==='list')insert=(selection||'First item\nSecond item').split('\n').map(line=>`- ${line}`).join('\n');
      else {const [left,right,fallback]=wraps[kind!];insert=left+(selection||fallback)+right;}
      textarea.setRangeText(insert,start,end,'select');textarea.focus();textarea.dispatchEvent(new Event('input',{bubbles:true}));
    }));
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(draft.pending||(!draft.attempt&&!draft.markdown.trim()))return;
      if(!draft.attempt&&([...textarea.value].length>20000||new TextEncoder().encode(textarea.value).byteLength>81920)){draft.error='Keep this note within 20,000 characters (80 KiB).';syncState();return;}
      const payload=draft.begin();draft.pending=true;draft.error='';syncState();
      try {
        const result=await api<PostResponse>(`/api/boards/${boardId}/entries`,payload,signal);
        if(!result?.entry||result.entry.board_id!==boardId||result.entry.kind!=='note'||typeof result.entry.id!=='string'||result.entry.markdown!==payload.markdown.replace(/\r\n?/g,'\n'))throw new ApiError('Posting could not be confirmed. Retry to check the same submission.',503,'UNCERTAIN_RESPONSE');
        draft.saved();
        if(!alive())return;
        textarea.value='';titleInput.value='';tagsInput.value='';preview.replaceChildren();selectTab(0);syncState();
        finish(result,result.replayed?'Your note was already saved. No duplicate was posted.':'Note posted. It’s here to stay.');
      } catch(error){
        const definitive=error instanceof ApiError&&[400,409,413,415,422].includes(error.status);
        draft.failed(error instanceof DOMException&&error.name==='AbortError'?'Posting was interrupted. Retry to check the same submission.':fail(error),definitive);
        if(alive()){syncState();denied(error);}
      } finally {draft.pending=false;if(alive())syncState();}
    });
    syncState();selectMode(draft.mode);
    return ()=>{active=false;previewVersion++;cancelFeed();signal.removeEventListener('abort',cancelFeed);disposeDrawing?.();};
  }

  const writing=draft.hasContent(),drawing=drawingDraftFor(boardId).hasContent();
  container.innerHTML=`<div class="compose-actions" role="group" aria-label="Add to this board"><a id="go-write" class="primary" href="/b/${boardId}/new">${writing?'Continue note':'Write a note'}</a><a id="go-draw" class="secondary" href="/b/${boardId}/new">${drawing?'Continue drawing':'Draw'}</a></div><div class="feed-heading"><span>THE BOARD</span><button id="refresh-feed" class="text-button" type="button">Refresh</button></div><div id="feed-status" class="feed-status" role="status"></div><section id="feed" aria-label="Board notes"></section><div class="pagination"><button id="previous-page" class="secondary" type="button" hidden>Previous page</button><button id="next-page" class="secondary" type="button" hidden>Older notes</button></div>`;
  for(const [id,mode] of [['go-write','write'],['go-draw','draw']] as const){
    const link=container.querySelector<HTMLAnchorElement>(`#${id}`)!;
    link.addEventListener('click',e=>{
      if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||e.button!==0)return;
      e.preventDefault();draft.mode=mode;navigate(link.getAttribute('href')!);
    });
  }
  const feed=container.querySelector<HTMLElement>('#feed')!;
  const feedStatus=container.querySelector<HTMLElement>('#feed-status')!;
  const previous=container.querySelector<HTMLButtonElement>('#previous-page')!;
  const next=container.querySelector<HTMLButtonElement>('#next-page')!;
  next.textContent='Next page';
  const cursors:(string|null)[]=[null];let page=0;let nextCursor:string|null=null;
  const browse=mountBrowse(boardId,feedStatus,debounce=>{
    cancelFeed();feed.replaceChildren();feed.setAttribute('aria-busy','true');
    previous.hidden=true;next.hidden=true;feedStatus.textContent='Updating results…';
    if(debounce)searchTimer=setTimeout(()=>void loadPage(true),250);else void loadPage(true);
  });
  const postStatus=document.createElement('p');postStatus.className='post-status';postStatus.setAttribute('role','status');postStatus.hidden=true;
  container.querySelector('.feed-heading')!.before(postStatus);
  function postedLink(result:PostResponse){
    postStatus.hidden=false;
    postStatus.innerHTML=`Saved permanently. Your current filters are unchanged. <a href="/b/${boardId}/e/${result.entry.id}">View ${result.entry.kind==='drawing'?'drawing':'note'} ↗</a>`;
    internalLink(postStatus.querySelector<HTMLAnchorElement>('a')!,navigate);
  }
  function card(entry:EntrySummary):HTMLElement {
    const item=document.createElement('article');item.className='note-card';
    item.innerHTML=`<div class="entry-meta"><span>${entry.kind==='drawing'?'DRAWING':'NOTE'} · ${escapeHtml(date(entry.created_at))}</span><span>Permanent</span></div><h2><a href="/b/${boardId}/e/${entry.id}">${escapeHtml(entry.title||(entry.kind==='drawing'?'Untitled drawing':'Untitled note'))}</a></h2>${entry.kind==='drawing'?drawingMarkup(entry):''}${entry.excerpt?`<p class="note-excerpt">${escapeHtml(entry.excerpt)}</p>`:''}${tagsMarkup(entry.tags)}<a class="open-note" href="/b/${boardId}/e/${entry.id}">Open ${entry.kind==='drawing'?'drawing':'note'} <span aria-hidden="true">↗</span></a>`;
    item.querySelectorAll<HTMLAnchorElement>('a').forEach(link=>internalLink(link,navigate));
    item.querySelectorAll<HTMLElement>('.entry-tags>span').forEach((span,index)=>{
      const button=document.createElement('button');button.type='button';button.textContent=span.textContent;button.setAttribute('aria-label',`Filter by tag ${entry.tags[index]}`);
      button.addEventListener('click',()=>browse.addTag(entry.tags[index]));span.replaceWith(button);
    });
    wireImages(item);return item;
  }
  async function loadPage(reset=false,targetPage=page) {
    cancelFeed();
    if(reset){cursors.splice(1);cursors[0]=null;}
    const requestedPage=reset?0:targetPage;
    const version=++feedVersion;feedStatus.textContent='Loading entries…';next.disabled=true;previous.disabled=true;feed.setAttribute('aria-busy','true');
    const controller=new AbortController();feedRequest=controller;
    try {
      const params=browse.params();
      const cursor=cursors[requestedPage];
      if(cursor)params.set('cursor',cursor);
      const result=await api<EntryPage>(`/api/boards/${boardId}/entries${params.size?`?${params}`:''}`,undefined,controller.signal);
      if(!alive()||version!==feedVersion)return;
      page=requestedPage;
      if(result.pageCursor)cursors[page]=result.pageCursor;
      nextCursor=result.nextCursor;
      feed.replaceChildren(...result.entries.map(card));
      if(!result.entries.length){const empty=document.createElement('div');empty.className='empty-notes';empty.innerHTML=browse.filtered()?'<h2>No matching entries.</h2><p>Try fewer words, a wider date range, or Clear filters. Nothing on the board has changed.</p>':'<h2>A blank page. A good beginning.</h2><p>Write a note or draw a sketch, or share this space with someone.</p>';feed.append(empty);}
      feedStatus.textContent=`${result.entries.length} ${result.entries.length===1?'entry':'entries'}${page>0?` · Page ${page+1}`:''}${result.nextCursor?' · More available':''}`;
      next.hidden=!nextCursor;previous.hidden=page===0;
    } catch(error){if(alive()&&version===feedVersion&&!denied(error))feedStatus.textContent=`${fail(error)} Use Refresh to try again.`;}
    finally{if(alive()&&version===feedVersion){next.disabled=false;previous.disabled=false;feed.setAttribute('aria-busy','false');}}
  }
  previous.addEventListener('click',()=>{if(page>0)void loadPage(false,page-1);});
  next.addEventListener('click',()=>{if(nextCursor){cursors[page+1]=nextCursor;void loadPage(false,page+1);}});
  container.querySelector<HTMLButtonElement>('#refresh-feed')!.addEventListener('click',()=>void loadPage(true));
  if(justPosted?.boardId===boardId){postedLink(justPosted.result);}
  justPosted=null;
  void loadPage();
  return ()=>{active=false;previewVersion++;cancelFeed();signal.removeEventListener('abort',cancelFeed);};
}

