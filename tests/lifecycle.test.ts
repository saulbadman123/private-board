import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {ApiError} from '../src/api.ts';
import type {BoardResponse} from '../src/api.ts';
import {createBoardSession,createConcealer,CHECK_FAILED_MESSAGE,EXPIRED_MESSAGE} from '../src/board-session.ts';
import {mountBoard} from '../src/board.ts';
import {draftFor,clearDraft} from '../src/drafts.ts';

const ID='11111111-1111-4111-8111-111111111111';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function setup(options?:{maxHiddenMs?:number}){
  let clock=1_000_000;
  const log:string[]=[];
  const checks:{resolve:(response:BoardResponse)=>void;reject:(error:unknown)=>void;signal:AbortSignal}[]=[];
  const response=(over:{id?:string;expiresIn?:number}={}):BoardResponse=>({board:{id:over.id??ID,title:'Test',created_at:'2026-10-22T00:00:00.000Z'},expiresAt:new Date(clock+(over.expiresIn??3_600_000)).toISOString()});
  const session=createBoardSession({
    check:(_id,signal)=>new Promise<BoardResponse>((resolve,reject)=>{log.push('check');checks.push({resolve,reject,signal});}),
    conceal:()=>{log.push('conceal');},reveal:()=>{log.push('reveal');},failed:message=>{log.push(`failed:${message}`);},
    gate:(_id,message)=>{log.push(`gate:${message}`);},remount:()=>{log.push('remount');},now:()=>clock
  },options);
  return {session,log,checks,response,advance(ms:number){clock+=ms;}};
}

test('hiding conceals in place and a healthy return rechecks once without remounting',async()=>{
  const t=setup();t.session.show(ID,t.response().expiresAt);
  t.session.hidden();t.session.hidden();t.session.resumed();t.session.resumed();
  assert.deepEqual(t.log,['conceal','check']);
  t.checks[0].resolve(t.response());await settle();
  assert.deepEqual(t.log,['conceal','check','reveal']);assert.equal(t.session.state(),'visible');
});

test('a revoked grant keeps content concealed and opens the gate; failures never look like a wrong password',async()=>{
  const denied=setup();denied.session.show(ID,denied.response().expiresAt);denied.session.hidden();denied.session.resumed();
  denied.checks[0].reject(new ApiError('Locked',401,'LOCKED'));await settle();
  assert.deepEqual(denied.log,['conceal','check','gate:']);assert.equal(denied.session.state(),'idle');

  const offline=setup();offline.session.show(ID,offline.response().expiresAt);offline.session.retry();
  offline.session.hidden();offline.session.resumed();
  offline.checks[0].reject(new ApiError('Could not connect.',0,'NETWORK'));await settle();
  assert.deepEqual(offline.log,['conceal','check',`failed:${CHECK_FAILED_MESSAGE}`]);assert.equal(offline.session.state(),'failed');
  offline.session.retry();assert.equal(offline.checks.length,2);
  offline.checks[1].resolve(offline.response());await settle();
  assert.deepEqual(offline.log.slice(3),['check','reveal']);

  const broken=setup();broken.session.show(ID,broken.response().expiresAt);broken.session.hidden();broken.session.resumed();
  broken.checks[0].reject(new Error('boom'));await settle();
  assert.equal(broken.session.state(),'failed');assert(!broken.log.some(entry=>entry.startsWith('gate')));
});

test('expiry is compared with the clock on return; a long absence rebuilds instead of restoring',()=>{
  const expired=setup();expired.session.show(ID,expired.response({expiresIn:1000}).expiresAt);expired.session.hidden();
  expired.advance(2000);expired.session.resumed();
  assert.deepEqual(expired.log,['conceal',`gate:${EXPIRED_MESSAGE}`]);

  const long=setup({maxHiddenMs:1000});long.session.show(ID,long.response().expiresAt);long.session.hidden();
  long.advance(5000);long.session.resumed();
  assert.deepEqual(long.log,['conceal','remount']);assert.equal(long.session.state(),'idle');
});

test('rapid hide and show, navigation during a check, and the wrong board cannot reveal stale content',async()=>{
  const rapid=setup();rapid.session.show(ID,rapid.response().expiresAt);
  rapid.session.hidden();rapid.session.resumed();rapid.session.hidden();
  assert(rapid.checks[0].signal.aborted);
  rapid.session.resumed();assert.equal(rapid.checks.length,2);
  rapid.checks[0].resolve(rapid.response());await settle();
  assert(!rapid.log.includes('reveal'));
  rapid.checks[1].resolve(rapid.response());await settle();
  assert.equal(rapid.log.filter(entry=>entry==='reveal').length,1);

  const navigated=setup();navigated.session.show(ID,navigated.response().expiresAt);navigated.session.hidden();navigated.session.resumed();
  navigated.session.stop();navigated.checks[0].resolve(navigated.response());await settle();
  assert.deepEqual(navigated.log,['conceal','check']);assert.equal(navigated.session.state(),'idle');

  const other=setup();other.session.show(ID,other.response().expiresAt);other.session.hidden();other.session.resumed();
  other.checks[0].resolve(other.response({id:'22222222-2222-4222-8222-222222222222'}));await settle();
  assert.equal(other.session.state(),'failed');assert(!other.log.includes('reveal'));

  const late=setup();late.session.show(ID,late.response().expiresAt);late.session.hidden();late.session.resumed();
  late.checks[0].resolve(late.response({expiresIn:-1}));await settle();
  assert.deepEqual(late.log,['conceal','check',`gate:${EXPIRED_MESSAGE}`]);
});

test('a board shown while the tab is already hidden starts concealed',()=>{
  const t=setup();t.session.show(ID,t.response().expiresAt,false);
  assert.deepEqual(t.log,['conceal']);t.session.resumed();assert.deepEqual(t.log,['conceal','check']);
});

test('deferred actions wait for a reveal or unlock of the same board and are discardable',async()=>{
  const ran:string[]=[];
  const t=setup();t.session.show(ID,t.response().expiresAt);
  t.session.defer(ID,()=>ran.push('visible'));assert.deepEqual(ran,['visible']);

  t.session.hidden();t.session.defer(ID,()=>ran.push('after reveal'));assert.deepEqual(ran,['visible']);
  t.session.resumed();t.checks[0].resolve(t.response());await settle();
  assert.deepEqual(ran,['visible','after reveal']);

  t.session.hidden();t.session.defer(ID,()=>ran.push('revoked'));t.session.resumed();
  t.checks[1].reject(new ApiError('Locked',401,'LOCKED'));await settle();
  assert.equal(ran.length,2);
  t.session.show(ID,t.response().expiresAt);assert.deepEqual(ran,['visible','after reveal','revoked']);

  t.session.hidden();t.session.defer(ID,()=>ran.push('discarded'));t.session.discardDeferred();
  t.session.resumed();t.checks[2].resolve(t.response());await settle();
  t.session.defer('22222222-2222-4222-8222-222222222222',()=>ran.push('elsewhere'));
  t.session.show(ID,t.response().expiresAt);
  assert.equal(ran.length,3);
});

test('concealing keeps the same mounted nodes, text, selection, and focus, then reveals in place',()=>{
  const dom=new JSDOM('<!doctype html><div id="app"><header>public</header><main id="main"><textarea id="note"></textarea></main><footer>public</footer></div>');
  const doc=dom.window.document,root=doc.querySelector<HTMLElement>('#app')!,main=root.querySelector<HTMLElement>('#main')!;
  const area=root.querySelector<HTMLTextAreaElement>('#note')!;
  area.value='half-typed draft';area.focus();area.setSelectionRange(2,6);
  const concealer=createConcealer(root);
  concealer.conceal();concealer.conceal();
  assert(main.classList.contains('concealed'));assert(main.hasAttribute('inert'));
  assert.equal(root.querySelector('#main'),main);assert.equal(area.value,'half-typed draft');
  assert.equal(root.querySelectorAll('.resume-cover').length,1);assert.equal(root.querySelector('.resume-cover')!.textContent,'Checking access…');

  let retries=0;concealer.failed('Could not check access.',()=>{retries++;});
  const cover=root.querySelector('.resume-cover')!;
  assert.match(cover.textContent!,/Could not check access\./);
  cover.querySelector<HTMLButtonElement>('button')!.click();
  assert.equal(retries,1);assert.equal(cover.textContent,'Checking access…');

  area.blur();assert.notEqual(doc.activeElement,area);concealer.reveal();
  assert(!main.classList.contains('concealed'));assert(!main.hasAttribute('inert'));assert.equal(root.querySelector('.resume-cover'),null);
  assert.equal(doc.activeElement,area);assert.deepEqual([area.selectionStart,area.selectionEnd],[2,6]);

  root.replaceChildren();concealer.reset();assert.doesNotThrow(()=>concealer.reveal());
  dom.window.close();
});

test('a post confirmed while hidden does not navigate until the board is shown again',async()=>{
  const dom=new JSDOM('<!doctype html><div id="board"></div>',{url:'https://board.example',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,navigator:dom.window.navigator,Event:dom.window.Event,DOMException:dom.window.DOMException,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const oldFetch=globalThis.fetch,id=randomUUID(),entryId=randomUUID();
  const paths:string[]=[],toasts:string[]=[],waiting:(()=>void)[]=[];let dispose=()=>{};
  try{
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){const payload=JSON.parse(String(init.body));return Response.json({entry:{id:entryId,board_id:id,kind:'note',title:null,markdown:payload.markdown,tags:[],created_at:new Date().toISOString()},replayed:false},{status:201});}
      return Response.json({entries:[],nextCursor:null});
    };
    const root=dom.window.document.querySelector<HTMLElement>('#board')!;
    dispose=mountBoard({container:root,view:'compose',response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:path=>{paths.push(path);},expired:()=>{throw new Error('Unexpected expiry');},toast:message=>{toasts.push(message);},whenVisible:action=>{waiting.push(action);}});
    const textarea=root.querySelector<HTMLTextAreaElement>('#note-body')!;
    textarea.value='Written, then the tab was hidden.';textarea.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
    root.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    for(let i=0;i<100&&!waiting.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(waiting.length,1);
    assert.deepEqual(paths,[]);assert.deepEqual(toasts,[]);
    assert.equal(draftFor(id).markdown,'');assert.equal(draftFor(id).attempt,null);
    waiting[0]();
    assert.deepEqual(paths,[`/b/${id}`]);assert.equal(toasts.length,1);
  }finally{
    dispose();clearDraft(id);globalThis.fetch=oldFetch;
    for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
    dom.window.close();
  }
});
