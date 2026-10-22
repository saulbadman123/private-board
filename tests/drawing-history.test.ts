import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingHistory,MAX_OPS,MAX_POINTS} from '../src/drawing-history.ts';
import type {Op,Renderer,Stroke} from '../src/drawing-history.ts';

const stroke=(n=1,points=2):Stroke=>({color:'#222824',size:6,points:Array.from({length:points*2},(_,i)=>n+i)});
function renderer(){
  const painted:Op[]=[];let blanks=0;
  const canvas=(label:string)=>({label}) as unknown as HTMLCanvasElement;
  const impl:Renderer={blank(){blanks++;return canvas('baseline');},paint(_target,op){painted.push(op);}};
  return {impl,painted,blanks:()=>blanks};
}

test('undo, redo, and a new stroke follow the usual rules',()=>{
  const history=new DrawingHistory();
  assert(!history.canUndo());assert(!history.canRedo());assert(!history.hasInk());assert(!history.undo());assert(!history.redo());
  const a=stroke(1),b=stroke(2);
  history.push(a);history.push(b);assert(history.hasInk());assert.deepEqual(history.ops,[a,b]);
  assert(history.undo());assert.deepEqual(history.ops,[a]);assert(history.canRedo());assert(history.hasInk());
  assert(history.undo());assert(!history.hasInk());assert.equal(history.ops.length,0);
  assert(history.redo());assert(history.hasInk());assert.deepEqual(history.ops,[a]);
  history.push(stroke(3));assert(!history.canRedo());
});

test('Clear is a step of its own: it ends the ink and can be undone',()=>{
  const history=new DrawingHistory();
  history.push(stroke());history.push('clear');
  assert(!history.hasInk());assert(history.canUndo());
  history.undo();assert(history.hasInk());
  history.redo();assert(!history.hasInk());
  history.push(stroke(5));assert(history.hasInk());
});

test('over budget, the oldest steps are painted into the baseline in order and the artwork is kept',()=>{
  const history=new DrawingHistory(),r=renderer(),all:Op[]=[];
  for(let i=0;i<MAX_OPS+5;i++){const op=stroke(i);all.push(op);history.push(op);}
  assert(history.overBudget());history.trim(r.impl);
  assert(!history.overBudget());assert.equal(history.ops.length,MAX_OPS);
  assert.deepEqual(r.painted,all.slice(0,5));assert.equal(r.blanks(),1);
  assert(history.baseline);assert(history.baselineInk);
  // Undo reaches back exactly as far as the retained steps, and never loses what was folded.
  let undone=0;while(history.undo())undone++;
  assert.equal(undone,MAX_OPS);assert(history.hasInk());
});

test('one very long stroke over the point budget is folded too, and its ink remains',()=>{
  const history=new DrawingHistory(),r=renderer();
  history.push(stroke(1,MAX_POINTS+10));history.trim(r.impl);
  assert.equal(history.ops.length,0);assert(history.baselineInk);assert(history.hasInk());assert.equal(r.painted.length,1);
  history.trim(r.impl);assert.equal(r.painted.length,1);
});

test('folding a Clear leaves a blank baseline, and reset forgets everything',()=>{
  const history=new DrawingHistory(),r=renderer();
  history.push(stroke());history.push('clear');
  for(let i=0;i<MAX_OPS;i++)history.push(stroke(i));
  history.trim(r.impl);
  // The first stroke and the Clear (the two oldest steps) were baked in; the strokes after Clear remain.
  assert.deepEqual(r.painted.map(op=>op==='clear'?'clear':'stroke'),['stroke','clear']);assert(!history.baselineInk);assert(history.hasInk());
  history.reset();
  assert.equal(history.ops.length,0);assert.equal(history.baseline,null);assert(!history.baselineInk);assert(!history.hasInk());assert(!history.overBudget());
});
