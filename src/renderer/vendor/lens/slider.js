// Extracted from components.js defineComponent('slider') at design-systems
// 7a424c93b9be13cf835b91ea67495fec2ec0584e (MIT; see LICENSE).
// Original DOM, value flow, lg:sync and native input callback are retained.
import {createLensSurface} from './internal/lens-surface.js';
let componentId=0;
const node=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
const accessibleLabel=label=>{if(typeof label!=='string'||!label.trim())throw new TypeError('A non-empty accessible label is required');return label;};
export function createSlider({label,min=0,max=100,step=1,value=50,onChange=()=>{}}={}) {
  if(![min,max,step,value].every(Number.isFinite)||max<=min||step<=0)throw new TypeError('Invalid slider range');
  const el=node('label','lg-slider'),head=node('span','lg-slider-heading'),output=node('output'),wrap=node('span','lg-slider-wrap'),input=node('input');
  head.append(node('span','',accessibleLabel(label)),output);input.type='range';input.setAttribute('aria-label',label);input.min=min;input.max=max;input.step=step;input.value=value;input.id=`lg-range-${++componentId}`;input.dataset.lgSound='tick';output.htmlFor=input.id;wrap.append(input,createLensSurface({tag:'span',className:'lg-slider-thumb',kind:'thumb'}).element);el.append(head,wrap);el.dataset.lgComponent='slider';
  // Keep the native range as a transparent hit/focus layer. The same Lens
  // track is a separate decoration so it can be sampled below its glass thumb.
  const track=node('span','lg-slider-track');track.setAttribute('aria-hidden','true');track.dataset.liquidBackdrop='';wrap.prepend(track);
  input.defaultValue=String(value);
  const abort=new AbortController(),setValue=(next,{emit=false}={})=>{if(!Number.isFinite(Number(next)))return;input.value=next;output.value=input.value;if(emit)onChange(Number(input.value));input.dispatchEvent(new CustomEvent('lg:sync',{bubbles:true}));};setValue(value);
  input.addEventListener('input',()=>setValue(input.value,{emit:true}),{signal:abort.signal});
  document.addEventListener('reset',event=>{if(event.target===input.form)queueMicrotask(()=>{if(!abort.signal.aborted&&!event.defaultPrevented)setValue(input.value);});},{signal:abort.signal});
  return {element:el,get value(){return Number(input.value);},setValue,destroy(){abort.abort();el.dispatchEvent(new CustomEvent('lg:unmount',{bubbles:true}));}};
}
