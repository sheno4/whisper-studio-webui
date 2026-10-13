import { useEffect, type RefObject } from 'react';
import { advanceSpring, settleSpring, springAxis } from './spring';

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/** Physical pointer feedback: native clicks, on-demand springs, no React frame updates. */
export function useGlassFeedback(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const authoredTransform = element.style.transform;
    const authoredWillChange = element.style.willChange;
    const axes = { x: springAxis(0), y: springAxis(0), scaleX: springAxis(1), scaleY: springAxis(1), light: springAxis(0.25) };
    let leftRim: HTMLElement | null = null;
    let rightRim: HTMLElement | null = null;
    let frame = 0;
    let previousTime = 0;
    let pointer: number | undefined;
    let bounds: DOMRect | undefined;
    let previousPointer = { x: 0, y: 0, time: 0 };

    const refreshRims = () => {
      // Maps arrive after mount and can be removed by a material preference.
      if (!leftRim?.isConnected) leftRim = element.querySelector('[data-glass-rim="left"]');
      if (!rightRim?.isConnected) rightRim = element.querySelector('[data-glass-rim="right"]');
    };
    const render = () => {
      const { x, y, scaleX, scaleY, light } = axes;
      const resting = x.value === 0 && y.value === 0 && scaleX.value === 1 && scaleY.value === 1;
      element.style.transform = resting || reducedMotion.matches ? authoredTransform : `${authoredTransform} translate3d(${x.value.toFixed(3)}px, ${y.value.toFixed(3)}px, 0) scale(${scaleX.value.toFixed(4)}, ${scaleY.value.toFixed(4)})`.trim();
      if (leftRim) leftRim.style.opacity = (1.08 * (1 - light.value)).toFixed(3);
      if (rightRim) rightRim.style.opacity = (1.12 * light.value).toFixed(3);
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
      const delta = previousTime ? (time - previousTime) / 1000 : 1 / 60;
      previousTime = time;
      let moving = false;
      Object.values(axes).forEach((state) => { if (advanceSpring(state, delta)) moving = true; });
      render();
      if (moving) frame = requestAnimationFrame(tick);
      else settle();
    };
    const schedule = () => {
      refreshRims();
      if (reducedMotion.matches || document.hidden) { settle(); return; }
      if (!frame) {
        previousTime = 0;
        element.style.willChange = 'transform';
        frame = requestAnimationFrame(tick);
      }
    };
    const detachPointer = () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    const resetTargets = () => {
      pointer = undefined;
      bounds = undefined;
      detachPointer();
      delete element.dataset.glassPressed;
      axes.x.target = 0;
      axes.y.target = 0;
      axes.scaleX.target = 1;
      axes.scaleY.target = 1;
      axes.light.target = 0.25;
    };
    const reset = () => { resetTargets(); schedule(); };
    const instantReset = () => { resetTargets(); settle(); };
    const press = (event: PointerEvent) => {
      if (pointer !== undefined || event.button !== 0 || !event.isPrimary || element.matches(':disabled, [aria-disabled="true"]')) return;
      pointer = event.pointerId;
      bounds = element.getBoundingClientRect();
      previousPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      element.dataset.glassPressed = 'true';
      axes.scaleX.target = reducedMotion.matches ? 1 : 0.976;
      axes.scaleY.target = reducedMotion.matches ? 1 : 0.956;
      axes.light.target = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
      // Don't capture buttons: native release-outside click eligibility must stay intact.
      window.addEventListener('pointermove', track, { passive: true });
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', release);
      schedule();
    };
    const track = (event: PointerEvent) => {
      if (pointer !== event.pointerId || !bounds) return;
      const interval = Math.max(8, event.timeStamp - previousPointer.time) / 1000;
      if (!reducedMotion.matches) {
        axes.x.target = clamp((event.clientX - (bounds.left + bounds.width / 2)) * 0.06, 3);
        axes.y.target = clamp((event.clientY - (bounds.top + bounds.height / 2)) * 0.06, 2);
        axes.x.velocity = clamp((event.clientX - previousPointer.x) * 0.06 / interval, 80);
        axes.y.velocity = clamp((event.clientY - previousPointer.y) * 0.06 / interval, 80);
      }
      axes.light.target = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
      previousPointer = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      schedule();
    };
    const release = (event: PointerEvent) => { if (event.pointerId === pointer) reset(); };
    const preferenceChanged = () => { if (reducedMotion.matches) instantReset(); };
    const visibilityChanged = () => { if (document.hidden) instantReset(); };
    const sizeChanged = new ResizeObserver(() => { if (pointer !== undefined) instantReset(); });
    sizeChanged.observe(element);
    element.addEventListener('pointerdown', press);
    element.addEventListener('keydown', instantReset);
    window.addEventListener('blur', instantReset);
    document.addEventListener('visibilitychange', visibilityChanged);
    reducedMotion.addEventListener('change', preferenceChanged);
    return () => {
      cancelAnimationFrame(frame);
      detachPointer();
      sizeChanged.disconnect();
      element.removeEventListener('pointerdown', press);
      element.removeEventListener('keydown', instantReset);
      window.removeEventListener('blur', instantReset);
      document.removeEventListener('visibilitychange', visibilityChanged);
      reducedMotion.removeEventListener('change', preferenceChanged);
      element.style.transform = authoredTransform;
      element.style.willChange = authoredWillChange;
      delete element.dataset.glassPressed;
      leftRim?.style.removeProperty('opacity');
      rightRim?.style.removeProperty('opacity');
    };
  }, [ref, enabled]);
}
