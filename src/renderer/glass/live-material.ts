/** The upstream feImage is a shape/vector field, never a page snapshot.
 * Chromium samples the native backdrop continuously. This controller changes
 * only the local SVG optical parameters and a separate reflection layer. */
type Optics={pressure?:number;energy?:number;bend?:number[];velocity?:number[]};
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

export function createLiveMaterial(node:HTMLElement,source:HTMLElement):()=>void {
  const filters=[...node.querySelectorAll<SVGElement>('feDisplacementMap')];
  const alpha=node.querySelector<SVGElement>('feComponentTransfer[in="EDGE_INTENSITY"] feFuncA');
  if(filters.length!==3)return ()=>{};
  const originalScales=filters.map(filter=>filter.getAttribute('scale'));
  const originalAlpha=alpha?.getAttribute('tableValues')??null;
  const glint=document.createElement('span');glint.className='rdev-live-glint';glint.setAttribute('aria-hidden','true');node.append(glint);
  const abort=new AbortController(),signal=abort.signal;
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let reduced=media.matches,hover=false,held=false,focus=source.contains(document.activeElement),pointerId:number|null=null;
  let pointX=0,pointY=0,previousX=0,previousY=0,previousTime=0,velocity=0,scrollEnergy=0;
  let width=1,height=1,rect:DOMRect|null=null,geometryDirty=true,last=0,lastInput=0,disposed=false;
  let pressure=0,energy=0,bendX=0,bendY=0,materialPressure=0,materialEnergy=0,previousSignature='';
  const changed=()=>{if(disposed)return;lastInput=performance.now();if(!document.hidden)wake(material);};
  const enabled=()=>!source.matches(':disabled')&&!source.closest('[aria-disabled="true"],[inert]')&&(!source.matches('.lg-segment-bar')||Boolean(source.querySelector('button:not(:disabled):not([aria-disabled="true"])')));
  const sample=(event:PointerEvent)=>{
    if(pointerId!==null&&event.pointerId!==pointerId)return;
    const at=event.timeStamp||performance.now(),dt=clamp(at-previousTime,4,80);
    if(previousTime)velocity=clamp(Math.hypot(event.clientX-previousX,event.clientY-previousY)/dt/1.8,0,1);
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
  source.addEventListener('lg:optics',event=>{
    // A toolbar does not consume a nested switch's spring event.
    if(!(event.target instanceof Node)||!event.target.contains(node))return;
    const detail=(event as CustomEvent<Optics>).detail;if(!detail)return;
    pressure=detail.pressure??0;energy=detail.energy??0;bendX=detail.bend?.[0]??0;bendY=detail.bend?.[1]??0;
    if(detail.velocity)velocity=clamp(Math.hypot(...detail.velocity)/1800,0,1);
    changed();
  },{signal});
  source.addEventListener('lg:gesture',event=>{
    if(event.target!==source)return;
    const phase=(event as CustomEvent<{phase:string}>).detail?.phase;
    if(phase==='end'||phase==='cancel'){
      held=false;pointerId=null;pressure=0;
      if(phase==='cancel'){energy=velocity=scrollEnergy=bendX=bendY=materialPressure=materialEnergy=0;}
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
      velocity=scrollEnergy=pressure=energy=bendX=bendY=materialPressure=materialEnergy=0;
      pending.delete(material);if(!pending.size&&frame){cancelAnimationFrame(frame);frame=0;}
      previousSignature='';
    }else{focus=source.contains(document.activeElement);geometryDirty=true;changed();}
  },{signal});
  media.addEventListener('change',event=>{reduced=event.matches;velocity=scrollEnergy=pressure=energy=0;changed();},{signal});
  const resize=new ResizeObserver(records=>{
    const box=records[0]?.contentRect;if(box){width=Math.max(1,box.width);height=Math.max(1,box.height);}geometryDirty=true;changed();
  });resize.observe(source);
  const material:LiveMaterial={
    read(){if(geometryDirty&&!disposed){rect=source.getBoundingClientRect();width=Math.max(1,rect.width||width);height=Math.max(1,rect.height||height);geometryDirty=false;}},
    write(now){
      if(disposed||document.hidden)return false;
      const dt=last?Math.min(.05,(now-last)/1000):1/60;last=now;
      const live=enabled(),engaged=live&&(hover||held||focus);
      if(!live){held=false;hover=false;focus=false;pressure=energy=0;}
      const nx=!reduced&&rect&&(hover||held)?clamp((pointX-rect.left)/width*2-1,-1,1):0;
      const ny=!reduced&&rect&&(hover||held)?clamp((pointY-rect.top)/height*2-1,-1,1):0;
      if(now-lastInput>20){velocity*=Math.exp(-dt*15);scrollEnergy*=Math.exp(-dt*14);}
      const targetPressure=reduced?0:Math.max(held?1:0,pressure),targetEnergy=reduced?0:clamp(energy+velocity*.55+scrollEnergy*.28,0,1);
      // Direct pressure on hold, bounded decay after release; no native label
      // transform or parent-inherited CSS variable is written here.
      materialPressure=held?targetPressure:materialPressure+(targetPressure-materialPressure)*Math.min(1,dt*25);
      materialEnergy=targetEnergy>materialEnergy?targetEnergy:materialEnergy+(targetEnergy-materialEnergy)*Math.min(1,dt*18);
      if(reduced){materialPressure=materialEnergy=0;}
      if(!held&&materialPressure<.002)materialPressure=0;
      if(materialEnergy<.002)materialEnergy=0;
      if(velocity<.002)velocity=0;if(scrollEnergy<.002)scrollEnergy=0;
      if(!held){if(pressure<.002)pressure=0;if(energy<.002)energy=0;if(Math.abs(bendX)<.005)bendX=0;if(Math.abs(bendY)<.005)bendY=0;}
      const depth=reduced?58:58*(1+(hover?.10:0)+(focus?.07:0)+materialPressure*.25+materialEnergy*.20+nx*.045+ny*.025+clamp(bendX+bendY,-10,10)*.004);
      const aberration=reduced?2:2+materialPressure*.9+materialEnergy*.75+Math.abs(nx)*.3;
      const signature=[depth,aberration,nx,ny,materialPressure,materialEnergy,engaged?1:0].map(fixed).join('|');
      if(signature!==previousSignature){
        filters[0].setAttribute('scale',fixed(-depth));filters[1].setAttribute('scale',fixed(-depth*(1+aberration*.05)));filters[2].setAttribute('scale',fixed(-depth*(1+aberration*.1)));
        alpha?.setAttribute('tableValues',`0 ${fixed(aberration*.05)} 1`);
        glint.style.background=`radial-gradient(ellipse at ${fixed(50+nx*42)}% ${fixed(20+ny*36)}%,rgb(255 255 255 / ${fixed(.14+materialPressure*.16+materialEnergy*.12)}),transparent 68%),linear-gradient(${fixed(115+nx*32+ny*14)}deg,transparent 15%,rgb(210 239 255 / ${fixed(.04+materialEnergy*.12)}),transparent 82%)`;
        glint.style.opacity=engaged?'1':'.35';
        node.dataset.liquidGlassLive='native-backdrop';previousSignature=signature;
      }
      if(!held){pressure*=Math.exp(-dt*24);energy*=Math.exp(-dt*20);bendX*=Math.exp(-dt*18);bendY*=Math.exp(-dt*18);}
      const settling=!reduced&&(velocity>.002||scrollEnergy>.002||Math.abs(materialPressure-targetPressure)>.002||materialPressure>.002&&!held||materialEnergy>.002||Math.abs(bendX)+Math.abs(bendY)>.005);
      if(!settling){last=0;velocity=scrollEnergy=0;}
      return settling;
    },
    dispose(){
      disposed=true;abort.abort();resize.disconnect();glint.remove();delete node.dataset.liquidGlassLive;
      filters.forEach((filter,index)=>{const value=originalScales[index];if(value===null)filter.removeAttribute('scale');else filter.setAttribute('scale',value);});
      if(alpha){if(originalAlpha===null)alpha.removeAttribute('tableValues');else alpha.setAttribute('tableValues',originalAlpha);}
      pending.delete(material);if(!pending.size&&frame){cancelAnimationFrame(frame);frame=0;}
    }
  };
  changed();
  return ()=>material.dispose();
}
