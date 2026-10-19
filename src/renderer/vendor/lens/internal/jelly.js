import { Spring, clamp, jellyMatrix, boundDrag, togglePose } from './jelly-physics.js';
import { scrubSegment, scrubSwitch, switchRelease, segmentGrab, segmentCenter, sliderBand,projectSlider,SEGMENT_LIFT, SWITCH_LIFT } from '../../ishiakiz/controls.js';
import {rubberBand} from '../../samasante/interaction.js';

// Keep Lens/IshiakiZ's rational endpoint resistance on both drag axes. Scaling
// the same curve avoids a hard vertical plateau and gives an invertible grab
// position when a release is interrupted.
const rangeBand=(distance,limit=8)=>sliderBand(Math.abs(distance)*8/limit)*limit/8*Math.sign(distance);
const rangeUnband=(distance,limit=8)=>{
  const value=Math.min(Math.abs(distance),limit-.001);
  return limit*value/(.55*(limit-value))*Math.sign(distance);
};

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
    window.addEventListener('blur', () => this.cancel(true), { signal:this.signal });
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
      x:new Spring(), y:new Spring(), press:new Spring(), stretch:new Spring(), bendX:new Spring(), bendY:new Spring(), fit:new Spring(element.offsetWidth),
      angle:0, held:false, freeX:0, freeY:0, width:element.offsetWidth,height:element.offsetHeight,
      offsetLeft:element.offsetLeft,offsetTop:element.offsetTop,travel:mode==='toggle'?this.toggleTravel(source):0,
      previousTransform:element.style.transform, previousOrigin:element.style.transformOrigin,
      optical:{bend:[0,0],pressure:0,energy:0},abort:new AbortController() };
    this.bodies.set(element, body);
    element.dataset.jelly = mode; element.style.setProperty('--jelly-matrix','matrix(1,0,0,1,0,0)');
    if(mode==='segment')element.style.transformOrigin='0 50%';
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
    if(body.mode==='segment')element.style.transformOrigin=body.previousOrigin;
    if(this.blockClick?.source===body.source)this.blockClick=null;
    if(!this.activeBodies.size&&this.frame){cancelAnimationFrame(this.frame);this.frame=0;this.last=0;}
  }

  grab(body, e) {
    if(e.button!==0 || !e.isPrimary || this.gesture || this.disabled(body))return;
    let presentation;
    if(body.mode==='segment'){
      const button=e.target.closest('button');
      if(button&&(button.matches(':disabled')||button.getAttribute('aria-disabled')==='true'))return;
      if(button&&button.getAttribute('aria-selected')!=='true'&&!button.hasAttribute('aria-current')){
        // The visible capsule can still cross the old slot after selection
        // commits. A fresh grab follows that presentation, not aria's target.
        presentation=body.element.getBoundingClientRect();
        if(!(presentation.width>0&&presentation.height>0&&e.clientX>=presentation.left&&e.clientX<=presentation.right&&e.clientY>=presentation.top&&e.clientY<=presentation.bottom))return;
      }
      if(!body.segments?.().length||body.source.closest('[aria-disabled=true]'))return;
    }
    // A panel never steals a slider, menu, button, or nested draggable's gesture.
    if(['tether','press','free'].includes(body.mode)) {
      const interactive=e.target.closest('button,input,textarea,select,a,[contenteditable]:not([contenteditable=false]),[role=button],[role=slider],[role=textbox],[data-optical-drag]');
      if(interactive&&interactive!==body.source&&interactive!==body.element)return;
      const nested=e.target.closest('[data-jelly]');if(nested&&nested!==body.source&&nested!==body.element)return;
    }
    const boundary=body.mode==='free'?body.element.parentElement:this.stage;
    const r=presentation??body.element.getBoundingClientRect(), sr=boundary.getBoundingClientRect();
    body.width=body.element.offsetWidth;
    body.height=body.element.offsetHeight;body.offsetLeft=body.element.offsetLeft;body.offsetTop=body.element.offsetTop;
    if(body.mode==='toggle')body.travel=this.toggleTravel(body.source);
    if(body.mode==='range')body.rangeRect=body.source.getBoundingClientRect();
    const sourceRect=body.mode==='segment'||body.mode==='toggle'?body.source.getBoundingClientRect():null;
    const grabOffset=(e.clientX-r.left)*body.width/Math.max(1,r.width);
    // Flatten the existing presentation scale around the exact grabbed local
    // point. The pointer can interrupt a release spring without a center jump.
    const baseX=sourceRect?e.clientX-grabOffset-sourceRect.left-body.source.clientLeft-body.element.offsetLeft:body.x.value;
    const capture=body.mode==='segment'?(e.target.closest('button')||body.source):body.source;
    this.gesture={body,boundary,capture,id:e.pointerId,startX:e.clientX,startY:e.clientY,baseX:body.x.value,restX:body.x.target,baseY:body.y.value,
      grabOffset,sourceWidth:body.source.clientWidth,lastX:e.clientX,lastY:e.clientY,lastTime:e.timeStamp,velocityX:0,velocityY:0,
      rect:{left:r.left-sr.left-body.x.value,top:r.top-sr.top-body.y.value,right:r.right-sr.left-body.x.value,bottom:r.bottom-sr.top-body.y.value},moved:false};
    if(body.mode==='range'){
      const g=this.gesture,rect=body.rangeRect;
      g.rangeScaleX=rect.width/Math.max(1,body.source.offsetWidth)||1;
      g.rangeScaleY=rect.height/Math.max(1,body.source.offsetHeight)||1;
      const onThumb=e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom;
      // A rail click retains the native range's jump. A thumb grab retains the
      // pointer's local offset, including a currently returning elastic thumb.
      g.rangeGrabOffset=onThumb?e.clientX-(r.left+r.width/2):0;
      const rest=body.rangeRestX??body.x.value,travel=Math.max(0,body.source.clientWidth-body.width);
      const overshoot=rest<=.01?Math.min(0,body.x.value):rest>=travel-.01?Math.max(0,body.x.value-travel):0;
      g.rangeOvershoot=this.reduced?0:overshoot;
      g.rangeSeedX=onThumb&&!this.reduced?rangeUnband(overshoot)-overshoot:0;
      g.rangeSeedY=this.reduced?0:rangeUnband(body.y.value,14);
      g.rangeLastX=body.x.value;g.rangeLastY=body.y.value;
      body.x.target=body.x.value;body.y.target=body.y.value;
      body.x.velocity=body.y.velocity=0;
    }
    if(body.mode==='segment'){
      const g=this.gesture,k=sourceRect.width/(body.source.offsetWidth||1)||1;
      g.sourceScale=k;g.sourceLeft=sourceRect.left+body.source.clientLeft*k;
      g.pointer=(e.clientX-g.sourceLeft)/k;
      const left=(r.left-g.sourceLeft)/k-body.element.offsetLeft,width=r.width/k;
      g.baseX=left;g.grab=segmentGrab(g.pointer,left,width);
      // Invert the same cubic band so a re-grab starts at the live vertical
      // presentation without adding another fourteen pixels on every grab.
      g.verticalLimit=Math.max(14,Math.abs(body.y.value));
      g.verticalOffset=70*(1-Math.cbrt(1-Math.min(1,Math.abs(body.y.value)/g.verticalLimit)))*Math.sign(body.y.value);
      body.fit.snap(width);body.x.snap(left);
      g.slots=body.segments().map(el=>({el,x:el.offsetLeft,w:el.offsetWidth}));
    }
    // A fresh gesture interrupts the shape at its current presentation.
    body.held=true;body.press.target=1;
    if(sourceRect&&body.mode!=='segment'){this.gesture.baseX=baseX;body.x.snap(baseX);body.y.snap(0);}
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
      const rect=b.rangeRect,travel=Math.max(0,b.source.clientWidth-b.width);
      const position=(e.clientX-rect.left-g.rangeGrabOffset)/g.rangeScaleX-b.width/2+g.rangeSeedX;
      const excess=position-clamp(position,0,travel);
      g.rangeOvershoot=this.reduced?0:rangeBand(excess);
      b.x.value=b.x.target=(b.rangeRestX??b.x.target)+g.rangeOvershoot;
      b.y.value=b.y.target=this.reduced?0:rangeBand(g.rangeSeedY+dy/g.rangeScaleY,14);
      // Release inherits the glass's resisted velocity, rather than the much
      // faster raw pointer outside a bound. No new jump is injected on release.
      b.x.velocity=clamp((b.x.value-g.rangeLastX)/elapsed,-2400,2400);
      b.y.velocity=clamp((b.y.value-g.rangeLastY)/elapsed,-420,420);
      g.rangeLastX=b.x.value;g.rangeLastY=b.y.value;
      g.rangeMoved=true;
    } else if(b.mode==='toggle') {
      b.x.target=scrubSwitch(g.baseX+dx,b.travel);b.y.target=0;
    } else if(b.mode==='segment') {
      // IshiakiZ's proportional grab survives fitting a differently sized
      // slot. Presentation width, rather than a stale target box, owns x.
      g.pointer=(e.clientX-g.sourceLeft)/g.sourceScale;
      const center=segmentCenter(g.pointer,g.grab,b.fit.value);
      const slot=g.slots.reduce((a,c)=>!a||Math.abs(c.x+c.w/2-center)<Math.abs(a.x+a.w/2-center)?c:a,null);
      if(slot&&slot.el!==g.preview){g.preview=slot.el;this.fitSegment(b,slot.w);}
      b.x.target=this.segmentPosition(b,g);
      // The selected glass can lift off its rail while its native labels stay
      // fixed. Sam Asante's bounded over-drag keeps that lift under the finger.
      const vertical=g.verticalOffset+dy/g.sourceScale;
      b.y.target=this.reduced?0:rubberBand(Math.abs(vertical),g.verticalLimit,70)*Math.sign(vertical);
    } else {
      const bound=boundDrag(g.baseX+dx,g.baseY+dy,g.rect,{width:g.boundary.clientWidth,height:g.boundary.clientHeight},22);
      b.x.target=clamp(bound.x,-b.maxTravel,b.maxTravel);b.y.target=clamp(bound.y,-b.maxTravel,b.maxTravel);
    }
    if(b.mode==='toggle'||b.mode==='segment'){
      // Held movement is direct manipulation; springs begin only at release.
      const previousY=b.y.value;
      b.x.value=b.x.target;b.y.value=b.y.target;
      b.x.velocity=g.velocityX;b.y.velocity=b.mode==='segment'?clamp((b.y.value-previousY)/elapsed,-420,420):g.velocityY;
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
    if(b.mode==='range'){
      b.x.target=b.rangeRestX??b.x.target;b.y.target=0;
      // Upstream projection feeds the optical bend only. Native range values
      // remain the sole model and are never changed by a visual release.
      b.bendX.value=cancelled||this.reduced?0:clamp((projectSlider(b.x.value,b.x.velocity)-b.x.target)*.06,-8,8);
      b.bendX.target=0;
    }
    if(b.mode==='toggle'){
      if(g.moved&&!cancelled)b.onCommit?.(switchRelease(b.x.value,b.travel,e&&e.timeStamp-g.lastTime<=80?g.velocityX:0));
      else b.x.target=g.restX;
      b.y.target=0;
    }
    if(b.mode==='segment'){
      if(g.moved&&!cancelled){
        const center=b.x.value+b.fit.value/2;
        const options=b.source.getAttribute('aria-disabled')==='true'?[]:b.segments();
        const selected=options.reduce((a,c)=>!a||Math.abs(c.offsetLeft+c.offsetWidth/2-center)<Math.abs(a.offsetLeft+a.offsetWidth/2-center)?c:a,null);
        if(selected)b.onCommit?.(selected);else b.x.target=b.segmentRestX??g.restX;
      }else b.x.target=b.segmentRestX??g.restX;
      this.fitSegment(b,b.segmentRestWidth??b.width,{snap:cancelled||this.reduced});
      b.y.target=0;
    }
    if(cancelled||this.reduced){
      for(const key of ['stretch','bendX','bendY'])b[key].target=0;
      for(const key of ['x','y','press','stretch','bendX','bendY','fit'])b[key].snap();
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
    if(b.mode==='toggle'){b.width=b.element.offsetWidth;b.height=b.element.offsetHeight;b.offsetLeft=b.element.offsetLeft;b.offsetTop=b.element.offsetTop;b.travel=this.toggleTravel(b.source);}
    if(snap){b.x.snap();b.y.snap();}this.wake(b);
  }
  /** Record layout once, then let the shared spring move the local material.
   * The retired compositor's unused shape arrays are never computed per frame. */
  transitionSegment(element,x,width,{snap=false}={}) {
    const b=this.bodies.get(element);if(!b)return;
    b.segmentRestX=x;b.segmentRestWidth=width;
    this.fitSegment(b,width,{snap:snap||this.reduced});
    this.target(element,x,0,{snap:snap||this.reduced});
  }
  fitSegment(body,width,{snap=false}={}){
    width=Math.max(1,width);
    body.width=width;body.element.style.width=`${width}px`;body.fit.target=width;
    body.height=body.element.offsetHeight;body.offsetLeft=body.element.offsetLeft;body.offsetTop=body.element.offsetTop;
    if(snap||this.reduced||!(body.fit.value>0))body.fit.snap(width);
  }
  segmentPosition(body,g){
    const first=g.slots[0],last=g.slots[g.slots.length-1];
    const x=segmentCenter(g.pointer,g.grab,body.fit.value)-body.fit.value/2;
    return first?scrubSegment(x,first,last,body.fit.value):x;
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
  cancel(snap=false){this.release(null,true);if(snap){for(const b of this.bodies.values()){for(const k of ['press','stretch','bendX','bendY'])b[k].target=0;for(const k of ['x','y','press','stretch','bendX','bendY','fit'])b[k].snap();b.optical={bend:[0,0],pressure:0,energy:0};}}this.wake();}
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
      const direct=b.held&&(b.mode==='toggle'||b.mode==='segment'||b.mode==='range');
      if(b.mode==='segment'){
        b.fit.step(dt,260,this.reduced?34:24);
        if(direct&&this.gesture?.body===b){b.x.value=b.x.target=this.segmentPosition(b,this.gesture);}
      }
      if(!direct){b.x.step(dt,b.mode==='range'?380:260,damping);b.y.step(dt,260,damping);}
      b.press.step(dt,310,this.reduced?32:18);
      const speed=direct&&this.gesture?.body===b&&now-this.gesture.lastTime>50?0:Math.hypot(b.x.velocity,b.y.velocity);
      if(speed>16)b.angle=Math.atan2(b.y.velocity,b.x.velocity);
      const normalized=Math.min(speed/(b.mode==='range'?1700:2400),.25);
      b.stretch.target=normalized*amount;
      b.stretch.step(dt,230,this.reduced?30:15);
      // Local bend and pressure feed the matching material's optical response.
      b.bendX.target=clamp((b.x.target-b.x.value)*.12,-11,11)*amount;
      b.bendY.target=clamp((direct&&b.mode==='segment'?b.y.value:b.y.target-b.y.value)*.12,-11,11)*amount;
      b.bendX.step(dt,190,this.reduced?28:14);b.bendY.step(dt,190,this.reduced?28:14);
      if(this.reduced){b.x.snap();b.y.snap();for(const key of ['press','stretch','bendX','bendY']){b[key].target=0;b[key].snap();}}
      const pressure=this.reduced?0:clamp(b.press.value,0,1.16);
      const lift=1+pressure*amount*(b.mode==='range'?.20:b.mode==='segment'?SEGMENT_LIFT.grow-1:.035);
      let m=jellyMatrix(b.stretch.value,b.angle,lift),x=b.x.value,y=b.y.value;
      if(direct&&b.mode==='toggle'){m=[1,0,0,1];y=0;}
      // Keep the horizontal proportional grab and its edge band exact while
      // retaining the same body's vertical lift and velocity deformation.
      if(direct&&b.mode==='segment')m=[1,0,0,m[3]];
      if(b.mode==='press'){
        const scale=this.reduced?1:1-Math.min(1,pressure)*.02;
        m=[scale,0,0,scale];x=y=0;
      }
      else if(b.mode==='toggle'&&!direct){
        const pose=togglePose(x,b.travel,b.width,pressure*amount,b.stretch.value);
        m=[pose.scaleX,0,0,pose.scaleY];x=pose.x;y=0;
      }
      if(b.mode==='segment'){
        // Fit is drawn with transform only. Its actual DOM presentation is
        // also the single geometry source used by the shared optical scene.
        m=[m[0]*b.fit.value/Math.max(1,b.width),0,0,m[3]];
      }
      const transform=`matrix(${m.map(v=>v.toFixed(5)).join(',')},${x.toFixed(3)},${y.toFixed(3)})`;
      if(b.lastTransform!==transform){b.element.style.transform=transform;b.lastTransform=transform;}
      const active=[...(direct?[]:['x','y']),'press','stretch','bendX','bendY',...(b.mode==='segment'?['fit']:[])].some(k=>b[k].moving);
      b.optical={bend:b.mode==='toggle'?[0,0]:[b.bendX.value,b.bendY.value],pressure,energy:Math.abs(b.stretch.value)+Math.hypot(b.bendX.value,b.bendY.value)*.015};
      b.element.classList.toggle('jelly-moving',active||b.held);
      b.element.dispatchEvent(new CustomEvent('lg:optics',{bubbles:true,detail:{...b.optical,velocity:speed>0?[b.x.velocity,b.y.velocity]:[0,0]}}));
      const opticalLift=b.mode==='segment'?SEGMENT_LIFT:b.mode==='toggle'?SWITCH_LIFT:null;
      const originX=b.mode==='segment'?0:b.width/2,originY=b.height/2;
      const localRect={
        x:b.offsetLeft+x+originX-m[0]*originX-m[2]*originY+Math.min(0,m[0]*b.width)+Math.min(0,m[2]*b.height),
        y:b.offsetTop+y+originY-m[1]*originX-m[3]*originY+Math.min(0,m[1]*b.width)+Math.min(0,m[3]*b.height),
        width:Math.abs(m[0]*b.width)+Math.abs(m[2]*b.height),height:Math.abs(m[1]*b.width)+Math.abs(m[3]*b.height),
      };
      const detail={pressure,bend:{x:b.optical.bend[0],y:b.optical.bend[1]},velocity:{x:speed>0?b.x.velocity:0,y:speed>0?b.y.velocity:0},
        localRect,zoom:opticalLift?1+(opticalLift.zoom-1)*pressure:1,dispersion:opticalLift?opticalLift.dispersion*pressure:0};
      b.element.dispatchEvent(new CustomEvent('lg:material',{bubbles:true,detail}));
      // Ancestor sources receive the event by bubbling. Disjoint handles get
      // one direct delivery; no second stage-wide event for the same body.
      if(b.source!==b.element&&!b.source.contains(b.element))b.source.dispatchEvent(new CustomEvent('lg:material',{bubbles:true,detail}));
      moving ||= active;
      if(!active)this.activeBodies.delete(b);
    }
    this.renderer?.invalidate();
    if(moving&&!this.frame)this.frame=requestAnimationFrame(time=>this.tick(time));else if(!moving)this.last=0;
  }
  destroy(){this.cancel(true);this.destroyed=true;cancelAnimationFrame(this.frame);this.frame=0;this.abort.abort();for(const element of [...this.bodies.keys()])this.unregister(element);this.activeBodies.clear();}
}
