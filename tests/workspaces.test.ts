import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {mountComposeMenu} from '../src/compose-menu.ts';
import {mountBoard} from '../src/board.ts';
import {draftFor,clearDraft} from '../src/drafts.ts';

const ID='11111111-1111-4111-8111-111111111111';
async function until(condition:()=>boolean){for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('UI condition did not settle');}

test('New post opens two real links, labels drafts, and closes on Escape, outside press, hiding, and navigation',()=>{
  const dom=new JSDOM('<!doctype html><div id="box"></div>',{url:'https://board.example'});
  const doc=dom.window.document,box=doc.querySelector<HTMLElement>('#box')!;
  const paths:string[]=[];let drafts={writing:false,drawing:false};
  const dispose=mountComposeMenu({container:box,boardId:ID,navigate:path=>{paths.push(path);},drafts:()=>drafts});
  const toggle=box.querySelector<HTMLButtonElement>('#compose-toggle')!,menu=box.querySelector<HTMLElement>('#compose-menu')!;
  const write=box.querySelector<HTMLAnchorElement>('#go-write')!,draw=box.querySelector<HTMLAnchorElement>('#go-draw')!;
  // jsdom would try to follow a link the component let through; record what the component did, then stop it.
  const prevented:boolean[]=[];
  for(const link of [write,draw])link.addEventListener('click',event=>{prevented.push(event.defaultPrevented);event.preventDefault();});

  assert(menu.hidden);assert.equal(toggle.getAttribute('aria-label'),'New post');assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(toggle.getAttribute('aria-controls'),'compose-menu');
  assert.equal(write.getAttribute('href'),`/b/${ID}/new?mode=write`);assert.equal(draw.getAttribute('href'),`/b/${ID}/new?mode=draw`);
  assert.equal(write.textContent,'Write a note');assert.equal(draw.textContent,'Draw');
  assert(box.classList.contains('with-compose'));assert(doc.body.classList.contains('has-compose'));

  drafts={writing:true,drawing:true};toggle.click();
  assert(!menu.hidden);assert.equal(toggle.getAttribute('aria-expanded'),'true');assert(doc.body.classList.contains('compose-open'));
  assert.equal(write.textContent,'Continue note');assert.equal(draw.textContent,'Continue drawing');

  toggle.focus();doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'}));
  assert(menu.hidden);assert.equal(doc.activeElement,toggle);assert(!doc.body.classList.contains('compose-open'));

  toggle.click();doc.body.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true}));assert(menu.hidden);
  toggle.click();toggle.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true}));assert(!menu.hidden);

  draw.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true,button:0,ctrlKey:true}));
  assert.deepEqual(prevented,[false]);assert.deepEqual(paths,[]);assert(!menu.hidden);
  draw.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
  assert.deepEqual(prevented,[false,true]);assert.deepEqual(paths,[`/b/${ID}/new?mode=draw`]);assert(menu.hidden);

  toggle.click();Object.defineProperty(doc,'hidden',{value:true,configurable:true});doc.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert(menu.hidden);

  dispose();
  assert.equal(box.querySelector('.compose-fab'),null);assert(!box.classList.contains('with-compose'));assert(!doc.body.classList.contains('has-compose'));
  dom.window.close();
});

test('the composer opens in the mode from the URL, reports only the user\'s own switches, and otherwise keeps the last mode',async()=>{
  const dom=new JSDOM('<!doctype html><div id="board"></div>',{url:'https://board.example',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,navigator:dom.window.navigator,Event:dom.window.Event,DOMException:dom.window.DOMException,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const context={fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',fillRect(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){}};
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'getContext',{value:()=>context});
  const oldFetch=globalThis.fetch,id=randomUUID(),changes:string[]=[];let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    const root=dom.window.document.querySelector<HTMLElement>('#board')!;
    const options={container:root,view:'compose' as const,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:()=>{},expired:()=>{},toast:()=>{},modeChanged:(mode:string)=>{changes.push(mode);}};
    const selected=(tab:string)=>root.querySelector(`#mode-${tab}`)!.getAttribute('aria-selected')==='true';
    assert.equal(root.querySelector('.compose-fab'),null);

    dispose=mountBoard({...options,mode:'draw'});await until(()=>!!root.querySelector('#post-drawing'));
    assert(selected('draw'));assert(!selected('write'));assert(root.querySelector<HTMLElement>('#write-composer')!.hidden);
    assert.equal(draftFor(id).mode,'draw');assert.deepEqual(changes,[]);

    root.querySelector<HTMLButtonElement>('#mode-write')!.click();
    assert(selected('write'));assert.deepEqual(changes,['write']);

    dispose();dispose=mountBoard({...options,signal:new AbortController().signal});
    assert(selected('write'));assert.deepEqual(changes,['write']);

    dispose();dispose=mountBoard({...options,mode:'draw',signal:new AbortController().signal});await until(()=>!!root.querySelector('#post-drawing'));
    assert(selected('draw'));assert.equal(draftFor(id).mode,'draw');assert.deepEqual(changes,['write']);
  }finally{
    dispose();clearDraft(id);globalThis.fetch=oldFetch;
    for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
    dom.window.close();
  }
});
