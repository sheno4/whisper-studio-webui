import { Spring, clamp, jellyMatrix, boundDrag, togglePose } from './jelly-physics.js';

/** Gesture-driven motion for semantic DOM and its matching glass shader. */
export class JellyController {
  constructor(stage, renderer, { intensity = .7 } = {}) {
    this.stage = stage; this.renderer = renderer; this.intensity = intensity;
    this.bodies = new Map(); this.activeBodies = new Set(); this.frame = 0; this.last = 0; this.gesture = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.abort = new AbortController(); this.signal = this.abort.signal;
    this.blockClick = null;
    window.addEventListener('pointermove', e => this.move(e), { signal:this.signal, passive:false });
    window.addEventListener('pointerup', e => this.release(e), { signal:this.signal });
    window.addEventListener('pointercancel', e => this.release(e, true), { signal:this.signal });
    window.addEventListener('blur', () => this.cancel(), { signal:this.signal });
    window.addEventListener('resize', () => this.reflow(), { signal:this.signal });
    window.addEventListener('keydown', e => {
      if(e.key!=='Escape'||!this.gesture||e.isComposing||e.defaultPrevented)return;
      e.preventDefault();e.stopPropagation();this.cancel(true);
    }, { capture:true, signal:this.signal });
    document.addEventListener('visibilitychange', () => {
      if(document.hidden){this.cancel(true);cancelAnimationFrame(this.frame);this.frame=0;this.last=0;this.activeBodies.clear();}
      else this.wake();
    }, { signal:this.signal });
    document.addEventListener('click', e => {
      if(this.blockClick && performance.now() < this.blockClick.until && this.blockClick.source.contains(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation(); this.blockClick = null;
      }
    }, { capture:true, signal:this.signal });
  }

  register(element, { source=element, mode='tether', maxTravel=Infinity, onCommit, segments, onPosition } = {}) {
    this.unregister(element);
    const body = { element,source,mode,maxTravel,onCommit,segments,onPosition,
      x:new Spring(), y:new Spring(), press:new Spring(), stretch:new Spring(), bendX:new Spring(), bendY:new Spring(),
      angle:0, held:false, freeX:0, freeY:0, width:element.offsetWidth, travel:mode==='toggle'?this.toggleTravel(source):0,
      previousTransform:element.style.transform, optical:{bend:[0,0],pressure:0,energy:0},abort:new AbortController() };
    this.bodies.set(element, body);
    element.dataset.jelly = mode; element.style.setProperty('--jelly-matrix','matrix(1,0,0,1,0,0)');
    source.addEventListener('pointerdown', e => this.grab(body,e), { signal:body.abort.signal });
    source.addEventListener('lostpointercapture', e => {if(this.gesture?.id===e.pointerId)this.release(e,true);}, { signal:body.abort.signal });
    const availability=new MutationObserver(()=>{
      if(this.gesture?.body===body&&(this.disabled(body)||this.gesture.capture.matches(':disabled')))this.cancel(true);
    });
    availability.observe(source,{attributes:true,subtree:mode==='segment',attributeFilter:['disabled','aria-disabled','inert']});
    for(let ancestor=source.parentElement;ancestor;ancestor=ancestor.parentElement)availability.observe(ancestor,{attributes:true,attributeFilter:['disabled','aria-disabled','inert']});
    body.abort.signal.addEventListener('abort',()=>availability.disconnect(),{once:true});
    return body;
  }

  unregister(element) {
    const body=this.bodies.get(element);if(!body)return;
    if(this.gesture?.body===body)this.cancel(true);
    body.abort.abort();this.bodies.delete(element);this.activeBodies.delete(body);
    delete element.dataset.jelly;delete element.dataset.held;
    element.classList.remove('jelly-moving');element.style.removeProperty('--jelly-matrix');
    if(element.style.transform===body.lastTransform)element.style.transform=body.previousTransform;
    if(this.blockClick?.source===body.source)this.blockClick=null;
    if(!this.activeBodies.size&&this.frame){cancelAnimationFrame(this.frame);this.frame=0;this.last=0;}
  }

  grab(body, e) {
    if(e.button!==0 || !e.isPrimary || this.gesture || this.disabled(body))return;
    if(body.mode==='segment'){
      const button=e.target.closest('button');
      if(button&&(button.matches(':disabled')||button.getAttribute('aria-disabled')==='true'))return;
      if(button&&button.getAttribute('aria-selected')!=='true'&&!button.hasAttribute('aria-current'))return;
      if(!body.segments?.().length||body.source.closest('[aria-disabled=true]'))return;
    }
    // A panel never steals a slider, menu, button, or nested draggable's gesture.
    if(['tether','press','free'].includes(body.mode)) {
      const interactive=e.target.closest('button,input,textarea,select,a,[contenteditable]:not([contenteditable=false]),[role=button],[role=slider],[role=textbox],[data-optical-drag]');
      if(interactive&&interactive!==body.source&&interactive!==body.element)return;
      const nested=e.target.closest('[data-jelly]');if(nested&&nested!==body.source&&nested!==body.element)return;
    }
    const boundary=body.mode==='free'?body.element.parentElement:this.stage;
    const r=body.element.getBoundingClientRect(), sr=boundary.getBoundingClientRect();
    body.width=body.element.offsetWidth;
    if(body.mode==='toggle')body.travel=this.toggleTravel(body.source);
    const sourceRect=body.mode==='segment'||body.mode==='toggle'?body.source.getBoundingClientRect():null;
    const grabOffset=(e.clientX-r.left)*body.width/Math.max(1,r.width);
    // Flatten the existing presentation scale around the exact grabbed local
    // point. The pointer can interrupt a release spring without a center jump.
    const baseX=sourceRect?e.clientX-grabOffset-sourceRect.left-body.source.clientLeft-body.element.offsetLeft:body.x.value;
    const capture=body.mode==='segment'?(e.target.closest('button')||body.source):body.source;
    this.gesture={body,boundary,capture,id:e.pointerId,startX:e.clientX,startY:e.clientY,baseX:body.x.value,restX:body.x.target,baseY:body.y.value,
      grabOffset,sourceWidth:body.source.clientWidth,lastX:e.clientX,lastY:e.clientY,lastTime:e.timeStamp,velocityX:0,velocityY:0,
      rect:{left:r.left-sr.left-body.x.value,top:r.top-sr.top-body.y.value,right:r.right-sr.left-body.x.value,bottom:r.bottom-sr.top-body.y.value},moved:false};
    // A fresh gesture interrupts the shape at its current presentation.
    body.held=true;body.press.target=1;
    if(sourceRect){this.gesture.baseX=baseX;body.x.snap(baseX);body.y.snap(0);}
    if(['tether','press','free','segment'].includes(body.mode)){body.x.target=body.x.value;body.y.target=body.y.value;body.x.velocity=body.y.velocity=0;}
    body.element.dataset.held='true';
    if(!['range','press'].includes(body.mode)) {e.preventDefault();capture.setPointerCapture(e.pointerId);}
    if(capture.matches('button,[tabindex]'))capture.focus({preventScroll:true});
    body.source.dispatchEvent(new CustomEvent('lg:gesture',{bubbles:true,detail:{phase:'start',mode:body.mode,moved:false}}));
    this.wake(body);
  }

  move(e) {
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;
    const b=g.body,dx=e.clientX-g.startX,dy=e.clientY-g.startY;
    if(this.disabled(b)||g.capture.matches(':disabled')){this.cancel(true);return;}
    const elapsed=clamp((e.timeStamp-g.lastTime)/1000,1/240,.08);
    g.velocityX=clamp((e.clientX-g.lastX)/elapsed,-2400,2400);g.velocityY=clamp((e.clientY-g.lastY)/elapsed,-2400,2400);
    g.lastX=e.clientX;g.lastY=e.clientY;g.lastTime=e.timeStamp;
    const wasMoved=g.moved;g.moved ||= Math.hypot(dx,dy)>5;
    if(g.moved&&!wasMoved)b.source.dispatchEvent(new CustomEvent('lg:gesture',{bubbles:true,detail:{phase:'drag',mode:b.mode,moved:true}}));
    if(b.mode==='press') {
      // Buttons acknowledge pressure without dragging the surrounding panel.
      b.x.target=0;b.y.target=0;
    } else if(b.mode==='range') {
      b.y.target=this.reduced?0:clamp(dy*.35,-18,18);
    } else if(b.mode==='toggle') {
      b.x.target=clamp(g.baseX+dx,0,b.travel);b.y.target=0;
    } else if(b.mode==='segment') {
      // Delta from the presentation position preserves exactly where the
      // pointer grabbed the capsule, including an interrupted release spring.
      b.x.target=clamp(g.baseX+dx,3,Math.max(3,g.sourceWidth-b.width-3));
      b.y.target=0;
    } else {
      const bound=boundDrag(g.baseX+dx,g.baseY+dy,g.rect,{width:g.boundary.clientWidth,height:g.boundary.clientHeight},22);
      b.x.target=clamp(bound.x,-b.maxTravel,b.maxTravel);b.y.target=clamp(bound.y,-b.maxTravel,b.maxTravel);
    }
    if(b.mode==='toggle'||b.mode==='segment'){
      // Held movement is direct manipulation; springs begin only at release.
      b.x.value=b.x.target;b.y.value=b.y.target;
      b.x.velocity=g.velocityX;b.y.velocity=g.velocityY;
    }else if(this.reduced){b.x.snap();b.y.snap();}
    if(!['range','press'].includes(b.mode))e.preventDefault();
    this.wake(b);
  }

  release(e, cancelled=false) {
    const g=this.gesture;if(!g||(e&&g.id!==e.pointerId))return;
    this.gesture=null;const b=g.body;b.held=false;b.press.target=0;delete b.element.dataset.held;
    if(e&&e.timeStamp-g.lastTime>80){b.x.velocity=0;b.y.velocity=0;}
    if(g.moved&&!['range','press'].includes(b.mode))this.blockClick={source:b.source,until:performance.now()+350};
    if(g.capture.hasPointerCapture?.(g.id))g.capture.releasePointerCapture(g.id);
    if(['tether','press'].includes(b.mode)) {b.x.target=0;b.y.target=0;}
    if(b.mode==='free') {
      if(cancelled){b.x.target=b.freeX;b.y.target=b.freeY;}
      else{b.freeX=b.x.target;b.freeY=b.y.target;b.onPosition?.(b.freeX,b.freeY);}
    }
    if(b.mode==='range')b.y.target=0;
    if(b.mode==='toggle'){
      if(g.moved&&!cancelled)b.onCommit?.(b.x.target>=b.travel/2);
      else b.x.target=g.restX;
      b.y.target=0;
    }
    if(b.mode==='segment'){
      if(g.moved&&!cancelled){
        const center=b.x.target+b.width/2;
        const options=b.source.getAttribute('aria-disabled')==='true'?[]:b.segments();
        const selected=options.reduce((a,c)=>!a||Math.abs(c.offsetLeft+c.offsetWidth/2-center)<Math.abs(a.offsetLeft+a.offsetWidth/2-center)?c:a,null);
        if(selected)b.onCommit?.(selected);else b.x.target=b.segmentRestX??g.restX;
      }else b.x.target=b.segmentRestX??g.restX;
      b.y.target=0;
    }
    if(cancelled||this.reduced){
      for(const key of ['stretch','bendX','bendY'])b[key].target=0;
      for(const key of ['x','y','press','stretch','bendX','bendY'])b[key].snap();
      b.optical={bend:[0,0],pressure:0,energy:0};
    }
    // Native click behavior remains intact for a tap; only a true drag suppresses it.
    b.source.dispatchEvent(new CustomEvent('lg:gesture',{bubbles:true,detail:{phase:cancelled?'cancel':'end',mode:b.mode,moved:g.moved}}));
    this.wake(b);
  }

  target(element,x,y=0,{snap=false}={}) {
    const b=this.bodies.get(element);if(!b)return;
    b.x.target=x;b.y.target=y;
    if(b.mode==='free'){b.freeX=x;b.freeY=y;}
    if(b.mode==='toggle'){b.width=b.element.offsetWidth;b.travel=this.toggleTravel(b.source);}
    if(snap){b.x.snap();b.y.snap();}this.wake(b);
  }
  /** Record layout once, then let the shared spring move the local material.
   * The retired compositor's unused shape arrays are never computed per frame. */
  transitionSegment(element,x,width,{snap=false}={}) {
    const b=this.bodies.get(element);if(!b)return;
    b.width=width;b.segmentRestX=x;
    this.target(element,x,0,{snap:snap||this.reduced});
  }
  pulse(element,amount=.45) {
    if(this.reduced)return;
    const b=this.bodies.get(element);if(!b)return;
    b.press.velocity=clamp(b.press.velocity+amount*8,-4,4);b.stretch.velocity=clamp(b.stretch.velocity+amount*1.2,-1.5,1.5);this.wake(b);
  }
  setIntensity(value,explicit=false){this.intensity=clamp(value,0,1);this.wake();}
  disabled(body){return body.source.matches(':disabled')||Boolean(body.source.closest('[aria-disabled=true],[inert]'))||body.mode==='segment'&&!body.segments?.().length;}
  toggleTravel(source){const thumb=source.querySelector('[data-glass="thumb"]');if(!thumb)return 0;const inset=parseFloat(getComputedStyle(thumb).left)||3;return Math.max(0,source.clientWidth-thumb.offsetWidth-inset*2);}
  toggleProgress(source){const body=this.bodies.get(source.querySelector('[data-glass="thumb"]'));return clamp((body?.x.value||0)/Math.max(1,this.toggleTravel(source)),0,1);}
  optics(element){return this.bodies.get(element)?.optical||{bend:[0,0],pressure:0,energy:0};}
  cancel(snap=false){this.release(null,true);if(snap){for(const b of this.bodies.values())for(const k of ['x','y','press','stretch','bendX','bendY'])b[k].snap();}this.wake();}
  reflow(){
    this.cancel();
    for(const b of this.bodies.values())if(b.mode==='free'){
      const parent=b.element.parentElement,w=parent.clientWidth,h=parent.clientHeight;
      if(!w||!h)continue;
      const maxX=Math.max(0,(w-b.element.offsetWidth)/2-22),maxY=Math.max(0,(h-b.element.offsetHeight)/2-22);
      b.x.target=b.freeX=clamp(b.freeX,-maxX,maxX);b.y.target=b.freeY=clamp(b.freeY,-maxY,maxY);b.onPosition?.(b.freeX,b.freeY);
    }
    this.wake();
  }
  reset(){this.cancel();for(const b of this.bodies.values()){if(['tether','free','press'].includes(b.mode)){b.x.target=b.y.target=b.freeX=b.freeY=0;}b.press.target=0;}this.wake();}
  wake(body){
    if(this.destroyed)return;
    if(body)this.activeBodies.add(body);else for(const candidate of this.bodies.values())this.activeBodies.add(candidate);
    if(this.activeBodies.size&&!this.frame&&!document.hidden)this.frame=requestAnimationFrame(now=>this.tick(now));
  }

  tick(now) {
    this.frame=0;const dt=this.last?Math.min((now-this.last)/1000,.05):1/60;this.last=now;
    const amount=this.reduced?0:this.intensity;let moving=false;
    for(const b of this.activeBodies){
      if(!b.element.isConnected){this.activeBodies.delete(b);continue;}
      const damping=this.reduced?34:b.mode==='toggle'?26:b.held?22:17;
      const direct=b.held&&(b.mode==='toggle'||b.mode==='segment');
      if(!direct){b.x.step(dt,b.mode==='range'?380:260,damping);b.y.step(dt,260,damping);}
      b.press.step(dt,310,this.reduced?32:18);
      const speed=direct&&this.gesture?.body===b&&now-this.gesture.lastTime>50?0:Math.hypot(b.x.velocity,b.y.velocity);
      if(speed>16)b.angle=Math.atan2(b.y.velocity,b.x.velocity);
      const normalized=Math.min(speed/(b.mode==='range'?1700:2400),.25);
      b.stretch.target=normalized*amount;
      b.stretch.step(dt,230,this.reduced?30:15);
      // Local bend and pressure feed the matching material's optical response.
      b.bendX.target=clamp((b.x.target-b.x.value)*.12,-11,11)*amount;
      b.bendY.target=clamp((b.y.target-b.y.value)*.12,-11,11)*amount;
      b.bendX.step(dt,190,this.reduced?28:14);b.bendY.step(dt,190,this.reduced?28:14);
      if(this.reduced){b.x.snap();b.y.snap();for(const key of ['press','stretch','bendX','bendY']){b[key].target=0;b[key].snap();}}
      const pressure=this.reduced?0:clamp(b.press.value,0,1.16);
      const lift=1+pressure*amount*(b.mode==='range'?.20:.035);
      let m=jellyMatrix(b.stretch.value,b.angle,lift),x=b.x.value,y=b.y.value;
      if(direct){m=[1,0,0,1];y=0;}
      else if(b.mode==='toggle'){
        const pose=togglePose(x,b.travel,b.width,pressure*amount,b.stretch.value);
        m=[pose.scaleX,0,0,pose.scaleY];x=pose.x;y=0;
      }
      const transform=`matrix(${m.map(v=>v.toFixed(5)).join(',')},${x.toFixed(3)},${y.toFixed(3)})`;
      if(b.lastTransform!==transform){b.element.style.transform=transform;b.lastTransform=transform;}
      const active=[...(direct?[]:['x','y']),'press','stretch','bendX','bendY'].some(k=>b[k].moving);
      b.optical={bend:b.mode==='toggle'?[0,0]:[b.bendX.value,b.bendY.value],pressure,energy:Math.abs(b.stretch.value)+Math.hypot(b.bendX.value,b.bendY.value)*.015};
      b.element.classList.toggle('jelly-moving',active||b.held);
      b.element.dispatchEvent(new CustomEvent('lg:optics',{bubbles:true,detail:{...b.optical,velocity:speed>0?[b.x.velocity,b.y.velocity]:[0,0]}}));
      moving ||= active;
      if(!active)this.activeBodies.delete(b);
    }
    this.renderer?.invalidate();
    if(moving&&!this.frame)this.frame=requestAnimationFrame(time=>this.tick(time));else if(!moving)this.last=0;
  }
  destroy(){this.cancel(true);this.destroyed=true;cancelAnimationFrame(this.frame);this.frame=0;this.abort.abort();for(const element of [...this.bodies.keys()])this.unregister(element);this.activeBodies.clear();}
}
