import test from 'node:test';
import assert from 'node:assert/strict';
import {clampZoom,createStage,fitZoom,MAX_ZOOM,MIN_ZOOM} from '../src/stage.ts';

test('fit chooses the largest zoom that shows the whole picture, within sane limits',()=>{
  assert.equal(fitZoom({width:1000,height:800},{width:500,height:500}),0.5);
  assert.equal(fitZoom({width:1000,height:800},{width:2000,height:400}),0.5);
  assert.equal(fitZoom({width:1000,height:800},{width:900,height:900}),0.9);
  assert.equal(fitZoom({width:100,height:100},{width:5000,height:5000}),2);   // a small picture is not blown up past 2x
  assert.equal(fitZoom({width:1000,height:800},{width:0,height:0}),1);       // no layout yet (hidden): leave it alone
  assert.equal(clampZoom(0.001),MIN_ZOOM);assert.equal(clampZoom(99),MAX_ZOOM);assert.equal(clampZoom(1),1);
});

// A tiny stand-in for layout: the picture is centered when smaller than the view and scrolls when larger.
function layout(view={width:400,height:300}){
  const stage=Object.assign(new EventTarget(),{scrollLeft:0,scrollTop:0,clientWidth:view.width,clientHeight:view.height,getBoundingClientRect:()=>({left:0,top:0})}) as unknown as HTMLElement;
  const content={style:{width:'',height:''},getBoundingClientRect(){
    const width=parseFloat(content.style.width)||0,height=parseFloat(content.style.height)||0;
    return {left:width<view.width?(view.width-width)/2:-stage.scrollLeft,top:height<view.height?(view.height-height)/2:-stage.scrollTop,width,height};
  }};
  return {stage,content:content as unknown as HTMLElement,raw:content};
}

test('zoom steps keep the point at the middle of the view where it was; Fit and 100% report their size',()=>{
  const {stage,content,raw}=layout();let changes=0;
  const view=createStage({stage,content,size:()=>({width:1000,height:800}),box:()=>({width:400,height:300}),changed:()=>{changes++;}});
  view.fit();
  assert.equal(view.zoom,0.375);assert(view.fitting);assert.equal(view.label(),'38%');assert.equal(raw.style.width,'375px');assert.equal(raw.style.height,'300px');
  // Which bitmap column sits under the middle of the view (the fake layout already accounts for scrolling).
  const middle=()=>(200-content.getBoundingClientRect().left)/view.zoom;
  const before=middle();
  view.zoomIn();assert(!view.fitting);assert(view.zoom>0.375);assert(Math.abs(middle()-before)<1);
  view.actual();assert.equal(view.zoom,1);assert.equal(view.label(),'100%');assert.equal(raw.style.width,'1000px');assert(Math.abs(middle()-before)<1);
  view.zoomOut();assert(view.zoom<1);
  for(let i=0;i<40;i++)view.zoomIn();assert.equal(view.zoom,MAX_ZOOM);
  for(let i=0;i<60;i++)view.zoomOut();assert.equal(view.zoom,MIN_ZOOM);
  assert(changes>5);
  view.dispose();
});

test('refit follows the room only while fitting; a chosen zoom is never undone',()=>{
  const room={width:400,height:300};
  const {stage,content,raw}=layout();
  const view=createStage({stage,content,size:()=>({width:1000,height:800}),box:()=>room});
  view.fit();room.width=800;room.height=600;view.refit();
  assert.equal(view.zoom,0.75);assert.equal(raw.style.width,'750px');
  view.zoomIn();const chosen=view.zoom;room.width=300;room.height=200;view.refit();
  assert.equal(view.zoom,chosen);
  view.fit();assert.equal(view.zoom,0.25);
  view.dispose();
});

test('a new bitmap size is applied at the current zoom, and fit re-fits',()=>{
  const bitmap={width:1024,height:768};
  const {stage,content,raw}=layout({width:1600,height:1200});
  const view=createStage({stage,content,size:()=>bitmap,box:()=>({width:1600,height:1200})});
  view.fit();assert.equal(view.zoom,1.5625);
  bitmap.width=1600;bitmap.height=1200;view.resized();assert.equal(view.zoom,1);assert.equal(raw.style.width,'1600px');
  view.actual();view.zoomIn();bitmap.width=1024;bitmap.height=768;view.resized();
  assert(!view.fitting);assert.equal(raw.style.width,`${Math.round(1024*view.zoom)}px`);
  view.dispose();
});

test('Ctrl/Cmd+wheel zooms around the pointer; a plain wheel scrolls as usual',()=>{
  const {stage,content}=layout();
  const view=createStage({stage,content,size:()=>({width:1000,height:800}),box:()=>({width:400,height:300})});
  view.fit();
  const wheel=(init:object)=>{const event=Object.assign(new Event('wheel',{cancelable:true}),{ctrlKey:false,metaKey:false,deltaY:-100,clientX:100,clientY:100},init);stage.dispatchEvent(event);return event;};
  const plain=wheel({});assert(!plain.defaultPrevented);assert(view.fitting);
  const zoomed=wheel({ctrlKey:true});assert(zoomed.defaultPrevented);assert(view.zoom>0.375);
  const out=view.zoom;wheel({metaKey:true,deltaY:100});assert(view.zoom<out);
  view.dispose();
  const after=wheel({ctrlKey:true});assert(!after.defaultPrevented);
});

test('panning scrolls the view by the given amount',()=>{
  const {stage,content}=layout();
  const view=createStage({stage,content,size:()=>({width:1000,height:800}),box:()=>({width:400,height:300})});
  view.panBy(30,-10);assert.equal(stage.scrollLeft,30);assert.equal(stage.scrollTop,-10);
  view.dispose();
});
