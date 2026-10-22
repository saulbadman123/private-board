import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {mountBoard} from '../src/board.ts';
import {clearDraft,drawingDraftFor} from '../src/drafts.ts';

async function until(condition:()=>boolean){for(let i=0;i<150;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('UI condition did not settle');}
function environment(){
  const dom=new JSDOM('<!doctype html><div id="app"><main id="main" data-view="read"><div id="board"></div></main></div><div id="toast"></div>',{url:'https://board.example',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,navigator:dom.window.navigator,Event:dom.window.Event,DOMException:dom.window.DOMException,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const copied:string[]=[];let clipboardWorks=true;
  Object.defineProperty(dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{if(!clipboardWorks)throw new Error('denied');copied.push(text);}}});
  const context={fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},clearRect(){},drawImage(){},fillRect(){}};
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'getContext',{value:()=>context});
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'toBlob',{value:(callback:(blob:Blob)=>void)=>callback(new Blob([new Uint8Array([1,2,3,4])],{type:'image/png'}))});
  // Downloads go through a temporary link; record it instead of letting jsdom try to navigate.
  const downloads:{name:string;href:string}[]=[],blobs:Blob[]=[];
  const doc=dom.window.document;
  doc.addEventListener('click',event=>{const link=(event.target as Element).closest?.('a[download]') as HTMLAnchorElement|null;if(link){downloads.push({name:link.download,href:link.href});event.preventDefault();}},true);
  const create=URL.createObjectURL;URL.createObjectURL=(blob:Blob)=>{blobs.push(blob);return create(blob);};
  const oldFetch=globalThis.fetch;
  return {
    dom,doc,root:doc.querySelector<HTMLElement>('#board')!,copied,downloads,blobs,clipboard(works:boolean){clipboardWorks=works;},
    $:<T extends Element=HTMLElement>(selector:string)=>doc.querySelector<T>(selector)!,
    restore(){URL.createObjectURL=create;globalThis.fetch=oldFetch;for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();}
  };
}
type Env=ReturnType<typeof environment>;
function reader(env:Env,id:string,entryId:string,over:object={}){
  const toasts:string[]=[],expired:string[]=[];
  const options={container:env.root,view:'feed' as const,entryId,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:(message:string)=>{expired.push(message);},toast:(message:string)=>{toasts.push(message);},...over};
  return {toasts,expired,options};
}

test('Copy Markdown copies the exact source of the authorized note, and shows it selected if the clipboard refuses',async()=>{
  const env=environment(),id=randomUUID(),entryId=randomUUID();let dispose=()=>{};
  // The server stores notes with LF line endings, so the source never contains CR.
  const markdown='# Hello\n\nBody with **bold**, `code`, and 😀.\n\n- one\n- two';
  try{
    globalThis.fetch=async()=>Response.json({entry:{id:entryId,board_id:id,kind:'note',title:'T',markdown,tags:[],created_at:new Date().toISOString()}});
    const ctx=reader(env,id,entryId);dispose=mountBoard(ctx.options);
    await until(()=>!!env.root.querySelector('#copy-markdown'));
    assert.equal(env.root.querySelector('#download-drawing'),null);assert(env.$('#copy-fallback').hidden);
    env.$<HTMLButtonElement>('#copy-markdown').click();await until(()=>ctx.toasts.includes('Markdown copied.'));
    assert.deepEqual(env.copied,[markdown]);assert(env.$('#copy-fallback').hidden);

    env.clipboard(false);env.$<HTMLButtonElement>('#copy-markdown').click();await until(()=>ctx.toasts.some(message=>/selected/.test(message)));
    const field=env.$<HTMLTextAreaElement>('#fallback-text');
    assert(!env.$('#copy-fallback').hidden);assert.equal(field.value,markdown);assert.equal(env.doc.activeElement,field);assert.deepEqual([field.selectionStart,field.selectionEnd],[0,markdown.length]);
    assert.equal(env.copied.length,1);assert(field.readOnly);
  }finally{dispose();env.restore();}
});

test('Download image fetches the stored bytes through the authorized route, names the file by its real type, and handles 401 and network loss',async()=>{
  const env=environment(),id=randomUUID(),entryId=randomUUID();let dispose=()=>{};
  const requests:{url:string;credentials?:string}[]=[];let mode:'ok'|'locked'|'offline'='ok';
  try{
    globalThis.fetch=async(url,init)=>{
      const path=String(url);
      if(path.endsWith('/image')){
        requests.push({url:path,credentials:init?.credentials});
        if(mode==='offline')throw new Error('offline');
        if(mode==='locked')return Response.json({error:{code:'LOCKED',message:'Enter the board password to continue.'}},{status:401});
        return new Response(new Uint8Array([82,73,70,70]),{headers:{'Content-Type':'image/webp'}});
      }
      return Response.json({entry:{id:entryId,board_id:id,kind:'drawing',title:'Sketch',drawing_caption:'A cat',tags:[],created_at:new Date().toISOString(),width:1600,height:1200,image_mime:'image/webp',image_bytes:4}});
    };
    const ctx=reader(env,id,entryId);dispose=mountBoard(ctx.options);
    await until(()=>!!env.root.querySelector('#download-drawing'));
    assert.equal(env.root.querySelector('#copy-markdown'),null);
    const button=env.$<HTMLButtonElement>('#download-drawing');
    button.click();await until(()=>env.downloads.length===1);
    assert.deepEqual(requests,[{url:`/api/boards/${id}/entries/${entryId}/image`,credentials:'same-origin'}]);
    assert.equal(env.downloads[0].name,`drawing-${entryId.slice(0,8)}.webp`);assert.match(env.downloads[0].href,/^blob:/);
    assert.equal(env.blobs.length,1);assert.deepEqual([...new Uint8Array(await env.blobs[0].arrayBuffer())],[82,73,70,70]);
    await until(()=>ctx.toasts.includes('Drawing downloaded.')&&!button.disabled);

    mode='locked';button.click();await until(()=>ctx.expired.length===1);
    assert.equal(env.downloads.length,1);assert.match(ctx.expired[0],/access expired/);await until(()=>!button.disabled);

    mode='offline';button.click();await until(()=>ctx.toasts.some(message=>/Could not connect/.test(message)));
    assert.equal(env.downloads.length,1);await until(()=>!button.disabled);
    // Nothing public: the only URL ever requested is the board route, and no link was created for it.
    assert(requests.every(request=>request.url.startsWith(`/api/boards/${id}/`)));
  }finally{dispose();env.restore();}
});

test('Download PNG saves the current drawing, or exactly the bytes of an unconfirmed attempt, without posting',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{},posts=0;
  try{
    globalThis.fetch=async(_url,init)=>{if(init?.method==='POST')posts++;return Response.json({entries:[],nextCursor:null});};
    const toasts:string[]=[];
    dispose=mountBoard({container:env.root,view:'compose',mode:'draw',response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:()=>{},toast:(message:string)=>{toasts.push(message);}});
    await until(()=>!!env.root.querySelector('#download-draft'));
    env.$<HTMLButtonElement>('#download-draft').click();await until(()=>env.downloads.length===1);
    assert.equal(env.downloads[0].name,'drawing-draft.png');assert.equal(env.blobs[0].size,4);assert.equal(env.blobs[0].type,'image/png');assert(toasts.includes('Drawing saved to your downloads.'));
    // While a post is unconfirmed the frozen attempt is what would be retried, so that is what is saved.
    drawingDraftFor(id).attempt={requestId:randomUUID(),title:null,caption:'',tags:[],blob:new Blob([new Uint8Array([9,9,9])],{type:'image/png'})};
    env.$<HTMLButtonElement>('#download-draft').click();await until(()=>env.downloads.length===2);
    assert.equal(env.blobs[1].size,3);assert.equal(posts,0);
  }finally{dispose();clearDraft(id);env.restore();}
});
