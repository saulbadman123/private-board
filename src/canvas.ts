export type Point={x:number;y:number};
export function canvasPoint(canvas:HTMLCanvasElement,event:{clientX:number;clientY:number}):Point{
  const rect=canvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};
}
type Segment={from:Point|null;to:Point;color:string;size:number};
type Options={canDraw:()=>boolean;brush:()=>{color:string;size:number};changed:()=>void};
export function attachCanvas(canvas:HTMLCanvasElement,options:Options){
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)throw new Error('This browser could not open a drawing canvas. Markdown notes are still available.');
  let pointer:number|null=null,last:Point|null=null,brush={color:'#222824',size:6};
  let frame:number|null=null;let queue:Segment[]=[];
  function flush(){
    if(frame!==null){cancelAnimationFrame(frame);frame=null;}
    for(const segment of queue){
      context!.fillStyle=segment.color;context!.strokeStyle=segment.color;context!.lineWidth=segment.size;context!.lineCap='round';context!.lineJoin='round';
      context!.beginPath();
      if(segment.from){context!.moveTo(segment.from.x,segment.from.y);context!.lineTo(segment.to.x,segment.to.y);context!.stroke();}
      else{context!.arc(segment.to.x,segment.to.y,segment.size/2,0,Math.PI*2);context!.fill();}
    }
    queue=[];
  }
  function add(to:Point){queue.push({from:last,to,...brush});last=to;if(frame===null)frame=requestAnimationFrame(flush);}
  function down(event:PointerEvent){
    if(pointer!==null||!options.canDraw()||(event.pointerType==='mouse'&&event.button!==0))return;
    event.preventDefault();pointer=event.pointerId;last=null;brush=options.brush();
    try{canvas.setPointerCapture(pointer);}catch{/* capture may be unavailable */}
    add(canvasPoint(canvas,event));options.changed();
  }
  function move(event:PointerEvent){
    if(pointer!==event.pointerId)return;
    if(!options.canDraw()){end(event);return;}
    event.preventDefault();
    const samples=event.getCoalescedEvents?.()??[];
    for(const sample of samples.length?samples:[event])add(canvasPoint(canvas,sample));
  }
  function end(event:PointerEvent){
    if(pointer!==event.pointerId)return;
    finish();
  }
  function finish(){
    const id=pointer;pointer=null;last=null;flush();
    if(id===null)return;
    try{if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);}catch{/* already released */}
  }
  // Flush the stroke before the tab stops producing animation frames. Leaving
  // the tab must not join the old stroke to a new pointer position on return.
  const document=canvas.ownerDocument;
  const visibilityChanged=()=>{if(document?.hidden)finish();};
  document?.addEventListener('visibilitychange',visibilityChanged);
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);
  canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);canvas.addEventListener('lostpointercapture',end);
  return {flush,finish,clear(){finish();context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);},dispose(){
    document?.removeEventListener('visibilitychange',visibilityChanged);
    canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);
    canvas.removeEventListener('pointerup',end);canvas.removeEventListener('pointercancel',end);canvas.removeEventListener('lostpointercapture',end);
    finish();
  }};
}

