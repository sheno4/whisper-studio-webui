import { useSyncExternalStore } from 'react';

export type GlassCapability = { mode: 'optical' | 'frosted' | 'solid'; reason: string; enabled: boolean; nativeOptical:boolean; gpuReady:boolean };
const subscribers = new Set<() => void>();
let snapshot: GlassCapability = { mode: 'solid', reason: 'not-mounted', enabled: false,nativeOptical:false,gpuReady:false };
let gpuReady=false,gpuReason='lens-not-ready';
/** Reports the actual upstream Lens renderer, rather than browser SVG support.
 * The historical export remains for source compatibility with retired modules. */
export function setUnifiedGlassReady(ready:boolean,reason='lens-webgl2'):void {
  if(gpuReady===ready&&gpuReason===reason)return;
  gpuReady=ready;gpuReason=reason;update();
}
let stopObserving: (() => void) | undefined;

function measureCapability(): GlassCapability {
  const solid=(reason:string):GlassCapability=>({mode:'solid',reason,enabled:false,nativeOptical:false,gpuReady:false});
  if (typeof window === 'undefined') return solid('not-mounted');
  if (document.documentElement.dataset.material === 'solid') return solid('user-preference');
  if (document.documentElement.dataset.material !== 'glass' && window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return solid('reduced-transparency');
  if (window.matchMedia('(forced-colors: active)').matches || window.matchMedia('(prefers-contrast: more)').matches) return solid('increased-contrast');
  const backdrop=CSS.supports('backdrop-filter','blur(1px)');
  const nativeOptical=gpuReady;
  return {mode:nativeOptical?'optical':backdrop?'frosted':'solid',reason:nativeOptical?gpuReason:backdrop?'lens-native-backdrop':gpuReason,enabled:nativeOptical||backdrop,nativeOptical,gpuReady};
}

function update(): void {
  const next = measureCapability();
  if (snapshot.mode === next.mode && snapshot.reason === next.reason && snapshot.enabled === next.enabled&&snapshot.nativeOptical===next.nativeOptical&&snapshot.gpuReady===next.gpuReady) return;
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
