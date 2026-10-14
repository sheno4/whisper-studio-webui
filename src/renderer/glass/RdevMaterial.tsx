import {useLayoutEffect, useRef, useState} from 'react';
import LiquidGlass from '../vendor/liquid-glass-react';
import {useGlassCapability} from './capabilities';

const ZERO_MOUSE=Object.freeze({x:0,y:0});
export const GLASS_LAYER_LIMIT=8;
export const GLASS_PIXEL_LIMIT=200_000;
type Owner='button'|'segment'|'switch'|'toolbar';
type Entry={node:HTMLElement;pixels:number;priority:number;set:(active:boolean)=>void};
const entries=new Set<Entry>();
function allocate():void {
  let count=0,pixels=0;
  for(const entry of [...entries].sort((a,b)=>a.priority-b.priority)) {
    const active=entry.node.isConnected&&entry.pixels>0&&entry.pixels<=80_000&&count<GLASS_LAYER_LIMIT&&pixels+entry.pixels<=GLASS_PIXEL_LIMIT;
    if(active){count++;pixels+=entry.pixels;}
    entry.set(active);
  }
  const stage=document.querySelector<HTMLElement>('.studio-workbench-root');
  if(stage){stage.dataset.glassLayerCount=String(count);stage.dataset.glassLayerPixels=String(Math.ceil(pixels));}
}

/** The actual upstream React component renders a local material only. Native
 * labels/actions remain siblings, outside its React and filter work. */
export function RdevMaterial({owner,radius=999}:{owner:Owner;radius?:number}) {
  const ref=useRef<HTMLSpanElement>(null);
  const [active,setActive]=useState(false);
  const glass=useGlassCapability();
  useLayoutEffect(()=>{
    const node=ref.current;if(!node||glass.mode!=='optical')return;
    const entry:Entry={node,pixels:0,priority:owner==='segment'?0:owner==='switch'?1:owner==='toolbar'?2:3,set:value=>setActive(old=>old===value?old:value)};
    entries.add(entry);
    const resize=new ResizeObserver(records=>{
      const box=records[0]?.contentRect;if(!box)return;
      const pixels=box.width*box.height;
      if(entry.pixels!==pixels){entry.pixels=pixels;allocate();}
    });resize.observe(node);
    return ()=>{resize.disconnect();entries.delete(entry);allocate();};
  },[glass.mode,owner]);
  return <span ref={ref} aria-hidden="true" className="rdev-material" data-liquid-glass-layer data-liquid-glass-provider="rdev" data-liquid-glass-owner={owner} data-liquid-glass-active={active&&glass.mode==='optical'?'true':'false'}>
    {active&&glass.mode==='optical'?<LiquidGlass className="rdev-liquid-glass" mode="standard" displacementScale={58} aberrationIntensity={2} blurAmount={.045} saturation={135} elasticity={0} globalMousePos={ZERO_MOUSE} mouseOffset={ZERO_MOUSE} padding="0" cornerRadius={radius} style={{position:'absolute',top:'50%',left:'50%',width:'100%',height:'100%'}}><span /></LiquidGlass>:null}
  </span>;
}
