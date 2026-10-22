import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {mountBoard} from '../src/board.ts';
import {draftFor,clearDraft} from '../src/drafts.ts';

async function until(condition:()=>boolean){for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('UI condition did not settle');}
function environment(){
  const dom=new JSDOM('<!doctype html><div id="board"></div>',{url:'https://board.example',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,navigator:dom.window.navigator,Event:dom.window.Event,DOMException:dom.window.DOMException,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const oldFetch=globalThis.fetch;
  return {dom,root:dom.window.document.querySelector<HTMLElement>('#board')!,restore(){globalThis.fetch=oldFetch;for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();}};
}
const summary=(n:number)=>({id:`00000000-0000-4000-8000-00000000000${n}`,board_id:'',kind:'note' as const,title:`Note ${n}`,excerpt:'Excerpt.',tags:[] as string[],created_at:new Date().toISOString()});

test('returning to the feed restores its page and reading position; posting, Lock, and unusable cursors start over',async()=>{
  const env=environment(),id=randomUUID(),entryId=randomUUID();let dispose=()=>{};
  const urls:URL[]=[],paths:string[]=[];let failCursor=false;
  const page=env.dom.window.document.documentElement;
  // Lay the cards out 200px apart so the reading anchor can be computed without a real layout engine.
  Object.defineProperty(env.dom.window.HTMLElement.prototype,'getBoundingClientRect',{configurable:true,value(this:HTMLElement){
    const n=Number(this.dataset?.entryId?.slice(-1));const top=n?100+((n-1)%3)*200-page.scrollTop:0;
    return {top,bottom:n?top+180:0,left:0,right:0,width:0,height:n?180:0,x:0,y:top,toJSON(){return {};}};
  }});
  try{
    globalThis.fetch=async(url,init)=>{
      if(init?.method==='POST'){const payload=JSON.parse(String(init.body));return Response.json({entry:{id:entryId,board_id:id,kind:'note',title:null,markdown:payload.markdown,tags:[],created_at:new Date().toISOString()},replayed:false},{status:201});}
      const u=new URL(String(url),'https://board.example');urls.push(u);
      if(u.searchParams.get('cursor')==='N1'){
        if(failCursor)return Response.json({error:{code:'QUERY',message:'Check the search filters, dates, or page cursor.'}},{status:400});
        return Response.json({entries:[4,5,6].map(summary),pageCursor:'N1',nextCursor:null});
      }
      return Response.json({entries:[1,2,3].map(summary),pageCursor:'P0',nextCursor:'N1'});
    };
    const options={container:env.root,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:(path:string)=>{paths.push(path);},expired:()=>{throw new Error('Unexpected expiry');},toast:()=>{}};
    const remount=(over:object={})=>{dispose();dispose=mountBoard({...options,signal:new AbortController().signal,...over});};
    const status=()=>env.root.querySelector('#feed-status')!.textContent!;
    const ids=()=>[...env.root.querySelectorAll<HTMLElement>('.note-card')].map(card=>card.dataset.entryId!.slice(-1));

    dispose=mountBoard(options);await until(()=>ids().length===3);
    assert.deepEqual(ids(),['1','2','3']);
    env.root.querySelector<HTMLButtonElement>('#next-page')!.click();await until(()=>ids()[0]==='4');
    assert.match(status(),/Page 2/);
    page.scrollTop=250;assert.equal(page.scrollTop,250);

    // Back from an entry: same page, same card at the same height.
    remount();page.scrollTop=0;
    await until(()=>ids()[0]==='4');
    assert.equal(urls.at(-1)!.searchParams.get('cursor'),'N1');assert.match(status(),/Page 2/);
    assert.equal(page.scrollTop,250);

    // A page that can no longer be fetched starts the feed over instead of showing an error.
    failCursor=true;remount();await until(()=>ids()[0]==='1');
    assert.equal(urls.at(-1)!.searchParams.get('cursor'),null);assert.doesNotMatch(status(),/Page 2/);
    failCursor=false;

    // Refresh replaces the saved page: coming back lands on page 1, not on the page read before.
    env.root.querySelector<HTMLButtonElement>('#next-page')!.click();await until(()=>ids()[0]==='4');
    env.root.querySelector<HTMLButtonElement>('#refresh-feed')!.click();await until(()=>ids()[0]==='1');
    remount();await until(()=>ids()[0]==='1');assert.doesNotMatch(status(),/Page 2/);

    // Posting starts from a fresh first page, so the new entry is where it belongs.
    env.root.querySelector<HTMLButtonElement>('#next-page')!.click();await until(()=>ids()[0]==='4');
    remount({view:'compose'});
    const textarea=env.root.querySelector<HTMLTextAreaElement>('#note-body')!;
    textarea.value='A new thought.';textarea.dispatchEvent(new env.dom.window.Event('input',{bubbles:true}));
    env.root.querySelector('form')!.dispatchEvent(new env.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>paths.length===1);assert.deepEqual(paths,[`/b/${id}`]);
    remount();await until(()=>ids().length===3);
    assert.equal(ids()[0],'1');assert.equal(urls.at(-1)!.searchParams.get('cursor'),null);
    assert.match(env.root.querySelector('.post-status')!.textContent!,/Saved permanently/);

    // Lock clears the saved position.
    env.root.querySelector<HTMLButtonElement>('#next-page')!.click();await until(()=>ids()[0]==='4');
    dispose();dispose=()=>{};clearDraft(id);
    dispose=mountBoard({...options,signal:new AbortController().signal});await until(()=>ids().length===3);
    assert.equal(ids()[0],'1');assert.equal(urls.at(-1)!.searchParams.get('cursor'),null);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('cards drop the repeated permanence label, link drawing thumbnails, and label untitled entries without inventing titles',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  const long='Something long enough that it will need to be shortened at a word boundary for the list';
  try{
    const base={board_id:id,tags:[] as string[],created_at:new Date().toISOString()};
    const entries=[
      {...base,id:randomUUID(),kind:'note',title:'Titled note',excerpt:'Body of the titled note.'},
      {...base,id:randomUUID(),kind:'note',title:null,excerpt:long},
      {...base,id:randomUUID(),kind:'note',title:null,excerpt:'Short thought'},
      {...base,id:randomUUID(),kind:'drawing',title:null,excerpt:'A cat on a roof',drawing_caption:'A cat on a roof',width:1024,height:768},
      {...base,id:randomUUID(),kind:'drawing',title:null,excerpt:'',drawing_caption:null,width:1024,height:768}
    ];
    globalThis.fetch=async()=>Response.json({entries,pageCursor:null,nextCursor:null});
    dispose=mountBoard({container:env.root,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:()=>{},toast:()=>{}});
    await until(()=>env.root.querySelectorAll('.note-card').length===5);
    const cards=[...env.root.querySelectorAll<HTMLElement>('.note-card')];
    for(const card of cards){assert.doesNotMatch(card.textContent!,/Permanent/);assert.equal(card.querySelector('.open-note'),null);assert.equal(card.querySelectorAll('h2 a').length,1);}
    assert.match(env.root.querySelector('.feed-heading')!.textContent!,/Posts are permanent/);

    assert.equal(cards[0].querySelector('h2')!.className,'');assert.equal(cards[0].querySelector('h2')!.textContent,'Titled note');
    const label=cards[1].querySelector('h2')!;
    assert.equal(label.className,'untitled');assert.match(label.textContent!,/^Untitled note: Something long enough/);assert(label.textContent!.endsWith('…'));
    assert(cards[1].querySelector('.note-excerpt'));
    assert.equal(cards[2].querySelector('.note-excerpt'),null);assert.equal(cards[2].querySelector('h2')!.textContent,'Untitled note: Short thought');
    assert.equal(cards[3].querySelector('h2')!.textContent,'Untitled drawing: A cat on a roof');
    assert.equal(cards[4].querySelector('h2')!.textContent,'Untitled drawing');

    const thumb=cards[3].querySelector<HTMLAnchorElement>('.drawing-link')!;
    assert.equal(thumb.getAttribute('href'),`/b/${id}/e/${entries[3].id}`);assert.equal(thumb.getAttribute('aria-hidden'),'true');assert.equal(thumb.getAttribute('tabindex'),'-1');
    assert(thumb.querySelector('img'));assert.equal(cards[0].querySelector('.drawing-link'),null);

    assert(env.root.querySelector('.browse-bar #filter-kind'));assert.equal(env.root.querySelector('#feed-filters #filter-kind'),null);
  }finally{dispose();clearDraft(id);env.restore();}
});
