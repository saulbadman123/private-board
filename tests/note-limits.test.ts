import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {byteLength,characterCount,isWellFormed,MAX_NOTE_BYTES,MAX_NOTE_CHARACTERS,measureNote,parseTagField,titleProblem} from '../shared/note-limits.ts';
import {NoteInputError,prepareNote} from '../server/notes.ts';

// A small deterministic generator, so a failure can be reproduced.
function random(seed:number){let state=seed;return()=>{state=(state*1664525+1013904223)>>>0;return state/2**32;};}
const alphabet=['a','Z',' ','\n','\r\n','é','é','😀','👨‍👩‍👧‍👦','\ud83d','\ude00','\u0000','日本',' ','\t','‏'];
function sample(next:()=>number,length:number){let text='';for(let i=0;i<length;i++)text+=alphabet[Math.floor(next()*alphabet.length)];return text;}

test('client counts match the server counts exactly, including lone surrogates and emoji sequences',()=>{
  const next=random(7);
  const fixed=['','a','😀','\ud83d','\ude00','\ud83d😀','é','👨‍👩‍👧‍👦','a\r\nb','\u0000x','日本語','x'.repeat(1000)];
  for(const text of [...fixed,...Array.from({length:400},()=>sample(next,1+Math.floor(next()*60)))]){
    assert.equal(characterCount(text),[...text].length,JSON.stringify(text));
    assert.equal(byteLength(text),Buffer.byteLength(text),JSON.stringify(text));
    // Node's built-in check (not yet in TypeScript's library typings) is the reference.
    assert.equal(isWellFormed(text),(text as unknown as {isWellFormed():boolean}).isWellFormed(),JSON.stringify(text));
  }
});

test('the note limit is 20,000 code points; the byte cap is a backstop that valid text can never reach',()=>{
  const size=(text:string)=>measureNote(text);
  assert.deepEqual([size('a'.repeat(19999)).ok,size('a'.repeat(20000)).ok,size('a'.repeat(20001)).ok],[true,true,false]);
  assert.equal(size('a'.repeat(20001)).overCharacters,1);assert.equal(size('a'.repeat(23420)).overCharacters,3420);
  // An emoji is one character, however many bytes it takes: 20,000 of them is exactly 80,000 bytes.
  assert(size('😀'.repeat(20000)).ok);assert.equal(size('😀'.repeat(20000)).bytes,80000);assert(80000<=MAX_NOTE_BYTES);
  assert.equal(size('😀'.repeat(20001)).overCharacters,1);
  assert.equal(size('a\ud83d').wellFormed,false);assert.equal(size('a\ud83d').ok,false);assert.equal(size('a\u0000').ok,false);
  assert.equal(MAX_NOTE_CHARACTERS,20000);
});

test('the browser and the server accept and reject the same notes, titles, and tags',()=>{
  const base={kind:'note',requestId:randomUUID(),markdown:'Body',title:null as string|null,tags:[] as string[]};
  const serverAccepts=(over:object)=>{try{prepareNote({...base,...over});return true;}catch(error){if(error instanceof NoteInputError)return false;throw error;}};
  const markdowns=['a'.repeat(20000),'a'.repeat(20001),'😀'.repeat(20000),'😀'.repeat(20001),'x\ud83d','  ','ok'];
  for(const markdown of markdowns)assert.equal(measureNote(markdown).ok&&markdown.trim()!=='',serverAccepts({markdown}),JSON.stringify(markdown.slice(0,12)));
  const titles=['x'.repeat(120),'x'.repeat(121),'  '+'x'.repeat(120)+'  ','tab\there','😀'.repeat(120),'😀'.repeat(121),''];
  for(const title of titles)assert.equal(titleProblem(title)===null,serverAccepts({title}),JSON.stringify(title.slice(0,12)));
  const tagFields=['a, b, c','a, b, c, d, e','a, b, c, d, e, f','x'.repeat(24),'x'.repeat(25),'İ'.repeat(12),'İ'.repeat(13),'tag\u0007, b','','  ,  , a'];
  for(const field of tagFields){const {tags,problem}=parseTagField(field);assert.equal(problem===null,serverAccepts({tags}),JSON.stringify(field));}
  assert.match(parseTagField('a,b,c,d,e,f').problem!,/up to 5 tags \(there are 6\)/);
  assert.match(parseTagField('x'.repeat(25)).problem!,/up to 24 characters/);
  assert.match(titleProblem('x'.repeat(130))!,/up to 120 characters \(it is 130\)/);
});
