import type { MenuHandle } from '../vendor/lens-native/index.js';

/** Native top-layer placement keeps the factory's physical containment (and
 * therefore its outside-click/focus logic), while escaping scroll clipping.
 * The element stays in the shared stage's material/geometry registry. */
export function bindLensMenuPopover(instance: MenuHandle, { align = 'start', matchWidth = false, onOpen }: { align?: 'start' | 'end'; matchWidth?: boolean; onOpen?: () => void } = {}): () => void {
  const root = instance.element;
  const trigger = root.querySelector<HTMLButtonElement>(':scope > button')!;
  const panel = root.querySelector<HTMLElement>('.lg-menu-popover')!;
  const abort = new AbortController(), signal = abort.signal;
  let destroyed = false, wasOpen = false, placing = false;
  const naturalMinimum = Number.parseFloat(getComputedStyle(panel).minWidth) || 0;
  panel.setAttribute('popover', 'manual');
  // An auto-width fixed box shrinks to the space remaining after `left`, making
  // ResizeObserver placement feed width back into left. Explicit intrinsic
  // width keeps the original natural menu size independent of its position.
  Object.assign(panel.style, { position: 'fixed', inset: 'auto', margin: '0', border: '0', color: 'inherit', overflowY: 'auto', width: 'max-content', maxWidth: 'calc(100vw - 24px)' });
  const place = (): void => {
    if (destroyed || panel.hidden || placing) return;
    placing = true;
    try {
      const anchor = trigger.getBoundingClientRect(), viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0, topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      let changed = false;
      const availableWidth = Math.max(0, width - 24);
      const minWidth = `${Math.min(matchWidth ? anchor.width : naturalMinimum, availableWidth)}px`;
      const maxWidth = `${availableWidth}px`;
      if (panel.style.minWidth !== minWidth) { panel.style.minWidth = minWidth; changed = true; }
      if (panel.style.maxWidth !== maxWidth) { panel.style.maxWidth = maxWidth; changed = true; }
      const below = topEdge + height - anchor.bottom - 20, above = anchor.top - topEdge - 20;
      // The factory animates transform. Layout dimensions must stay independent
      // of that animation, otherwise each placement feeds its scale back in.
      const desired = Math.max(panel.scrollHeight, panel.offsetHeight);
      const flip = below < Math.min(desired, 200) && above > below;
      const maxHeight = `${Math.max(44, Math.min(height - 24, flip ? above : below))}px`;
      if (panel.style.maxHeight !== maxHeight) { panel.style.maxHeight = maxHeight; changed = true; }
      const panelWidth = panel.offsetWidth, panelHeight = panel.offsetHeight;
      const x = Math.max(leftEdge + 12, Math.min(align === 'end' ? anchor.right - panelWidth : anchor.left, leftEdge + width - panelWidth - 12));
      const y = Math.max(topEdge + 12, Math.min(flip ? anchor.top - panelHeight - 8 : anchor.bottom + 8, topEdge + height - panelHeight - 12));
      const nextLeft = `${x}px`, nextTop = `${y}px`;
      if (panel.style.left !== nextLeft) { panel.style.left = nextLeft; changed = true; }
      if (panel.style.top !== nextTop) { panel.style.top = nextTop; changed = true; }
      const origin = `${align === 'end' ? 'right' : 'left'} ${flip ? 'bottom' : 'top'}`;
      if (panel.style.transformOrigin !== origin) panel.style.transformOrigin = origin;
      // Keep the guard through synchronous notification. The runtime still
      // receives this invalidation, while our own sync listener ignores it.
      if (changed) root.dispatchEvent(new CustomEvent('lg:sync', { bubbles: true }));
    } finally {
      placing = false;
    }
  };
  const sync = (): void => {
    if (destroyed || placing) return;
    const open = trigger.getAttribute('aria-expanded') === 'true';
    panel.setAttribute('aria-hidden', String(!open));
    panel.style.pointerEvents = open ? 'auto' : 'none';
    if (open && !panel.hidden) {
      if (typeof panel.showPopover === 'function' && !panel.matches(':popover-open')) panel.showPopover();
      place();
      if (!wasOpen) queueMicrotask(() => { if (!destroyed && trigger.getAttribute('aria-expanded') === 'true') onOpen?.(); });
    } else if (panel.hidden && typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    wasOpen = open;
  };
  const observe = new MutationObserver(sync);
  observe.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded', 'disabled'] });
  observe.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  const resize = new ResizeObserver(place); resize.observe(trigger); resize.observe(panel);
  root.addEventListener('lg:sync', sync, { signal });
  window.addEventListener('resize', place, { signal, passive: true });
  window.addEventListener('scroll', place, { signal, passive: true, capture: true });
  window.visualViewport?.addEventListener('resize', place, { signal, passive: true });
  window.visualViewport?.addEventListener('scroll', place, { signal, passive: true });
  panel.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const item = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[role="menuitem"],button[role="option"]') : null;
    if (!item || !panel.contains(item) || item.matches(':disabled')) return;
    // During the browser's default mouse-focus transfer, the native factory's
    // focusout microtask can observe BODY before the next item receives focus.
    // Complete that same focus transfer synchronously, keeping blur events and
    // the eventual click intact instead of dismissing the menu before mouseup.
    event.preventDefault();
    item.focus({ preventScroll: true });
  }, { signal });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); instance.close();
  }, { signal, capture: true });
  sync();
  return () => {
    destroyed = true; abort.abort(); observe.disconnect(); resize.disconnect();
    if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
  };
}

/** A native form control already reflects every disabled ancestor correctly,
 * including the first-legend exception. Observe only those ancestor flags. */
export function observeFieldsetDisabled(control: HTMLButtonElement | HTMLSelectElement, update: () => void): () => void {
  const observer = new MutationObserver(update);
  let ancestor = control.parentElement;
  while (ancestor) {
    if (ancestor instanceof HTMLFieldSetElement) observer.observe(ancestor, { attributes: true, attributeFilter: ['disabled'] });
    ancestor = ancestor.parentElement;
  }
  update();
  return () => observer.disconnect();
}
