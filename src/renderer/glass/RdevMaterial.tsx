import {useId,useLayoutEffect,useRef,useState,type RefObject} from 'react';
import LiquidGlass from '../vendor/liquid-glass-react';
import {localBezelProfile} from '../vendor/liquid-glass-react/local-bezel';
import {useGlassCapability} from './capabilities';
import {createLiveMaterial} from './live-material';
import {unifiedGlassScene,type UnifiedGlassNode} from './unified-scene';

const ZERO_MOUSE=Object.freeze({x:0,y:0});
export const GLASS_LAYER_LIMIT=8;
export const GLASS_PIXEL_LIMIT=200_000;
export type MaterialOwner='button'|'segment'|'switch'|'toolbar'|'select'|'menu'|'selection'|'slider';
export type MaterialFrame=Pick<Partial<UnifiedGlassNode>,'rect'|'captureBounds'|'radius'|'pressure'|'bend'|'velocity'|'open'|'origin'|'active'|'tint'>;
type MaterialProps=MaterialFrame&{owner:MaterialOwner;radius?:number;group?:string;role?:UnifiedGlassNode['role'];interactionRef?:RefObject<HTMLElement|null>;hostRef?:RefObject<HTMLElement|null>;gpuOnly?:boolean};
type Reservation={pixels:number;currentPixels:number;node:HTMLElement;transient:boolean;resize:ResizeObserver};
const reservations=new Set<Reservation>();
function reportBudget():void {
  const stage=document.querySelector<HTMLElement>('.studio-workbench-root');
  if(stage){
    const live=[...reservations].filter(item=>item.node.dataset.nativeSize!=='overflow'&&item.currentPixels>0);
    stage.dataset.glassLayerCount=String(live.length);stage.dataset.glassLayerPixels=String(Math.ceil(live.reduce((sum,item)=>sum+item.currentPixels,0)));
    stage.dataset.glassReservedLayers=String(reservations.size);stage.dataset.glassReservedPixels=String(Math.ceil([...reservations].reduce((sum,item)=>sum+item.pixels,0)));
  }
}
/** Admission is fixed for this mounted surface. Hover, focus, presses and a
 * newly opened menu cannot evict a native subtree or promote a fallback. */
function reserve(node:HTMLElement,owner:MaterialOwner,synthetic:boolean,role:UnifiedGlassNode['role'],host?:HTMLElement|null):Reservation|null {
  // Reserve the structural motion envelope, not the initially selected pill.
  // Changing segment widths and highlight rows must not pause SVG mid-drag.
  // Hidden highlights use a known menu-width row, never a fake 1px layer.
  const structural=owner==='segment'||owner==='selection';
  const measuredWidth=structural?(host?.clientWidth||node.offsetWidth):(node.offsetWidth||host?.clientWidth||0);
  const measuredHeight=owner==='selection'?48:owner==='segment'?(host?.clientHeight||node.offsetHeight):(node.offsetHeight||host?.clientHeight||0);
  const pixels=measuredWidth*measuredHeight;
  const used=[...reservations].reduce((sum,item)=>sum+item.pixels,0);
  const transient=owner==='menu'||owner==='selection';
  const moving=role==='indicator'||role==='thumb';
  const peers=[...reservations].filter(item=>item.transient===transient);
  const groupUsed=peers.reduce((sum,item)=>sum+item.pixels,0);
  // Tiny satellite proxies are genuine CSS-backdrop lenses, not blank GPU
  // ghosts. Their changing geometry does not reserve a misleading 1px SVG.
  if(synthetic||!transient&&!moving||pixels<=0||pixels>(owner==='menu'?140_000:80_000)||peers.length>=(transient?2:6)||groupUsed+pixels>(transient?120_000:80_000)||reservations.size>=GLASS_LAYER_LIMIT||used+pixels>GLASS_PIXEL_LIMIT){node.dataset.liquidGlassBudget=pixels<=0?'zero-geometry':!transient&&!moving?'static-material':'capacity';return null;}
  const measure=()=>{
    reservation.currentPixels=node.offsetWidth*node.offsetHeight;
    // The original SVG subtree is retained if a structural resize exceeds
    // its reservation. Only its paint pauses; fixed browser frost continues.
    node.dataset.nativeSize=reservation.currentPixels>reservation.pixels?'overflow':'bounded';reportBudget();
  };
  const resize=new ResizeObserver(measure);
  const reservation:Reservation={node,pixels,currentPixels:node.offsetWidth*node.offsetHeight,transient,resize};reservations.add(reservation);node.dataset.liquidGlassBudget='allocated';resize.observe(node);measure();return reservation;
}
function interactionSource(node:HTMLElement,owner:MaterialOwner):HTMLElement {
  const selector=owner==='segment'?'.lg-segment-bar':owner==='switch'?'.lg-switch':owner==='select'?'[role="combobox"]':owner==='menu'||owner==='selection'?'[role="listbox"],[role="menu"]':'button';
  return node.parentElement?.closest<HTMLElement>('[data-liquid-glass-source]')??node.parentElement?.closest<HTMLElement>(selector)??node.parentElement??node;
}

/** The upstream native material stays mounted throughout interaction. Studio
 * contributes transparent lighting; it never owns or repaints the backdrop. */
export function RdevMaterial({owner,radius=999,interactionRef,hostRef,group,role,gpuOnly=false,...frame}:MaterialProps) {
  const id=useId(),ref=useRef<HTMLSpanElement>(null);
  const handle=useRef<ReturnType<typeof unifiedGlassScene.register>|null>(null);
  const latest=useRef(frame);latest.current=frame;
  const [allocation,setAllocation]=useState<{native:boolean;depth:number}|null>(null);
  const glass=useGlassCapability();
  const materialRole=role??(owner==='menu'?'menu':owner==='switch'||owner==='slider'?'thumb':owner==='segment'||owner==='selection'?'indicator':'surface');
  useLayoutEffect(()=>{
    const node=ref.current,parent=node?.parentElement;if(!node||!parent||gpuOnly)return;
    // Absolute inset:0 fills a positioned parent's padding box. The lens and
    // its shape-local map must instead match that parent's outer border box.
    // Read structural borders only; pointer motion never recalculates them.
    const align=()=>{
      const border=getComputedStyle(parent);
      for(const [side,width] of [['top',border.borderTopWidth],['right',border.borderRightWidth],['bottom',border.borderBottomWidth],['left',border.borderLeftWidth]] as const){
        const value=`${-(parseFloat(width)||0)}px`;if(node.style[side]!==value)node.style[side]=value;
      }
    };
    align();const resize=new ResizeObserver(align);resize.observe(parent,{box:'border-box'});resize.observe(node);
    return()=>resize.disconnect();
  },[gpuOnly]);
  useLayoutEffect(()=>{
    const node=ref.current;if(!node||!glass.enabled)return;
    let disposed=false,reservation:Reservation|null=null;
    const admit=()=>{if(disposed)return;reservation=glass.nativeOptical?reserve(node,owner,gpuOnly,materialRole,hostRef?.current):null;setAllocation({native:Boolean(reservation),depth:localBezelProfile(node.offsetWidth,node.offsetHeight).maxOffset*2});};
    if(hostRef&&!hostRef.current)queueMicrotask(admit);else admit();
    return ()=>{disposed=true;if(reservation){reservation.resize.disconnect();reservations.delete(reservation);reportBudget();}};
  },[glass.enabled,glass.nativeOptical,owner,gpuOnly,materialRole]);
  useLayoutEffect(()=>{
    const node=ref.current;if(!node||!glass.enabled||!allocation)return;
    let disposed=false,stopLive:(()=>void)|undefined;
    const mount=()=>{
      if(disposed)return;
      const source=interactionRef?.current??interactionSource(node,owner);
      const visualHost=node.parentElement??source;
      const controller=unifiedGlassScene.register({element:node,host:hostRef?.current??visualHost,owner:`material-${id}`,group:group??`material-${id}`,radius,role:materialRole,source,synthetic:gpuOnly,transient:owner==='menu'||owner==='selection',...latest.current});
      handle.current=controller;
      // Fallback and native surfaces share exactly the same live controller.
      // It never stops/restarts because lighting readiness or hover changes.
      stopLive=createLiveMaterial(node,source,sample=>controller.update({sample}));
      visualHost.dataset.glassRenderer=allocation.native?'rdev':'browser-backdrop';
    };
    if(interactionRef&&!interactionRef.current||hostRef&&!hostRef.current)queueMicrotask(mount);else mount();
    return ()=>{disposed=true;stopLive?.();handle.current?.unregister();handle.current=null;const parent=node.parentElement;if(parent?.dataset.glassRenderer)delete parent.dataset.glassRenderer;};
  },[glass.enabled,id,owner,group,role,radius,interactionRef,hostRef,gpuOnly,allocation]);
  useLayoutEffect(()=>{handle.current?.update({...frame,radius});},[radius,frame.rect,frame.captureBounds,frame.pressure,frame.bend,frame.velocity,frame.open,frame.origin,frame.active,frame.tint]);
  const native=Boolean(allocation?.native);
  return <span ref={ref} aria-hidden="true" className="rdev-material" data-liquid-glass-layer data-liquid-glass-provider={native?'rdev':'browser-backdrop'} data-liquid-glass-renderer={native?'rdev':'fallback'} data-liquid-glass-native-optical={native?'true':'false'} data-liquid-glass-owner={owner} data-liquid-glass-satellite={gpuOnly||undefined} data-liquid-glass-active={native?'true':'false'} hidden={gpuOnly&&frame.active===false}>
    {native?<LiquidGlass className="rdev-liquid-glass" mode="standard" localOptics displacementScale={allocation!.depth} aberrationIntensity={2} blurAmount={owner==='menu'?-.09375:-.109375} saturation={135} elasticity={0} globalMousePos={ZERO_MOUSE} mouseOffset={ZERO_MOUSE} padding="0" cornerRadius={radius} style={{position:'absolute',top:'50%',left:'50%',width:'100%',height:'100%'}}><span /></LiquidGlass>:null}
  </span>;
}
