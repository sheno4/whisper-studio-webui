import { animate, motionValue } from 'framer-motion';
import { useEffect, useRef, type RefObject } from 'react';

import { useGlassCapability } from './capabilities';
import { RdevMaterial } from './RdevMaterial';
import {getLiquidPopoverFrame} from './useLiquidPopover';

/** One optical capsule follows the primitive's actual highlighted item. Its
 * spring values live outside React; resizing happens only when the target
 * changes, while every animation frame writes a single transform. */
export function LiquidMenuHighlight({ hostRef, materialHostRef, group, active, itemSelector, selectedFallback = false }: {
  hostRef: RefObject<HTMLElement | null>;
  materialHostRef?:RefObject<HTMLElement|null>;
  group?:string;
  active: boolean;
  itemSelector: string;
  selectedFallback?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const tailRef=useRef<HTMLDivElement>(null);
  const glass = useGlassCapability();

  useEffect(() => {
    const host = hostRef.current;
    const element = ref.current;
    if (!active || !host || !element) return;
    const values = [motionValue(0), motionValue(0), motionValue(1), motionValue(1)];
    let controls: Array<{ stop: () => void }> = [];
    let baseWidth = 1;
    let baseHeight = 1;
    let initialized = false;
    let frame = 0;
    let lastTarget: HTMLElement | null = null;
    let hostBox=host.getBoundingClientRect(),scaleX=1,scaleY=1;
    let previous=[0,0,1,1],destination=[0,0,1,1];
    let pressed=false;
    const popup=materialHostRef?.current??null;
    let popupBox=popup?.getBoundingClientRect();
    let popoverFrame=popup?getLiquidPopoverFrame(popup):undefined;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const render = (): void => {
      frame = 0;
      const x=values[0].get(),y=values[1].get(),w=values[2].get(),h=values[3].get();
      const velocityY=values[1].getVelocity(),stretch=reduce.matches?1:1+Math.min(.18,Math.abs(velocityY)/6000);
      const width=w/stretch,height=h*stretch,left=x+(w-width)/2,top=y+(h-height)/2;
      element.style.transform = `translate3d(${left}px,${top}px,0) scale(${width / baseWidth},${height / baseHeight})`;
      const world=(xx:number,yy:number,ww:number,hh:number)=>{
        const result={x:hostBox.left+(xx-host.scrollLeft+host.clientLeft)*scaleX,y:hostBox.top+(yy-host.scrollTop+host.clientTop)*scaleY,width:ww*scaleX,height:hh*scaleY};
        const shape=popoverFrame?.rect;
        if(!shape||!popupBox?.width||!popupBox.height)return result;
        const sx=shape.width/popupBox.width,sy=shape.height/popupBox.height;
        return{x:shape.x+(result.x-popupBox.left)*sx,y:shape.y+(result.y-popupBox.top)*sy,width:result.width*sx,height:result.height*sy};
      };
      const open=popoverFrame?.open??1;
      element.dispatchEvent(new CustomEvent('lg:material',{bubbles:true,detail:{rect:world(left,top,width,height),open,pressure:pressed?1:Math.min(.3,Math.abs(velocityY)/2400),velocity:{x:values[0].getVelocity(),y:velocityY},active:!element.hidden&&open>.025}}));
      const tail=tailRef.current;
      if(tail){
        const distance=Math.hypot(destination[0]-previous[0],destination[1]-previous[1]);
        const travelled=Math.hypot(x-previous[0],y-previous[1]);
        const scale=reduce.matches||distance<2?0:Math.max(0,1-travelled/distance*1.6);
        const tw=previous[2]*scale,th=previous[3]*scale;
        tail.dispatchEvent(new CustomEvent('lg:material',{bubbles:true,detail:{rect:world(previous[0]+(previous[2]-tw)/2,previous[1]+(previous[3]-th)/2,tw,th),pressure:.22*scale,open:scale*open,active:scale>.035&&open>.025}}));
      }
    };
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(render); };
    const subscriptions = values.map((value) => value.on('change', schedule));

    const update = (): void => {
      const items = [...host.querySelectorAll<HTMLElement>(itemSelector)];
      const target = items.find((item) => item.hasAttribute('data-highlighted') && !item.hasAttribute('data-disabled'))
        ?? (selectedFallback ? items.find((item) => item.getAttribute('aria-selected') === 'true' || item.hasAttribute('data-selected')) : undefined);
      if (!target) { element.hidden = true; lastTarget = null;render();return; }
      hostBox = host.getBoundingClientRect();
      popupBox=popup?.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      scaleX = host.offsetWidth ? hostBox.width / host.offsetWidth : 1;
      scaleY = host.offsetHeight ? hostBox.height / host.offsetHeight : 1;
      if (!scaleX || !scaleY) return;
      const next = [
        (targetBox.left - hostBox.left) / scaleX + host.scrollLeft - host.clientLeft,
        (targetBox.top - hostBox.top) / scaleY + host.scrollTop - host.clientTop,
        targetBox.width / scaleX,
        targetBox.height / scaleY
      ];
      if (next[2] <= 0 || next[3] <= 0) return;
      element.hidden = false;
      const sameTarget = lastTarget === target && baseWidth === next[2] && baseHeight === next[3] &&
        values[0].get() === next[0] && values[1].get() === next[1];
      if (sameTarget) return;
      previous=values.map(value=>value.get());destination=next;
      lastTarget = target;
      baseWidth = next[2];
      baseHeight = next[3];
      element.style.width = `${baseWidth}px`;
      element.style.height = `${baseHeight}px`;
      element.dataset.liquidHighlightTarget = target.dataset.value ?? target.textContent ?? '';
      controls.forEach((control) => control.stop());
      const instant = !initialized || reduce.matches || document.documentElement.dataset.inputModality === 'keyboard';
      if (instant) next.forEach((value, index) => values[index].jump(value));
      else controls = next.map((value, index) => animate(values[index], value, { type: 'spring', duration: 0.25, bounce: 0 }));
      initialized = true;
      render();
    };
    const press = (event: PointerEvent): void => {
      if ((event.target as Element).closest(itemSelector)?.matches(':not([data-disabled])')){element.dataset.pressed = 'true';pressed=true;render();}
    };
    const release = (): void => { delete element.dataset.pressed;pressed=false;render(); };
    // Observe only primitive state, never our per-frame transform writes.
    const observer = new MutationObserver(update);
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-highlighted', 'data-selected', 'aria-selected', 'data-disabled'] });
    const resize = new ResizeObserver(update);
    resize.observe(host);
    host.addEventListener('scroll', update, { passive: true });
    host.addEventListener('pointerdown', press);
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    reduce.addEventListener('change', update);
    const morph=(event:Event)=>{if(event.target!==popup)return;popoverFrame=(event as CustomEvent<ReturnType<typeof getLiquidPopoverFrame>>).detail;render();};
    popup?.addEventListener('lg:material',morph);
    update();
    return () => {
      observer.disconnect();
      resize.disconnect();
      host.removeEventListener('scroll', update);
      host.removeEventListener('pointerdown', press);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      reduce.removeEventListener('change', update);
      popup?.removeEventListener('lg:material',morph);
      controls.forEach((control) => control.stop());
      subscriptions.forEach((unsubscribe) => unsubscribe());
      values.forEach((value) => value.destroy());
      if (frame) cancelAnimationFrame(frame);
      element.hidden=true;
      element.dispatchEvent(new CustomEvent('lg:material',{bubbles:true,detail:{active:false,pressure:0}}));
      tailRef.current?.dispatchEvent(new CustomEvent('lg:material',{bubbles:true,detail:{active:false,pressure:0,open:0}}));
    };
  }, [active, hostRef, materialHostRef, itemSelector, selectedFallback]);

  return <><div ref={ref} className="glass-liquid-highlight" data-liquid-highlight aria-hidden="true" hidden>
    <div className="glass-liquid-highlight__body">
      {glass.enabled ? <RdevMaterial owner="selection" radius={11} group={group} role="indicator" interactionRef={ref} hostRef={materialHostRef??hostRef} /> : null}
    </div>
  </div><div ref={tailRef} className="glass-liquid-highlight-tail" aria-hidden="true">{glass.enabled?<RdevMaterial owner="selection" group={group} radius={11} role="indicator" interactionRef={tailRef} hostRef={materialHostRef??hostRef} active={false} gpuOnly/>:null}</div></>;
}
