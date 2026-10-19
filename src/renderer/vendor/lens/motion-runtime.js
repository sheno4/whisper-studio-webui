import {JellyController} from './internal/jelly.js';
import {bindKeyboardFocus} from './focus.js';

/** Native Lens gestures only. No renderer, backdrop raster or audio dependency. */
export function createMotionSystem(stage){
  const jelly=new JellyController(stage,undefined,{intensity:.7});
  const abort=new AbortController(),signal=abort.signal,observers=[];
  const unbindFocus=bindKeyboardFocus(stage);
  stage.classList.add('lg-stage');
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change',event=>{jelly.reduced=event.matches;jelly.cancel(true);},{signal});
  const mount=(root=stage)=>{
    // React may replace surface hosts without destroying the enclosing stage.
    for(const [element,body] of jelly.bodies){
      const handle=element.dataset.lgDragHandle,source=handle?element.querySelector(handle):element;
      if(!stage.contains(element)||!stage.contains(body.source)||(body.autoDrag&&(element.dataset.lgDrag!==body.mode||source!==body.source))||(body.autoToggle&&(body.source.dataset.lgComponent!=='switch'||body.source.querySelector('[data-glass=thumb]')!==element)))jelly.unregister(element);
    }
    const all=selector=>[...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll(selector)];
    for(const el of all('[data-lg-drag]'))if(!jelly.bodies.has(el)){
      const mode=el.dataset.lgDrag,handle=el.dataset.lgDragHandle,source=handle?el.querySelector(handle):el;
      if(!source)continue;
      const body=jelly.register(el,{source,mode,maxTravel:mode==='free'?Infinity:el.matches('button')?5:75});body.autoDrag=true;
      if(mode==='free'){
        const update=()=>{const body=jelly.bodies.get(el),parent=el.parentElement,x=Math.round((.5+body.x.target/Math.max(1,parent.clientWidth))*100),y=Math.round((.5+body.y.target/Math.max(1,parent.clientHeight))*100);el.setAttribute('aria-valuenow',String(x));el.setAttribute('aria-valuetext',`X ${x}%, Y ${y}%`);};
        jelly.bodies.get(el).onPosition=update;
        update();
        el.addEventListener('keydown',event=>{const delta={ArrowLeft:[-16,0],ArrowRight:[16,0],ArrowUp:[0,-16],ArrowDown:[0,16],Home:[0,0]}[event.key];if(!delta)return;event.preventDefault();const b=jelly.bodies.get(el),p=el.parentElement,maxX=Math.max(0,(p.clientWidth-el.offsetWidth)/2-22),maxY=Math.max(0,(p.clientHeight-el.offsetHeight)/2-22);jelly.target(el,event.key==='Home'?0:Math.max(-maxX,Math.min(maxX,b.x.target+delta[0])),event.key==='Home'?0:Math.max(-maxY,Math.min(maxY,b.y.target+delta[1])));update();},{signal:body.abort.signal});
      }
    }
    for(const el of all('[data-lg-component=switch]')){
      const thumb=el.querySelector('[data-glass=thumb]');if(!thumb||jelly.bodies.has(thumb))continue;
      const body=jelly.register(thumb,{source:el,mode:'toggle',onCommit:checked=>el.dispatchEvent(new CustomEvent('lg:set',{detail:{value:checked,emit:true}}))});body.autoToggle=true;
      let placed=false;const sync=event=>{
        const detail=event?.detail||{};if(body.held&&!detail.cancel)return;
        if(detail.cancel&&jelly.gesture?.body===body)jelly.cancel(true);
        jelly.target(thumb,el.getAttribute('aria-checked')==='true'?jelly.toggleTravel(el):0,0,{snap:Boolean(detail.snap)||!placed});placed=true;
      };
      el.addEventListener('lg:sync',sync,{signal:body.abort.signal});
      el.addEventListener('lg:unmount',()=>jelly.unregister(thumb),{signal:body.abort.signal});
      el.addEventListener('lg:gesture',event=>{if(event.detail.phase==='cancel')sync({detail:{snap:true}});},{signal:body.abort.signal});
      const observer=new ResizeObserver(()=>sync({detail:{snap:true}}));observer.observe(el);
      body.abort.signal.addEventListener('abort',()=>observer.disconnect(),{once:true});sync({detail:{snap:true}});
    }
    for(const el of all('[data-lg-component=slider]')){
      const input=el.querySelector('input'),thumb=el.querySelector('.lg-slider-thumb');if(!input||!thumb||jelly.bodies.has(thumb))continue;
      const body=jelly.register(thumb,{source:input,mode:'range'});body.autoRange=true;
      let placed=false;
      const sync=event=>{
        const resized=body.rangeWidth!==undefined&&body.rangeWidth!==input.clientWidth;
        if(resized&&jelly.gesture?.body===body)jelly.cancel(true);
        const p=Math.max(0,Math.min(1,(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min)||1)));
        body.width=thumb.offsetWidth;body.height=thumb.offsetHeight;body.offsetLeft=thumb.offsetLeft;body.offsetTop=thumb.offsetTop;
        body.rangeWidth=input.clientWidth;
        body.rangeRestX=Math.max(0,input.clientWidth-body.width)*p;
        if(body.held){
          const gesture=jelly.gesture;
          body.x.value=body.x.target=body.rangeRestX+(gesture?.rangeOvershoot??0);
          // Native rail clicks may jump immediately before the first drag
          // sample. That click distance is not pointer release velocity.
          if(gesture?.body===body&&!gesture.rangeMoved)gesture.rangeLastX=body.x.value;
          jelly.wake(body);
        }
        else jelly.target(thumb,body.rangeRestX,0,{snap:!placed||resized||Boolean(event?.detail?.snap)||jelly.reduced||document.documentElement.dataset.inputModality==='keyboard'});
        const fill=`${p*100}%`,track=el.querySelector('[data-liquid-backdrop]');if(track&&track.style.getPropertyValue('--lg-range-fill')!==fill)track.style.setProperty('--lg-range-fill',fill);placed=true;
      };
      input.addEventListener('lg:sync',sync,{signal:body.abort.signal});
      input.addEventListener('blur',()=>{if(jelly.gesture?.body===body)jelly.cancel(true);},{signal:body.abort.signal});
      el.addEventListener('lg:unmount',()=>jelly.unregister(thumb),{signal:body.abort.signal});
      const observer=new ResizeObserver(()=>sync({detail:{snap:true}}));observer.observe(input);body.abort.signal.addEventListener('abort',()=>observer.disconnect(),{once:true});sync();
    }
    for(const el of all('[data-lg-segments]')){
      const indicator=el.querySelector('.lg-segment-indicator'),bar=el.querySelector('.lg-segment-bar');if(!indicator||!bar||jelly.bodies.has(indicator))continue;
      const buttons=()=>[...bar.querySelectorAll('button')].filter(button=>!button.matches(':disabled')&&button.getAttribute('aria-disabled')!=='true');
      const body=jelly.register(indicator,{source:bar,mode:'segment',segments:buttons,onCommit:button=>el.dispatchEvent(new CustomEvent('lg:set',{detail:{value:button.dataset.value,emit:true}}))});
      let placed=false;const sync=event=>{
        const button=bar.querySelector('[aria-selected=true],[aria-current]');if(!button)return;
        const detail=event?.detail||{};
        // Counts and translated labels update in place. Their lg:sync must not
        // wrest the held indicator from the pointer or replace the body.
        if(body.held&&!detail.cancel)return;
        if(detail.cancel&&jelly.gesture?.body===body)jelly.cancel(true);
        if(detail.snap){for(const key of ['press','stretch','bendX','bendY']){body[key].target=0;body[key].snap();}body.optical={bend:[0,0],pressure:0,energy:0};}
        jelly.transitionSegment(indicator,button.offsetLeft,button.offsetWidth,{snap:Boolean(detail.snap)||!placed});if(button.offsetWidth)placed=true;
      };
      el.addEventListener('lg:sync',sync,{signal:body.abort.signal});
      el.addEventListener('lg:unmount',()=>jelly.unregister(indicator),{signal:body.abort.signal});
      bar.addEventListener('lg:gesture',event=>{if(event.detail.phase==='cancel'||event.detail.phase==='end')sync();},{signal:body.abort.signal});
      // Resizing changes the slot geometry, not the selected value. Place the
      // capsule at that geometry immediately instead of launching a fit spring.
      // sync's held guard still leaves an active drag under the pointer.
      const observer=new ResizeObserver(()=>sync({detail:{snap:true}}));observer.observe(bar);
      body.abort.signal.addEventListener('abort',()=>observer.disconnect(),{once:true});sync();
    }
    return api;
  };
  const api={jelly,mount,destroy(){abort.abort();observers.forEach(observer=>observer.disconnect());unbindFocus();jelly.destroy();stage.classList.remove('lg-stage');}};
  mount();return api;
}
