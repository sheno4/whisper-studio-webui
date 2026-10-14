import { useSyncExternalStore } from 'react';

export type GlassCapability = { mode: 'optical' | 'frosted' | 'solid'; reason: string; enabled: boolean };
const subscribers = new Set<() => void>();
let snapshot: GlassCapability = { mode: 'solid', reason: 'not-mounted', enabled: false };
let stopObserving: (() => void) | undefined;

function measureCapability(): GlassCapability {
  if (typeof window === 'undefined') return { mode: 'solid', reason: 'not-mounted', enabled: false };
  if (document.documentElement.dataset.material === 'solid') return { mode: 'solid', reason: 'user-preference', enabled: false };
  if (document.documentElement.dataset.material !== 'glass' && window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return { mode: 'solid', reason: 'reduced-transparency', enabled: false };
  if (window.matchMedia('(forced-colors: active)').matches || window.matchMedia('(prefers-contrast: more)').matches) return { mode: 'solid', reason: 'increased-contrast', enabled: false };
  // rdev documents full SVG displacement in Chromium and partial effects in
  // Firefox/Safari. Their CSS fallback must not be reported as full optics.
  const chromium=/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent)&&!navigator.userAgent.includes('Firefox/');
  const backdrop=CSS.supports('backdrop-filter','blur(1px)');
  return chromium&&backdrop ? {mode:'optical',reason:'rdev-svg',enabled:true} : {mode:'frosted',reason:'svg-displacement-unavailable',enabled:true};
}

function update(): void {
  const next = measureCapability();
  if (snapshot.mode === next.mode && snapshot.reason === next.reason && snapshot.enabled === next.enabled) return;
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
    if (subscribers.size === 0) { stopObserving?.(); stopObserving = undefined; }
  };
}

export function useGlassCapability(): GlassCapability {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
