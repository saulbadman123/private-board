import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {mountBoard} from '../src/board.ts';
import {clearDraft,drawingDraftFor} from '../src/drafts.ts';

async function until(condition:()=>boolean){for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('UI condition did not settle');}

// A page shaped like the real one (header, main with a data-view, footer, toast) so layout-level behavior can be checked.
function environment(){
  const dom=new JSDOM('<!doctype html><div id="app"><header id="site-header">h</header><main id="main" data-view="compose"><div id="board"></div></main><footer id="site-footer">f</footer></div><div id="toast"></div>',{url:'https://board.example',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,navigator:dom.window.navigator,Event:dom.window.Event,DOMException:dom.window.DOMException,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const ops:unknown[][]=[];
  const context={fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},clearRect(){},drawImage(){ops.push(['baseline']);},fillRect(this:{fillStyle:string},x:number,y:number,w:number,h:number){ops.push(['paper',this.fillStyle,x,y,w,h]);}};
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'getContext',{value:()=>context});
  let blobBytes=4;
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'toBlob',{value:(callback:(blob:Blob)=>void)=>callback(new Blob([new Uint8Array(blobBytes)],{type:'image/png'}))});
  const oldFetch=globalThis.fetch;
  const doc=dom.window.document;
  return {
    dom,doc,root:doc.querySelector<HTMLElement>('#board')!,ops,page:doc.documentElement,
    setBlobBytes(bytes:number){blobBytes=bytes;},
    $:<T extends Element=HTMLElement>(selector:string)=>doc.querySelector<T>(selector)!,
    restore(){globalThis.fetch=oldFetch;for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();}
  };
}
type Env=ReturnType<typeof environment>;
const boardOptions=(env:Env,id:string,over:object={})=>({container:env.root,view:'compose' as const,mode:'draw' as const,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:()=>{},toast:()=>{},...over});
function pointer(env:Env,canvas:HTMLCanvasElement,type:string,id:number,x:number,y:number){
  const event=new env.dom.window.Event(type,{cancelable:true,bubbles:true});
  Object.assign(event,{pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:y});canvas.dispatchEvent(event);
}
let nextPointer=1;
function stroke(env:Env,canvas:HTMLCanvasElement,points:[number,number][]){
  canvas.getBoundingClientRect=()=>({left:0,top:0,width:512,height:384,right:512,bottom:384,x:0,y:0,toJSON(){return {};}});
  const id=nextPointer++;
  pointer(env,canvas,'pointerdown',id,...points[0]);for(const point of points.slice(1))pointer(env,canvas,'pointermove',id,...point);pointer(env,canvas,'pointerup',id,...points.at(-1)!);
}
const key=(env:Env,target:Element,init:KeyboardEventInit)=>{const event=new env.dom.window.KeyboardEvent('keydown',{bubbles:true,cancelable:true,...init});target.dispatchEvent(event);return event;};
async function mount(env:Env,id:string,over:object={}){
  const dispose=mountBoard(boardOptions(env,id,over));await until(()=>!!env.root.querySelector('#post-drawing'));return dispose;
}

test('undo, redo, and clear are steps of one history that survives mode switches and remounts',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    dispose=await mount(env,id);
    const canvas=env.$<HTMLCanvasElement>('canvas'),draft=drawingDraftFor(id);
    const state=()=>({undo:env.$<HTMLButtonElement>('#undo-drawing').disabled,redo:env.$<HTMLButtonElement>('#redo-drawing').disabled,clear:env.$<HTMLButtonElement>('#clear-drawing').disabled,post:env.$<HTMLButtonElement>('#post-drawing').disabled});
    assert.deepEqual(state(),{undo:true,redo:true,clear:true,post:true});

    stroke(env,canvas,[[10,10],[40,40]]);stroke(env,canvas,[[50,10],[90,40]]);
    assert.equal(draft.history.ops.length,2);assert.deepEqual(state(),{undo:false,redo:true,clear:false,post:false});

    const papers=()=>env.ops.filter(op=>op[0]==='paper').length;
    let before=papers();
    env.$<HTMLButtonElement>('#undo-drawing').click();
    assert.equal(draft.history.ops.length,1);assert(papers()>before,'undo repaints from blank paper');assert.equal(state().redo,false);
    env.$<HTMLButtonElement>('#redo-drawing').click();assert.equal(draft.history.ops.length,2);assert.equal(state().redo,true);

    // Keyboard: Ctrl+Z undoes, Shift+Ctrl+Z and Ctrl+Y redo; text fields keep their own undo.
    assert(key(env,canvas,{key:'z',ctrlKey:true}).defaultPrevented);assert.equal(draft.history.ops.length,1);
    assert(key(env,canvas,{key:'z',ctrlKey:true,shiftKey:true}).defaultPrevented);assert.equal(draft.history.ops.length,2);
    key(env,canvas,{key:'z',metaKey:true});assert.equal(draft.history.ops.length,1);
    assert(key(env,canvas,{key:'y',ctrlKey:true}).defaultPrevented);assert.equal(draft.history.ops.length,2);
    const insideText=key(env,env.$('#draw-title'),{key:'z',ctrlKey:true});assert(!insideText.defaultPrevented);assert.equal(draft.history.ops.length,2);

    // Clear is undoable.
    env.$<HTMLButtonElement>('#clear-drawing').click();
    assert.equal(draft.history.ops.at(-1),'clear');assert.deepEqual(state(),{undo:false,redo:true,clear:true,post:true});
    // (Undoing the Clear brings the ink back, and the Clear itself can be redone.)
    env.$<HTMLButtonElement>('#undo-drawing').click();assert.deepEqual(state(),{undo:false,redo:false,clear:false,post:false});assert.equal(draft.ink,true);

    // Switching to Write and back, and remounting the board, keep the history and the canvas.
    env.$<HTMLButtonElement>('#mode-write').click();env.$<HTMLButtonElement>('#mode-draw').click();
    assert.equal(draft.history.ops.length,2);assert.equal(env.$('canvas'),canvas);
    dispose();dispose=await mount(env,id);
    assert.equal(draft.history.ops.length,2);assert.equal(env.$('canvas'),canvas);assert.equal(state().undo,false);
    env.$<HTMLButtonElement>('#undo-drawing').click();env.$<HTMLButtonElement>('#undo-drawing').click();
    assert.deepEqual(state(),{undo:true,redo:false,clear:true,post:true});assert.equal(draft.ink,false);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('while a post is unconfirmed the drawing is frozen, but the view stays usable',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async(_url,init)=>{if(init?.method==='POST')throw new Error('Lost connection');return Response.json({entries:[],nextCursor:null});};
    dispose=await mount(env,id);
    const canvas=env.$<HTMLCanvasElement>('canvas');stroke(env,canvas,[[10,10],[40,40]]);
    env.$('#drawing-form').dispatchEvent(new env.dom.window.Event('submit',{cancelable:true}));
    await until(()=>!!drawingDraftFor(id).attempt&&!drawingDraftFor(id).pending);
    for(const selector of ['#undo-drawing','#redo-drawing','#clear-drawing','#draw-paper'])assert(env.$<HTMLButtonElement>(selector).disabled,selector);
    for(const selector of ['#zoom-in','#zoom-out','#zoom-fit','#zoom-actual','#pointer-pan','#expand-drawing'])assert(!env.$<HTMLButtonElement>(selector).disabled,selector);
    assert(env.$<HTMLDetailsElement>('.draw-view-more').open,'view controls are always shown when there is no phone-sized screen');
    const ops=drawingDraftFor(id).history.ops.length;
    key(env,canvas,{key:'z',ctrlKey:true});stroke(env,canvas,[[1,1],[5,5]]);
    assert.equal(drawingDraftFor(id).history.ops.length,ops);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('paper size is a new-drawing choice: confirmed when there is ink, scaled brushes, never changed by resizing',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{},confirms=0,answer=false;
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    env.dom.window.confirm=()=>{confirms++;return answer;};
    dispose=await mount(env,id);
    const canvas=env.$<HTMLCanvasElement>('canvas'),draft=drawingDraftFor(id),paper=env.$<HTMLSelectElement>('#draw-paper');
    assert.deepEqual([canvas.width,canvas.height,paper.value],[1024,768,'standard']);
    assert.deepEqual([...paper.options].map(option=>option.textContent),['Standard · 1024 × 768','Large · 1600 × 1200']);

    const choose=(value:string)=>{paper.value=value;paper.dispatchEvent(new env.dom.window.Event('change',{bubbles:true}));};
    const broad=env.$<HTMLSelectElement>('#draw-size');broad.value='14';broad.dispatchEvent(new env.dom.window.Event('change'));
    // With nothing drawn, switching needs no confirmation.
    choose('large');assert.equal(confirms,0);assert.deepEqual([canvas.width,canvas.height],[1600,1200]);
    assert(env.ops.some(op=>op[0]==='paper'&&op[2]===0&&op[4]===1600&&op[5]===1200));
    choose('standard');assert.equal(confirms,0);assert.deepEqual([canvas.width,canvas.height],[1024,768]);

    stroke(env,canvas,[[10,10],[40,40]]);
    const first=draft.history.ops[0];assert(first!=='clear'&&first.size===14);          // Broad on Standard paper is 14px
    // Ink on the page: declining keeps everything, accepting starts a new blank drawing.
    answer=false;choose('large');assert.equal(confirms,1);assert.equal(paper.value,'standard');assert.deepEqual([canvas.width,canvas.height],[1024,768]);assert.equal(draft.history.ops.length,1);assert(draft.ink);
    answer=true;choose('large');assert.equal(confirms,2);assert.equal(paper.value,'large');assert.deepEqual([canvas.width,canvas.height],[1600,1200]);assert.equal(draft.history.ops.length,0);assert(!draft.ink);
    assert(env.$<HTMLButtonElement>('#post-drawing').disabled);

    // The same Broad brush is proportionally thicker on Large paper.
    stroke(env,canvas,[[10,10],[40,40]]);
    const large=draft.history.ops[0];assert(large!=='clear');assert.equal(large.size,14*1600/1024);
    // Points map across the larger bitmap.
    assert.deepEqual(large.points.slice(0,2),[10*1600/512,10*1200/384]);

    // Resizing the window never touches the bitmap or the ink.
    env.dom.window.dispatchEvent(new env.dom.window.Event('resize'));await new Promise(resolve=>setTimeout(resolve,50));
    assert.deepEqual([canvas.width,canvas.height],[1600,1200]);assert.equal(draft.history.ops.length,1);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('posting on Large paper clears the draft at its real size, and an over-limit PNG explains itself without losing the drawing',async()=>{
  const env=environment(),id=randomUUID(),entryId=randomUUID();let dispose=()=>{},posts=0;const paths:string[]=[];
  try{
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){posts++;return Response.json({entry:{id:entryId,board_id:id,kind:'drawing',title:null,drawing_caption:null,tags:[],created_at:new Date().toISOString(),width:1600,height:1200,image_mime:'image/png',image_bytes:4},replayed:false},{status:201});}
      return Response.json({entries:[],nextCursor:null});
    };
    dispose=await mount(env,id,{navigate:(path:string)=>{paths.push(path);}});
    const canvas=env.$<HTMLCanvasElement>('canvas'),draft=drawingDraftFor(id),paper=env.$<HTMLSelectElement>('#draw-paper');
    paper.value='large';paper.dispatchEvent(new env.dom.window.Event('change',{bubbles:true}));
    stroke(env,canvas,[[10,10],[40,40]]);

    env.setBlobBytes(3*1024*1024+1);
    env.$('#drawing-form').dispatchEvent(new env.dom.window.Event('submit',{cancelable:true}));
    await until(()=>/MiB/.test(env.$('#drawing-error').textContent!));
    assert.match(env.$('#drawing-error').textContent!,/3\.0 MiB as a PNG; the limit is 3 MiB\. Try Standard paper, or simplify the drawing\. Nothing has been changed\./);
    assert.equal(posts,0);assert.equal(draft.attempt,null);assert(draft.ink);assert.equal(draft.history.ops.length,1);assert(!env.$<HTMLButtonElement>('#post-drawing').disabled);

    env.setBlobBytes(4);const before=env.ops.length;
    env.$('#drawing-form').dispatchEvent(new env.dom.window.Event('submit',{cancelable:true}));
    await until(()=>paths.length===1);
    assert.equal(posts,1);assert.deepEqual(paths,[`/b/${id}`]);
    assert(!draft.ink);assert.equal(draft.history.ops.length,0);
    assert(env.ops.slice(before).some(op=>op[0]==='paper'&&op[2]===0&&op[3]===0&&op[4]===1600&&op[5]===1200),'the whole Large page is cleared');
    assert.deepEqual([canvas.width,canvas.height],[1600,1200]);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('the expanded workspace is a modal in-page mode: everything else is inert, Escape exits, and cleanup is complete',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    dispose=await mount(env,id);
    const composer=env.$('#draw-composer'),expand=env.$<HTMLButtonElement>('#expand-drawing');
    // The back link and the Write/Draw tabs share one wrapper, which is what goes inert.
    const inertIds=()=>['#site-header','#site-footer','.composer-nav','#write-composer'].filter(selector=>env.$(selector).hasAttribute('inert'));
    assert.equal(expand.textContent,'Expand');assert.equal(composer.getAttribute('role'),'tabpanel');assert.deepEqual(inertIds(),[]);

    expand.click();
    assert(composer.classList.contains('is-expanded'));assert(env.page.classList.contains('drawing-expanded'));
    assert.equal(composer.getAttribute('role'),'dialog');assert.equal(composer.getAttribute('aria-modal'),'true');assert.equal(expand.textContent,'Exit expanded view');
    assert.deepEqual(inertIds(),['#site-header','#site-footer','.composer-nav','#write-composer']);
    assert(env.$('#back-board').closest('[inert]'),'the back link is unreachable while expanded');
    assert(!composer.hasAttribute('inert'));assert(!env.$('#toast').hasAttribute('inert'));assert(!env.$('#main').hasAttribute('inert'));

    expand.focus();key(env,expand,{key:'Escape'});
    assert(!composer.classList.contains('is-expanded'));assert(!env.page.classList.contains('drawing-expanded'));
    assert.equal(composer.getAttribute('role'),'tabpanel');assert(!composer.hasAttribute('aria-modal'));assert.deepEqual(inertIds(),[]);assert.equal(env.doc.activeElement,expand);

    // Leaving the page while expanded (route change, lock, expiry) must not leave the page locked.
    expand.click();assert(env.page.classList.contains('drawing-expanded'));
    dispose();dispose=()=>{};
    assert(!env.page.classList.contains('drawing-expanded'));assert.deepEqual(['#site-header','#site-footer'].filter(selector=>env.$(selector).hasAttribute('inert')),[]);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('Draw/Pan modes, zoom buttons, and the page width follow the mode; Pan never draws',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    dispose=await mount(env,id);
    const canvas=env.$<HTMLCanvasElement>('canvas'),draft=drawingDraftFor(id),page=env.$('#main');
    assert.equal(page.dataset.view,'draw');
    env.$<HTMLButtonElement>('#mode-write').click();assert.equal(page.dataset.view,'compose');
    env.$<HTMLButtonElement>('#mode-draw').click();assert.equal(page.dataset.view,'draw');

    const pressed=(selector:string)=>env.$(selector).getAttribute('aria-pressed');
    assert.deepEqual([pressed('#pointer-draw'),pressed('#pointer-pan'),canvas.classList.contains('is-pan')],['true','false',false]);
    env.$<HTMLButtonElement>('#pointer-pan').click();
    assert.deepEqual([pressed('#pointer-draw'),pressed('#pointer-pan'),canvas.classList.contains('is-pan')],['false','true',true]);
    const stage=env.$('#canvas-slot');stage.scrollLeft=0;
    canvas.getBoundingClientRect=()=>({left:0,top:0,width:512,height:384,right:512,bottom:384,x:0,y:0,toJSON(){return {};}});
    pointer(env,canvas,'pointerdown',90,100,100);pointer(env,canvas,'pointermove',90,60,100);pointer(env,canvas,'pointerup',90,60,100);
    assert.equal(draft.history.ops.length,0);assert(!draft.ink);assert.equal(stage.scrollLeft,40);
    env.$<HTMLButtonElement>('#pointer-draw').click();stroke(env,canvas,[[10,10],[20,20]]);assert.equal(draft.history.ops.length,1);

    const level=()=>env.$('#zoom-level').textContent;
    assert.equal(level(),'100%');                         // no layout in jsdom, so Fit leaves it at 100%
    env.$<HTMLButtonElement>('#zoom-in').click();assert.equal(level(),'125%');assert.equal(canvas.style.width,'1280px');assert.equal(canvas.style.height,'960px');
    env.$<HTMLButtonElement>('#zoom-out').click();env.$<HTMLButtonElement>('#zoom-out').click();assert.equal(level(),'80%');
    env.$<HTMLButtonElement>('#zoom-actual').click();assert.equal(level(),'100%');assert.equal(canvas.style.width,'1024px');
    env.$<HTMLButtonElement>('#zoom-fit').click();assert.equal(level(),'100%');
    // Zoom is a view only: the bitmap and the ink are untouched.
    assert.deepEqual([canvas.width,canvas.height],[1024,768]);assert.equal(draft.history.ops.length,1);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('the drawing viewer offers Fit, 100%, and an expanded view that returns the same picture and focus',async()=>{
  const env=environment(),id=randomUUID(),entryId=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entry:{id:entryId,board_id:id,kind:'drawing',title:'Sketch',drawing_caption:'A cat on a roof',tags:[],created_at:new Date().toISOString(),width:1600,height:1200,image_mime:'image/png',image_bytes:10}});
    dispose=mountBoard({...boardOptions(env,id),view:'feed',mode:undefined,entryId});
    await until(()=>!!env.root.querySelector('.entry-full'));
    const image=env.$<HTMLImageElement>('.private-drawing'),frame=env.$('.drawing-frame');
    assert.deepEqual([image.getAttribute('width'),image.getAttribute('height')],['1600','1200']);
    const pressed=(selector:string)=>env.$(selector).getAttribute('aria-pressed');
    assert.deepEqual([pressed('#view-fit'),pressed('#view-actual'),frame.classList.contains('is-actual')],['true','false',false]);
    env.$<HTMLButtonElement>('#view-actual').click();assert.deepEqual([pressed('#view-fit'),pressed('#view-actual'),frame.classList.contains('is-actual')],['false','true',true]);
    env.$<HTMLButtonElement>('#view-fit').click();assert(!frame.classList.contains('is-actual'));

    const expand=env.$<HTMLButtonElement>('#view-expand');expand.click();
    const viewer=env.$('.viewer');
    assert.equal(image.closest('.viewer'),viewer);assert.equal(viewer.getAttribute('role'),'dialog');assert.equal(viewer.getAttribute('aria-modal'),'true');
    assert.equal(viewer.querySelector('.viewer-title')!.textContent,'Sketch');
    assert(env.page.classList.contains('drawing-expanded'));assert(env.$('#back-board').hasAttribute('inert'));assert(env.$('#site-header').hasAttribute('inert'));assert(!viewer.hasAttribute('inert'));
    assert.equal(env.doc.activeElement,viewer.querySelector('.viewer-close'));
    assert.equal(env.$('.zoom-level').textContent,'100%');assert.equal(image.style.width,'1600px');
    env.$<HTMLButtonElement>('[data-zoom=in]').click();assert.equal(env.$('.zoom-level').textContent,'125%');assert.equal(image.style.width,'2000px');

    key(env,env.doc.body,{key:'Escape'});
    assert.equal(env.root.querySelector('.viewer'),null);assert.equal(image.parentElement,frame);assert.equal(image.nextElementSibling,frame.querySelector('.image-error'));
    assert.equal(image.style.width,'');assert(!env.page.classList.contains('drawing-expanded'));
    assert(!env.$('#back-board').hasAttribute('inert'));assert(!env.$('#site-header').hasAttribute('inert'));assert.equal(env.doc.activeElement,expand);

    // Closing with the button works too, and leaving the page while it is open cleans up.
    expand.click();env.$<HTMLButtonElement>('.viewer-close').click();assert.equal(env.root.querySelector('.viewer'),null);
    expand.click();dispose();dispose=()=>{};
    assert(!env.page.classList.contains('drawing-expanded'));assert(!env.$('#site-header').hasAttribute('inert'));
  }finally{dispose();clearDraft(id);env.restore();}
});
