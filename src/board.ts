import { api, apiBlob, ApiError } from './api.ts';
import type { BoardResponse } from './api.ts';
import type { Entry, EntryPage, EntrySummary, PostResponse } from '../shared/contracts.ts';
import { escapeHtml } from '../shared/escape.ts';
import { draftFor, drawingDraftFor } from './drafts.ts';
import {mountBrowse} from './browse.ts';
import {mountComposeMenu} from './compose-menu.ts';
import {openDrawingViewer} from './viewer.ts';
import {mountNoteComposer} from './note-composer.ts';
import {copyText,extensionFor,saveBlob} from './export.ts';
import {clearFeed,feedView,saveFeed} from './feed-state.ts';
import type {FeedView} from './feed-state.ts';

export type BoardView='feed'|'compose';
export type ComposeMode='write'|'draw';
// `mode` comes from /new?mode=; without it the composer reopens in the mode last used. `modeChanged` reports the user's own switches.
type Options={container:HTMLElement;response:BoardResponse;entryId?:string;view?:BoardView;mode?:ComposeMode;modeChanged?:(mode:ComposeMode)=>void;signal:AbortSignal;navigate:(path:string)=>void;expired:(message:string)=>void;toast:(message:string)=>void;whenVisible?:(action:()=>void)=>void;};
// Hand-off from the composer page to the board page. Held in memory only, never in the URL.
let justPosted:{boardId:string;result:PostResponse}|null=null;
function date(value: string) { return new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}); }
function tagsMarkup(tags: string[]) { return tags.length ? `<div class="entry-tags">${tags.map(t=>`<span>#${escapeHtml(t)}</span>`).join('')}</div>` : ''; }
// Untitled entries get a short label from their first words so they can be told apart in a list. Display only: the stored title stays empty.
function derivedLabel(entry: EntrySummary): string | null {
  const words=(entry.kind==='drawing'?entry.drawing_caption??'':entry.excerpt).trim();
  if(!words)return null;
  const chars=[...words];
  if(chars.length<=60)return words;
  const cut=chars.slice(0,60).join('');
  return `${cut.replace(/\s+\S*$/,'')||cut}…`;
}
const scroller=()=>document.documentElement;
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
  // With `link`, the picture opens the entry. That link repeats the title link, so it stays out of the tab order and the accessibility tree.
  function drawingMarkup(entry:{id:string;title:string|null;drawing_caption?:string|null;width?:number|null;height?:number|null},link?:string){
    const image=`<img class="private-drawing" src="/api/boards/${boardId}/entries/${entry.id}/image" width="${entry.width??1024}" height="${entry.height??768}" alt="${escapeHtml(entry.drawing_caption||entry.title||'Anonymous drawing')}" loading="lazy" decoding="async"/>`;
    return `<div class="drawing-frame">${link?`<a class="drawing-link" href="${link}" tabindex="-1" aria-hidden="true">${image}</a>`:image}<p class="image-error" hidden>Drawing could not load. <button type="button" class="text-button image-retry">Retry image</button></p></div>`;
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

  const drafts=()=>({writing:draftFor(boardId).hasContent(),drawing:drawingDraftFor(boardId).hasContent()});

  if (options.entryId) {
    scroller().scrollTop=0;
    container.innerHTML=`<a id="back-board" class="text-link" href="/b/${boardId}">← Back to results</a><div id="entry-content" role="status" class="entry-loading">Opening entry…</div>`;
    internalLink(container.querySelector<HTMLAnchorElement>('#back-board')!,navigate);
    const disposeMenu=mountComposeMenu({container,boardId,navigate,drafts});
    let closeViewer:(()=>void)|undefined;
    const target=container.querySelector<HTMLElement>('#entry-content')!;
    void (async()=>{
      try {
        const {entry}=await api<{entry:Entry}>(`/api/boards/${boardId}/entries/${options.entryId}`,undefined,signal);
        if(!alive())return;
        target.removeAttribute('role');
        target.innerHTML=`<article class="entry-full"><div class="entry-meta"><span>${entry.kind==='drawing'?'DRAWING':'NOTE'} · ${escapeHtml(date(entry.created_at))}</span><span>Permanent</span></div>${entry.title?`<h2 class="entry-title">${escapeHtml(entry.title)}</h2>`:''}${entry.kind==='drawing'?drawingMarkup(entry)+'<div class="view-modes" role="group" aria-label="Drawing view"><button type="button" id="view-fit" aria-pressed="true">Fit</button><button type="button" id="view-actual" aria-pressed="false">100%</button><button type="button" id="view-expand">Expand</button></div>'+(entry.drawing_caption?`<p class="drawing-caption">${escapeHtml(entry.drawing_caption)}</p>`:''):'<div class="markdown entry-markdown"></div>'}${tagsMarkup(entry.tags)}<div class="entry-footer"><div class="entry-actions"><button id="copy-entry" class="secondary" type="button">Copy entry link</button>${entry.kind==='note'?'<button id="copy-markdown" class="secondary" type="button">Copy Markdown</button>':'<button id="download-drawing" class="secondary" type="button">Download image</button>'}</div><span>Shared anonymously</span></div><div id="copy-fallback" class="copy-fallback" hidden><label for="fallback-text">Select the text and press Ctrl+C (Cmd+C on a Mac).</label><textarea id="fallback-text" readonly rows="8"></textarea></div></article>`;
        if(entry.kind==='note')void markdown(target.querySelector<HTMLElement>('.entry-markdown')!,entry.markdown,++previewVersion);
        else{
          wireImages(target);
          // Fit shows the whole drawing in the column; 100% shows real pixels (scroll to move); Expand opens the viewer.
          const frame=target.querySelector<HTMLElement>('.drawing-frame')!,image=frame.querySelector<HTMLImageElement>('img')!;
          const fit=target.querySelector<HTMLButtonElement>('#view-fit')!,actual=target.querySelector<HTMLButtonElement>('#view-actual')!,expand=target.querySelector<HTMLButtonElement>('#view-expand')!;
          const setActual=(on:boolean)=>{frame.classList.toggle('is-actual',on);fit.setAttribute('aria-pressed',String(!on));actual.setAttribute('aria-pressed',String(on));};
          fit.addEventListener('click',()=>setActual(false));actual.addEventListener('click',()=>setActual(true));
          expand.addEventListener('click',()=>{
            if(closeViewer)return;
            closeViewer=openDrawingViewer({container,image,width:entry.width,height:entry.height,label:entry.title||entry.drawing_caption||'Anonymous drawing',closed:()=>{closeViewer=undefined;expand.focus();}});
          });
        }
        target.querySelector<HTMLButtonElement>('#copy-entry')!.addEventListener('click',async()=>{
          const url=`${location.origin}/b/${boardId}/e/${entry.id}`;
          try {await navigator.clipboard.writeText(url);toast('Entry link copied. The board password is still required.');}
          catch {window.prompt('Copy this entry link:',url);}
        });
        // Copy the note's Markdown source; if the clipboard refuses, show it selected so it can still be copied by hand.
        target.querySelector<HTMLButtonElement>('#copy-markdown')?.addEventListener('click',async()=>{
          if(entry.kind!=='note')return;
          if(await copyText(entry.markdown)){toast('Markdown copied.');return;}
          const box=target.querySelector<HTMLElement>('#copy-fallback')!,field=target.querySelector<HTMLTextAreaElement>('#fallback-text')!;
          box.hidden=false;field.value=entry.markdown;field.focus();field.select();toast('Could not copy automatically. The text is selected: press Ctrl+C.');
        });
        // Download the stored bytes through the same board-authorized route the page uses. No public or signed link exists.
        const download=target.querySelector<HTMLButtonElement>('#download-drawing');
        download?.addEventListener('click',async()=>{
          download.disabled=true;
          try{
            const blob=await apiBlob(`/api/boards/${boardId}/entries/${entry.id}/image`,signal);
            if(!alive())return;
            saveBlob(blob,`drawing-${entry.id.slice(0,8)}.${extensionFor(blob.type)}`);toast('Drawing downloaded.');
          }catch(error){if(alive()&&!denied(error)&&!(error instanceof DOMException&&error.name==='AbortError'))toast(fail(error));}
          finally{download.disabled=false;}
        });
      } catch(error){if(alive()&&!denied(error)){target.setAttribute('role','alert');target.textContent=fail(error);}}
    })();
    return ()=>{active=false;signal.removeEventListener('abort',cancelFeed);closeViewer?.();disposeMenu();};
  }

  const draft=draftFor(boardId);

  if (options.view==='compose') {
    scroller().scrollTop=0;
    container.innerHTML=`<a id="back-board" class="text-link" href="/b/${boardId}">← Back to board</a><section class="composer" aria-label="Write a note"><div class="composer-heading"><div><h2>Write a note</h2><p>Something small. Something worth keeping.</p></div></div><div id="composer-body"></div></section>`;
    const back=container.querySelector<HTMLAnchorElement>('#back-board')!;
    back.addEventListener('click',e=>{
      if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||e.button!==0)return;
      e.preventDefault();
      if((draft.pending||drawingDraftFor(boardId).pending)&&!window.confirm('A post is still being sent. Leave anyway? Your draft keeps a Retry button.'))return;
      navigate(back.getAttribute('href')!);
    });
    const writeComposer=container.querySelector<HTMLElement>('.composer')!;
    writeComposer.id='write-composer';writeComposer.setAttribute('role','tabpanel');writeComposer.setAttribute('aria-labelledby','mode-write');
    const modes=document.createElement('div');modes.className='composer-modes';modes.setAttribute('role','tablist');modes.setAttribute('aria-label','Entry type');
    modes.innerHTML='<button type="button" id="mode-write" role="tab" aria-controls="write-composer" aria-selected="true">Write</button><button type="button" id="mode-draw" role="tab" aria-controls="draw-composer" aria-selected="false" tabindex="-1">Draw</button>';
    // Back link and mode tabs share one row, which keeps the paper high on the page.
    const nav=document.createElement('div');nav.className='composer-nav';writeComposer.before(nav);nav.append(back,modes);
    const drawComposer=document.createElement('section');drawComposer.id='draw-composer';drawComposer.className='composer';drawComposer.hidden=true;drawComposer.setAttribute('role','tabpanel');drawComposer.setAttribute('aria-labelledby','mode-draw');writeComposer.after(drawComposer);
    const modeTabs=[modes.querySelector<HTMLButtonElement>('#mode-write')!,modes.querySelector<HTMLButtonElement>('#mode-draw')!];
    let drawingMounted=false,drawingLoading=false;
    // A post can be confirmed while the tab is hidden; show its result only once access is rechecked.
    const finish=(result:PostResponse,message:string)=>(options.whenVisible??((action:()=>void)=>action()))(()=>{toast(message);justPosted={boardId,result};navigate(`/b/${boardId}`);});
    // Drawing gets a wider page than writing; the stylesheet keys off the page's data-view.
    const page=container.closest<HTMLElement>('[data-view]');
    function selectMode(mode:ComposeMode,byUser=false){
      draft.mode=mode;if(byUser)options.modeChanged?.(mode);
      if(page)page.dataset.view=mode==='draw'?'draw':'compose';
      if(mode==='draw'&&drawingMounted)drawComposer.dispatchEvent(new Event('drawing-shown'));writeComposer.hidden=mode!=='write';drawComposer.hidden=mode!=='draw';
      modeTabs.forEach((tab,index)=>{const selected=(mode==='write'?0:1)===index;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;});
      if(mode==='draw'&&!drawingMounted&&!drawingLoading){
        drawingLoading=true;drawComposer.textContent='Opening drawing paper…';
        void import('./drawing-editor.ts').then(({mountDrawing})=>{
          if(!alive())return;
          disposeDrawing=mountDrawing({boardId,container:drawComposer,signal,expired,toast,posted:result=>finish(result,result.replayed?'Your drawing was already saved. No duplicate was posted.':'Drawing posted. It’s here to stay.')});drawingMounted=true;
        }).catch(error=>{if(alive())drawComposer.textContent=error instanceof Error?error.message:'The drawing tool could not load. Switch to Write and back to retry.';}).finally(()=>{drawingLoading=false;});
      }
    }
    modeTabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectMode(index===0?'write':'draw',true));tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-index;selectMode(next===0?'write':'draw',true);modeTabs[next].focus();}});});
    const disposeNote=mountNoteComposer({host:container.querySelector<HTMLElement>('#composer-body')!,boardId,draft,signal,alive,navigate,toast,denied,finish,renderPreview:(target,source)=>{void markdown(target,source,++previewVersion);},cancelPreview:()=>{previewVersion++;}});
    selectMode(options.mode??draft.mode);
    return ()=>{active=false;previewVersion++;cancelFeed();signal.removeEventListener('abort',cancelFeed);disposeNote();disposeDrawing?.();};
  }

  container.innerHTML=`<div class="feed-heading"><span>THE BOARD <small>· Posts are permanent</small></span><button id="refresh-feed" class="text-button" type="button">Refresh</button></div><div id="feed-status" class="feed-status" role="status"></div><section id="feed" aria-label="Board notes"></section><div class="pagination"><button id="previous-page" class="secondary" type="button" hidden>Previous page</button><button id="next-page" class="secondary" type="button" hidden>Older notes</button></div>`;
  const disposeMenu=mountComposeMenu({container,boardId,navigate,drafts});
  const feed=container.querySelector<HTMLElement>('#feed')!;
  const feedStatus=container.querySelector<HTMLElement>('#feed-status')!;
  const previous=container.querySelector<HTMLButtonElement>('#previous-page')!;
  const next=container.querySelector<HTMLButtonElement>('#next-page')!;
  next.textContent='Next page';
  const cursors:(string|null)[]=[null];let page=0;let nextCursor:string|null=null;let loaded=false;
  const browse=mountBrowse(boardId,feedStatus,debounce=>{
    cancelFeed();loaded=false;clearFeed(boardId);feed.replaceChildren();feed.setAttribute('aria-busy','true');
    previous.hidden=true;next.hidden=true;feedStatus.textContent='Updating results…';
    if(debounce)searchTimer=setTimeout(()=>void loadPage(true),250);else void loadPage(true);
  });
  const postStatus=document.createElement('p');postStatus.className='post-status';postStatus.setAttribute('role','status');postStatus.hidden=true;
  container.querySelector('.feed-heading')!.before(postStatus);
  function postedLink(result:PostResponse){
    postStatus.hidden=false;
    postStatus.innerHTML=`Saved permanently. ${browse.filtered()?'Filters are still on, so it may not be listed below. ':''}<a href="/b/${boardId}/e/${result.entry.id}">View ${result.entry.kind==='drawing'?'drawing':'note'} ↗</a>`;
    internalLink(postStatus.querySelector<HTMLAnchorElement>('a')!,navigate);
  }
  function card(entry:EntrySummary):HTMLElement {
    const item=document.createElement('article');item.className='note-card';item.dataset.entryId=entry.id;
    const href=`/b/${boardId}/e/${entry.id}`,kind=entry.kind==='drawing'?'drawing':'note',label=entry.title?null:derivedLabel(entry);
    const heading=entry.title?escapeHtml(entry.title):label?`<span class="sr-only">Untitled ${kind}: </span>${escapeHtml(label)}`:`Untitled ${kind}`;
    // A short note's whole text is already its label; showing it twice adds nothing.
    const excerpt=entry.excerpt&&entry.excerpt.trim()!==label?`<p class="note-excerpt">${escapeHtml(entry.excerpt)}</p>`:'';
    item.innerHTML=`<div class="entry-meta"><span>${kind.toUpperCase()} · ${escapeHtml(date(entry.created_at))}</span></div><h2${entry.title?'':' class="untitled"'}><a href="${href}">${heading}</a></h2>${entry.kind==='drawing'?drawingMarkup(entry,href):''}${excerpt}${tagsMarkup(entry.tags)}`;
    item.querySelectorAll<HTMLAnchorElement>('a').forEach(link=>internalLink(link,navigate));
    item.querySelectorAll<HTMLElement>('.entry-tags>span').forEach((span,index)=>{
      const button=document.createElement('button');button.type='button';button.textContent=span.textContent;button.setAttribute('aria-label',`Filter by tag ${entry.tags[index]}`);
      button.addEventListener('click',()=>browse.addTag(entry.tags[index]));span.replaceWith(button);
    });
    wireImages(item);return item;
  }
  function readingAnchor():FeedView['anchor']{
    for(const card of feed.querySelectorAll<HTMLElement>('.note-card')){
      const box=card.getBoundingClientRect();
      if(box.bottom>0)return {id:card.dataset.entryId!,top:box.top};
    }
    return null;
  }
  // Put the entry the reader was looking at back where it was; fall back to the raw scroll offset.
  function restoreReading(view:FeedView){
    const card=view.anchor&&[...feed.querySelectorAll<HTMLElement>('.note-card')].find(item=>item.dataset.entryId===view.anchor!.id);
    scroller().scrollTop=card?scroller().scrollTop+card.getBoundingClientRect().top-view.anchor!.top:view.scrollTop;
  }
  // `after` says where to leave the page once the entries are shown: a saved view to restore, or 'feed' for a page change.
  async function loadPage(reset=false,targetPage=page,after:FeedView|'feed'|null=null) {
    cancelFeed();
    if(reset){cursors.splice(1);cursors[0]=null;loaded=false;clearFeed(boardId);}
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
      if(!result.entries.length){const empty=document.createElement('div');empty.className='empty-notes';empty.innerHTML=browse.filtered()?'<h2>No matching entries.</h2><p>Try fewer words, a wider date range, or Clear filters. Nothing on the board has changed.</p>':'<h2>A blank page. A good beginning.</h2><p>Use + to write a note or draw a sketch, or share this space with someone.</p>';feed.append(empty);}
      feedStatus.textContent=`${result.entries.length} ${result.entries.length===1?'entry':'entries'}${page>0?` · Page ${page+1}`:''}${result.nextCursor?' · More available':''}`;
      next.hidden=!nextCursor;previous.hidden=page===0;
      loaded=true;
      if(after==='feed')feed.scrollIntoView?.({block:'start'});
      else if(after)restoreReading(after);
    } catch(error){
      if(alive()&&version===feedVersion&&!denied(error)){
        // A saved page that can no longer be fetched (for example a cursor from an older deployment) starts the feed over.
        if(after&&after!=='feed'){clearFeed(boardId);void loadPage(true);return;}
        feedStatus.textContent=`${fail(error)} Use Refresh to try again.`;
      }
    }
    finally{if(alive()&&version===feedVersion){next.disabled=false;previous.disabled=false;feed.setAttribute('aria-busy','false');}}
  }
  previous.addEventListener('click',()=>{if(page>0)void loadPage(false,page-1,'feed');});
  next.addEventListener('click',()=>{if(nextCursor){cursors[page+1]=nextCursor;void loadPage(false,page+1,'feed');}});
  container.querySelector<HTMLButtonElement>('#refresh-feed')!.addEventListener('click',()=>void loadPage(true));
  // After posting, start from a fresh first page so the new entry is where it belongs; otherwise resume where the reader left off.
  const posted=justPosted?.boardId===boardId?justPosted:null;
  const resume=posted?null:feedView(boardId);
  if(posted)postedLink(posted.result);
  justPosted=null;
  if(resume){cursors.splice(0,cursors.length,...resume.cursors);void loadPage(false,resume.page,resume);}
  else{clearFeed(boardId);scroller().scrollTop=0;void loadPage();}
  return ()=>{
    if(loaded)saveFeed(boardId,{cursors:[...cursors],page,anchor:readingAnchor(),scrollTop:scroller().scrollTop});
    active=false;previewVersion++;cancelFeed();signal.removeEventListener('abort',cancelFeed);disposeMenu();
  };
}
