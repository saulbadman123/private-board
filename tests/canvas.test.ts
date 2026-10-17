import test from 'node:test';
import assert from 'node:assert/strict';
import {attachCanvas,canvasPoint} from '../src/canvas.ts';

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
