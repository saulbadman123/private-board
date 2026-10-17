import {HttpError} from './errors.ts';
import {checksum,MAX_DRAWING_REQUEST,MAX_IMAGE_BYTES,optimizeDrawing} from './images.ts';
import {prepareNote,NoteStoreError} from './notes.ts';
import type {Store} from './types.ts';

async function multipart(request:Request):Promise<FormData>{
  const type=request.headers.get('content-type')??'';
  if(!/^multipart\/form-data\s*;/i.test(type))throw new HttpError(415,'CONTENT_TYPE','Send a drawing as multipart form data.');
  const length=request.headers.get('content-length');
  if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_DRAWING_REQUEST))throw new HttpError(413,'TOO_LARGE','This upload is too large.');
  const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'DRAWING','The drawing upload is empty.');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_DRAWING_REQUEST){await reader.cancel();throw new HttpError(413,'TOO_LARGE','This upload is too large.');}chunks.push(value);}
  try{
    const data=await new Response(Buffer.concat(chunks),{headers:{'content-type':type}}).formData();
    const allowed=['kind','requestId','title','caption','tags','image'];
    if([...data.keys()].some(k=>!allowed.includes(k)||data.getAll(k).length!==1))throw new Error();
    return data;
  }catch{throw new HttpError(400,'DRAWING','The drawing upload is invalid.');}
}

export async function postDrawing(request:Request,store:Store,boardId:string,tokenHash:string){
  const data=await multipart(request);
  const image=data.get('image');
  if(data.get('kind')!=='drawing'||!(image instanceof Blob)||image.size===0)throw new HttpError(400,'DRAWING','Include a drawing to post.');
  if(image.size>MAX_IMAGE_BYTES)throw new HttpError(413,'IMAGE_SIZE','Keep drawings within 3 MiB.');
  function text(name:string,fallback=''){const value=data.get(name)??fallback;if(typeof value!=='string'||value.length>8192)throw new HttpError(400,'DRAWING','The drawing details are invalid.');return value;}
  let tags:unknown;try{tags=JSON.parse(text('tags','[]'));}catch{throw new HttpError(400,'DRAWING','The drawing tags are invalid.');}
  const meta=prepareNote({kind:'note',requestId:text('requestId'),title:text('title'),tags,markdown:'drawing'});
  const caption=text('caption').trim();
  if([...caption].length>280||caption.includes('\u0000')||Buffer.from(caption).toString('utf8')!==caption)throw new HttpError(400,'DRAWING','Use a description of up to 280 characters.');
  const input=Buffer.from(await image.arrayBuffer());
  const hash=checksum(Buffer.from(JSON.stringify(['drawing',meta.title,caption,meta.tags,checksum(input)])));
  const previous=await store.submission(boardId,meta.requestId);
  if(previous){if(previous.hash!==hash||previous.entry.kind!=='drawing')throw new NoteStoreError('CONFLICT');return {entry:previous.entry,replayed:true};}
  const optimized=await optimizeDrawing(input,image.type);
  const objectKey=`${boardId}/${meta.requestId}/${optimized.sha256}.${optimized.extension}`;
  await store.putDrawing(objectKey,optimized.bytes,optimized.mime);
  return store.postDrawing({boardId,tokenHash,requestId:meta.requestId,hash,title:meta.title,caption:caption||null,tags:meta.tags,objectKey,width:optimized.width,height:optimized.height,mime:optimized.mime,bytes:optimized.bytes.length,sha256:optimized.sha256});
}
