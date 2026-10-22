import {api,ApiError} from './api.ts';
import type {PostResponse} from '../shared/contracts.ts';
import {drawingDraftFor} from './drafts.ts';
import {attachCanvas,paintPaper,paperRenderer,repaint} from './canvas.ts';
import {createStage} from './stage.ts';
import {BRUSH_REFERENCE_WIDTH,MAX_IMAGE_BYTES,PAPER_SIZES,paperFor} from '../shared/drawing-limits.ts';
import type {PaperSize} from '../shared/drawing-limits.ts';
import {setOthersInert} from './inert.ts';
import {saveBlob} from './export.ts';

type Options={boardId:string;container:HTMLElement;signal:AbortSignal;posted:(result:PostResponse)=>void;expired:(message:string)=>void;toast?:(message:string)=>void};
const MIB=1024*1024;
export function mountDrawing({boardId,container,signal,posted,expired,toast}:Options):()=>void{
  const draft=drawingDraftFor(boardId);let active=true;
  container.innerHTML=`<div class="composer-heading draw-heading"><div><h2>Put a little ink down.</h2><p>A quick sketch. A thought without words.</p></div></div><form id="drawing-form"><div class="draw-controls"><div class="draw-toolbar"><div class="draw-tools" role="group" aria-label="Drawing tool"><button id="draw-pen" type="button" aria-pressed="true">Pen</button><button id="draw-eraser" type="button" aria-pressed="false">Eraser</button></div><div class="draw-colors" role="group" aria-label="Pen color">${['#222824','#b93e43','#dc8e22','#327657','#356eae','#8252a4'].map((color,i)=>`<button type="button" class="color-swatch swatch-${i}" data-color="${color}" aria-label="${['Charcoal','Red','Gold','Green','Blue','Purple'][i]}" aria-pressed="false"></button>`).join('')}<label class="custom-color">Custom<input id="draw-color" type="color" aria-label="Custom pen color"/></label></div><label class="brush-size">Size<select id="draw-size" aria-label="Brush size"><option value="3">Fine</option><option value="6">Medium</option><option value="14">Broad</option></select></label><div class="draw-history" role="group" aria-label="History"><button id="undo-drawing" type="button">Undo</button><button id="redo-drawing" type="button">Redo</button></div><button id="clear-drawing" type="button" class="clear-drawing">Clear canvas</button><button id="expand-drawing" type="button" class="expand-drawing">Expand</button></div><details class="draw-view-more" open><summary>View &amp; paper</summary><div class="draw-view"><div class="draw-pointer" role="group" aria-label="Pointer"><button id="pointer-draw" type="button" aria-pressed="true">Draw</button><button id="pointer-pan" type="button" aria-pressed="false">Pan</button></div><div class="draw-zoom" role="group" aria-label="Zoom"><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="zoom-fit" type="button">Fit</button><button id="zoom-actual" type="button">100%</button><button id="zoom-in" type="button" aria-label="Zoom in">+</button><output id="zoom-level" class="zoom-level" aria-label="Zoom level"></output></div><label class="paper-size">Paper<select id="draw-paper" aria-label="Paper size">${(Object.keys(PAPER_SIZES) as PaperSize[]).map(key=>`<option value="${key}">${PAPER_SIZES[key].label} · ${PAPER_SIZES[key].width} × ${PAPER_SIZES[key].height}</option>`).join('')}</select></label><button id="download-draft" type="button">Download PNG</button></div></details></div><div id="canvas-slot" class="canvas-slot canvas-stage"></div><p class="draw-help">Draw with your finger, mouse, or pen. When zoomed in, use Pan or scroll to move around. Ctrl/Cmd+Z undoes.</p><details class="drawing-details"><summary>Title, description & tags <span>(optional)</span></summary><div class="field"><label for="draw-title">Title</label><input id="draw-title" maxlength="120" placeholder="Give your sketch a name"/></div><div class="field"><label for="draw-caption">Description</label><textarea id="draw-caption" maxlength="280" rows="2" placeholder="A short description for readers who cannot see the drawing"></textarea></div><div class="field"><label for="draw-tags">Tags</label><input id="draw-tags" placeholder="sketch, ideas"/><small>Up to five tags, separated by commas.</small></div></details><p id="drawing-attempt" class="soft-notice" hidden>This drawing is awaiting confirmation. Retry checks the same submission without changing or duplicating it.</p><p id="drawing-error" class="form-error" role="alert" hidden></p><div class="post-row"><p>Posts are permanent.<br/><span>Check before posting.</span></p><button class="primary" type="submit" id="post-drawing">Post drawing ↗</button></div></form>`;
  const form=container.querySelector<HTMLFormElement>('#drawing-form')!;
  if(!draft.canvas){
    const canvas=document.createElement('canvas');canvas.width=PAPER_SIZES.standard.width;canvas.height=PAPER_SIZES.standard.height;
    canvas.setAttribute('aria-label','Drawing paper. Use touch, mouse, or pen to sketch.');canvas.setAttribute('role','img');canvas.tabIndex=0;
    const ctx=canvas.getContext('2d',{alpha:false});
    if(!ctx)throw new Error('This browser could not open a drawing canvas. You can still write a note.');
    paintPaper(ctx,canvas.width,canvas.height);draft.canvas=canvas;
  }
  const canvas=draft.canvas,stageElement=container.querySelector<HTMLElement>('#canvas-slot')!;
  stageElement.append(canvas);
  const title=form.querySelector<HTMLInputElement>('#draw-title')!,caption=form.querySelector<HTMLTextAreaElement>('#draw-caption')!,tags=form.querySelector<HTMLInputElement>('#draw-tags')!;
  const errorBox=form.querySelector<HTMLElement>('#drawing-error')!,post=form.querySelector<HTMLButtonElement>('#post-drawing')!;
  const pen=form.querySelector<HTMLButtonElement>('#draw-pen')!,eraser=form.querySelector<HTMLButtonElement>('#draw-eraser')!;
  const picker=form.querySelector<HTMLInputElement>('#draw-color')!,size=form.querySelector<HTMLSelectElement>('#draw-size')!;
  const clear=form.querySelector<HTMLButtonElement>('#clear-drawing')!,undoButton=form.querySelector<HTMLButtonElement>('#undo-drawing')!,redoButton=form.querySelector<HTMLButtonElement>('#redo-drawing')!;
  const paperSelect=form.querySelector<HTMLSelectElement>('#draw-paper')!,expand=form.querySelector<HTMLButtonElement>('#expand-drawing')!,zoomLevel=form.querySelector<HTMLOutputElement>('#zoom-level')!;
  const drawMode=form.querySelector<HTMLButtonElement>('#pointer-draw')!,panMode=form.querySelector<HTMLButtonElement>('#pointer-pan')!;
  title.value=draft.title;caption.value=draft.caption;tags.value=draft.tags;picker.value=draft.color;size.value=String(draft.size);paperSelect.value=paperFor(canvas.width,canvas.height);
  if(draft.title||draft.caption||draft.tags)form.querySelector<HTMLDetailsElement>('details')!.open=true;
  const alive=()=>active&&!signal.aborted;
  const frozen=()=>!!draft.attempt||draft.pending;
  let panning=false;

  // Normal view fits the paper to the column and to the screen height; the expanded view fits it to the whole screen.
  const expanded=()=>container.classList.contains('is-expanded');
  // The tool rows stay pinned while the page scrolls, so what is left of the screen is the room for the paper and the Post row.
  const controls=form.querySelector<HTMLElement>('.draw-controls')!,postRow=form.querySelector<HTMLElement>('.post-row')!;
  const roomHeight=()=>Math.max(320,window.innerHeight-controls.offsetHeight-postRow.offsetHeight-40);
  const stage=createStage({
    stage:stageElement,content:canvas,size:()=>({width:canvas.width,height:canvas.height}),
    box:()=>expanded()?{width:stageElement.clientWidth,height:stageElement.clientHeight}:{width:stageElement.clientWidth,height:roomHeight()},
    changed:()=>{zoomLevel.textContent=stage.label();stageElement.style.maxHeight=expanded()?'':`${roomHeight()}px`;}
  });
  const surface=attachCanvas(canvas,{
    canDraw:()=>!frozen(),
    // Brush sizes are relative to Standard paper, so Fine/Medium/Broad look the same on Large.
    brush:()=>({color:draft.tool==='eraser'?'#ffffff':draft.color,size:draft.size*canvas.width/BRUSH_REFERENCE_WIDTH}),
    changed:()=>{draft.ink=true;draft.error='';sync();},
    record:stroke=>{draft.history.push(stroke);draft.history.trim(paperRenderer(canvas.width,canvas.height));sync();},
    pan:{active:()=>panning,by:(dx,dy)=>stage.panBy(dx,dy)}
  });

  // A focused canvas lets Ctrl/Cmd+Z reach the drawing after the last stroke.
  const focusCanvas=()=>canvas.focus({preventScroll:true});
  canvas.addEventListener('pointerdown',focusCanvas);
  function sync(){
    const locked=frozen();
    for(const field of [title,caption,tags])field.readOnly=locked;
    // Expand is only a view, so it stays usable while a post is unconfirmed.
    form.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('.draw-toolbar button:not(#expand-drawing),.draw-toolbar input,.draw-toolbar select').forEach(control=>{control.disabled=locked;});
    // Undo, Redo and Clear only apply to an editable draft that has something to act on.
    undoButton.disabled=locked||!draft.history.canUndo();redoButton.disabled=locked||!draft.history.canRedo();clear.disabled=locked||!draft.ink;
    paperSelect.disabled=locked;
    pen.setAttribute('aria-pressed',String(draft.tool==='pen'));eraser.setAttribute('aria-pressed',String(draft.tool==='eraser'));
    form.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.color===draft.color)));
    drawMode.setAttribute('aria-pressed',String(!panning));panMode.setAttribute('aria-pressed',String(panning));canvas.classList.toggle('is-pan',panning);
    post.disabled=draft.pending||(!draft.ink&&!draft.attempt);post.textContent=draft.pending?'Posting…':draft.attempt?'Retry posting':'Post drawing ↗';
    form.setAttribute('aria-busy',String(draft.pending));form.querySelector<HTMLElement>('#drawing-attempt')!.hidden=!draft.attempt;
    errorBox.hidden=!draft.error;errorBox.textContent=draft.error;
  }
  for(const field of [title,caption,tags])field.addEventListener('input',()=>{draft.title=title.value;draft.caption=caption.value;draft.tags=tags.value;draft.error='';sync();});
  pen.addEventListener('click',()=>{draft.tool='pen';sync();});eraser.addEventListener('click',()=>{draft.tool='eraser';sync();});
  form.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button=>button.addEventListener('click',()=>{draft.color=button.dataset.color!;draft.tool='pen';picker.value=draft.color;sync();}));
  picker.addEventListener('input',()=>{draft.color=picker.value;draft.tool='pen';sync();});size.addEventListener('change',()=>{draft.size=Number(size.value);});

  // History: each stroke and each Clear is one step; Undo and Redo replay from the baseline.
  function step(forward:boolean){
    if(frozen())return;
    surface.finish();
    if(!(forward?draft.history.redo():draft.history.undo()))return;
    repaint(canvas,draft.history);draft.ink=draft.history.hasInk();draft.error='';sync();
  }
  undoButton.addEventListener('click',()=>step(false));redoButton.addEventListener('click',()=>step(true));
  clear.addEventListener('click',()=>{
    if(frozen()||!draft.ink)return;
    surface.clear();draft.history.push('clear');draft.history.trim(paperRenderer(canvas.width,canvas.height));draft.ink=false;draft.error='';sync();
  });
  // Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl/Cmd+Y act on the drawing; text fields keep their own undo.
  const onKeys=(event:KeyboardEvent)=>{
    if((event.target as HTMLElement|null)?.closest?.('input,textarea,select,[contenteditable=true]'))return;
    if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
    const key=event.key.toLowerCase();
    if(key==='z'||key==='y'){event.preventDefault();step(key==='y'||event.shiftKey);}
  };
  container.addEventListener('keydown',onKeys);

  // Pointer mode, zoom, paper, and expand.
  const setPan=(on:boolean)=>{panning=on;sync();};
  drawMode.addEventListener('click',()=>setPan(false));panMode.addEventListener('click',()=>setPan(true));
  form.querySelector<HTMLButtonElement>('#zoom-in')!.addEventListener('click',()=>stage.zoomIn());
  form.querySelector<HTMLButtonElement>('#zoom-out')!.addEventListener('click',()=>stage.zoomOut());
  form.querySelector<HTMLButtonElement>('#zoom-fit')!.addEventListener('click',()=>stage.fit());
  form.querySelector<HTMLButtonElement>('#zoom-actual')!.addEventListener('click',()=>stage.actual());
  // Download what is on the paper now (or, while a post is unconfirmed, exactly the bytes being sent). A local file only; nothing is posted.
  form.querySelector<HTMLButtonElement>('#download-draft')!.addEventListener('click',async()=>{
    surface.finish();
    const blob=draft.attempt?.blob??await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob){toast?.('The canvas could not be saved.');return;}
    saveBlob(blob,'drawing-draft.png');toast?.('Drawing saved to your downloads.');
  });
  // Changing paper means a new drawing: never resize or resample ink, and never silently discard it.
  paperSelect.addEventListener('change',()=>{
    const next=paperSelect.value as PaperSize,current=paperFor(canvas.width,canvas.height);
    if(next===current||frozen()){paperSelect.value=current;return;}
    if(draft.ink&&!window.confirm('Changing the paper size starts a new, blank drawing. Discard this one?')){paperSelect.value=current;return;}
    surface.finish();
    canvas.width=PAPER_SIZES[next].width;canvas.height=PAPER_SIZES[next].height;
    const context=canvas.getContext('2d',{alpha:false});if(context)paintPaper(context,canvas.width,canvas.height);
    draft.history.reset();draft.ink=false;draft.error='';stage.fit();sync();
  });
  const previousRole=container.getAttribute('role');
  function setExpanded(on:boolean){
    container.classList.toggle('is-expanded',on);document.documentElement.classList.toggle('drawing-expanded',on);
    expand.textContent=on?'Exit expanded view':'Expand';
    if(on){container.setAttribute('role','dialog');container.setAttribute('aria-modal','true');container.setAttribute('aria-label','Drawing workspace');}
    else{container.removeAttribute('aria-modal');container.removeAttribute('aria-label');if(previousRole)container.setAttribute('role',previousRole);else container.removeAttribute('role');}
    setOthersInert(container,on);
    // Wait for the new layout before measuring the room.
    requestAnimationFrame(()=>{if(alive())stage.refit();});
  }
  expand.addEventListener('click',()=>setExpanded(!expanded()));
  const onEscape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&expanded()){event.preventDefault();setExpanded(false);expand.focus();}};
  document.addEventListener('keydown',onEscape);
  const onResize=()=>requestAnimationFrame(()=>{if(alive())stage.refit();});
  window.addEventListener('resize',onResize);
  // The composer may have been hidden (Write tab) while the window changed size.
  const onShown=()=>requestAnimationFrame(()=>{if(alive())stage.refit();});
  container.addEventListener('drawing-shown',onShown);

  form.addEventListener('submit',async event=>{
    event.preventDefault();if(draft.pending||(!draft.ink&&!draft.attempt))return;
    draft.pending=true;draft.error='';surface.finish();sync();
    try{
      let attempt=draft.attempt;
      if(!attempt){
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('The canvas could not be saved.')),'image/png'));
        if(blob.size>MAX_IMAGE_BYTES)throw new ApiError(`This drawing is ${(blob.size/MIB).toFixed(1)} MiB as a PNG; the limit is ${MAX_IMAGE_BYTES/MIB} MiB. ${paperFor(canvas.width,canvas.height)==='large'?'Try Standard paper, or simplify the drawing.':'Try simplifying the drawing.'} Nothing has been changed.`,413,'IMAGE_SIZE');
        attempt=draft.begin(blob);
      }
      const data=new FormData();data.set('kind','drawing');data.set('requestId',attempt.requestId);data.set('title',attempt.title??'');data.set('caption',attempt.caption);data.set('tags',JSON.stringify(attempt.tags));data.set('image',attempt.blob,'drawing.png');
      const result=await api<PostResponse>(`/api/boards/${boardId}/entries`,data,signal);
      if(!result?.entry||result.entry.kind!=='drawing'||result.entry.board_id!==boardId||typeof result.entry.id!=='string')throw new ApiError('The saved drawing could not be confirmed. Retry the same submission.',503,'UNCERTAIN_RESPONSE');
      draft.saved();if(!alive())return;
      title.value='';caption.value='';tags.value='';sync();posted(result);
    }catch(error){
      const definitive=error instanceof ApiError&&[400,409,413,415,422].includes(error.status);
      draft.failed(error instanceof DOMException&&error.name==='AbortError'?'Posting was interrupted. Retry to check the same drawing.':error instanceof Error?error.message:'Posting failed. Please retry.',definitive);
      if(alive()){sync();if(error instanceof ApiError&&error.status===401)expired('Your access expired. Unlock to continue. Your drawing is still here.');}
    }finally{draft.pending=false;if(alive())sync();}
  });
  // On a phone the view and paper controls start folded away; elsewhere they are always shown (the summary is hidden by CSS).
  const viewMore=form.querySelector<HTMLDetailsElement>('.draw-view-more')!;
  if(window.matchMedia?.('(max-width:600px)').matches)viewMore.open=false;
  sync();stage.fit();
  return ()=>{
    active=false;
    if(expanded())setExpanded(false);
    document.removeEventListener('keydown',onEscape);window.removeEventListener('resize',onResize);
    container.removeEventListener('keydown',onKeys);container.removeEventListener('drawing-shown',onShown);canvas.removeEventListener('pointerdown',focusCanvas);
    stage.dispose();surface.dispose();
  };
}
