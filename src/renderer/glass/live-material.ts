/** The upstream feImage is a shape/vector field, never a page snapshot.
 * Chromium samples the native backdrop continuously. This controller changes
 * only the local SVG optical parameters and a separate reflection layer. */
import {getGlassIntensity,subscribeGlassIntensity} from './material-intensity';
import {localBezelProfile} from '../vendor/liquid-glass-react/local-bezel';
export type MaterialPoint={x:number;y:number};
export type LiveMaterialSample={pointer:MaterialPoint;pressure:number;energy:number;bend:MaterialPoint;velocity:MaterialPoint;engaged:boolean;reduced:boolean;intensity:number};
type Optics={pressure?:number;energy?:number;bend?:number[]|MaterialPoint;velocity?:number[]|MaterialPoint};
type LiveMaterial={read:()=>void;write:(now:number)=>boolean;dispose:()=>void};
const pending=new Set<LiveMaterial>();
let frame=0;
function wake(material:LiveMaterial):void {
  pending.add(material);
  if(!frame)frame=requestAnimationFrame(tick);
}
function tick(now:number):void {
  frame=0;
  const batch=[...pending];pending.clear();
  // Every affected source read precedes every SVG/style write. A pointer frame
  // never queries or iterates all page controls.
  for(const material of batch)material.read();
  for(const material of batch)if(material.write(now))pending.add(material);
  if(pending.size)frame=requestAnimationFrame(tick);
}
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const fixed=(value:number)=>value.toFixed(3);

export function createLiveMaterial(node:HTMLElement,source:HTMLElement,onFrame?:(sample:LiveMaterialSample)=>void):()=>void {
  const filters=[...node.querySelectorAll<SVGElement>('feDisplacementMap')];
  const alpha=node.querySelector<SVGElement>('feComponentTransfer[in="EDGE_INTENSITY"] feFuncA');
  const originalScales=filters.map(filter=>filter.getAttribute('scale'));
  const originalAlpha=alpha?.getAttribute('tableValues')??null;
  const glint=document.createElement('span');glint.className='rdev-live-glint';glint.setAttribute('aria-hidden','true');node.append(glint);
  const shadow=document.createElement('span');shadow.className='rdev-live-shadow';shadow.setAttribute('aria-hidden','true');node.prepend(shadow);
  const abort=new AbortController(),signal=abort.signal;
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let reduced=media.matches,hover=matchMedia('(hover: hover) and (pointer: fine)').matches&&source.matches(':hover'),held=Boolean(node.closest('[data-held="true"]')),focus=source.contains(document.activeElement),pointerId:number|null=null;
  let pointX=0,pointY=0,previousX=0,previousY=0,previousTime=0,velocity=0,velocityX=0,velocityY=0,scrollEnergy=0;
  let width=1,height=1,shadowWidth=1,shadowHeight=1,rect:DOMRect|null=null,geometryDirty=true,last=0,lastInput=0,disposed=false;
  let pressure=0,energy=0,bendX=0,bendY=0,materialPressure=0,materialEnergy=0,engagement=0,previousSignature='';
  const changed=()=>{if(disposed)return;lastInput=performance.now();if(!document.hidden)wake(material);};
  const enabled=()=>!source.matches(':disabled')&&!source.closest('[aria-disabled="true"],[inert]')&&(!source.matches('.lg-segment-bar')||Boolean(source.querySelector('button:not(:disabled):not([aria-disabled="true"])')));
  const sample=(event:PointerEvent)=>{
    if(pointerId!==null&&event.pointerId!==pointerId)return;
    const at=event.timeStamp||performance.now(),dt=clamp(at-previousTime,4,80);
    if(previousTime){velocityX=clamp((event.clientX-previousX)/dt*1000,-2400,2400);velocityY=clamp((event.clientY-previousY)/dt*1000,-2400,2400);velocity=clamp(Math.hypot(velocityX,velocityY)/1800,0,1);}
    pointX=previousX=event.clientX;pointY=previousY=event.clientY;previousTime=at;changed();
  };
  const reset=()=>{held=false;pointerId=null;hover=false;pressure=energy=0;changed();};
  source.addEventListener('pointerenter',event=>{if(!enabled()||event.pointerType==='touch')return;hover=true;geometryDirty=true;sample(event);},{signal,passive:true});
  source.addEventListener('pointermove',event=>{if(enabled()&&!reduced)sample(event);},{signal,passive:true});
  source.addEventListener('pointerleave',()=>{hover=false;if(!held){previousTime=0;changed();}},{signal});
  source.addEventListener('pointerdown',event=>{if(!enabled()||event.button!==0||!event.isPrimary)return;held=true;pointerId=event.pointerId;geometryDirty=true;sample(event);},{signal,passive:true});
  window.addEventListener('pointermove',event=>{if(held&&!source.contains(event.target as Node)&&!reduced)sample(event);},{signal,passive:true});
  const end=(event:PointerEvent)=>{if(event.pointerId!==pointerId)return;held=false;pointerId=null;pressure=0;changed();};
  window.addEventListener('pointerup',end,{signal});window.addEventListener('pointercancel',end,{signal});
  window.addEventListener('blur',reset,{signal});
  source.addEventListener('focusin',()=>{focus=true;changed();},{signal});
  source.addEventListener('focusout',event=>{focus=event.relatedTarget instanceof Node&&source.contains(event.relatedTarget);changed();},{signal});
  const optical=(event:Event)=>{
    // A toolbar does not consume a nested switch's spring event.
    // A native range input is a sibling hit target, not the thumb's parent.
    // Accept its explicitly bound event as well as a containing Jelly body.
    if(event.target!==source&&(!(event.target instanceof Node)||!event.target.contains(node)))return;
    const detail=(event as CustomEvent<Optics>).detail;if(!detail)return;
    if(detail.pressure!==undefined)pressure=detail.pressure;
    if(detail.energy!==undefined)energy=detail.energy;
    if(detail.bend){const bend=Array.isArray(detail.bend)?{x:detail.bend[0]??0,y:detail.bend[1]??0}:detail.bend;bendX=bend.x;bendY=bend.y;}
    if(detail.velocity){const speed=Array.isArray(detail.velocity)?{x:detail.velocity[0]??0,y:detail.velocity[1]??0}:detail.velocity;velocityX=speed.x;velocityY=speed.y;velocity=clamp(Math.hypot(velocityX,velocityY)/1800,0,1);}
    changed();
  };
  source.addEventListener('lg:optics',optical,{signal});
  source.addEventListener('lg:material',optical,{signal});
  source.addEventListener('lg:gesture',event=>{
    if(event.target!==source)return;
    const phase=(event as CustomEvent<{phase:string}>).detail?.phase;
    if(phase==='end'||phase==='cancel'){
      held=false;pointerId=null;pressure=0;
      if(phase==='cancel'){energy=velocity=velocityX=velocityY=scrollEnergy=bendX=bendY=materialPressure=materialEnergy=0;}
      changed();
    }
  },{signal});
  window.addEventListener('scroll',event=>{
    if(!(hover||held||focus))return;
    const target=event.target;
    if(target===document||target===window||target instanceof Node&&(target.contains(source)||source.contains(target))){geometryDirty=true;scrollEnergy=reduced?0:.6;changed();}
  },{capture:true,passive:true,signal});
  window.addEventListener('resize',()=>{geometryDirty=true;if(hover||held||focus)changed();},{passive:true,signal});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){
      held=hover=false;pointerId=null;previousTime=last=0;
      velocity=velocityX=velocityY=scrollEnergy=pressure=energy=bendX=bendY=materialPressure=materialEnergy=0;
      pending.delete(material);if(!pending.size&&frame){cancelAnimationFrame(frame);frame=0;}
      previousSignature='';
    }else{focus=source.contains(document.activeElement);geometryDirty=true;changed();}
  },{signal});
  media.addEventListener('change',event=>{reduced=event.matches;velocity=velocityX=velocityY=scrollEnergy=pressure=energy=0;changed();},{signal});
  const resize=new ResizeObserver(records=>{
    const box=records[0]?.contentRect;if(box){width=Math.max(1,box.width);height=Math.max(1,box.height);}geometryDirty=true;changed();
  });resize.observe(source);if(source!==node)resize.observe(node);
  const material:LiveMaterial={
    read(){if(disposed)return;shadowWidth=Math.max(1,node.offsetWidth);shadowHeight=Math.max(1,node.offsetHeight);if(geometryDirty){rect=source.getBoundingClientRect();width=Math.max(1,rect.width||width);height=Math.max(1,rect.height||height);if(!previousTime){pointX=rect.left+width/2;pointY=rect.top+height/2;}geometryDirty=false;}},
    write(now){
      if(disposed||document.hidden)return false;
      const dt=last?Math.min(.05,(now-last)/1000):1/60;last=now;
      const live=enabled(),engaged=live&&(hover||held||focus);
      if(!live){held=false;hover=false;focus=false;pressure=energy=0;}
      const nx=!reduced&&rect&&(hover||held)?clamp((pointX-rect.left)/width*2-1,-1,1):0;
      const ny=!reduced&&rect&&(hover||held)?clamp((pointY-rect.top)/height*2-1,-1,1):0;
      if(now-lastInput>20){const decay=Math.exp(-dt*15);velocity*=decay;velocityX*=decay;velocityY*=decay;scrollEnergy*=Math.exp(-dt*14);}
      const targetPressure=reduced?0:Math.max(held?1:0,pressure),targetEnergy=reduced?0:clamp(energy+velocity*.55+scrollEnergy*.28,0,1);
      // Direct pressure on hold, bounded decay after release; no native label
      // transform or parent-inherited CSS variable is written here.
      materialPressure=held?targetPressure:materialPressure+(targetPressure-materialPressure)*Math.min(1,dt*25);
      materialEnergy=targetEnergy>materialEnergy?targetEnergy:materialEnergy+(targetEnergy-materialEnergy)*Math.min(1,dt*18);
      const targetEngagement=engaged?1:0;
      engagement=reduced?targetEngagement:engagement+(targetEngagement-engagement)*Math.min(1,dt*24);
      if(Math.abs(targetEngagement-engagement)<.002)engagement=targetEngagement;
      if(reduced){materialPressure=materialEnergy=0;}
      if(!held&&materialPressure<.002)materialPressure=0;
      if(materialEnergy<.002)materialEnergy=0;
      if(velocity<.002)velocity=velocityX=velocityY=0;if(scrollEnergy<.002)scrollEnergy=0;
      if(!held){if(pressure<.002)pressure=0;if(energy<.002)energy=0;if(Math.abs(bendX)<.005)bendX=0;if(Math.abs(bendY)<.005)bendY=0;}
      const intensity=getGlassIntensity();
      // Optical depth is local to this lens. Ordinary pointer travel changes
      // lighting/shadow only, never refraction depth, spectrum or base tint.
      // The map encodes signed offsets around .5. Its physical depth is twice
      // the local maximum offset, not an arbitrary amplitude on a cropped JPEG.
      const baseDepth=localBezelProfile(shadowWidth,shadowHeight).maxOffset*2;
      const depth=baseDepth*(1+materialPressure*.10)*intensity;
      const aberration=2;
      const elevation=reduced?2:2+4*materialPressure+materialEnergy*2;
      const shadowX=reduced?0:-nx*(4+elevation*.55)+bendX*.25+velocityX/1800*2;
      const shadowY=3+elevation*.75+(reduced?0:ny*(3+elevation*.3)+bendY*.35+velocityY/1800*2);
      const spread=1.5+elevation*.7;
      const shadowScaleX=1+spread*2/shadowWidth,shadowScaleY=1+spread*2/shadowHeight;
      const shadowOpacity=clamp((.28+materialPressure*.22+materialEnergy*.1)*intensity,0,.72);
      const signature=[depth,aberration,nx,ny,materialPressure,materialEnergy,engagement,shadowX,shadowY,shadowScaleX,shadowScaleY,shadowOpacity].map(fixed).join('|');
      if(signature!==previousSignature){
        filters.forEach((filter,index)=>{const scale=fixed(-depth*(1+index*.1));if(filter.getAttribute('scale')!==scale)filter.setAttribute('scale',scale);});
        // The glint's gradient is static; transform/opacity move its cached
        // silhouette instead of repainting a gradient on every pointer frame.
        glint.style.transform=`translate3d(${fixed(nx*8)}%,${fixed(ny*6)}%,0) scale(${fixed(1+materialPressure*.08)})`;
        glint.style.opacity=fixed((.28+engagement*.22)*intensity);
        // A fixed blurred silhouette is cached locally. Motion only changes
        // its compositor transform/opacity, never a per-frame box-shadow.
        shadow.style.transform=`translate3d(${fixed(shadowX)}px,${fixed(shadowY)}px,0) scale(${fixed(shadowScaleX)},${fixed(shadowScaleY)})`;
        shadow.style.opacity=fixed(shadowOpacity);
        node.dataset.liquidGlassLive=filters.length?'native-backdrop':'browser-backdrop';previousSignature=signature;
        onFrame?.({pointer:{x:nx,y:ny},pressure:materialPressure,energy:materialEnergy,bend:{x:bendX,y:bendY},velocity:{x:velocityX,y:velocityY},engaged,reduced,intensity});
      }
      if(!held){pressure*=Math.exp(-dt*24);energy*=Math.exp(-dt*20);bendX*=Math.exp(-dt*18);bendY*=Math.exp(-dt*18);}
      const settling=!reduced&&(Math.abs(engagement-targetEngagement)>.002||velocity>.002||scrollEnergy>.002||Math.abs(materialPressure-targetPressure)>.002||materialPressure>.002&&!held||materialEnergy>.002||Math.abs(bendX)+Math.abs(bendY)>.005);
      if(!settling){last=0;velocity=velocityX=velocityY=scrollEnergy=0;}
      return settling;
    },
    dispose(){
      disposed=true;unsubscribeIntensity();abort.abort();resize.disconnect();glint.remove();shadow.remove();node.style.removeProperty('--material-highlight');delete node.dataset.liquidGlassLive;
      filters.forEach((filter,index)=>{const value=originalScales[index];if(value===null)filter.removeAttribute('scale');else filter.setAttribute('scale',value);});
      if(alpha){if(originalAlpha===null)alpha.removeAttribute('tableValues');else alpha.setAttribute('tableValues',originalAlpha);}
      pending.delete(material);if(!pending.size&&frame){cancelAnimationFrame(frame);frame=0;}
    }
  };
  const unsubscribeIntensity=subscribeGlassIntensity(changed);
  changed();
  return ()=>material.dispose();
}
