/** Whisper Studio's size adapter for the original rdev SVG graph.
 * Generates a shape vector field, never a page/image capture. Its R/B channels
 * encode signed local X/Y refraction; alpha is an explicit local bezel mask.
 * Work occurs only for structural size/radius changes, with bounded caching. */
export type LocalBezelMap={url:string;width:number;height:number;pixels:number;bezel:number;maxOffset:number};
const cache=new Map<string,LocalBezelMap>();
const MAX_PIXELS=32_768,MAX_WIDTH=384,MAX_HEIGHT=192,MAX_ENTRIES=8;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
export function localBezelProfile(width:number,height:number) {
  const short=Math.max(1,Math.min(width,height));
  return{bezel:clamp(short*.24,3,14),maxOffset:clamp(short*.30,2,14)};
}
export function createLocalBezelMap(width:number,height:number,cornerRadius:number):LocalBezelMap {
  const cssWidth=Math.max(1,Math.round(width)),cssHeight=Math.max(1,Math.round(height));
  const radius=clamp(cornerRadius,0,Math.min(cssWidth,cssHeight)/2);
  const key=`${cssWidth}:${cssHeight}:${radius.toFixed(2)}`;
  const existing=cache.get(key);if(existing){cache.delete(key);cache.set(key,existing);return existing;}
  const scale=Math.min(1,MAX_WIDTH/cssWidth,MAX_HEIGHT/cssHeight,Math.sqrt(MAX_PIXELS/(cssWidth*cssHeight)));
  const mapWidth=Math.max(1,Math.floor(cssWidth*scale)),mapHeight=Math.max(1,Math.floor(cssHeight*scale));
  const canvas=document.createElement('canvas');canvas.width=mapWidth;canvas.height=mapHeight;
  const context=canvas.getContext('2d');if(!context)throw new Error('Local glass vector field is unavailable.');
  const image=context.createImageData(mapWidth,mapHeight),{bezel,maxOffset}=localBezelProfile(cssWidth,cssHeight);
  for(let y=0;y<mapHeight;y++)for(let x=0;x<mapWidth;x++){
    const px=(x+.5)/mapWidth*cssWidth-cssWidth/2,py=(y+.5)/mapHeight*cssHeight-cssHeight/2;
    const qx=Math.abs(px)-(cssWidth/2-radius),qy=Math.abs(py)-(cssHeight/2-radius);
    const ox=Math.max(qx,0),oy=Math.max(qy,0),length=Math.hypot(ox,oy);
    const distance=length+Math.min(Math.max(qx,qy),0)-radius,depth=Math.max(0,-distance);
    let nx=0,ny=0;
    if(length>1e-6){nx=Math.sign(px)*ox/length;ny=Math.sign(py)*oy/length;}
    else if(qx>qy)nx=Math.sign(px);else ny=Math.sign(py);
    // Circular bezel normal + Snell transmission. The offset approaches zero
    // at the inner bezel and never exceeds this lens's local physical bound.
    const edge=clamp(1-depth/bezel,0,.995),incident=Math.asin(edge);
    const transmitted=Math.asin(Math.sin(incident)/1.45);
    const offset=Math.min(maxOffset,Math.tan(incident-transmitted)*bezel*.85);
    const inner=clamp((bezel-depth)/Math.max(.75,1/scale),0,1),mask=inner*inner*(3-2*inner);
    const index=(y*mapWidth+x)*4;
    image.data[index]=Math.round((.5+nx*offset/(2*maxOffset))*255);
    image.data[index+1]=image.data[index+2]=Math.round((.5+ny*offset/(2*maxOffset))*255);
    image.data[index+3]=Math.round(mask*255);
  }
  context.putImageData(image,0,0);
  const result={url:canvas.toDataURL('image/png'),width:cssWidth,height:cssHeight,pixels:mapWidth*mapHeight,bezel,maxOffset};
  canvas.width=canvas.height=1;cache.set(key,result);if(cache.size>MAX_ENTRIES)cache.delete(cache.keys().next().value!);return result;
}
