// Real Lens progress factory from design-systems 7a424c93b9be13cf835b91ea67495fec2ec0584e (MIT).
// Extracted without a second renderer; retained original source: upstream/optical-progress.js.txt.
import {tokens} from './tokens.js';
import {opticClamp,opticColor,setOpticalState,clearOpticalState} from './internal/optics.js';

const opticalNode = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const opticalLabel = value => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('A non-empty accessible label is required');
  return value;
};
const opticalSurface = (element, kind) => { element.classList.add('lg-surface'); element.dataset.glass = kind; return element; };
const opticalSignal = (element, cue) => element.dispatchEvent(new CustomEvent('lg:commit', {bubbles: true, detail: {cue}}));
const opticalSync = element => element.dispatchEvent(new CustomEvent('lg:sync', {bubbles: true}));

export function addOpticalRim(element) {
  if (element.querySelector('.lg-optic-rim')) return;
  const rim = opticalNode('span', 'lg-optic-rim'), beam = opticalNode('span', 'lg-optic-beam');
  rim.setAttribute('aria-hidden', 'true'); rim.append(beam); element.append(rim);
}

function opticalPulse(element, color, forceMotion = false) {
  const beam = element.querySelector('.lg-optic-beam');
  beam?.getAnimations().forEach(animation => animation.cancel());
  if (forceMotion || !matchMedia('(prefers-reduced-motion: reduce)').matches) beam?.animate([{transform: 'rotate(-100deg)', opacity: 0}, {opacity: 1, offset: .1}, {transform: 'rotate(260deg)', opacity: 0}], {duration: tokens.optics.flowDuration, easing: 'ease-out'});
  element.style.setProperty('--lg-optical-color', tokens.optics[color]);
}

export function createOpticalProgress({label, value = 0, max = 100, completionColor = 'green', completeLabel = 'Complete', wave = true, motion = 'system', onChange = () => {}, onComplete = () => {}} = {}) {
  opticalLabel(label); opticalLabel(completeLabel); opticColor(completionColor);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(value)) throw new TypeError('Invalid progress range');
  if (!['system','on','off'].includes(motion)) throw new TypeError('Invalid progress motion preference');
  const element = opticalNode('div', 'lg-progress'), head = opticalNode('div', 'lg-progress-heading'), output = opticalNode('output', 'lg-progress-value');
  const track = opticalSurface(opticalNode('div', 'lg-progress-track'), 'optical-progress');
  const fill = opticalNode('span', 'lg-progress-fill'), emitter = opticalNode('span', 'lg-progress-emitter');
  const fiber = document.createElementNS('http://www.w3.org/2000/svg','svg'), fiberPath = document.createElementNS(fiber.namespaceURI,'path');
  fiber.setAttribute('viewBox','0 0 600 46'); fiber.setAttribute('preserveAspectRatio','none'); fiber.setAttribute('aria-hidden','true'); fiber.classList.add('lg-progress-fiber');
  fiberPath.setAttribute('d','M-240 23 Q-180 17 -120 23 T0 23 T120 23 T240 23 T360 23 T480 23 T600 23 T720 23 T840 23'); fiber.append(fiberPath);
  const status = opticalNode('span', 'lg-visually-hidden'); status.setAttribute('role', 'status');
  track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', label); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(max));
  fill.setAttribute('aria-hidden', 'true'); emitter.setAttribute('aria-hidden', 'true');
  head.append(opticalNode('span', '', label), output); track.append(fill, fiber, emitter); addOpticalRim(track); element.append(head, track, status);
  let current = 0, initialized = false, destroyed = false, color = completionColor;
  const setValue = (next, {emit = false, animate = true} = {}) => {
    if (destroyed) return;
    if (!Number.isFinite(next)) throw new TypeError('Progress value must be finite');
    const previous = current; current = opticClamp(next, 0, max);
    const complete = current === max, crossed = initialized && previous < max && complete;
    element.dataset.complete = String(complete); element.style.setProperty('--lg-progress', String(current / max));
    element.dataset.motion = motion; element.dataset.wave = String(Boolean(wave) && motion !== 'off' && current > 0);
    element.style.setProperty('--lg-optical-color', tokens.optics[color]);
    output.value = `${Math.round(current / max * 100)}%${complete ? ` · ${completeLabel}` : ''}`;
    track.setAttribute('aria-valuenow', String(current)); track.setAttribute('aria-valuetext', output.value);
    status.textContent = complete ? completeLabel : '';
    setOpticalState(track, {kind: 1, fill: current / max, complete: complete ? 1 : 0, color: opticColor(color), wave: Boolean(wave) && motion !== 'off', forceMotion: motion === 'on'}, {animate: initialized && animate && motion !== 'off', pulse: crossed});
    if (crossed && animate && motion !== 'off') opticalPulse(track, color, motion === 'on');
    if (!complete) track.querySelector('.lg-optic-beam').getAnimations().forEach(animation => animation.cancel());
    if (emit && previous !== current) onChange(current);
    if (crossed && emit) { onComplete(current); opticalSignal(element, 'success'); }
    initialized = true;
  };
  setValue(value, {animate: false});
  return {element, get value() {return current;}, setValue, setCompletionColor(next) {opticColor(next); color = next; setValue(current, {animate: false});}, setMotion(next) {if(!['system','on','off'].includes(next)) throw new TypeError('Invalid progress motion preference'); motion=next; setValue(current,{animate:false});}, destroy() {destroyed = true; element.dataset.wave='false'; track.querySelector('.lg-optic-beam').getAnimations().forEach(animation => animation.cancel()); clearOpticalState(track);}};
}


