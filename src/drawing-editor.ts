import {api,ApiError} from './api.ts';
import type {PostResponse} from '../shared/contracts.ts';
import {drawingDraftFor} from './drafts.ts';
import {attachCanvas} from './canvas.ts';

type Options={boardId:string;container:HTMLElement;signal:AbortSignal;posted:(result:PostResponse)=>void;expired:(message:string)=>void};
export function mountDrawing({boardId,container,signal,posted,expired}:Options):()=>void{
  const draft=drawingDraftFor(boardId);let active=true;
  container.innerHTML=`<div class="composer-heading"><div><h2>Put a little ink down.</h2><p>A quick sketch. A thought without words.</p></div></div><form id="drawing-form"><div class="draw-toolbar"><div class="draw-tools" role="group" aria-label="Drawing tool"><button id="draw-pen" type="button" aria-pressed="true">Pen</button><button id="draw-eraser" type="button" aria-pressed="false">Eraser</button></div><div class="draw-colors" role="group" aria-label="Pen color">${['#222824','#b93e43','#dc8e22','#327657','#356eae','#8252a4'].map((color,i)=>`<button type="button" class="color-swatch swatch-${i}" data-color="${color}" aria-label="${['Charcoal','Red','Gold','Green','Blue','Purple'][i]}" aria-pressed="false"></button>`).join('')}<label class="custom-color">Custom<input id="draw-color" type="color" aria-label="Custom pen color"/></label></div><label class="brush-size">Size<select id="draw-size" aria-label="Brush size"><option value="3">Fine</option><option value="6">Medium</option><option value="14">Broad</option></select></label><button id="clear-drawing" type="button" class="clear-drawing">Clear draft</button></div><div id="canvas-slot" class="canvas-slot"></div><p class="draw-help">Draw with your finger, mouse, or pen. Scroll outside the paper.</p><details class="drawing-details"><summary>Title, description & tags <span>(optional)</span></summary><div class="field"><label for="draw-title">Title</label><input id="draw-title" maxlength="120" placeholder="Give your sketch a name"/></div><div class="field"><label for="draw-caption">Description</label><textarea id="draw-caption" maxlength="280" rows="2" placeholder="A short description for readers who cannot see the drawing"></textarea></div><div class="field"><label for="draw-tags">Tags</label><input id="draw-tags" placeholder="sketch, ideas"/><small>Up to five tags, separated by commas.</small></div></details><p id="drawing-attempt" class="soft-notice" hidden>This drawing is awaiting confirmation. Retry checks the same submission without changing or duplicating it.</p><p id="drawing-error" class="form-error" role="alert" hidden></p><div class="post-row"><p>Posts are permanent.<br/><span>Check before posting.</span></p><button class="primary" type="submit" id="post-drawing">Post drawing ↗</button></div></form>`;
  const form=container.querySelector<HTMLFormElement>('#drawing-form')!;
  if(!draft.canvas){
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=768;
    canvas.setAttribute('aria-label','Drawing paper. Use touch, mouse, or pen to sketch.');canvas.setAttribute('role','img');
    const ctx=canvas.getContext('2d',{alpha:false});
    if(!ctx)throw new Error('This browser could not open a drawing canvas. You can still write a note.');
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1024,768);draft.canvas=canvas;
  }
  container.querySelector('#canvas-slot')!.append(draft.canvas);
  const canvas=draft.canvas;
  const title=form.querySelector<HTMLInputElement>('#draw-title')!,caption=form.querySelector<HTMLTextAreaElement>('#draw-caption')!,tags=form.querySelector<HTMLInputElement>('#draw-tags')!;
  const errorBox=form.querySelector<HTMLElement>('#drawing-error')!,post=form.querySelector<HTMLButtonElement>('#post-drawing')!;
  const pen=form.querySelector<HTMLButtonElement>('#draw-pen')!,eraser=form.querySelector<HTMLButtonElement>('#draw-eraser')!;
  const picker=form.querySelector<HTMLInputElement>('#draw-color')!,size=form.querySelector<HTMLSelectElement>('#draw-size')!;
  const clear=form.querySelector<HTMLButtonElement>('#clear-drawing')!;
  title.value=draft.title;caption.value=draft.caption;tags.value=draft.tags;picker.value=draft.color;size.value=String(draft.size);
  if(draft.title||draft.caption||draft.tags)form.querySelector<HTMLDetailsElement>('details')!.open=true;
  const alive=()=>active&&!signal.aborted;
  function sync(){
    const frozen=!!draft.attempt||draft.pending;
    for(const field of [title,caption,tags])field.readOnly=frozen;
    form.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('.draw-toolbar button,.draw-toolbar input,.draw-toolbar select').forEach(control=>{control.disabled=frozen;});
    pen.setAttribute('aria-pressed',String(draft.tool==='pen'));eraser.setAttribute('aria-pressed',String(draft.tool==='eraser'));
    form.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.color===draft.color)));
    post.disabled=draft.pending||(!draft.ink&&!draft.attempt);post.textContent=draft.pending?'Posting…':draft.attempt?'Retry posting':'Post drawing ↗';
    form.setAttribute('aria-busy',String(draft.pending));form.querySelector<HTMLElement>('#drawing-attempt')!.hidden=!draft.attempt;
    errorBox.hidden=!draft.error;errorBox.textContent=draft.error;
  }
  const surface=attachCanvas(canvas,{canDraw:()=>!draft.pending&&!draft.attempt,brush:()=>({color:draft.tool==='eraser'?'#ffffff':draft.color,size:draft.size}),changed:()=>{draft.ink=true;draft.error='';sync();}});
  for(const field of [title,caption,tags])field.addEventListener('input',()=>{draft.title=title.value;draft.caption=caption.value;draft.tags=tags.value;draft.error='';sync();});
  pen.addEventListener('click',()=>{draft.tool='pen';sync();});eraser.addEventListener('click',()=>{draft.tool='eraser';sync();});
  form.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button=>button.addEventListener('click',()=>{draft.color=button.dataset.color!;draft.tool='pen';picker.value=draft.color;sync();}));
  picker.addEventListener('input',()=>{draft.color=picker.value;draft.tool='pen';sync();});size.addEventListener('change',()=>{draft.size=Number(size.value);});
  clear.addEventListener('click',()=>{if(draft.ink&&!window.confirm('Clear this unsaved drawing?'))return;surface.clear();draft.ink=false;draft.error='';sync();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(draft.pending||(!draft.ink&&!draft.attempt))return;
    draft.pending=true;draft.error='';surface.finish();sync();
    try{
      let attempt=draft.attempt;
      if(!attempt){
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('The canvas could not be saved.')),'image/png'));
        if(blob.size>3*1024*1024)throw new ApiError('This drawing is too large. Try simplifying it before posting.',413,'IMAGE_SIZE');
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
  sync();return ()=>{active=false;surface.dispose();};
}
