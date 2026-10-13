import { useSyncExternalStore } from 'react';

export type GlassCapability = { mode: 'optical' | 'solid'; reason: string };
const optical: GlassCapability = { mode: 'optical', reason: '' };
const subscribers = new Set<() => void>();
let snapshot: GlassCapability = { mode: 'solid', reason: 'not-mounted' };
let stopObserving: (() => void) | undefined;

function measureCapability(): GlassCapability {
  if (typeof window === 'undefined') return { mode: 'solid', reason: 'not-mounted' };
  if (document.documentElement.dataset.material === 'solid') return { mode: 'solid', reason: 'user-preference' };
  if (document.documentElement.dataset.material !== 'glass' && window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return { mode: 'solid', reason: 'reduced-transparency' };
  if (window.matchMedia('(forced-colors: active)').matches || window.matchMedia('(prefers-contrast: more)').matches) return { mode: 'solid', reason: 'increased-contrast' };
  // All engines accept URL syntax. Only Chromium implements this SVG backdrop
  // graph. Syntax acceptance is deliberately not presented as pixel validation.
  const chromium = /(?:Chrome|Chromium|Edg)\/(\d+)/.exec(window.navigator.userAgent);
  if (!chromium || Number(chromium[1]) < 120 || /(?:Firefox|FxiOS|CriOS|EdgiOS)\//.test(window.navigator.userAgent)) {
    return { mode: 'solid', reason: 'svg-backdrop-unsupported' };
  }
  if (!window.CSS?.supports('backdrop-filter', 'url(#whisper-optics-probe)')) return { mode: 'solid', reason: 'backdrop-filter-unavailable' };
  return optical;
}

function update(): void {
  const next = measureCapability();
  if (snapshot.mode === next.mode && snapshot.reason === next.reason) return;
  snapshot = next;
  subscribers.forEach((listener) => listener());
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
    if (subscribers.size === 0) {
      stopObserving?.();
      stopObserving = undefined;
    }
  };
}

export function useGlassCapability(): GlassCapability {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
