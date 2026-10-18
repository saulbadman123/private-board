import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {mountBoard} from '../src/board.ts';
import {draftFor,clearDraft,drawingDraftFor} from '../src/drafts.ts';

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

test('editor preview, lost-response retry, remount, and success preserve the exact submitted draft',async()=>{
  const env=environment();const id=randomUUID(),entryId=randomUUID();const sent:unknown[]=[],paths:string[]=[];let dispose=()=>{};
  try{
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){
        const payload=JSON.parse(String(init.body));sent.push(payload);
        if(sent.length===1)throw new Error('Connection interrupted after server commit');
        return Response.json({entry:{id:entryId,board_id:id,kind:'note',title:null,markdown:payload.markdown,tags:[],created_at:new Date().toISOString()},replayed:true});
      }
      return Response.json({entries:[],nextCursor:null});
    };
    const options={container:env.root,view:'compose' as const,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:(path:string)=>{paths.push(path);},expired:()=>{throw new Error('Unexpected expiry');},toast:()=>{}};
    dispose=mountBoard(options);
    const textarea=env.root.querySelector<HTMLTextAreaElement>('#note-body')!;
    textarea.value='A **permanent** thought.';textarea.dispatchEvent(new env.dom.window.Event('input',{bubbles:true}));
    env.root.querySelector<HTMLButtonElement>('#preview-tab')!.click();
    await until(()=>!!env.root.querySelector('#note-preview strong'));
    env.root.querySelector<HTMLButtonElement>('#write-tab')!.click();
    env.root.querySelector('form')!.dispatchEvent(new env.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>!!draftFor(id).attempt&&!draftFor(id).pending);
    assert(textarea.readOnly);assert.match(env.root.querySelector('#post-note')!.textContent!,/Retry/);
    dispose();dispose=mountBoard({...options,signal:new AbortController().signal});
    assert.equal(env.root.querySelector<HTMLTextAreaElement>('#note-body')!.value,'A **permanent** thought.');
    env.root.querySelector('form')!.dispatchEvent(new env.dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>!draftFor(id).attempt&&!draftFor(id).markdown);
    assert.deepEqual(sent[0],sent[1]);assert.equal(env.root.querySelector<HTMLTextAreaElement>('#note-body')!.value,'');assert(!env.root.querySelector<HTMLTextAreaElement>('#note-body')!.readOnly);
    assert.deepEqual(paths,[`/b/${id}`]);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('drawing mode retains the note draft, freezes interrupted uploads, and retries the same bytes',async()=>{
  const env=environment(),id=randomUUID(),entryId=randomUUID();let dispose=()=>{},posts=0;
  const sent:{requestId:string;bytes:number[]}[]=[];
  const context={fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',fillRect(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){}};
  Object.defineProperty(env.dom.window.HTMLCanvasElement.prototype,'getContext',{value:()=>context});
  Object.defineProperty(env.dom.window.HTMLCanvasElement.prototype,'toBlob',{value:(callback:(blob:Blob)=>void)=>callback(new Blob([new Uint8Array([1,2,3,4])],{type:'image/png'}))});
  try{
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){
        assert(init.body instanceof FormData);assert(!('Content-Type'in(init.headers as Record<string,string>)));
        const form=init.body;posts++;sent.push({requestId:String(form.get('requestId')),bytes:[...new Uint8Array(await(form.get('image') as Blob).arrayBuffer())]});
        if(posts===1)throw new Error('Lost connection');
        return Response.json({entry:{id:entryId,board_id:id,kind:'drawing',title:null,drawing_caption:null,tags:[],created_at:new Date().toISOString(),width:1024,height:768,image_mime:'image/png',image_bytes:4},replayed:true});
      }
      return Response.json({entries:[],nextCursor:null});
    };
    const options={container:env.root,view:'compose' as const,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:()=>{},toast:()=>{}};
    dispose=mountBoard(options);
    const note=env.root.querySelector<HTMLTextAreaElement>('#note-body')!;note.value='My separate note draft';note.dispatchEvent(new env.dom.window.Event('input'));
    env.root.querySelector<HTMLButtonElement>('#mode-draw')!.click();await until(()=>!!env.root.querySelector('#post-drawing'));
    const canvas=env.root.querySelector<HTMLCanvasElement>('canvas')!;
    canvas.getBoundingClientRect=()=>({left:0,top:0,width:512,height:384,right:512,bottom:384,x:0,y:0,toJSON(){return{};}});
    for(const type of ['pointerdown','pointerup']){const event=new env.dom.window.Event(type,{cancelable:true});Object.assign(event,{pointerId:1,pointerType:'touch',button:0,clientX:100,clientY:100});canvas.dispatchEvent(event);}
    assert(drawingDraftFor(id).ink);
    env.root.querySelector<HTMLButtonElement>('#mode-write')!.click();assert.equal(note.value,'My separate note draft');
    env.root.querySelector<HTMLButtonElement>('#mode-draw')!.click();assert.equal(env.root.querySelector('canvas'),canvas);
    const submit=()=>env.root.querySelector('#drawing-form')!.dispatchEvent(new env.dom.window.Event('submit',{cancelable:true}));
    submit();await until(()=>!!drawingDraftFor(id).attempt&&!drawingDraftFor(id).pending);
    assert(env.root.querySelector<HTMLButtonElement>('#clear-drawing')!.disabled);assert.match(env.root.querySelector('#post-drawing')!.textContent!,/Retry/);
    dispose();dispose=mountBoard({...options,signal:new AbortController().signal});await until(()=>!!env.root.querySelector('#post-drawing'));
    submit();await until(()=>posts===2&&!drawingDraftFor(id).attempt&&!drawingDraftFor(id).pending);
    assert.deepEqual(sent[0],sent[1]);assert.equal(drawingDraftFor(id).ink,false);assert.equal(draftFor(id).markdown,'My separate note draft');
  }finally{dispose();clearDraft(id);env.restore();}
});

test('expired posting retains a retryable draft and an invalid success response never clears it',async()=>{
  const env=environment();const id=randomUUID();let expired=0,posts=0;let dispose=()=>{};
  try{
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){posts++;return posts===1?Response.json({error:{message:'Expired',code:'LOCKED'}},{status:401}):Response.json({unexpected:'not an acknowledgment'});}
      return Response.json({entries:[],nextCursor:null});
    };
    dispose=mountBoard({container:env.root,view:'compose',response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:()=>{expired++;},toast:()=>{}});
    const body=env.root.querySelector<HTMLTextAreaElement>('#note-body')!;body.value='Keep me';body.dispatchEvent(new env.dom.window.Event('input'));
    const submit=()=>env.root.querySelector('form')!.dispatchEvent(new env.dom.window.Event('submit',{cancelable:true}));
    submit();await until(()=>expired===1);const requestId=draftFor(id).attempt!.requestId;
    assert.equal(draftFor(id).markdown,'Keep me');assert(body.readOnly);
    submit();await until(()=>posts===2&&!draftFor(id).pending);
    assert.equal(draftFor(id).attempt!.requestId,requestId);assert.equal(draftFor(id).markdown,'Keep me');
  }finally{dispose();clearDraft(id);env.restore();}
});

test('browsing cancels stale searches, retains filters on return/post, filters tags, and clears private preferences on lock',async()=>{
  const env=environment(),id=randomUUID(),entryId=randomUUID();let dispose=()=>{},resolveOld:((value:Response)=>void)|undefined;
  const reads:{url:URL;signal:AbortSignal|null|undefined}[]=[];
  const entry={id:entryId,board_id:id,kind:'note',title:'Current match',tags:['idea'],created_at:new Date().toISOString(),excerpt:'Newest response'};
  const navigated:string[]=[];
  const options={container:env.root,view:'feed' as 'feed'|'compose',response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:(path:string)=>{navigated.push(path);},expired:()=>{},toast:()=>{}};
  try{
    globalThis.fetch=async(url,init)=>{
      if(init?.method==='POST'){const payload=JSON.parse(String(init.body));return Response.json({entry:{...entry,markdown:payload.markdown},replayed:false});}
      const parsed=new URL(String(url),'https://board.example');reads.push({url:parsed,signal:init?.signal});
      if(parsed.searchParams.get('q')==='old')return new Promise<Response>(resolve=>{resolveOld=resolve;});
      return Response.json({entries:parsed.searchParams.get('q')==='new'?[entry]:[],nextCursor:null});
    };
    dispose=mountBoard(options);await until(()=>reads.length===1);
    const search=()=>env.root.querySelector<HTMLInputElement>('#board-search')!;
    search().value='old';search().dispatchEvent(new env.dom.window.Event('input'));
    search().dispatchEvent(new env.dom.window.KeyboardEvent('keydown',{key:'Enter'}));
    await until(()=>!!resolveOld);const old=reads.at(-1)!;
    search().value='new';search().dispatchEvent(new env.dom.window.Event('input'));
    assert(old.signal?.aborted);
    resolveOld!(Response.json({entries:[{...entry,title:'Stale response'}],nextCursor:null}));
    await until(()=>!!env.root.querySelector('.note-card'));
    assert.match(env.root.querySelector('#feed')!.textContent!,/Current match/);assert.doesNotMatch(env.root.querySelector('#feed')!.textContent!,/Stale response/);
    env.root.querySelector<HTMLButtonElement>('.entry-tags button')!.click();
    await until(()=>reads.at(-1)!.url.searchParams.get('tag')==='idea');
    assert.equal(env.root.querySelector<HTMLInputElement>('#filter-tags')!.value,'idea');
    const kind=env.root.querySelector<HTMLSelectElement>('#filter-kind')!;kind.value='drawing';kind.dispatchEvent(new env.dom.window.Event('change'));
    draftFor(id).markdown='Keep my words';
    dispose();dispose=mountBoard({...options,signal:new AbortController().signal});
    assert.equal(search().value,'new');assert.equal(env.root.querySelector<HTMLSelectElement>('#filter-kind')!.value,'drawing');
    assert.equal(env.root.querySelector('#go-write')!.textContent,'Continue note');assert.equal(env.root.querySelector('#go-draw')!.textContent,'Draw');
    assert.equal(env.root.querySelector('#note-form'),null);
    dispose();dispose=mountBoard({...options,view:'compose',signal:new AbortController().signal});
    assert.equal(env.root.querySelector<HTMLTextAreaElement>('#note-body')!.value,'Keep my words');assert.equal(env.root.querySelector('#feed'),null);
    env.root.querySelector('#note-form')!.dispatchEvent(new env.dom.window.Event('submit',{cancelable:true}));
    await until(()=>navigated.length===1);assert.deepEqual(navigated,[`/b/${id}`]);assert.equal(draftFor(id).markdown,'');
    dispose();dispose=mountBoard({...options,signal:new AbortController().signal});
    assert.equal(env.root.querySelector('#go-write')!.textContent,'Write a note');
    await until(()=>!!env.root.querySelector('.post-status a'));
    assert.equal(search().value,'new');assert.equal(env.root.querySelector<HTMLSelectElement>('#filter-kind')!.value,'drawing');assert.match(env.root.querySelector('.post-status a')!.getAttribute('href')!,new RegExp(entryId));
    assert.equal(reads.at(-1)!.url.searchParams.get('kind'),'drawing');
    env.root.querySelector<HTMLButtonElement>('#clear-filters')!.click();
    assert.equal(search().value,'');assert.equal(env.root.querySelector<HTMLSelectElement>('#filter-kind')!.value,'all');
    assert(env.root.querySelector<HTMLOptionElement>('#filter-sort [value=relevance]')!.disabled);
    await until(()=>!!env.root.querySelector('.empty-notes'));
    assert.match(env.root.querySelector('.empty-notes')!.textContent!,/blank page/);
    search().value='private';search().dispatchEvent(new env.dom.window.Event('input'));
    dispose();clearDraft(id);dispose=mountBoard({...options,signal:new AbortController().signal});assert.equal(search().value,'');
  }finally{dispose();clearDraft(id);env.restore();}
});

test('filter validation is accessible, avoids requests, and no-results differs from an empty board',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{},reads=0;
  try{
    globalThis.fetch=async()=>{reads++;return Response.json({entries:[],nextCursor:null});};
    dispose=mountBoard({container:env.root,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:()=>{},toast:()=>{}});
    await until(()=>!!env.root.querySelector('.empty-notes'));
    const from=env.root.querySelector<HTMLInputElement>('#filter-from')!,to=env.root.querySelector<HTMLInputElement>('#filter-to')!;
    from.value='2026-10-17';from.dispatchEvent(new env.dom.window.Event('change'));to.value='2026-10-16';to.dispatchEvent(new env.dom.window.Event('change'));
    await until(()=>!env.root.querySelector<HTMLElement>('#filter-error')!.hidden);
    assert.equal(reads,2);assert.equal(env.root.querySelector('#filter-error')!.getAttribute('role'),'alert');
    to.value='2026-10-17';to.dispatchEvent(new env.dom.window.Event('change'));
    await until(()=>!!env.root.querySelector('.empty-notes'));assert.match(env.root.querySelector('.empty-notes')!.textContent!,/No matching entries/);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('Previous preserves the first-page cutoff and Refresh starts a new page sequence',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};const cursors:(string|null)[]=[];
  try{
    globalThis.fetch=async(url)=>{
      const cursor=new URL(String(url),'https://board.example').searchParams.get('cursor');cursors.push(cursor);
      return Response.json({entries:[{id:randomUUID(),board_id:id,kind:'note',title:cursor==='second'?'Second page':'First page',tags:[],excerpt:'',created_at:new Date().toISOString()}],pageCursor:cursor??'first',nextCursor:cursor==='second'?null:'second'});
    };
    dispose=mountBoard({container:env.root,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:()=>{},toast:()=>{}});
    await until(()=>!env.root.querySelector<HTMLButtonElement>('#next-page')!.hidden);
    env.root.querySelector<HTMLButtonElement>('#next-page')!.click();await until(()=>!!env.root.querySelector('#feed')!.textContent?.includes('Second page'));
    env.root.querySelector<HTMLButtonElement>('#previous-page')!.click();await until(()=>!!env.root.querySelector('#feed')!.textContent?.includes('First page'));
    env.root.querySelector<HTMLButtonElement>('#refresh-feed')!.click();await until(()=>cursors.length===4);
    assert.deepEqual(cursors,[null,'second','first',null]);
  }finally{dispose();clearDraft(id);env.restore();}
});
