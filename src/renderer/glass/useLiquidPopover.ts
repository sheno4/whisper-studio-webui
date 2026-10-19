import {animate, motionValue} from 'framer-motion';
import {useLayoutEffect, useRef, type RefObject} from 'react';
import {menuMaterializeRect, menuOrigin} from '../vendor/ishiakiz/controls.js';
import type {MaterialFrame} from './RdevMaterial';

const presentationFrames=new WeakMap<HTMLElement,MaterialFrame>();
export const getLiquidPopoverFrame=(popup:HTMLElement):MaterialFrame|undefined=>presentationFrames.get(popup);

/** Base UI retains the popup's final layout and focus boundary. Only the
 * optical body grows from its actual trigger; content never controls layout. */
export function useLiquidPopover({open,popupNode,triggerRef,popupRef,contentRef,onClosed,immediate=false}:{open:boolean;popupNode:HTMLElement|null;triggerRef:RefObject<HTMLElement|null>;popupRef:RefObject<HTMLElement|null>;contentRef:RefObject<HTMLElement|null>;onClosed:()=>void;immediate?:boolean}):void {
  const progress=useRef(motionValue(0));
  const controls=useRef<{stop:()=>void}|null>(null);
  const lastPopup=useRef<HTMLElement|null>(null);
  const closed=useRef(onClosed);closed.current=onClosed;
  const currentOpen=useRef(open);currentOpen.current=open;
  useLayoutEffect(()=>{
    const popup=popupNode,trigger=triggerRef.current,content=contentRef.current;
    if(!popup||!trigger||!content)return;
    const value=progress.current;
    if(lastPopup.current!==popup){value.jump(open?0:1);lastPopup.current=popup;}
    const reduce=matchMedia('(prefers-reduced-motion: reduce)');
    const keyboard=document.documentElement.dataset.inputModality==='keyboard';
    const finish=()=>{if(!currentOpen.current)closed.current();};
    let triggerBox=trigger.getBoundingClientRect(),popupBox=popup.getBoundingClientRect();
    const triggerRadius=parseFloat(getComputedStyle(trigger).borderTopLeftRadius)||13;
    const popupRadius=parseFloat(getComputedStyle(popup).borderTopLeftRadius)||18;
    const nativeMaterial=popup.querySelector<HTMLElement>(':scope > .rdev-material');
    let pending=0;
    const measure=()=>{triggerBox=trigger.getBoundingClientRect();popupBox=popup.getBoundingClientRect();render();};
    const schedule=()=>{if(!pending)pending=requestAnimationFrame(()=>{pending=0;measure();});};
    const render=()=>{
      const p=Math.max(0,Math.min(1,value.get()));
      const shape=menuMaterializeRect(triggerBox,popupBox,p);
      // Preserve the source implementation's origin and scale channels while
      // adding the missing trigger-sized start of the continuous SDF body.
      const x=triggerBox.left+(shape.left-triggerBox.left)*p;
      const y=triggerBox.top+(shape.top-triggerBox.top)*p;
      const width=triggerBox.width+(shape.width-triggerBox.width)*p;
      const height=triggerBox.height+(shape.height-triggerBox.height)*p;
      const localOrigin=menuOrigin(triggerBox,popupBox);
      const captureX=Math.min(triggerBox.left,popupBox.left),captureY=Math.min(triggerBox.top,popupBox.top);
      const frame:MaterialFrame={rect:{x,y,width,height},captureBounds:{x:captureX,y:captureY,width:Math.max(triggerBox.right,popupBox.right)-captureX,height:Math.max(triggerBox.bottom,popupBox.bottom)-captureY},radius:triggerRadius+(popupRadius-triggerRadius)*p,origin:{x:popupBox.left+localOrigin.x,y:popupBox.top+localOrigin.y},open:p,pressure:(1-p)*.5,velocity:{x:0,y:value.getVelocity()*48},active:open||p>.001};
      presentationFrames.set(popup,frame);
      // Native and GPU ownership paint the exact same presentation box. A
      // delayed first texture cannot flash a full-size fallback then shrink.
      if(nativeMaterial&&popupBox.width&&popupBox.height){
        nativeMaterial.style.transformOrigin='0 0';
        nativeMaterial.style.transform=`translate3d(${x-popupBox.left}px,${y-popupBox.top}px,0) scale(${width/popupBox.width},${height/popupBox.height})`;
      }
      popup.dispatchEvent(new CustomEvent('lg:material',{bubbles:true,detail:frame}));
      popup.style.transformOrigin=`${localOrigin.x}px ${localOrigin.y}px`;
      const visible=reduce.matches||keyboard?p:Math.max(0,Math.min(1,(p-.16)/.84));
      content.style.opacity=String(visible);
      content.style.transform='none';
    };
    popup.dataset.liquidPopover='true';
    const unsubscribe=value.on('change',render);
    const resize=new ResizeObserver(schedule);resize.observe(popup);resize.observe(trigger);
    const settle=()=>{if(!reduce.matches&&!document.hidden)return;controls.current?.stop();value.jump(open?1:0);render();if(!open)finish();};
    reduce.addEventListener('change',settle);
    document.addEventListener('visibilitychange',settle);
    window.addEventListener('resize',schedule,{passive:true});
    window.addEventListener('scroll',schedule,{passive:true,capture:true});
    controls.current?.stop();
    if(reduce.matches||keyboard||immediate){value.jump(open?1:0);if(!open)queueMicrotask(finish);}
    else controls.current=animate(value,open?1:0,{type:'spring',stiffness:760,damping:48,mass:1,restDelta:.002,restSpeed:.01,onComplete:()=>{if(!open)finish();}});
    render();
    // Positioner can resolve collision placement one frame after the popup's
    // host ref attaches. This is a geometry read, not a screenshot/sample.
    schedule();
    return ()=>{controls.current?.stop();unsubscribe();resize.disconnect();reduce.removeEventListener('change',settle);document.removeEventListener('visibilitychange',settle);window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);if(pending)cancelAnimationFrame(pending);};
  },[open,popupNode,triggerRef,popupRef,contentRef,immediate]);
  useLayoutEffect(()=>()=>{controls.current?.stop();progress.current.destroy();},[]);
}
