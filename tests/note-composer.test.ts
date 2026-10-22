import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {mountBoard} from '../src/board.ts';
import {clearDraft,draftFor,hasDraftsFor} from '../src/drafts.ts';
import {characterCount,MAX_NOTE_CHARACTERS,measureNote} from '../shared/note-limits.ts';

async function until(condition:()=>boolean){for(let i=0;i<150;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('UI condition did not settle');}
function environment(){
  const dom=new JSDOM('<!doctype html><div id="app"><main id="main" data-view="compose"><div id="board"></div></main></div><div id="toast"></div>',{url:'https://board.example',pretendToBeVisual:true});
  const saved=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,location:dom.window.location,navigator:dom.window.navigator,Event:dom.window.Event,DOMException:dom.window.DOMException,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const copied:string[]=[];let clipboardWorks=true,answer=true;const confirms:string[]=[];
  Object.defineProperty(dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{if(!clipboardWorks)throw new Error('denied');copied.push(text);}}});
  dom.window.confirm=(message?:string)=>{confirms.push(String(message));return answer;};
  const oldFetch=globalThis.fetch,doc=dom.window.document;
  return {
    dom,doc,root:doc.querySelector<HTMLElement>('#board')!,copied,confirms,
    clipboard(works:boolean){clipboardWorks=works;},answer(value:boolean){answer=value;},
    $:<T extends Element=HTMLElement>(selector:string)=>doc.querySelector<T>(selector)!,
    restore(){globalThis.fetch=oldFetch;for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();}
  };
}
type Env=ReturnType<typeof environment>;
const paragraph=(i:number)=>`Paragraph ${i} starts here. It has a second sentence, and a third one follows it. `.repeat(3).trim();
function longText(minimum=MAX_NOTE_CHARACTERS+3000){const parts:string[]=[];let text='';for(let i=0;text.length<minimum;i++){parts.push(paragraph(i));text=parts.join('\n\n');}return text;}
const grouped=(n:number)=>n.toLocaleString();
function setup(env:Env,id:string,over:object={}){
  const toasts:string[]=[],paths:string[]=[];
  const options={container:env.root,view:'compose' as const,mode:'write' as const,response:{board:{id,title:'Test',created_at:new Date().toISOString()},expiresAt:new Date(Date.now()+60000).toISOString()},signal:new AbortController().signal,navigate:(path:string)=>{paths.push(path);},expired:()=>{throw new Error('Unexpected expiry');},toast:(message:string)=>{toasts.push(message);},...over};
  return {toasts,paths,options};
}
const type=(env:Env,value:string,selector='#note-body')=>{const field=env.$<HTMLTextAreaElement|HTMLInputElement>(selector);field.value=value;field.dispatchEvent(new env.dom.window.Event('input',{bubbles:true}));};
const click=(env:Env,selector:string)=>env.$<HTMLButtonElement>(selector).click();
const visible=(env:Env,selector:string)=>env.$(selector).closest('[hidden]')===null;
const submit=(env:Env)=>env.$('#note-form').dispatchEvent(new env.dom.window.Event('submit',{bubbles:true,cancelable:true}));

test('a note over the limit stays intact, shows its excess in both tabs, blocks posting, and announces only the crossing',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    dispose=mountBoard(setup(env,id).options);
    const text=longText(),size=measureNote(text),textarea=env.$<HTMLTextAreaElement>('#note-body');
    assert(!textarea.hasAttribute('maxlength'),'pasted text is never silently truncated');
    type(env,'a short start');assert.equal(env.$('#note-live').textContent,'');
    env.$('#note-live').textContent='x';type(env,text);
    assert.equal(textarea.value,text);assert.equal(draftFor(id).markdown,text);
    assert.equal(env.$('#note-count').textContent,`${grouped(size.characters)} / ${grouped(MAX_NOTE_CHARACTERS)} characters — ${grouped(size.overCharacters)} over the limit.`);
    assert(env.$('#note-count').classList.contains('over'));assert.equal(textarea.getAttribute('aria-invalid'),'true');
    assert(env.$<HTMLButtonElement>('#post-note').disabled);assert.match(env.$('#form-hint').textContent!,/Bring the note down/);assert(visible(env,'#form-hint'));
    assert(visible(env,'#over-actions'));
    assert.match(env.$('#note-live').textContent!,new RegExp(`${grouped(size.overCharacters)} characters over the limit`));
    // The status lives outside both tab panels, so it is there in Preview too.
    assert(!env.$('#write-panel').contains(env.$('#note-status')));assert(!env.$('#preview-panel').contains(env.$('#note-status')));
    click(env,'#preview-tab');assert(visible(env,'#note-status'));assert.match(env.$('#note-count').textContent!,/over the limit/);click(env,'#write-tab');
    // Still over: more typing does not re-announce.
    env.$('#note-live').textContent='unchanged';type(env,text+' more');assert.equal(env.$('#note-live').textContent,'unchanged');
    // Back under the limit: announced once, post enabled, no over actions.
    type(env,'short again');assert.equal(env.$('#note-live').textContent,'The note is within the limit.');
    assert(!env.$<HTMLButtonElement>('#post-note').disabled);assert(!visible(env,'#over-actions'));assert.equal(textarea.hasAttribute('aria-invalid'),false);
    // The limit itself is fine; one more character is not.
    type(env,'a'.repeat(MAX_NOTE_CHARACTERS));assert(!env.$<HTMLButtonElement>('#post-note').disabled);
    type(env,'a'.repeat(MAX_NOTE_CHARACTERS+1));assert(env.$<HTMLButtonElement>('#post-note').disabled);assert.match(env.$('#note-count').textContent!,/1 over the limit/);
    // Submitting while invalid sends nothing.
    let posted=false;globalThis.fetch=async()=>{posted=true;return Response.json({});};submit(env);assert(!posted);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('Review split shows both parts without changing the draft, steps between cuts, and copies only the remainder',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    const ctx=setup(env,id);dispose=mountBoard(ctx.options);
    const text=longText();type(env,text);
    click(env,'#review-split');
    assert(visible(env,'#split-review'));assert.equal(env.doc.activeElement,env.$('#split-title'));
    const first=()=>env.$<HTMLTextAreaElement>('#split-first').value,rest=()=>env.$<HTMLTextAreaElement>('#split-rest').value;
    const consistent=()=>{assert(text.startsWith(first()));assert(text.endsWith(rest()));assert.equal(text.slice(first().length,text.length-rest().length).trim(),'','only blank lines separate the parts');};
    consistent();assert(characterCount(first())<=MAX_NOTE_CHARACTERS);
    assert.match(env.$('#split-summary').textContent!,new RegExp(`first part is ${grouped(characterCount(first()))} characters and the remaining text is ${grouped(characterCount(rest()))}`));
    assert.match(env.$('#split-summary').textContent!,/paragraph break/);assert.equal(env.$('#split-warning').hidden,true);
    // The draft is untouched by looking.
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,text);assert.equal(draftFor(id).remainder,'');assert.equal(draftFor(id).split,null);

    const length=characterCount(first());
    assert(!env.$<HTMLButtonElement>('#split-earlier').disabled);click(env,'#split-earlier');consistent();assert(characterCount(first())<length);
    assert(!env.$<HTMLButtonElement>('#split-later').disabled);click(env,'#split-later');consistent();assert.equal(characterCount(first()),length);
    // Later keeps moving to larger first parts (a sentence or line inside the next paragraph) until the limit stops it.
    let steps=0;while(!env.$<HTMLButtonElement>('#split-later').disabled&&steps<50){const before=characterCount(first());click(env,'#split-later');consistent();assert(characterCount(first())>before);assert(characterCount(first())<=MAX_NOTE_CHARACTERS);steps++;}
    assert(env.$<HTMLButtonElement>('#split-later').disabled,'stopped at the latest cut that fits');assert(steps<50);
    while(!env.$<HTMLButtonElement>('#split-earlier').disabled){click(env,'#split-earlier');consistent();}
    assert(characterCount(first())>0&&env.$<HTMLButtonElement>('#split-earlier').disabled);
    // Back to the suggestion for the rest of the test.
    click(env,'#split-close');click(env,'#review-split');

    click(env,'#split-copy');await until(()=>ctx.toasts.includes('Remaining text copied.'));
    assert.deepEqual(env.copied,[rest()]);assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,text);

    // A refused clipboard leaves the remainder selected, ready for Ctrl+C.
    env.clipboard(false);click(env,'#split-copy');await until(()=>ctx.toasts.some(message=>/selected/.test(message)));
    assert.equal(env.doc.activeElement,env.$('#split-rest'));

    click(env,'#split-close');assert(!visible(env,'#split-review'));assert.equal(env.doc.activeElement,env.$('#review-split'));assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,text);
    // Editing the body while a review is open makes it stale, so it closes; the title and tags are not part of the split.
    click(env,'#review-split');assert(visible(env,'#split-review'));
    type(env,'A title','#note-title');type(env,'a, b','#note-tags');assert(visible(env,'#split-review'),'title and tags leave the review open');
    type(env,text+' tail');assert(!visible(env,'#split-review'));

    // The note-level Copy remaining text opens the same review and copies the suggested remainder.
    env.clipboard(true);env.copied.length=0;click(env,'#copy-overflow');await until(()=>env.copied.length===1);
    assert(visible(env,'#split-review'));assert.equal(env.copied[0],rest());
  }finally{dispose();clearDraft(id);env.restore();}
});

test('Use first part keeps one remainder in memory, and Undo split restores the exact source (asking before discarding edits)',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    dispose=mountBoard(setup(env,id).options);
    const text=longText(),draft=draftFor(id);type(env,text);click(env,'#review-split');
    const first=env.$<HTMLTextAreaElement>('#split-first').value,rest=env.$<HTMLTextAreaElement>('#split-rest').value;
    click(env,'#use-first');
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,first);assert.equal(draft.markdown,first);assert.equal(draft.remainder,rest);assert.deepEqual(draft.split,{source:text,first});
    assert(!visible(env,'#split-review'));assert(visible(env,'#remainder-panel'));assert.equal(env.$<HTMLTextAreaElement>('#remainder-text').value,rest);
    assert.match(env.$('#remainder-summary').textContent!,new RegExp(`${grouped(characterCount(rest))} characters wait here`));assert.match(env.$('#remainder-summary').textContent!,/this tab only/);
    assert(!env.$<HTMLButtonElement>('#post-note').disabled);assert.equal(env.doc.activeElement,env.$('#remainder-title'));
    assert.match(env.$('#note-live').textContent!,/Nothing has been posted yet/);assert(visible(env,'#undo-split'));
    assert(hasDraftsFor(id));

    // Editing the first part, then undoing: declining keeps everything; accepting restores the original text.
    type(env,first+' edited');env.answer(false);click(env,'#undo-split');
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,first+' edited');assert.equal(draft.remainder,rest);assert.match(env.confirms.at(-1)!,/Undo the split/);
    env.answer(true);click(env,'#undo-split');
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,text);assert.equal(draft.markdown,text);assert.equal(draft.remainder,'');assert.equal(draft.split,null);assert(!visible(env,'#remainder-panel'));
    assert(env.$<HTMLButtonElement>('#post-note').disabled);

    // Without edits no confirmation is needed.
    click(env,'#review-split');click(env,'#use-first');const asked=env.confirms.length;click(env,'#undo-split');assert.equal(env.confirms.length,asked);assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,text);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('posting the first part keeps the remainder, never posts it automatically, and continues as a fresh submission',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};const posts:{requestId:string;markdown:string;title:string|null;tags:string[]}[]=[],entryIds=[randomUUID(),randomUUID()];
  try{
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){const payload=JSON.parse(String(init.body));posts.push(payload);return Response.json({entry:{id:entryIds[posts.length-1],board_id:id,kind:'note',title:payload.title,markdown:payload.markdown,tags:payload.tags,created_at:new Date().toISOString()},replayed:false},{status:201});}
      return Response.json({entries:[],nextCursor:null});
    };
    const ctx=setup(env,id);dispose=mountBoard(ctx.options);
    const text=longText(),draft=draftFor(id);
    type(env,'Long note','#note-title');type(env,'idea, long','#note-tags');type(env,text);
    click(env,'#review-split');click(env,'#use-first');
    const rest=draft.remainder;
    submit(env);await until(()=>posts.length===1&&!draft.pending);
    assert.equal(posts[0].markdown,draft.split===null?posts[0].markdown:'');assert(text.startsWith(posts[0].markdown));assert(characterCount(posts[0].markdown)<=MAX_NOTE_CHARACTERS);
    // It stays on the composer: no navigation, the editor is empty, and the rest is waiting with a link to what was saved.
    assert.deepEqual(ctx.paths,[]);assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,'');assert.equal(draft.remainder,rest);assert.equal(draft.split,null);
    assert(visible(env,'#continue-panel'));assert.equal(env.doc.activeElement,env.$('#continue-panel'));
    assert.equal(env.$<HTMLAnchorElement>('#continue-text a').getAttribute('href'),`/b/${id}/e/${entryIds[0]}`);
    assert.match(env.$('#continue-text').textContent!,new RegExp(`${grouped(characterCount(rest))} characters are still waiting`));assert.match(env.$('#continue-text').textContent!,/Nothing is posted until you choose to/);
    assert(ctx.toasts.some(message=>/The rest is waiting/.test(message)));assert(visible(env,'#remainder-panel'));assert(!visible(env,'#undo-split'));
    assert(env.$<HTMLButtonElement>('#post-note').disabled,'nothing to post until the remainder is brought back');
    env.$<HTMLAnchorElement>('#continue-text a').dispatchEvent(new env.dom.window.MouseEvent('click',{bubbles:true,cancelable:true,button:0}));assert.deepEqual(ctx.paths,[`/b/${id}/e/${entryIds[0]}`]);ctx.paths.length=0;

    // Continue: the remainder becomes the draft, with the title and tags offered as editable defaults.
    click(env,'#continue-remainder');
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,rest);assert.equal(env.$<HTMLInputElement>('#note-title').value,'Long note');assert.equal(env.$<HTMLInputElement>('#note-tags').value,'idea, long');
    assert.equal(draft.remainder,'');assert(!visible(env,'#continue-panel'));assert(!visible(env,'#remainder-panel'));assert.equal(env.doc.activeElement,env.$('#note-body'));
    assert.equal(posts.length,1,'continuing alone posts nothing');
    submit(env);await until(()=>ctx.paths.length===1);
    assert.equal(posts[1].markdown,rest);assert.notEqual(posts[1].requestId,posts[0].requestId);assert.deepEqual(ctx.paths,[`/b/${id}`]);
    assert(text.startsWith(posts[0].markdown)&&text.endsWith(posts[1].markdown));
    assert.equal(text.slice(posts[0].markdown.length,text.length-posts[1].markdown.length).trim(),'','nothing but blank lines is missing between the two posts');
    assert.equal(hasDraftsFor(id),false);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('a lost or failed submission keeps the first part exactly and the entire remainder, and does not advance',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{},attempts=0;const posts:{requestId:string;markdown:string}[]=[];
  try{
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){
        const payload=JSON.parse(String(init.body));posts.push(payload);attempts++;
        if(attempts===1)throw new Error('Connection interrupted after server commit');
        return Response.json({entry:{id:randomUUID(),board_id:id,kind:'note',title:null,markdown:payload.markdown,tags:[],created_at:new Date().toISOString()},replayed:true});
      }
      return Response.json({entries:[],nextCursor:null});
    };
    const ctx=setup(env,id);dispose=mountBoard(ctx.options);
    const text=longText(),draft=draftFor(id);type(env,text);click(env,'#review-split');click(env,'#use-first');const rest=draft.remainder;
    submit(env);await until(()=>!!draft.attempt&&!draft.pending);
    assert(env.$<HTMLTextAreaElement>('#note-body').readOnly);assert.equal(draft.remainder,rest);assert(visible(env,'#remainder-panel'));
    assert(!visible(env,'#undo-split'),'a possibly-published first part cannot be un-split');assert(env.$<HTMLButtonElement>('#discard-draft').disabled);
    assert.match(env.$('#post-note').textContent!,/Retry/);assert(!draft.undoSplit());assert(!draft.continueWithRemainder());assert.equal(ctx.paths.length,0);
    // The remainder also survives leaving and returning to the composer.
    dispose();dispose=mountBoard({...ctx.options,signal:new AbortController().signal});
    assert.equal(env.$<HTMLTextAreaElement>('#remainder-text').value,rest);assert(env.$<HTMLTextAreaElement>('#note-body').readOnly);
    submit(env);await until(()=>!draft.attempt&&!draft.pending);
    assert.equal(posts[1].requestId,posts[0].requestId);assert.equal(posts[1].markdown,posts[0].markdown);
    assert(visible(env,'#continue-panel'));assert.equal(draft.remainder,rest);assert.equal(ctx.paths.length,0);
    assert(ctx.toasts.some(message=>/already saved/.test(message)));
  }finally{dispose();clearDraft(id);env.restore();}
});

test('remaining text is never silently replaced: a second split is refused, Continue asks before replacing, Lock clears it',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    const draft=draftFor(id);draft.remainder='Text from an earlier split that is still waiting.';
    const ctx=setup(env,id);dispose=mountBoard(ctx.options);
    assert(visible(env,'#remainder-panel'));assert(draft.hasContent());assert(hasDraftsFor(id));
    type(env,longText());click(env,'#review-split');
    assert(env.$<HTMLButtonElement>('#use-first').disabled);assert(visible(env,'#split-note'));assert.match(env.$('#split-note').textContent!,/already waiting/);
    assert(!draft.useFirstPart('a','b','c'));assert.equal(draft.remainder,'Text from an earlier split that is still waiting.');
    assert(!env.$<HTMLButtonElement>('#split-copy').disabled,'copying is still possible');
    click(env,'#split-close');type(env,'');

    // Something typed meanwhile: Continue asks before replacing it, and declining changes nothing.
    draft.continuation={entryId:randomUUID(),title:'',tags:''};dispose();dispose=mountBoard({...ctx.options,signal:new AbortController().signal});
    type(env,'A different note I started.');env.answer(false);click(env,'#continue-remainder');
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,'A different note I started.');assert.equal(draft.remainder,'Text from an earlier split that is still waiting.');assert.match(env.confirms.at(-1)!,/Replace what is in the editor/);
    env.answer(true);click(env,'#continue-remainder');assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,'Text from an earlier split that is still waiting.');assert.equal(draft.remainder,'');

    // Lock (clearDraft) forgets it all.
    draft.remainder='More waiting text.';clearDraft(id);assert.equal(hasDraftsFor(id),false);assert.equal(draftFor(id).remainder,'');
  }finally{dispose();clearDraft(id);env.restore();}
});

test('draft feedback says where the text lives; Copy draft and Discard draft are explicit',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    const ctx=setup(env,id);dispose=mountBoard(ctx.options);const draft=draftFor(id);
    assert.equal(env.$('#draft-state').textContent,'');assert(!visible(env,'#copy-draft'));assert(!visible(env,'#discard-draft'));
    type(env,'A draft in progress');
    assert.match(env.$('#draft-state').textContent!,/Draft kept in this tab only\. It is not saved or synced\./);assert(visible(env,'#copy-draft'));assert(visible(env,'#discard-draft'));
    click(env,'#copy-draft');await until(()=>ctx.toasts.includes('Draft copied.'));assert.deepEqual(env.copied,['A draft in progress']);
    env.clipboard(false);click(env,'#copy-draft');await until(()=>ctx.toasts.some(message=>/selected/.test(message)));assert.equal(env.doc.activeElement,env.$('#note-body'));
    draft.remainder='kept text';type(env,'A draft in progress');
    env.answer(false);click(env,'#discard-draft');assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,'A draft in progress');assert.match(env.confirms.at(-1)!,/remaining text/);assert.equal(draft.remainder,'kept text');
    env.answer(true);click(env,'#discard-draft');
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,'');assert.equal(draft.hasContent(),false);assert.equal(env.$('#draft-state').textContent,'');assert(!visible(env,'#remainder-panel'));
  }finally{dispose();clearDraft(id);env.restore();}
});

test('title and tag problems are explained next to the field and block posting without a server round trip',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{},posts=0;
  try{
    globalThis.fetch=async(_url,init)=>{if(init?.method==='POST')posts++;return Response.json({entries:[],nextCursor:null});};
    dispose=mountBoard(setup(env,id).options);
    type(env,'A fine body');assert(!env.$<HTMLButtonElement>('#post-note').disabled);
    type(env,'x'.repeat(121),'#note-title');
    assert(visible(env,'#title-error'));assert.match(env.$('#title-error').textContent!,/up to 120 characters \(it is 121\)/);assert.equal(env.$('#note-title').getAttribute('aria-invalid'),'true');
    assert(env.$<HTMLDetailsElement>('#note-details').open);assert(env.$<HTMLButtonElement>('#post-note').disabled);assert.match(env.$('#form-hint').textContent!,/Fix the title or tags/);
    assert.match(env.$('#note-title').getAttribute('aria-describedby')!,/title-error/);
    submit(env);assert.equal(posts,0);
    type(env,'A good title','#note-title');assert(!visible(env,'#title-error'));assert.equal(env.$('#note-title').hasAttribute('aria-invalid'),false);
    type(env,'a, b, c, d, e, f','#note-tags');assert.match(env.$('#tags-error').textContent!,/up to 5 tags \(there are 6\)/);assert(env.$<HTMLButtonElement>('#post-note').disabled);
    type(env,'a, b, c','#note-tags');assert(!visible(env,'#tags-error'));assert(!env.$<HTMLButtonElement>('#post-note').disabled);
    // A title longer than before is still typed in full: nothing is truncated on the way in.
    assert.equal(env.$('#note-title').hasAttribute('maxlength'),false);
  }finally{dispose();clearDraft(id);env.restore();}
});

test('over the limit only by trailing whitespace, the offer is to remove it, not to split',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    dispose=mountBoard(setup(env,id).options);
    const body='a'.repeat(MAX_NOTE_CHARACTERS);type(env,body+'   \n\n');
    assert(env.$<HTMLButtonElement>('#post-note').disabled);click(env,'#review-split');
    assert.equal(env.$('#use-first').textContent,'Remove trailing whitespace');assert.match(env.$('#split-summary').textContent!,/Only trailing spaces or blank lines/);assert(!visible(env,'#split-earlier'));
    click(env,'#use-first');
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,body);assert.equal(draftFor(id).remainder,'');assert(!env.$<HTMLButtonElement>('#post-note').disabled);assert(!visible(env,'#split-review'));
  }finally{dispose();clearDraft(id);env.restore();}
});

test('a cut that runs through a code block is flagged for the reader to adjust, not silently repaired',async()=>{
  const env=environment(),id=randomUUID();let dispose=()=>{};
  try{
    globalThis.fetch=async()=>Response.json({entries:[],nextCursor:null});
    dispose=mountBoard(setup(env,id).options);
    const text='Short intro.\n\n```\n'+'a line of code here\n'.repeat(1500)+'```\n\nOutro.';
    assert(characterCount(text)>MAX_NOTE_CHARACTERS);type(env,text);click(env,'#review-split');
    assert(visible(env,'#split-warning'));assert.match(env.$('#split-warning').textContent!,/inside a code block, table, link, or code span/);
    // The unfenced first part is posted as it is: no closing fence is added behind the reader's back.
    assert(!env.$<HTMLTextAreaElement>('#split-first').value.trimEnd().endsWith('```'));
    assert.equal(env.$<HTMLTextAreaElement>('#note-body').value,text);
  }finally{dispose();clearDraft(id);env.restore();}
});
