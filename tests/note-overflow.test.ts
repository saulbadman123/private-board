import test from 'node:test';
import assert from 'node:assert/strict';
import {characterCount,MAX_NOTE_CHARACTERS} from '../shared/note-limits.ts';
import {indexAfter,splitAt,startOfNextPost,stepBoundaries,suggestSplit} from '../src/note-overflow.ts';

function random(seed:number){let state=seed;return()=>{state=(state*1664525+1013904223)>>>0;return state/2**32;};}
const pieces=['alpha','beta ','gamma. ','delta!\n','\n\n','é','é ','😀','👨‍👩‍👧‍👦','日本語。','- item\n','```\ncode\n```\n','| a | b |\n|---|---|\n| 1 | 2 |\n','[link text](https://example.com/page) ','`code span` ',' '];
const graphemeStarts=(text:string)=>{const set=new Set<number>();for(const part of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text))set.add(part.index);set.add(text.length);return set;};
// Every split must be lossless, within the limit, non-empty, and never inside a character.
function check(text:string,limit:number){
  const split=suggestSplit(text,limit);
  if(characterCount(text)<=limit){assert.equal(split,null);return null;}
  assert(split);
  assert.equal(split.first+split.rest,text,'first + rest reconstructs the original exactly');
  assert(characterCount(split.first)<=limit,`first part is ${characterCount(split.first)} > ${limit}`);
  assert(split.first.trim().length>0);assert(split.pos>0&&split.pos<text.length);
  assert(!(text.charCodeAt(split.pos)>=0xdc00&&text.charCodeAt(split.pos)<=0xdfff&&text.charCodeAt(split.pos-1)>=0xd800&&text.charCodeAt(split.pos-1)<=0xdbff),'never inside a surrogate pair');
  assert(graphemeStarts(text).has(split.pos),`${split.kind} cut at ${split.pos} is inside a grapheme cluster`);
  return split;
}

test('text that fits is left alone; the cut position counts code points, not UTF-16 units',()=>{
  assert.equal(suggestSplit('short note',100),null);
  assert.equal(suggestSplit('a'.repeat(20000)),null);
  assert.equal(indexAfter('😀😀😀',2),4);assert.equal(indexAfter('abc',10),3);assert.equal(indexAfter('abc',0),0);
  const split=suggestSplit('word '.repeat(5000))!;assert(characterCount(split.first)<=MAX_NOTE_CHARACTERS);assert.equal(split.first+split.rest,'word '.repeat(5000));
});

test('every suggested split is lossless, within the limit, and lands on a character boundary (randomized)',()=>{
  const next=random(2026);
  for(let round=0;round<300;round++){
    let text='';const target=80+Math.floor(next()*600);
    while(text.length<target)text+=pieces[Math.floor(next()*pieces.length)];
    for(const limit of [20,57,100,150])check(text,limit);
  }
});

test('a cut prefers a paragraph break, then a line break, a sentence end, a space, and only then a hard cut',()=>{
  const para=['Alpha beta gamma delta. Epsilon zeta eta theta.','Iota kappa lambda mu nu xi omicron pi rho sigma.','Tau upsilon phi chi psi omega and then some more words to run past the limit.'].join('\n\n');
  const a=check(para,100)!;assert.equal(a.kind,'paragraph');assert.equal(a.first,para.split('\n\n').slice(0,2).join('\n\n'));assert(a.rest.startsWith('\n\n'));
  assert.equal(startOfNextPost(a.rest),para.split('\n\n')[2]);

  const lines=['one two three four five six seven','eight nine ten eleven twelve thirteen','fourteen fifteen sixteen seventeen eighteen nineteen twenty'].join('\n');
  assert.equal(check(lines,90)!.kind,'line');

  const sentences='First sentence here. Second sentence follows it. Third sentence keeps going on and on and on without any line break at all.';
  const s=check(sentences,70)!;assert.equal(s.kind,'sentence');assert(s.first.endsWith('follows it.'));

  const words='alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron';
  const w=check(words,40)!;assert.equal(w.kind,'word');assert(!w.first.endsWith(' '));assert(/^\s/.test(w.rest));

  const unbroken='x'.repeat(300);
  const h=check(unbroken,100)!;assert.equal(h.kind,'hard');assert.equal(h.first.length,100);
});

test('a first part under half the limit is not worth posting, so a sizeable cut of a weaker kind wins',()=>{
  const text='Short opening.\n\n'+'long sentence without any paragraph breaks '.repeat(20);
  const split=check(text,300)!;
  assert.notEqual(split.kind,'paragraph');assert(characterCount(split.first)>150);
});

test('characters are never torn apart: emoji sequences, combining marks, and surrogate pairs',()=>{
  const family='👨‍👩‍👧‍👦';   // 7 code points, 11 UTF-16 units, one character
  const split=check(family.repeat(300),200)!;
  assert.equal(split.kind,'hard');assert.equal(split.pos%family.length,0);assert.equal(characterCount(split.first)%7,0);
  const accented=check('é'.repeat(300),151)!;assert.equal(accented.pos%2,0);
  const faces=check('😀'.repeat(300),201)!;assert.equal(faces.pos%2,0);assert.equal(characterCount(faces.first),201);
});

test('Markdown is not cut through when another cut exists; when none does, the cut is flagged',()=>{
  // A word cut inside a link would split the link text.
  const link='[a very long link text that goes on and on](https://example.com/some/long/path)';
  const linked=`${'plain words here '.repeat(4)}${link} and a tail of ordinary words after the link ends`;
  const cut=linked.indexOf('link text')+4;const at=check(linked,cut)!;
  assert(at.safe);assert(at.pos<=linked.indexOf('[a very')||at.pos>=linked.indexOf(link)+link.length,'not inside the link');

  // A fenced code block that spans the limit: any cut through it is flagged, and a cut before it is safe.
  const code=['Intro line.',' ','```js',...Array.from({length:40},(_,i)=>`const value${i} = ${i};`),'```','After the code.'].join('\n');
  const through=check(code,300)!;assert.equal(through.safe,false);assert.equal(through.kind,'line');
  const before=check(code,100)!;assert.equal(before.safe,false);                // still inside: nothing safe of a useful size
  const clear=check(`Intro paragraph one.\n\nIntro paragraph two.\n\n\`\`\`\n${'x\n'.repeat(80)}\`\`\`\n\nOutro text.`,60)!;
  assert(clear.safe);assert.equal(clear.kind,'paragraph');assert(clear.first.endsWith('two.'));

  // A table is kept whole when a cut before it is available.
  const table=['Lead in text that sets up the table below.','','| name | value |','|------|-------|',...Array.from({length:30},(_,i)=>`| row${i} | ${i} |`),'','Afterwards.'].join('\n');
  const t=check(table,200)!;assert.equal(t.safe,false);
  const roomy=check(table,table.indexOf('| name')+5,)!;                          // limit lands inside the header row
  assert.equal(roomy.safe,true);assert(roomy.first.trimEnd().endsWith('below.'));
});

test('Earlier and Later step between paragraph, line, and sentence boundaries within the limit',()=>{
  const text=['Para one sentence a. Sentence b.','Line two of para one','','Para two sentence a. Sentence b.','Para two line two'].join('\n');
  const steps=stepBoundaries(text,90);
  assert(steps.length>=5);assert.deepEqual(steps.map(s=>s.pos),[...steps.map(s=>s.pos)].sort((a,b)=>a-b));
  assert(steps.every(s=>s.pos<=indexAfter(text,90)&&['paragraph','line','sentence'].includes(s.kind)));
  assert(steps.every(s=>!/\s/.test(text[s.pos-1])),'a boundary always follows a visible character');
  assert.deepEqual([...new Set(steps.map(s=>s.kind))].sort(),['line','paragraph','sentence']);
  for(const step of steps){const split=splitAt(text,step);assert.equal(split.first+split.rest,text);assert(characterCount(split.first)<=90);}
});

test('only trailing whitespace over the limit is offered for removal, not a split',()=>{
  const text='a'.repeat(200)+' '.repeat(40)+'\n\n';
  const split=check(text,200)!;
  assert.equal(split.kind,'trailing');assert.equal(split.first,'a'.repeat(200));assert.equal(split.rest.trim(),'');
});

test('the next post starts after the blank lines that separated it, but keeps indentation and content',()=>{
  assert.equal(startOfNextPost('\n\nNext'),'Next');assert.equal(startOfNextPost('  \n\r\n  indented'),'  indented');
  assert.equal(startOfNextPost('\n\n    code block'),'    code block');assert.equal(startOfNextPost('no leading blank'),'no leading blank');
});

test('a realistic over-limit paste splits at a paragraph break with the right sizes',()=>{
  const paragraph='This is a paragraph of ordinary prose. It has several sentences. '.repeat(8).trim();
  const text=Array.from({length:60},()=>paragraph).join('\n\n');
  assert(characterCount(text)>MAX_NOTE_CHARACTERS);
  const split=suggestSplit(text)!;
  assert.equal(split.first+split.rest,text);assert.equal(split.kind,'paragraph');assert(characterCount(split.first)<=MAX_NOTE_CHARACTERS);assert(characterCount(split.first)>MAX_NOTE_CHARACTERS-paragraph.length-2);
  // The remainder may be larger than the number of characters over the limit: it starts at a paragraph, not at the limit.
  const over=characterCount(text)-MAX_NOTE_CHARACTERS;assert(characterCount(split.rest)>=over);
});
