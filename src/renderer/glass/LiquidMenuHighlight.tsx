import { animate, motionValue } from 'framer-motion';
import { useEffect, useRef, type RefObject } from 'react';

import { useGlassCapability } from './capabilities';
import { RdevMaterial } from './RdevMaterial';

/** One optical capsule follows the primitive's actual highlighted item. Its
 * spring values live outside React; resizing happens only when the target
 * changes, while every animation frame writes a single transform. */
export function LiquidMenuHighlight({ hostRef, active, itemSelector, selectedFallback = false }: {
  hostRef: RefObject<HTMLElement | null>;
  active: boolean;
  itemSelector: string;
  selectedFallback?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
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
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const render = (): void => {
      frame = 0;
      element.style.transform = `translate3d(${values[0].get()}px,${values[1].get()}px,0) scale(${values[2].get() / baseWidth},${values[3].get() / baseHeight})`;
    };
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(render); };
    const subscriptions = values.map((value) => value.on('change', schedule));

    const update = (): void => {
      const items = [...host.querySelectorAll<HTMLElement>(itemSelector)];
      const target = items.find((item) => item.hasAttribute('data-highlighted') && !item.hasAttribute('data-disabled'))
        ?? (selectedFallback ? items.find((item) => item.getAttribute('aria-selected') === 'true' || item.hasAttribute('data-selected')) : undefined);
      if (!target) { element.hidden = true; lastTarget = null; return; }
      const hostBox = host.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      const scaleX = host.offsetWidth ? hostBox.width / host.offsetWidth : 1;
      const scaleY = host.offsetHeight ? hostBox.height / host.offsetHeight : 1;
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
      if ((event.target as Element).closest(itemSelector)?.matches(':not([data-disabled])')) element.dataset.pressed = 'true';
    };
    const release = (): void => { delete element.dataset.pressed; };
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
    update();
    return () => {
      observer.disconnect();
      resize.disconnect();
      host.removeEventListener('scroll', update);
      host.removeEventListener('pointerdown', press);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      reduce.removeEventListener('change', update);
      controls.forEach((control) => control.stop());
      subscriptions.forEach((unsubscribe) => unsubscribe());
      values.forEach((value) => value.destroy());
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active, hostRef, itemSelector, selectedFallback]);

  return <div ref={ref} className="glass-liquid-highlight" data-liquid-highlight aria-hidden="true" hidden>
    <div className="glass-liquid-highlight__body">
      {glass.mode === 'optical' ? <RdevMaterial owner="selection" radius={11} interactionRef={hostRef} /> : null}
    </div>
  </div>;
}
