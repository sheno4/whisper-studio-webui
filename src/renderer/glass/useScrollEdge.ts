import { useEffect, type RefObject } from 'react';

type ScrollEdgeOptions = {
  enabled?: boolean;
  barSelector?: string;
  bottom?: boolean;
  size?: number;
};

const OVERLAP = 20;

/** Adapted from Liquid Glass for the Web's MIT scroll-edge component.
 * Edges are independent siblings: masking them never masks a glass control.
 * Native scrolling owns the interaction; only finite measurement work is queued.
 */
export function useScrollEdge<T extends HTMLElement>(ref: RefObject<T | null>, {
  enabled = true, barSelector, bottom = true, size = 28
}: ScrollEdgeOptions = {}): void {
  useEffect(() => {
    const viewport = ref.current;
    if (!enabled || !viewport) return;
    const host = viewport.closest<HTMLElement>('.workbench-pane, .prefs-dialog, .studio-import-sheet') ?? viewport.parentElement;
    if (!host) return;
    const ownedHostClass = !host.classList.contains('glass-scroll-edge-host');
    host.classList.add('glass-scroll-edge-host');
    const previousContainer = viewport.getAttribute('data-scroll-edge-container');
    viewport.dataset.scrollEdgeContainer = 'true';
    const makeEdge = (edge: 'top' | 'bottom'): HTMLDivElement => {
      const node = viewport.ownerDocument.createElement('div');
      node.className = 'glass-scroll-edge';
      node.dataset.edge = edge; node.dataset.style = 'soft';
      node.dataset.scrollEdgeFor = viewport.id || viewport.classList.item(0) || 'content';
      node.setAttribute('aria-hidden', 'true'); node.hidden = true;
      const layer = viewport.ownerDocument.createElement('div');
      layer.className = 'glass-scroll-edge-layer'; node.append(layer); host.append(node);
      return node;
    };
    const topEdge = makeEdge('top');
    const bottomEdge = bottom ? makeEdge('bottom') : undefined;
    let frame = 0;
    let disposed = false;
    let bar: HTMLElement | null = null;
    const contentTargets = new Set<Element>();

    const write = (element: HTMLElement, property: string, value: string): void => {
      if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
    };
    const measure = (): void => {
      frame = 0;
      if (disposed || !viewport.isConnected || !host.isConnected) return;
      const nextBar = barSelector ? viewport.querySelector<HTMLElement>(barSelector) : null;
      if (bar !== nextBar) {
        if (bar) resize.unobserve(bar);
        bar = nextBar;
        if (bar) resize.observe(bar);
      }
      // Fixed-height overflow viewports do not resize as task/text content grows.
      // Observe their existing content roots as well, without observing the bands.
      for (const child of viewport.children) if (!contentTargets.has(child)) { contentTargets.add(child); resize.observe(child); }
      for (const child of contentTargets) if (!viewport.contains(child)) { resize.unobserve(child); contentTargets.delete(child); }
      const bounds = viewport.getBoundingClientRect();
      const parent = host.getBoundingClientRect();
      const scaleX = host.offsetWidth ? parent.width / host.offsetWidth : 1;
      const scaleY = host.offsetHeight ? parent.height / host.offsetHeight : 1;
      if (!bounds.width || !bounds.height || !scaleX || !scaleY) { topEdge.hidden = true; if (bottomEdge) bottomEdge.hidden = true; return; }
      const left = (bounds.left - parent.left) / scaleX + viewport.clientLeft - host.clientLeft;
      const top = (bounds.top - parent.top) / scaleY + viewport.clientTop - host.clientTop;
      const overflow = viewport.scrollHeight - viewport.clientHeight;
      const remaining = overflow - viewport.scrollTop;
      let extent = size;
      if (bar) {
        const barBounds = bar.getBoundingClientRect();
        // Only expand to cover a bar after it reaches its actual sticky inset.
        const inset = Number.parseFloat(getComputedStyle(bar).top) || 0;
        if (barBounds.top <= bounds.top + (viewport.clientTop + inset + 1) * scaleY) {
          extent = Math.max(size, (barBounds.bottom - bounds.top) / scaleY + OVERLAP);
        }
      }
      const height = Math.min(viewport.clientHeight / 2, extent);
      for (const edge of [topEdge, bottomEdge]) if (edge) {
        write(edge, 'left', `${left.toFixed(2)}px`);
        write(edge, 'width', `${viewport.clientWidth}px`);
        write(edge, '--glass-scroll-edge-size', `${height.toFixed(2)}px`);
        const tone = bar?.getAttribute('data-glass-adaptive-tone') ?? bar?.getAttribute('data-lg-tone');
        if (tone === 'dark') edge.dataset.tone = 'dark'; else delete edge.dataset.tone;
      }
      write(topEdge, 'top', `${top.toFixed(2)}px`);
      topEdge.hidden = overflow <= 1 || viewport.scrollTop <= 1;
      if (bottomEdge) {
        write(bottomEdge, 'top', `${(top + viewport.clientHeight - height).toFixed(2)}px`);
        bottomEdge.hidden = overflow <= 1 || remaining <= 1;
      }
    };
    const schedule = (): void => { if (!disposed && !frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport); resize.observe(host);
    const content = new MutationObserver(schedule);
    content.observe(viewport, { childList: true, subtree: true, characterData: true });
    viewport.addEventListener('scroll', schedule, { passive: true });
    // Outer/page scroll can change a sticky bar even when its local scrollTop is unchanged.
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    schedule();
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); content.disconnect();
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
      topEdge.remove(); bottomEdge?.remove();
      if (previousContainer === null) viewport.removeAttribute('data-scroll-edge-container');
      else viewport.setAttribute('data-scroll-edge-container', previousContainer);
      if (ownedHostClass) host.classList.remove('glass-scroll-edge-host');
    };
  }, [ref, enabled, barSelector, bottom, size]);
}
