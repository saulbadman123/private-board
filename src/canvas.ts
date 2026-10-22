import type { DrawingHistory, Op, Renderer, Stroke } from './drawing-history.ts';

export type Point={x:number;y:number};
// Maps a pointer to bitmap pixels through the canvas's on-screen box, so it holds at any zoom. Clamped to the paper.
export function canvasPoint(canvas:HTMLCanvasElement,event:{clientX:number;clientY:number}):Point{
  const rect=canvas.getBoundingClientRect();
  const x=(event.clientX-rect.left)*canvas.width/rect.width,y=(event.clientY-rect.top)*canvas.height/rect.height;
  return {x:Math.min(Math.max(x,0),canvas.width),y:Math.min(Math.max(y,0),canvas.height)};
}
type Segment={from:Point|null;to:Point;color:string;size:number};
type Options={canDraw:()=>boolean;brush:()=>{color:string;size:number};changed:()=>void;record?:(stroke:Stroke)=>void;pan?:{active:()=>boolean;by:(dx:number,dy:number)=>void}};
type Painter=Pick<CanvasRenderingContext2D,'fillStyle'|'strokeStyle'|'lineWidth'|'lineCap'|'lineJoin'|'beginPath'|'moveTo'|'lineTo'|'stroke'|'arc'|'fill'|'fillRect'>;

// One drawing routine for live input, undo/redo replay, and folding into the baseline, so all three give the same pixels.
export function paintSegment(context:Painter,segment:Segment){
  context.fillStyle=segment.color;context.strokeStyle=segment.color;context.lineWidth=segment.size;context.lineCap='round';context.lineJoin='round';
  context.beginPath();
  if(segment.from){context.moveTo(segment.from.x,segment.from.y);context.lineTo(segment.to.x,segment.to.y);context.stroke();}
  else{context.arc(segment.to.x,segment.to.y,segment.size/2,0,Math.PI*2);context.fill();}
}
export function paintStroke(context:Painter,stroke:Stroke){
  let last:Point|null=null;
  for(let i=0;i<stroke.points.length;i+=2){const to={x:stroke.points[i],y:stroke.points[i+1]};paintSegment(context,{from:last,to,color:stroke.color,size:stroke.size});last=to;}
}
export function paintPaper(context:Painter,width:number,height:number){context.fillStyle='#ffffff';context.fillRect(0,0,width,height);}
function paperContext(canvas:HTMLCanvasElement){const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('This browser could not open a drawing canvas. Markdown notes are still available.');return context;}
// Redraw the whole canvas from the baseline and the recorded operations (after Undo or Redo).
export function repaint(canvas:HTMLCanvasElement,history:DrawingHistory){
  const context=paperContext(canvas);
  if(history.baseline)context.drawImage(history.baseline,0,0);else paintPaper(context,canvas.width,canvas.height);
  for(const op of history.ops)paintOp(context,op,canvas);
}
function paintOp(context:Painter,op:Op,canvas:{width:number;height:number}){if(op==='clear')paintPaper(context,canvas.width,canvas.height);else paintStroke(context,op);}
export function paperRenderer(width:number,height:number,create:()=>HTMLCanvasElement=()=>document.createElement('canvas')):Renderer{
  return {
    blank(){const canvas=create();canvas.width=width;canvas.height=height;paintPaper(paperContext(canvas),width,height);return canvas;},
    paint(target,op){paintOp(paperContext(target),op,target);}
  };
}

export function attachCanvas(canvas:HTMLCanvasElement,options:Options){
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)throw new Error('This browser could not open a drawing canvas. Markdown notes are still available.');
  let pointer:number|null=null,last:Point|null=null,brush={color:'#222824',size:6},stroke:Stroke|null=null;
  let panning:{id:number;x:number;y:number}|null=null;
  let frame:number|null=null;let queue:Segment[]=[];
  function flush(){
    if(frame!==null){cancelAnimationFrame(frame);frame=null;}
    for(const segment of queue)paintSegment(context!,segment);
    queue=[];
  }
  function add(to:Point){queue.push({from:last,to,...brush});stroke?.points.push(to.x,to.y);last=to;if(frame===null)frame=requestAnimationFrame(flush);}
  function down(event:PointerEvent){
    // Pan mode moves the view and never leaves ink, even when drawing is frozen.
    if(options.pan?.active()){
      if(panning||pointer!==null||(event.pointerType==='mouse'&&event.button!==0))return;
      event.preventDefault();panning={id:event.pointerId,x:event.clientX,y:event.clientY};
      try{canvas.setPointerCapture(event.pointerId);}catch{/* capture may be unavailable */}
      return;
    }
    if(pointer!==null||!options.canDraw()||(event.pointerType==='mouse'&&event.button!==0))return;
    event.preventDefault();pointer=event.pointerId;last=null;brush=options.brush();stroke={color:brush.color,size:brush.size,points:[]};
    try{canvas.setPointerCapture(pointer);}catch{/* capture may be unavailable */}
    add(canvasPoint(canvas,event));options.changed();
  }
  function move(event:PointerEvent){
    if(panning&&panning.id===event.pointerId){
      event.preventDefault();options.pan!.by(panning.x-event.clientX,panning.y-event.clientY);panning.x=event.clientX;panning.y=event.clientY;return;
    }
    if(pointer!==event.pointerId)return;
    if(!options.canDraw()){end(event);return;}
    event.preventDefault();
    const samples=event.getCoalescedEvents?.()??[];
    for(const sample of samples.length?samples:[event])add(canvasPoint(canvas,sample));
  }
  function end(event:PointerEvent){
    if(panning&&panning.id===event.pointerId){release(panning.id);panning=null;return;}
    if(pointer!==event.pointerId)return;
    finish();
  }
  function release(id:number){try{if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);}catch{/* already released */}}
  function finish(){
    const id=pointer,done=stroke;pointer=null;last=null;stroke=null;flush();
    if(done&&done.points.length)options.record?.(done);
    if(id===null)return;
    release(id);
  }
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);
  canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);canvas.addEventListener('lostpointercapture',end);
  return {flush,finish,clear(){finish();paintPaper(context,canvas.width,canvas.height);},dispose(){
    canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);
    canvas.removeEventListener('pointerup',end);canvas.removeEventListener('pointercancel',end);canvas.removeEventListener('lostpointercapture',end);
    if(panning){release(panning.id);panning=null;}
    finish();
  }};
}
