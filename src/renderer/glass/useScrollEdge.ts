import { useEffect, type RefObject } from 'react';

type ScrollEdgeOptions = {
  enabled?: boolean;
  barSelector?: string;
  bottom?: boolean;
  horizontal?: boolean;
  size?: number;
};

const OVERLAP = 20;
const hosts = new WeakMap<HTMLElement, { users: number; owned: boolean }>();
type Edge = 'top' | 'bottom' | 'left' | 'right';

/** Adapted from Liquid Glass for the Web's MIT scroll-edge component.
 * Edges are independent siblings: masking them never masks a glass control.
 * Native scrolling owns the interaction; only finite measurement work is queued.
 */
export function useScrollEdge<T extends HTMLElement>(ref: RefObject<T | null>, {
  enabled = true, barSelector, bottom = true, horizontal = true, size = 28
}: ScrollEdgeOptions = {}): void {
  useEffect(() => {
    const viewport = ref.current;
    if (!enabled || !viewport) return;
    const host = viewport.closest<HTMLElement>('.workbench-pane, .prefs-dialog, .studio-import-sheet') ?? viewport.parentElement;
    if (!host) return;
    const ownership = hosts.get(host) ?? { users: 0, owned: !host.classList.contains('glass-scroll-edge-host') };
    ownership.users += 1; hosts.set(host, ownership);
    host.classList.add('glass-scroll-edge-host');
    const previousContainer = viewport.getAttribute('data-scroll-edge-container');
    viewport.dataset.scrollEdgeContainer = 'true';
    const makeEdge = (edge: Edge): HTMLDivElement => {
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
    const leftEdge = horizontal ? makeEdge('left') : undefined;
    const rightEdge = horizontal ? makeEdge('right') : undefined;
    const edges = [topEdge, bottomEdge, leftEdge, rightEdge].filter((edge): edge is HTMLDivElement => Boolean(edge));
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
      if (!bounds.width || !bounds.height || !scaleX || !scaleY) { for (const edge of edges) edge.hidden = true; return; }
      const left = (bounds.left - parent.left) / scaleX + viewport.clientLeft - host.clientLeft + host.scrollLeft;
      const top = (bounds.top - parent.top) / scaleY + viewport.clientTop - host.clientTop + host.scrollTop;
      const overflow = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const offset = Math.max(0, Math.min(overflow, viewport.scrollTop));
      const horizontalOverflow = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      // RTL uses negative scrollLeft in current browser engines. Translate it
      // to distance from the physical left edge before choosing the fades.
      const rtl = getComputedStyle(viewport).direction === 'rtl';
      const horizontalOffset = Math.max(0, Math.min(horizontalOverflow, rtl ? horizontalOverflow + viewport.scrollLeft : viewport.scrollLeft));
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
      const width = Math.min(viewport.clientWidth / 2, size);
      for (const edge of edges) {
        const tone = bar?.getAttribute('data-glass-adaptive-tone') ?? bar?.getAttribute('data-lg-tone');
        if (tone === 'dark') edge.dataset.tone = 'dark'; else delete edge.dataset.tone;
      }
      const place = (edge: HTMLDivElement | undefined, x: number, y: number, w: number, h: number, distance: number, total: number): void => {
        if (!edge) return;
        write(edge, 'left', `${x.toFixed(2)}px`); write(edge, 'top', `${y.toFixed(2)}px`);
        write(edge, 'width', `${w.toFixed(2)}px`); write(edge, 'height', `${h.toFixed(2)}px`);
        // Fade only the local edge as content approaches its boundary. The
        // viewport, its scrollbar and the workbench never translate or scale.
        write(edge, 'opacity', Math.min(1, distance / Math.max(1, size)).toFixed(3));
        edge.hidden = total <= 1;
      };
      place(topEdge, left, top, viewport.clientWidth, height, offset, overflow);
      place(bottomEdge, left, top + viewport.clientHeight - height, viewport.clientWidth, height, overflow - offset, overflow);
      place(leftEdge, left, top, width, viewport.clientHeight, horizontalOffset, horizontalOverflow);
      place(rightEdge, left + viewport.clientWidth - width, top, width, viewport.clientHeight, horizontalOverflow - horizontalOffset, horizontalOverflow);
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
      for (const edge of edges) edge.remove();
      if (previousContainer === null) viewport.removeAttribute('data-scroll-edge-container');
      else viewport.setAttribute('data-scroll-edge-container', previousContainer);
      ownership.users -= 1;
      if (!ownership.users) { if (ownership.owned) host.classList.remove('glass-scroll-edge-host'); hosts.delete(host); }
    };
  }, [ref, enabled, barSelector, bottom, horizontal, size]);
}
