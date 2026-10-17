import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {HttpError} from './errors.ts';
export const MAX_IMAGE_BYTES=3*1024*1024;
export const MAX_DRAWING_REQUEST=3.5*1024*1024;
export const checksum=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
let processing=0;

function formatOf(data:Buffer):'png'|'webp'{
  if(data.length>=20&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    let offset=8;
    while(offset+12<=data.length){const length=data.readUInt32BE(offset);const kind=data.toString('ascii',offset+4,offset+8);if(['acTL','fcTL','fdAT'].includes(kind))throw new HttpError(400,'IMAGE','Animated images are not supported.');if(length>data.length-offset-12)break;offset+=12+length;if(kind==='IEND')break;}
    return 'png';
  }
  if(data.length>=20&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'){
    let offset=12;
    while(offset+8<=data.length){const kind=data.toString('ascii',offset,offset+4);const length=data.readUInt32LE(offset+4);if(['ANIM','ANMF'].includes(kind))throw new HttpError(400,'IMAGE','Animated images are not supported.');if(length>data.length-offset-8)break;offset+=8+length+(length%2);}
    return 'webp';
  }
  throw new HttpError(400,'IMAGE','Use a PNG or WebP drawing.');
}

export async function optimizeDrawing(input:Buffer,declaredMime:string){
  if(!input.length||input.length>MAX_IMAGE_BYTES)throw new HttpError(413,'IMAGE_SIZE','Keep drawings within 3 MiB.');
  const format=formatOf(input);
  if(declaredMime!==`image/${format}`)throw new HttpError(400,'IMAGE','The image type does not match its contents.');
  if(processing>=2)throw new HttpError(503,'BUSY','Drawing processing is busy. Retry in a moment.',2);
  processing++;
  try{
    const source=sharp(input,{limitInputPixels:1024*768,failOn:'warning',animated:false});
    const metadata=await source.metadata();
    if(metadata.format!==format||!metadata.width||!metadata.height||metadata.width>1024||metadata.height>768||(metadata.pages??1)!==1)throw new HttpError(400,'IMAGE','Drawings must be a single image, up to 1024 × 768 pixels.');
    const pipeline=source.flatten({background:'#ffffff'}).toColourspace('srgb').removeAlpha();
    const png=await pipeline.clone().png({compressionLevel:9,adaptiveFiltering:true}).timeout({seconds:5}).toBuffer();
    const webp=await pipeline.clone().webp({lossless:true,effort:4}).timeout({seconds:5}).toBuffer();
    const useWebp=webp.length<png.length;
    const bytes=useWebp?webp:png;
    if(bytes.length>MAX_IMAGE_BYTES)throw new HttpError(413,'IMAGE_SIZE','This drawing is too large to store. Your draft is still available.');
    return {bytes,mime:useWebp?'image/webp' as const:'image/png' as const,extension:useWebp?'webp':'png',width:metadata.width,height:metadata.height,sha256:checksum(bytes)};
  }catch(error){
    if(error instanceof HttpError)throw error;
    throw new HttpError(400,'IMAGE','This image could not be decoded safely. Try clearing and redrawing the canvas.');
  }finally{processing--;}
}
