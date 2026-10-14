import {useEffect, useRef, type RefObject} from 'react';
import {createMotionSystem, type MotionSystem} from '../vendor/lens/motion-runtime.js';

/** Native gestures only; rdev React materials own local optical rendering. */
export function useGlassMotionStage(ref:RefObject<HTMLElement|null>) {
  const system=useRef<MotionSystem|undefined>(undefined);
  useEffect(()=>{
    const stage=ref.current;if(!stage)return;
    const instance=createMotionSystem(stage);system.current=instance;
    stage.dataset.glassRenderer='rdev-liquid-glass-react';
    let frame=0;
    const mounting=new MutationObserver(()=>{
      if(!frame)frame=requestAnimationFrame(()=>{frame=0;instance.mount();});
    });
    mounting.observe(stage,{childList:true,subtree:true,attributes:true,attributeFilter:['data-lg-drag','data-lg-segments','data-lg-component']});
    return ()=>{cancelAnimationFrame(frame);mounting.disconnect();system.current=undefined;instance.destroy();delete stage.dataset.glassRenderer;};
  },[ref]);
  return system;
}
