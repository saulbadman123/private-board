import test from 'node:test';
import assert from 'node:assert/strict';
import {attachCanvas,canvasPoint,paintStroke,repaint} from '../src/canvas.ts';
import {DrawingHistory} from '../src/drawing-history.ts';
import type {Stroke} from '../src/drawing-history.ts';

function stubCanvas(width=1024,height=768,rect={left:0,top:0,width:512,height:384}){
  const ops:unknown[][]=[];
  const context={fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',beginPath(){},moveTo(x:number,y:number){ops.push(['from',x,y]);},lineTo(x:number,y:number){ops.push(['to',x,y]);},stroke(){ops.push(['stroke',this.strokeStyle,this.lineWidth]);},arc(x:number,y:number,r:number){ops.push(['dot',x,y,r,this.fillStyle]);},fill(){},fillRect(x:number,y:number,w:number,h:number){ops.push(['paper',this.fillStyle,x,y,w,h]);},drawImage(){ops.push(['baseline']);}};
  const captured=new Set<number>(),target=new EventTarget();
  const canvas=Object.assign(target,{width,height,getBoundingClientRect:()=>rect,getContext:()=>context,setPointerCapture:(id:number)=>captured.add(id),hasPointerCapture:(id:number)=>captured.has(id),releasePointerCapture:(id:number)=>captured.delete(id)}) as unknown as HTMLCanvasElement;
  const emit=(type:string,id:number,x:number,y:number,extra:object={})=>{const event=new Event(type,{cancelable:true});Object.assign(event,{pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:y,...extra});canvas.dispatchEvent(event);return event;};
  return {canvas,ops,emit,captured};
}
function withFrames<T>(run:()=>T):T{
  const oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  try{return run();}finally{globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;}
}

test('pointer coordinates are clamped to the paper, at any zoom',()=>{
  const {canvas}=stubCanvas(1024,768,{left:100,top:100,width:256,height:192});
  assert.deepEqual(canvasPoint(canvas,{clientX:-500,clientY:900}),{x:0,y:768});
  assert.deepEqual(canvasPoint(canvas,{clientX:5000,clientY:-5}),{x:1024,y:0});
  assert.deepEqual(canvasPoint(canvas,{clientX:228,clientY:196}),{x:512,y:384});
});

test('each stroke is recorded once with its points, and replaying it paints the same operations as drawing it live',()=>withFrames(()=>{
  const live=stubCanvas(),recorded:Stroke[]=[];
  const surface=attachCanvas(live.canvas,{canDraw:()=>true,brush:()=>({color:'#b93e43',size:9}),changed:()=>{},record:stroke=>recorded.push(stroke)});
  live.emit('pointerdown',1,100,100);live.emit('pointermove',1,150,120);live.emit('pointermove',1,200,160);live.emit('pointerup',1,200,160);
  surface.flush();
  assert.equal(recorded.length,1);assert.deepEqual(recorded[0],{color:'#b93e43',size:9,points:[200,200,300,240,400,320]});
  // A tap is a one-point stroke (a dot); pointer cancel still records what was drawn.
  live.emit('pointerdown',2,10,10);live.emit('pointercancel',2,10,10);surface.flush();
  assert.equal(recorded.length,2);assert.equal(recorded[1].points.length,2);

  const replay=stubCanvas();
  paintStroke(replay.canvas.getContext('2d')!,recorded[0]);paintStroke(replay.canvas.getContext('2d')!,recorded[1]);
  assert.deepEqual(replay.ops,live.ops);
  surface.dispose();
}));

test('pan mode moves the view and never draws, even when drawing is frozen; other buttons and pointers are ignored',()=>withFrames(()=>{
  const {canvas,ops,emit,captured}=stubCanvas();const moves:number[][]=[];let panning=true,frozen=true,changes=0;
  const surface=attachCanvas(canvas,{canDraw:()=>!frozen,brush:()=>({color:'#000',size:6}),changed:()=>{changes++;},pan:{active:()=>panning,by:(dx,dy)=>{moves.push([dx,dy]);}}});
  emit('pointerdown',1,100,100);assert(captured.has(1));
  emit('pointermove',1,90,110);emit('pointermove',1,70,110);
  emit('pointerdown',2,0,0);emit('pointermove',2,5,5);   // a second finger is ignored
  assert.deepEqual(moves,[[10,-10],[20,0]]);assert.equal(ops.length,0);assert.equal(changes,0);
  emit('pointerup',1,70,110);assert(!captured.has(1));
  emit('pointermove',1,10,10);assert.equal(moves.length,2);   // released: no more panning
  emit('pointerdown',3,50,50,{pointerType:'mouse',button:2});assert(!captured.has(3));
  // Back to Draw mode: normal ink again (and none while frozen).
  panning=false;emit('pointerdown',4,50,50);assert.equal(ops.length,0);
  emit('pointermove',4,60,60);frozen=false;emit('pointerdown',5,50,50);surface.flush();assert(ops.length>0);assert(changes>0);
  surface.dispose();
}));

test('repaint redraws from the baseline (or blank paper) and replays the steps in order',()=>{
  const history=new DrawingHistory(),a:Stroke={color:'#000',size:4,points:[1,1,2,2]},b:Stroke={color:'#fff',size:8,points:[5,5]};
  const blank=stubCanvas();
  history.push(a);history.push('clear');history.push(b);
  repaint(blank.canvas,history);
  // Blank paper, stroke a (starts with a dot), Clear, stroke b (a dot).
  assert.deepEqual(blank.ops.filter(op=>op[0]==='paper'||op[0]==='dot').map(op=>op[0]),['paper','dot','paper','dot']);
  assert(!blank.ops.some(op=>op[0]==='baseline'));
  const based=stubCanvas();history.baseline={} as HTMLCanvasElement;history.ops=[b];
  repaint(based.canvas,history);
  assert.deepEqual(based.ops.map(op=>op[0]),['baseline','dot']);
});

test('pointer coordinates survive CSS resize; cancel/lost capture release input and frozen submissions stop strokes',()=>{
  let rect={left:10,top:20,width:512,height:384},frames=0,canDraw=true,changes=0;
  const ops:unknown[][]=[];
  const context={fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',beginPath(){},moveTo(x:number,y:number){ops.push(['from',x,y]);},lineTo(x:number,y:number){ops.push(['to',x,y]);},stroke(){ops.push(['stroke',this.strokeStyle]);},arc(x:number,y:number,r:number){ops.push(['dot',x,y,r]);},fill(){},fillRect(){ops.push(['clear']);}};
  const target=new EventTarget();const captured=new Set<number>();
  const canvas=Object.assign(target,{width:1024,height:768,getBoundingClientRect:()=>rect,getContext:()=>context,setPointerCapture:(id:number)=>captured.add(id),hasPointerCapture:(id:number)=>captured.has(id),releasePointerCapture:(id:number)=>captured.delete(id)}) as unknown as HTMLCanvasElement;
  const oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame=()=>++frames;globalThis.cancelAnimationFrame=()=>{};
  const emit=(type:string,id:number,x=266,y=212)=>{const event=new Event(type,{cancelable:true});Object.assign(event,{pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:y});canvas.dispatchEvent(event);};
  let dispose=()=>{};
  try{
    assert.deepEqual(canvasPoint(canvas,{clientX:266,clientY:212}),{x:512,y:384});
    const surface=attachCanvas(canvas,{canDraw:()=>canDraw,brush:()=>({color:'#222824',size:6}),changed:()=>changes++});dispose=surface.dispose;
    emit('pointerdown',1);emit('pointerdown',2);emit('pointermove',2);emit('pointercancel',1);
    assert.equal(changes,1);assert(!captured.has(1));assert(ops.some(op=>op[0]==='dot'&&op[1]===512&&op[2]===384));
    rect={left:10,top:20,width:256,height:192};assert.deepEqual(canvasPoint(canvas,{clientX:138,clientY:116}),{x:512,y:384});
    emit('pointerdown',3,138,116);emit('lostpointercapture',3);emit('pointerdown',4,138,116);canDraw=false;emit('pointermove',4,200,150);
    assert.equal(changes,3);assert(!captured.has(4));const before=ops.length;emit('pointerdown',5);surface.flush();assert.equal(ops.length,before);
    canDraw=true;emit('pointerdown',6);surface.finish();assert(!captured.has(6));surface.clear();assert(ops.some(op=>op[0]==='clear'));assert.equal(canvas.width,1024);assert.equal(canvas.height,768);
  }finally{dispose();globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;}
});
