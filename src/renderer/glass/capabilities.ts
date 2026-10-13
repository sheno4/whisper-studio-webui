import { useSyncExternalStore } from 'react';

export type LensRendererState = 'pending' | 'ready' | 'fallback';
export type GlassCapability = { mode: 'optical' | 'frosted' | 'solid'; reason: string; enabled: boolean };
const subscribers = new Set<() => void>();
let rendererState: LensRendererState = 'pending';
let snapshot: GlassCapability = { mode: 'solid', reason: 'not-mounted', enabled: false };
let stopObserving: (() => void) | undefined;

function measureCapability(): GlassCapability {
  if (typeof window === 'undefined') return { mode: 'solid', reason: 'not-mounted', enabled: false };
  if (document.documentElement.dataset.material === 'solid') return { mode: 'solid', reason: 'user-preference', enabled: false };
  if (document.documentElement.dataset.material !== 'glass' && window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return { mode: 'solid', reason: 'reduced-transparency', enabled: false };
  if (window.matchMedia('(forced-colors: active)').matches || window.matchMedia('(prefers-contrast: more)').matches) return { mode: 'solid', reason: 'increased-contrast', enabled: false };
  // The actual Lens WebGL2 context decides support, including Firefox. A CSS
  // syntax check or a browser name cannot establish renderer availability.
  if (rendererState === 'ready') return { mode: 'optical', reason: '', enabled: true };
  return { mode: 'frosted', reason: rendererState === 'pending' ? 'initializing' : 'webgl-unavailable', enabled: true };
}

function update(): void {
  const next = measureCapability();
  if (snapshot.mode === next.mode && snapshot.reason === next.reason && snapshot.enabled === next.enabled) return;
  snapshot = next;
  subscribers.forEach((listener) => listener());
}

export function setLensRendererState(state: LensRendererState): void {
  rendererState = state;
  update();
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  if (!stopObserving) {
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-material'] });
    const queries = ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].map((query) => window.matchMedia(query));
    queries.forEach((query) => query.addEventListener('change', update));
    stopObserving = () => {
      observer.disconnect();
      queries.forEach((query) => query.removeEventListener('change', update));
    };
    update();
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) { stopObserving?.(); stopObserving = undefined; }
  };
}

export function useGlassCapability(): GlassCapability {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
