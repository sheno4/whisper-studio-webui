import type {GlassSystem, JellyController} from '../vendor/lens-native/index.js';
import {bindNativeSegmentMotion} from './segment-motion';

type BodyOptions = NonNullable<Parameters<JellyController['register']>[1]>;
type Spring = {target: number; value: number};
type Body = {element: HTMLElement; source: HTMLElement; mode: BodyOptions['mode']; segments?: () => HTMLElement[]; x: Spring; y: Spring; onPosition?: () => void};
type NativeJelly = JellyController & {
  bodies: Map<HTMLElement, Body>;
  gesture: {body: Body; capture: HTMLElement} | null;
  blockClick: {source: HTMLElement} | null;
  grab(body: Body, event: PointerEvent): void;
  release(event?: PointerEvent | null, cancelled?: boolean): void;
  toggleTravel(source: HTMLElement): number;
};
type Registration = {root: HTMLElement; element: HTMLElement; abort: AbortController; cleanups: Array<() => void>};
const mountSelectors = new Set(['[data-lg-drag]', '[data-lg-component=switch]', '[data-lg-component=slider]', '[data-lg-segments]']);
export const controlSelector = '[data-lg-drag],[data-lg-component=switch],[data-lg-component=slider],[data-lg-segments]';

/** The portable runtime only has an app-wide destroy. Suppress its first
 * non-detachable mount, then register the same native bodies with node scopes.
 * This local, synchronous override never changes the vendor or DOM structure. */
export function withoutInitialControlMount<T>(stage: HTMLElement, create: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(stage, 'querySelectorAll');
  const query = stage.querySelectorAll;
  Object.defineProperty(stage, 'querySelectorAll', {configurable: true, value(selector: string) {
    return mountSelectors.has(selector)
      ? stage.ownerDocument.createDocumentFragment().querySelectorAll(selector)
      : query.call(stage, selector);
  }});
  try { return create(); }
  finally {
    if (descriptor) Object.defineProperty(stage, 'querySelectorAll', descriptor);
    else Reflect.deleteProperty(stage, 'querySelectorAll');
  }
}

export function createNativeLifecycle(system: GlassSystem, stage: HTMLElement) {
  const jelly = system.jelly as NativeJelly;
  const registrations = new Map<HTMLElement, Registration>();
  const nativeGrab = jelly.grab;
  const nativeRelease = jelly.release;
  // :disabled includes controls disabled by a containing fieldset.
  jelly.grab = function(body, event) {
    if (body.source.matches(':disabled') || body.source.closest('[inert]') || (body.mode === 'segment' && !body.segments?.().length)) return;
    if (body.mode === 'segment' && event.target instanceof Element && event.target.closest('button')?.matches(':disabled')) return;
    return nativeGrab.call(this, body, event);
  };
  jelly.release = function(event, cancelled = false) {
    const gesture = this.gesture, body = gesture?.body;
    // Becoming disabled/inert during a drag cancels the gesture, rather than
    // leaving an uncommitted switch thumb at the pointer's final position.
    const sourceDisabled = Boolean(body && (body.source.matches(':disabled') || body.source.closest('[inert]')));
    const shouldCancel = cancelled || sourceDisabled || Boolean(body?.mode === 'segment' && (body.source.getAttribute('aria-disabled') === 'true' || gesture?.capture.matches(':disabled') || !body.segments?.().length));
    nativeRelease.call(this, event, shouldCancel);
    // Native cancellation restores its grab-time position. Controlled props may
    // also have changed mid-drag, so finish at the current semantic value.
    if (shouldCancel && body?.mode === 'toggle' && this.gesture !== gesture) {
      this.target(body.element, body.source.getAttribute('aria-checked') === 'true' ? this.toggleTravel(body.source) : 0);
    }
  };

  const all = (root: HTMLElement, selector: string): HTMLElement[] => [
    ...(root.matches(selector) ? [root] : []), ...root.querySelectorAll<HTMLElement>(selector)
  ];
  const addBody = (root: HTMLElement, element: HTMLElement, options: BodyOptions): Registration => {
    const source = options.source ?? element;
    const entry: Registration = {root, element, abort: new AbortController(), cleanups: []};
    // Capture only register()'s two native handlers on this one source. The
    // upstream controller still owns pointer capture, springs, optics and taps.
    const descriptor = Object.getOwnPropertyDescriptor(source, 'addEventListener');
    const add = source.addEventListener;
    Object.defineProperty(source, 'addEventListener', {configurable: true, value(type: string, listener: EventListener, eventOptions?: AddEventListenerOptions | boolean) {
      const scoped = typeof eventOptions === 'boolean' ? {capture: eventOptions, signal: entry.abort.signal} : {...eventOptions, signal: entry.abort.signal};
      add.call(source, type, listener, scoped);
      entry.cleanups.push(() => source.removeEventListener(type, listener, scoped));
    }});
    try { jelly.register(element, options); }
    finally {
      if (descriptor) Object.defineProperty(source, 'addEventListener', descriptor);
      else Reflect.deleteProperty(source, 'addEventListener');
    }
    registrations.set(element, entry);
    return entry;
  };

  const remove = (entry: Registration) => {
    if (jelly.gesture?.body.element === entry.element) jelly.release(null, true);
    if (jelly.blockClick && (entry.root.contains(jelly.blockClick.source) || entry.element === jelly.blockClick.source)) jelly.blockClick = null;
    entry.abort.abort();
    entry.cleanups.forEach(cleanup => cleanup());
    jelly.bodies.delete(entry.element);
    registrations.delete(entry.element);
    delete entry.element.dataset.jelly;
    delete entry.element.dataset.held;
    entry.element.style.removeProperty('--jelly-matrix');
    entry.element.classList.remove('jelly-moving');
  };

  const release = (root: HTMLElement) => {
    for (const entry of registrations.values()) {
      if (root === entry.root || root.contains(entry.root) || root === entry.element || root.contains(entry.element)) remove(entry);
    }
    system.renderer?.invalidate();
  };
  const prune = () => {
    for (const entry of registrations.values()) {
      if (!stage.contains(entry.root) || !stage.contains(entry.element)) remove(entry);
    }
  };
  const mount = (root: HTMLElement = stage) => {
    prune();
    for (const element of all(root, '[data-lg-drag]')) {
      if (jelly.bodies.has(element)) continue;
      const mode = element.dataset.lgDrag as BodyOptions['mode'];
      if (!['tether', 'press', 'free', 'range', 'toggle', 'segment'].includes(mode ?? '')) continue;
      const entry = addBody(element, element, {mode, maxTravel: mode === 'free' ? Infinity : element.matches('button') ? 18 : 75});
      if (mode !== 'free') continue;
      const update = () => {
        const body = jelly.bodies.get(element), parent = element.parentElement;
        if (!body || !parent) return;
        const x = Math.round((.5 + body.x.target / Math.max(1, parent.clientWidth)) * 100);
        const y = Math.round((.5 + body.y.target / Math.max(1, parent.clientHeight)) * 100);
        element.setAttribute('aria-valuenow', String(x));
        element.setAttribute('aria-valuetext', `X ${x}%, Y ${y}%`);
      };
      const body = jelly.bodies.get(element);
      if (body) body.onPosition = update;
      element.addEventListener('keydown', event => {
        const delta = ({ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16], Home: [0, 0]} as Record<string, number[]>)[event.key];
        const current = jelly.bodies.get(element), parent = element.parentElement;
        if (!delta || !current || !parent || element.matches(':disabled')) return;
        event.preventDefault();
        const maxX = Math.max(0, (parent.clientWidth - element.offsetWidth) / 2 - 22);
        const maxY = Math.max(0, (parent.clientHeight - element.offsetHeight) / 2 - 22);
        jelly.target(element, event.key === 'Home' ? 0 : Math.max(-maxX, Math.min(maxX, current.x.target + delta[0])), event.key === 'Home' ? 0 : Math.max(-maxY, Math.min(maxY, current.y.target + delta[1])));
        update();
      }, {signal: entry.abort.signal});
      update();
    }
    for (const element of all(root, '[data-lg-component=switch]')) {
      const thumb = element.querySelector<HTMLElement>('[data-glass=thumb]');
      if (!thumb || jelly.bodies.has(thumb)) continue;
      const entry = addBody(element, thumb, {source: element, mode: 'toggle', onCommit: checked => {
        if (!element.matches(':disabled')) element.dispatchEvent(new CustomEvent('lg:set', {detail: {value: checked, emit: true}}));
      }});
      const sync = (snap = false) => jelly.target(thumb, element.getAttribute('aria-checked') === 'true' ? jelly.toggleTravel(element) : 0, 0, {snap});
      element.addEventListener('lg:sync', () => sync(), {signal: entry.abort.signal});
      const observer = new ResizeObserver(() => sync(true)); observer.observe(element);
      entry.cleanups.push(() => observer.disconnect());
      sync(true);
    }
    for (const element of all(root, '[data-lg-component=slider]')) {
      const input = element.querySelector<HTMLInputElement>('input'), thumb = element.querySelector<HTMLElement>('.lg-slider-thumb');
      if (!input || !thumb || jelly.bodies.has(thumb)) continue;
      const entry = addBody(element, thumb, {source: input, mode: 'range'});
      const sync = (snap = false) => {
        const fraction = (Number(input.value) - Number(input.min)) / Math.max(Number.EPSILON, Number(input.max) - Number(input.min));
        jelly.target(thumb, (input.clientWidth - 24) * fraction, 0, {snap});
        element.style.setProperty('--lg-range-fill', `${fraction * 100}%`);
      };
      input.addEventListener('lg:sync', () => sync(), {signal: entry.abort.signal});
      const observer = new ResizeObserver(() => sync(true)); observer.observe(input);
      entry.cleanups.push(() => observer.disconnect());
      sync(true);
    }
    for (const element of all(root, '[data-lg-segments]')) {
      const indicator = element.querySelector<HTMLElement>('.lg-segment-indicator'), bar = element.querySelector<HTMLElement>('.lg-segment-bar');
      if (!indicator || !bar || jelly.bodies.has(indicator)) continue;
      const buttons = () => [...bar.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.matches(':disabled'));
      const entry = addBody(element, indicator, {source: bar, mode: 'segment', segments: buttons, onCommit: (button: HTMLButtonElement) => {
        if (!button.matches(':disabled')) element.dispatchEvent(new CustomEvent('lg:set', {detail: {value: button.dataset.value, emit: true}}));
      }});
      entry.cleanups.push(bindNativeSegmentMotion(jelly, element, bar, indicator, entry.abort.signal));
    }
    system.renderer?.invalidate(160);
    return system;
  };
  system.mount = function(root = stage) {mount(root); return this;};
  return {mount, release, prune, destroy() {
    for (const entry of registrations.values()) remove(entry);
    jelly.grab = nativeGrab;
    jelly.release = nativeRelease;
  }};
}
