import {useEffect, useLayoutEffect, useRef, type RefObject} from 'react';
import {createGlassSystem, materialPresets, tokens, type GlassSystem, type SceneName} from '../vendor/lens-native/index.js';
import {getGlassIntensity, subscribeGlassIntensity} from '../glass/material-intensity';
import {setUnifiedGlassReady} from '../glass/capabilities';
import {createNativeLifecycle, controlSelector, withoutInitialControlMount} from './native-lifecycle';
import {createNativeDOMEnhancer} from './native-dom';
import {adaptViewportRenderer, type NativeRenderer} from './viewport-renderer';
import {createTopLayerPresentation} from './top-layer-presentation';

export type LensRuntimeOptions = {wallpaperUrl?: string};
type StageRuntime = {system: GlassSystem; schedule(root: HTMLElement): void; release(root: HTMLElement): void; wallpaper(url?: string): void; destroy(): void};
const stages = new Map<HTMLElement, StageRuntime>();

/** Inserting native factory nodes shares one frame and never recreates a system. */
export function scheduleLensMount(root: HTMLElement): void {
  for (const [stage, runtime] of stages) if (stage === root || stage.contains(root)) runtime.schedule(root);
}

/** Call before handle.destroy()/removal to detach native gesture resources. */
export function releaseLensRoot(root: HTMLElement): void {
  for (const runtime of stages.values()) runtime.release(root);
}

function createStageRuntime(stage: HTMLElement): StageRuntime {
  const canvas = stage.ownerDocument.createElement('canvas');
  stage.prepend(canvas);
  const system = withoutInitialControlMount(stage, () => createGlassSystem(stage, {
    canvas, material: 'thick', scene: 'aurora', motion: false,
    elasticity: tokens.motion.elasticity, audio: {enabled: false, storage: null},
    onFallback: () => setUnifiedGlassReady(false, 'lens-css-fallback')
  }));
  const renderer = system.renderer as NativeRenderer | undefined;
  const lifecycle = createNativeLifecycle(system, stage);
  const enhancer = createNativeDOMEnhancer(stage);
  const viewport = renderer ? adaptViewportRenderer(renderer, stage, canvas) : undefined;
  const presentation = renderer && viewport ? createTopLayerPresentation(renderer, stage, canvas, viewport.viewport) : undefined;
  const abort = new AbortController();
  const media = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].map(query => window.matchMedia(query));
  let allowed = true, destroyed = false, mounting = 0, wallpaperGeneration = 0;
  let image: HTMLImageElement | undefined, pendingImage: HTMLImageElement | undefined;
  let requestedWallpaper: string | undefined | null = null;
  const roots = new Set<HTMLElement>();
  const report = () => {
    const ready = Boolean(allowed && renderer && !renderer.suspended && !renderer.lost && canvas.dataset.gpuState === 'active');
    setUnifiedGlassReady(ready, ready ? 'lens-webgl2' : allowed ? 'lens-css-fallback' : 'lens-solid');
  };
  const resumeGPU = renderer?.resumeGPU;
  const startGPU = renderer?.startGPU;
  if (renderer && resumeGPU) renderer.resumeGPU = function() {if (allowed && !destroyed) resumeGPU.call(this);};
  if (renderer && startGPU) renderer.startGPU = function() {if (allowed && !destroyed) startGPU.call(this); else this.suspendGPU();};

  const applyIntensity = () => {
    // Stored .8 is the app default: preserve upstream Thick exactly at .8.
    const amount = Math.max(0, Math.min(1.25, getGlassIntensity() / .8));
    system.setMaterial({refraction: Math.min(1, materialPresets.thick.refraction * amount), blur: Math.min(1, materialPresets.thick.blur * amount), dispersion: Math.min(1, materialPresets.thick.dispersion * amount)});
    system.jelly.setIntensity(allowed && !media[1].matches ? Math.min(1, tokens.motion.elasticity * amount) : 0);
  };
  const applyPreferences = () => {
    const material = document.documentElement.dataset.material;
    allowed = material !== 'solid' && (material === 'glass' || !media[2].matches) && !media[3].matches && !media[4].matches;
    const appearance = document.documentElement.dataset.appearance;
    const dark = appearance === 'dark' || (appearance !== 'light' && media[0].matches);
    const scene: SceneName = dark ? 'ocean' : 'aurora';
    stage.classList.toggle('opaque', !allowed);
    stage.dataset.lensMaterial = allowed ? 'glass' : 'solid';
    if (stage.dataset.scene !== scene) system.setScene(scene);
    if (renderer) {
      renderer.reducedMotion = media[1].matches;
      if (!allowed) renderer.suspendGPU();
      else if (renderer.suspended && renderer.gpuLease?.active) renderer.resumeGPU();
    }
    applyIntensity(); report();
  };
  const refresh = () => {
    mounting = 0; lifecycle.prune(); enhancer.prune();
    const pending = [...roots]; roots.clear();
    for (const root of pending) {
      if (root !== stage && !stage.contains(root)) continue;
      enhancer.mount(root); lifecycle.mount(root);
    }
  };
  const schedule = (root: HTMLElement) => {
    if (destroyed) return;
    if (![...roots].some(existing => existing === root || existing.contains(root))) {
      for (const existing of roots) if (root.contains(existing)) roots.delete(existing);
      roots.add(root);
    }
    if (!mounting) mounting = requestAnimationFrame(refresh);
  };
  const release = (root: HTMLElement) => {
    presentation?.release(root); lifecycle.release(root); enhancer.release(root);
    for (const pending of roots) if (pending === root || root.contains(pending)) roots.delete(pending);
  };
  const structural = `${controlSelector},button,input,textarea`;
  const containsControls = (node: Node): node is HTMLElement => node instanceof HTMLElement && (node.matches(structural) || Boolean(node.querySelector(structural)));
  const structureObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLElement) enhancer.repair(record.target);
        continue;
      }
      // Text and optical state writes never enter the registration path.
      for (const node of record.removedNodes) if (containsControls(node)) release(node);
      for (const node of record.addedNodes) if (containsControls(node)) schedule(node);
    }
  });
  structureObserver.observe(stage, {subtree: true, childList: true, attributes: true, attributeFilter: ['class']});
  const preferences = new MutationObserver(applyPreferences);
  preferences.observe(document.documentElement, {attributes: true, attributeFilter: ['data-material', 'data-appearance']});
  const gpu = new MutationObserver(report);
  gpu.observe(canvas, {attributes: true, attributeFilter: ['data-gpu-state', 'hidden']});
  media.forEach(query => query.addEventListener('change', applyPreferences, {signal: abort.signal}));
  const unsubscribeIntensity = subscribeGlassIntensity(applyIntensity);
  applyPreferences(); enhancer.mount(); lifecycle.mount();
  stage.dataset.glassRenderer = 'lens-native';

  const cancelPendingImage = () => {
    if (!pendingImage) return;
    pendingImage.onload = null; pendingImage.onerror = null; pendingImage.removeAttribute('src'); pendingImage = undefined;
  };
  const wallpaper = (url?: string) => {
    if (requestedWallpaper === url || destroyed) return;
    requestedWallpaper = url;
    const generation = ++wallpaperGeneration;
    cancelPendingImage();
    if (!renderer) return;
    if (!url) {
      image = undefined; renderer.artwork = null; delete stage.dataset.lensWallpaper;
      renderer.setScene(renderer.settings.scene); return;
    }
    const next = new Image(); pendingImage = next;
    next.crossOrigin = 'anonymous';
    next.onload = () => {
      if (destroyed || generation !== wallpaperGeneration) return;
      pendingImage = undefined; next.onload = null; next.onerror = null;
      const previousArtwork = renderer.artwork, previousImage = image;
      image = next;
      renderer.artwork = (context, {width, height}) => {
        const scale = Math.max(width / next.naturalWidth, height / next.naturalHeight);
        const w = next.naturalWidth * scale, h = next.naturalHeight * scale;
        context.drawImage(next, (width - w) / 2, (height - h) / 2, w, h);
      };
      try {renderer.setScene(renderer.settings.scene); stage.dataset.lensWallpaper = 'ready';}
      catch {
        image = previousImage; renderer.artwork = previousArtwork;
        stage.dataset.lensWallpaper = 'unavailable'; renderer.setScene(renderer.settings.scene);
      }
    };
    next.onerror = () => {
      if (!destroyed && generation === wallpaperGeneration) {
        stage.dataset.lensWallpaper = 'unavailable'; pendingImage = undefined;
        next.onload = null; next.onerror = null;
      }
    };
    next.src = url;
  };
  return {system, schedule, release, wallpaper, destroy() {
    if (destroyed) return;
    destroyed = true; ++wallpaperGeneration; cancelPendingImage();
    cancelAnimationFrame(mounting); roots.clear();
    structureObserver.disconnect(); preferences.disconnect(); gpu.disconnect();
    abort.abort(); unsubscribeIntensity(); presentation?.destroy(); viewport?.destroy();
    lifecycle.destroy(); system.destroy(); enhancer.destroy(); image = undefined;
    canvas.remove(); stage.classList.remove('webgl-ready', 'fallback', 'opaque', 'lg-stage');
    delete stage.dataset.glassRenderer; delete stage.dataset.lensMaterial; delete stage.dataset.lensWallpaper;
    setUnifiedGlassReady(false, 'lens-unmounted');
  }};
}

/** One workbench scene; data updates and wallpaper changes retain its system. */
export function useLensRuntimeStage(ref: RefObject<HTMLElement | null>, options: LensRuntimeOptions = {}) {
  const system = useRef<GlassSystem | undefined>(undefined);
  const runtime = useRef<StageRuntime | undefined>(undefined);
  const wallpaper = useRef(options.wallpaperUrl); wallpaper.current = options.wallpaperUrl;
  useLayoutEffect(() => {
    const stage = ref.current;
    if (!stage) return;
    const instance = createStageRuntime(stage);
    runtime.current = instance; system.current = instance.system; stages.set(stage, instance);
    instance.wallpaper(wallpaper.current);
    return () => {
      if (stages.get(stage) === instance) stages.delete(stage);
      runtime.current = undefined; system.current = undefined; instance.destroy();
    };
  }, [ref]);
  useEffect(() => runtime.current?.wallpaper(options.wallpaperUrl), [options.wallpaperUrl]);
  return system;
}
