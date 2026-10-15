import {useLayoutEffect, useRef, useState, type RefObject} from 'react';
import LiquidGlass from '../vendor/liquid-glass-react';
import {useGlassCapability} from './capabilities';
import {createLiveMaterial} from './live-material';

const ZERO_MOUSE=Object.freeze({x:0,y:0});
export const GLASS_LAYER_LIMIT=8;
export const GLASS_PIXEL_LIMIT=200_000;
export type MaterialOwner='button'|'segment'|'switch'|'toolbar'|'select'|'menu'|'selection';
type Entry={node:HTMLElement;source:HTMLElement;pixels:number;visible:boolean;hover:boolean;focus:boolean;held:boolean;owner:MaterialOwner;order:number;active:boolean|undefined;set:(active:boolean)=>void};
const entries=new Set<Entry>();
let order=0;
const rank:Record<MaterialOwner,number>={menu:-1000,selection:-900,select:0,segment:1,switch:2,button:3,toolbar:4};
const disabled=(source:HTMLElement)=>source.matches(':disabled')||Boolean(source.closest('[aria-disabled="true"],[inert]'))||source.matches('.lg-segment-bar')&&!source.querySelector('button:not(:disabled):not([aria-disabled="true"])');
const priority=(entry:Entry)=>rank[entry.owner]-(entry.held?60:entry.focus?40:entry.hover?20:0);
function allocate():void {
  let count=0,pixels=0;
  for(const entry of [...entries].sort((a,b)=>a.owner==='menu'&&b.owner==='menu'?b.order-a.order:priority(a)-priority(b))) {
    const eligible=entry.node.isConnected&&entry.visible&&!disabled(entry.source)&&entry.pixels>0;
    const active=eligible&&entry.pixels<=(entry.owner==='menu'?140_000:80_000)&&count<GLASS_LAYER_LIMIT&&pixels+entry.pixels<=GLASS_PIXEL_LIMIT;
    if(active){count++;pixels+=entry.pixels;}
    entry.node.dataset.liquidGlassBudget=active?'allocated':!eligible?'inactive':'capacity';
    if(entry.active!==active){entry.active=active;entry.set(active);}
  }
  const stage=document.querySelector<HTMLElement>('.studio-workbench-root');
  if(stage){stage.dataset.glassLayerCount=String(count);stage.dataset.glassLayerPixels=String(Math.ceil(pixels));}
}

function interactionSource(node:HTMLElement,owner:MaterialOwner):HTMLElement {
  const selector=owner==='segment'?'.lg-segment-bar':owner==='switch'?'.lg-switch':owner==='select'?'[role="combobox"]':owner==='menu'||owner==='selection'?'[role="listbox"],[role="menu"]':'button';
  return node.parentElement?.closest<HTMLElement>('[data-liquid-glass-source]')??node.parentElement?.closest<HTMLElement>(selector)??node.parentElement??node;
}

function registerMaterial(node:HTMLElement,source:HTMLElement,owner:MaterialOwner,set:(value:boolean)=>void):()=>void {
  const abort=new AbortController(),signal=abort.signal,box=node.getBoundingClientRect();
  const entry:Entry={node,source,owner,set,order:++order,active:undefined,pixels:box.width*box.height,visible:box.width>0&&box.height>0&&box.bottom>0&&box.right>0&&box.top<innerHeight&&box.left<innerWidth,hover:false,focus:source.contains(document.activeElement),held:false};
  entries.add(entry);
  const change=(key:'hover'|'focus'|'held',value:boolean)=>{if(entry[key]!==value){entry[key]=value;allocate();}};
  source.addEventListener('pointerenter',()=>change('hover',true),{signal});
  source.addEventListener('pointerleave',()=>change('hover',false),{signal});
  source.addEventListener('pointerdown',()=>change('held',true),{signal});
  source.addEventListener('lg:gesture',event=>{
    if(event.target!==source)return;
    const phase=(event as CustomEvent<{phase:string}>).detail?.phase;
    if(phase==='cancel'||phase==='end')change('held',false);
  },{signal});
  window.addEventListener('pointerup',()=>change('held',false),{signal});
  window.addEventListener('pointercancel',()=>change('held',false),{signal});
  window.addEventListener('blur',()=>change('held',false),{signal});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){entry.held=entry.hover=false;allocate();}},{signal});
  source.addEventListener('focusin',()=>change('focus',true),{signal});
  source.addEventListener('focusout',event=>change('focus',event.relatedTarget instanceof Node&&source.contains(event.relatedTarget)),{signal});
  const resize=new ResizeObserver(records=>{
    const next=records[0]?.contentRect;if(!next)return;
    const pixels=next.width*next.height;
    if(entry.pixels!==pixels){entry.pixels=pixels;allocate();}
  });resize.observe(node);
  const intersection=new IntersectionObserver(records=>{
    const next=records[0];if(next&&entry.visible!==next.isIntersecting){entry.visible=next.isIntersecting;allocate();}
  });intersection.observe(node);
  const attributes=new MutationObserver(allocate);
  // Native fieldset disabled inheritance is included by :disabled. Observe
  // this source's ancestor attributes only, never the page's subtree.
  for(let element:HTMLElement|null=source;element;element=element.parentElement)attributes.observe(element,{attributes:true,attributeFilter:['disabled','aria-disabled','inert','hidden']});
  allocate();
  return ()=>{abort.abort();resize.disconnect();intersection.disconnect();attributes.disconnect();entries.delete(entry);allocate();};
}

/** The actual upstream React component renders a local material only. Native
 * labels/actions remain siblings, outside its React and filter work. */
export function RdevMaterial({owner,radius=999,interactionRef}:{owner:MaterialOwner;radius?:number;interactionRef?:RefObject<HTMLElement|null>}) {
  const ref=useRef<HTMLSpanElement>(null);
  const [active,setActive]=useState(false);
  const glass=useGlassCapability();
  useLayoutEffect(()=>{
    const node=ref.current;if(!node||glass.mode!=='optical')return;
    let disposed=false,cleanup:(()=>void)|undefined;
    const mount=()=>{if(!disposed)cleanup=registerMaterial(node,interactionRef?.current??interactionSource(node,owner),owner,setActive);};
    // A child's layout effect may run before its parent's host ref attaches.
    // Resolve an explicitly supplied source after the whole commit in that case.
    if(interactionRef&&!interactionRef.current)queueMicrotask(mount);else mount();
    return ()=>{disposed=true;cleanup?.();};
  },[glass.mode,owner,interactionRef]);
  useLayoutEffect(()=>{
    const node=ref.current;if(!node||!active||glass.mode!=='optical')return;
    return createLiveMaterial(node,interactionRef?.current??interactionSource(node,owner));
  },[active,glass.mode,owner,interactionRef]);
  return <span ref={ref} aria-hidden="true" className="rdev-material" data-liquid-glass-layer data-liquid-glass-provider="rdev" data-liquid-glass-owner={owner} data-liquid-glass-active={active&&glass.mode==='optical'?'true':'false'}>
    {active&&glass.mode==='optical'?<LiquidGlass className="rdev-liquid-glass" mode="standard" displacementScale={58} aberrationIntensity={2} blurAmount={owner==='menu'?.03125:-.0625} saturation={135} elasticity={0} globalMousePos={ZERO_MOUSE} mouseOffset={ZERO_MOUSE} padding="0" cornerRadius={radius} style={{position:'absolute',top:'50%',left:'50%',width:'100%',height:'100%'}}><span /></LiquidGlass>:null}
  </span>;
}
