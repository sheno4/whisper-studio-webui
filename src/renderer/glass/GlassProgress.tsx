import {useLayoutEffect,useRef} from 'react';
import {createComponent,type OpticalProgressHandle} from '../vendor/lens-native/index.js';
import {releaseLensRoot,scheduleLensMount} from '../lens/Runtime';
import '../lens/progress.css';

export interface GlassProgressProps {
  label:string;value?:number;max?:number;caption?:string;displayValue?:string;valueText?:string;
  active?:boolean;completionColor?:'green'|'gold';size?:'default'|'compact';className?:string;
}

/** React owns an empty host; Lens creates and updates the real optical track,
 * fill, emitter and fiber once. Progress never acquires another GL renderer. */
export function GlassProgress(props:GlassProgressProps):React.JSX.Element {
  const host=useRef<HTMLDivElement>(null),handle=useRef<OpticalProgressHandle|null>(null);
  const update=useRef<(()=>void)|null>(null),latest=useRef(props);latest.current=props;
  const max=Number.isFinite(props.max)&&props.max!>0?props.max!:100;
  useLayoutEffect(()=>{
    const root=host.current;if(!root)return;
    const current=latest.current;
    const instance=createComponent('progress',{label:current.label,max,value:0,completeLabel:'已完成',completionColor:current.completionColor??'green',motion:'off'});
    handle.current=instance;root.append(instance.element);scheduleLensMount(instance.element);
    const element=instance.element,track=element.querySelector<HTMLElement>('.lg-progress-track')!;
    const caption=element.querySelector<HTMLElement>('.lg-progress-heading > span')!;
    const output=element.querySelector<HTMLOutputElement>('.lg-progress-value')!;
    const beam=track.querySelector<HTMLElement>('.lg-optic-beam')!;
    const reduce=matchMedia('(prefers-reduced-motion: reduce)');
    let visible=false,lastMotion:'system'|'off'='off',lastColor=current.completionColor??'green';
    let pulse:Animation|null=null;
    const clearPulse=()=>{if(pulse){pulse.removeEventListener('finish',finishPulse);pulse.removeEventListener('cancel',finishPulse);pulse=null;}};
    const finishPulse=()=>{clearPulse();sync();};
    const sync=()=>{
      const p=latest.current,known=typeof p.value==='number'&&Number.isFinite(p.value);
      const value=known?Math.min(max,Math.max(0,p.value!)):0;
      if(value<max)clearPulse();
      const crossing=known&&instance.value<max&&value===max;
      const motion=visible&&!document.hidden&&!reduce.matches&&((p.active!==false&&value<max)||crossing||pulse!==null)?'system':'off';
      if(lastMotion!==motion){
        instance.setMotion(motion);lastMotion=motion;
        if(motion==='off'){clearPulse();beam.getAnimations().forEach(animation=>animation.cancel());}
      }
      const color=p.completionColor??'green';if(color!==lastColor){instance.setCompletionColor(color);lastColor=color;}
      if(instance.value!==value)instance.setValue(value,{animate:motion!=='off'});
      if(crossing&&motion!=='off'){
        clearPulse();pulse=beam.getAnimations().find(animation=>animation.playState==='running')??null;
        pulse?.addEventListener('finish',finishPulse);pulse?.addEventListener('cancel',finishPulse);
      }
      // Keep the original finite completion beam and color transition. A
      // completed track has no endlessly running fiber after that handoff.
      if(value===max)element.dataset.wave='false';
      element.dataset.indeterminate=String(!known);
      element.dataset.pendingMotion=String(!known&&motion!=='off');
      if(!known){track.removeAttribute('aria-valuenow');element.style.setProperty('--lg-progress','.32');}
      else{track.setAttribute('aria-valuenow',String(value));element.style.setProperty('--lg-progress',String(value/max));}
      track.setAttribute('aria-label',p.label);
      track.setAttribute('aria-valuetext',p.valueText??(known?`${Math.round(value/max*100)}%${value===max?' · 已完成':''}`:'进度待确认'));
      const text=p.caption??p.label;caption.textContent=text;caption.title=text;
      output.value=p.displayValue??(known?`${Math.round(value/max*100)}%${value===max?' · 已完成':''}`:'进度待确认');output.title=output.value;
    };
    update.current=sync;
    const observer=new IntersectionObserver(entries=>{const entry=entries[0];if(entry&&visible!==entry.isIntersecting){visible=entry.isIntersecting;sync();}});
    observer.observe(root);reduce.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);sync();
    return()=>{update.current=null;handle.current=null;clearPulse();observer.disconnect();reduce.removeEventListener('change',sync);document.removeEventListener('visibilitychange',sync);releaseLensRoot(instance.element);instance.destroy();instance.element.remove();};
  },[max]);
  useLayoutEffect(()=>{update.current?.();},[props.label,props.value,props.caption,props.displayValue,props.valueText,props.active,props.completionColor]);
  return <div ref={host} className={`glass-progress ${props.className??''}`.trim()} data-glass-progress-source="lens-native" data-size={props.size??'default'}/>;
}
