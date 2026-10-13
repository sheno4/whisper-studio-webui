import { useEffect, type RefObject } from 'react';
import { dragReleaseVelocity, rubberBandDrag, type DragPosition } from './drag-math';
import { advanceSpring, settleSpring, springAxis } from './spring';

const controlSelector = 'button, a, input, textarea, select, [contenteditable], [role="button"], [role="slider"], [role="textbox"]';
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Handle-only direct manipulation. No React frame state or idle animation loop. */
export function useGlassDrag(ref: RefObject<HTMLElement | null>, enabled: boolean, handleSelector: string): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const authoredTransform = element.style.transform;
    const authoredWillChange = element.style.willChange;
    const axes = { x: springAxis(0), y: springAxis(0), scaleX: springAxis(1), scaleY: springAxis(1), light: springAxis(0.25) };
    let leftRim: HTMLElement | null = null;
    let rightRim: HTMLElement | null = null;
    let ambientRim: HTMLElement | null = null;
    let pointer: number | undefined;
    let handle: HTMLElement | undefined;
    let frame = 0;
    let previousTime = 0;
    let grab = { x: 0, y: 0 };
    let freeRange = { x: 64, y: 64 };
    let startLight = 0.25;
    let history: DragPosition[] = [];

    const refreshRims = () => {
      leftRim = element.querySelector(':scope > [data-glass-rim="left"]');
      rightRim = element.querySelector(':scope > [data-glass-rim="right"]');
      ambientRim = element.querySelector(':scope > [data-glass-rim="ambient"]');
    };
    const render = () => {
      const { x, y, scaleX, scaleY, light } = axes;
      const resting = x.value === 0 && y.value === 0 && scaleX.value === 1 && scaleY.value === 1;
      element.style.transform = resting ? authoredTransform : `${authoredTransform} translate3d(${x.value.toFixed(3)}px, ${y.value.toFixed(3)}px, 0) scale(${reducedMotion.matches ? 1 : scaleX.value.toFixed(4)}, ${reducedMotion.matches ? 1 : scaleY.value.toFixed(4)})`.trim();
      if (leftRim) leftRim.style.opacity = (1.08 * (1 - light.value)).toFixed(3);
      if (rightRim) rightRim.style.opacity = (1.12 * light.value).toFixed(3);
      if (ambientRim) ambientRim.style.opacity = (0.24 + Math.min(0.12, Math.hypot(x.value, y.value) / 500)).toFixed(3);
    };
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      Object.values(axes).forEach(settleSpring);
      render();
      element.style.willChange = authoredWillChange;
    };
    const tick = (time: number) => {
      if (document.hidden || !element.isConnected) { instantReset(); return; }
      const elapsed = previousTime ? (time - previousTime) / 1000 : 1 / 60;
      previousTime = time;
      let moving = false;
      Object.values(axes).forEach((state) => { if (advanceSpring(state, elapsed)) moving = true; });
      render();
      if (moving) frame = requestAnimationFrame(tick);
      else settle();
    };
    const resetTargets = () => {
      axes.x.target = 0;
      axes.y.target = 0;
      axes.scaleX.target = 1;
      axes.scaleY.target = 1;
      axes.light.target = 0.25;
    };
    const detach = () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
      if (handle && pointer !== undefined && handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      pointer = undefined;
      handle = undefined;
      delete element.dataset.glassDragging;
    };
    const instantReset = () => {
      // Clear identity first: lostpointercapture may be dispatched synchronously.
      const activePointer = pointer;
      const activeHandle = handle;
      pointer = undefined;
      detach();
      if (activeHandle && activePointer !== undefined && activeHandle.hasPointerCapture(activePointer)) activeHandle.releasePointerCapture(activePointer);
      resetTargets();
      settle();
      history = [];
    };
    const startReturn = () => {
      resetTargets();
      if (reducedMotion.matches || document.hidden) { settle(); return; }
      previousTime = 0;
      frame = requestAnimationFrame(tick);
    };
    const press = (event: PointerEvent) => {
      if (pointer !== undefined || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
      const candidate = event.target.closest<HTMLElement>(handleSelector);
      if (!candidate || !element.contains(candidate) || event.target.closest(controlSelector) || candidate.closest('[data-glass-draggable="true"]') !== element) return;
      event.preventDefault();
      cancelAnimationFrame(frame);
      frame = 0;
      refreshRims();
      const bounds = element.getBoundingClientRect();
      pointer = event.pointerId;
      handle = candidate;
      grab = { x: event.clientX - axes.x.value, y: event.clientY - axes.y.value };
      // A returning spring may still be outside the nominal free range. Use its
      // current presentation as this grab's boundary instead of snapping it in.
      freeRange = { x: Math.max(64, Math.abs(axes.x.value)), y: Math.max(64, Math.abs(axes.y.value)) };
      startLight = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0.1, 0.9);
      axes.light.value = startLight;
      history = [{ x: axes.x.value, y: axes.y.value, time: event.timeStamp }];
      element.dataset.glassDragging = 'true';
      element.style.willChange = 'transform';
      candidate.setPointerCapture(event.pointerId);
      window.addEventListener('pointermove', track, { passive: true });
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', cancel);
      render();
    };
    const track = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      const x = rubberBandDrag(event.clientX - grab.x, freeRange.x);
      const y = rubberBandDrag(event.clientY - grab.y, freeRange.y);
      const previous = history.at(-1)!;
      const elapsed = Math.max(8, event.timeStamp - previous.time) / 1000;
      const velocityX = (x - previous.x) / elapsed;
      const velocityY = (y - previous.y) / elapsed;
      axes.x.value = x;
      axes.y.value = y;
      axes.scaleX.value = reducedMotion.matches ? 1 : 1 + Math.min(0.014, Math.abs(velocityX) * 0.000012) - Math.min(0.01, Math.abs(velocityY) * 0.000009);
      axes.scaleY.value = reducedMotion.matches ? 1 : 1 + Math.min(0.014, Math.abs(velocityY) * 0.000012) - Math.min(0.01, Math.abs(velocityX) * 0.000009);
      axes.light.value = clamp(startLight + (x - y) / 200, 0.05, 0.95);
      history.push({ x, y, time: event.timeStamp });
      history = history.filter((sample) => event.timeStamp - sample.time <= 80).slice(-12);
      render();
    };
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      const velocity = dragReleaseVelocity(history, event.timeStamp);
      axes.x.velocity = velocity.x;
      axes.y.velocity = velocity.y;
      // Preserve presentation values. The return can be grabbed again mid-flight.
      const activePointer = pointer;
      const activeHandle = handle;
      pointer = undefined;
      detach();
      if (activeHandle?.hasPointerCapture(activePointer)) activeHandle.releasePointerCapture(activePointer);
      startReturn();
    };
    const cancel = (event: PointerEvent) => { if (event.pointerId === pointer) instantReset(); };
    const lostCapture = (event: PointerEvent) => { if (event.pointerId === pointer) instantReset(); };
    const visibilityChanged = () => { if (document.hidden) instantReset(); };
    const preferenceChanged = () => { if (reducedMotion.matches) instantReset(); };
    const resizeObserver = new ResizeObserver(() => { if (pointer !== undefined || frame) instantReset(); });
    resizeObserver.observe(element);
    element.addEventListener('pointerdown', press);
    element.addEventListener('lostpointercapture', lostCapture);
    element.addEventListener('keydown', instantReset);
    window.addEventListener('blur', instantReset);
    window.addEventListener('resize', instantReset, { passive: true });
    document.addEventListener('visibilitychange', visibilityChanged);
    reducedMotion.addEventListener('change', preferenceChanged);
    return () => {
      instantReset();
      resizeObserver.disconnect();
      element.removeEventListener('pointerdown', press);
      element.removeEventListener('lostpointercapture', lostCapture);
      element.removeEventListener('keydown', instantReset);
      window.removeEventListener('blur', instantReset);
      window.removeEventListener('resize', instantReset);
      document.removeEventListener('visibilitychange', visibilityChanged);
      reducedMotion.removeEventListener('change', preferenceChanged);
      leftRim?.style.removeProperty('opacity');
      rightRim?.style.removeProperty('opacity');
      ambientRim?.style.removeProperty('opacity');
    };
  }, [ref, enabled, handleSelector]);
}
