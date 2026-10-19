import type {JellyController} from '../vendor/lens-native/index.js';

type SegmentBody = {element: HTMLElement; x: {target: number}; y: {target: number}};
type SegmentJelly = Pick<JellyController, 'target' | 'cancel'> & {
  bodies: ReadonlyMap<HTMLElement, SegmentBody>;
  gesture: {body: SegmentBody; capture: HTMLElement} | null;
};

/** Keep the original segment springs in charge of presentation. The factory's
 * ResizeObserver also emits lg:sync; neither path may snap an active spring or
 * replace the pointer's horizontal/vertical targets while it owns the lens. */
export function bindNativeSegmentMotion(jelly: SegmentJelly, element: HTMLElement, bar: HTMLElement, indicator: HTMLElement, signal: AbortSignal): () => void {
  let placed = false, syncing = false;
  const buttons = () => [...bar.querySelectorAll<HTMLButtonElement>('.lg-segment-option')];
  const sync = () => {
    if (syncing || signal.aborted) return;
    syncing = true;
    try {
      const gesture = jelly.gesture?.body.element === indicator ? jelly.gesture : null;
      if (gesture) {
        const disabled = Boolean(bar.getAttribute('aria-disabled') === 'true' || bar.closest('[inert]') || gesture.capture.matches(':disabled') || !buttons().some(button => !button.matches(':disabled')));
        // cancel() releases native capture and emits lg:gesture. Its synchronous
        // sync is guarded here; the outer call then restores the semantic value.
        if (disabled) jelly.cancel();
        else return;
      }
      const selected = bar.querySelector<HTMLElement>('[aria-selected=true],[aria-current]');
      if (!selected || !selected.offsetWidth) return;
      const width = `${selected.offsetWidth}px`, x = selected.offsetLeft;
      if (indicator.style.width !== width) indicator.style.width = width;
      const body = jelly.bodies.get(indicator);
      if (!placed || (body && (body.x.target !== x || body.y.target !== 0))) jelly.target(indicator, x, 0, {snap: !placed});
      placed = true;
    } finally { syncing = false; }
  };
  element.addEventListener('lg:sync', sync, {signal});
  bar.addEventListener('lg:gesture', event => {
    const phase = (event as CustomEvent<{phase: string}>).detail.phase;
    if (phase === 'end' || phase === 'cancel') sync();
  }, {signal});
  // Observe actual option geometry as well as the rail. A label can change a
  // segment's width without changing the rail's overall dimensions.
  const resize = new ResizeObserver(sync);
  resize.observe(bar); buttons().forEach(button => resize.observe(button));
  // Disabled/inert changes can cancel a held segment immediately. These narrow
  // attributes deliberately exclude Jelly's per-frame style/class writes.
  const availability = new MutationObserver(sync);
  availability.observe(bar, {subtree: true, attributes: true, attributeFilter: ['disabled', 'inert', 'aria-disabled']});
  for (let ancestor = bar.parentElement; ancestor; ancestor = ancestor.parentElement) {
    availability.observe(ancestor, {attributes: true, attributeFilter: ['disabled', 'inert']});
  }
  sync();
  return () => {resize.disconnect(); availability.disconnect();};
}
