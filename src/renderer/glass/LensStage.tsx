import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';

import { createGlassSystem } from '../vendor/lens/runtime.js';
import type { ArtworkInfo, GlassSystem } from '../vendor/lens/index';

export type LensRendererState = 'pending' | 'ready' | 'fallback';
export type LensStageOptions = {
  enabled: boolean;
  appearance: 'system' | 'light' | 'dark';
  wallpaper?: string;
  onState?: (state: LensRendererState) => void;
};

type ArtworkState = { dark: boolean; wallpaper?: HTMLImageElement };

/** The scene is the real sampled background, never a capture of application DOM. */
function drawArtwork(context: CanvasRenderingContext2D, { width: w, height: h, dpr }: ArtworkInfo, state: ArtworkState): void {
  const palette = state.dark
    ? ['#183447', '#23596c', '#244d73', '#41467b', '#73577a', '#263d52']
    : ['#d5e9e5', '#bbdde9', '#a8badf', '#a4ace9', '#d5bad9', '#efcec5'];
  const base = context.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, palette[0]); base.addColorStop(.5, palette[1]); base.addColorStop(1, palette[5]);
  context.fillStyle = base; context.fillRect(0, 0, w, h);

  if (state.wallpaper?.naturalWidth && state.wallpaper.naturalHeight) {
    const image = state.wallpaper;
    const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
    const imageWidth = image.naturalWidth * scale, imageHeight = image.naturalHeight * scale;
    context.drawImage(image, (w - imageWidth) / 2, (h - imageHeight) / 2, imageWidth, imageHeight);
    context.fillStyle = state.dark ? '#07152238' : '#ffffff18';
    context.fillRect(0, 0, w, h);
    return;
  }

  // Adapted from the upstream scene artwork: static raised, curved sheets give
  // the shader actual contours to refract, with no demo text or idle movement.
  const ribbon = (offset: number, first: string, second: string): void => {
    const contour = new Path2D(); contour.moveTo(-w * .1, h * (.98 + offset));
    contour.bezierCurveTo(w * .13, h * (.39 + offset), w * .48, h * (.86 + offset), w * 1.1, h * (-.32 + offset));
    const shape = new Path2D(contour); shape.lineTo(w * 1.15, h * 1.4); shape.lineTo(-w * .1, h * 1.4); shape.closePath();
    const face = context.createLinearGradient(w * .05, h * .1, w * .87, h * .92);
    face.addColorStop(0, first); face.addColorStop(.48, second); face.addColorStop(1, palette[5]);
    context.save(); context.shadowColor = state.dark ? '#07152a65' : '#38486830';
    context.shadowBlur = 27 * dpr; context.shadowOffsetY = -7 * dpr; context.fillStyle = face; context.fill(shape); context.restore();
    context.save(); context.clip(shape); context.filter = `blur(${15 * dpr}px)`;
    context.strokeStyle = state.dark ? '#bce9ff24' : '#ffffff45'; context.lineWidth = 37 * dpr; context.stroke(contour);
    context.filter = 'none'; context.strokeStyle = state.dark ? '#c1e9ff38' : '#ffffff66'; context.lineWidth = 1.2 * dpr; context.stroke(contour);
    context.restore();
  };
  ribbon(-.31, palette[1], palette[2]); ribbon(-.10, palette[2], palette[3]);
  ribbon(.18, palette[3], palette[4]); ribbon(.44, palette[4], palette[5]);
  const glow = context.createRadialGradient(w * .12, h * .08, 0, w * .12, h * .08, w * .85);
  glow.addColorStop(0, state.dark ? '#d8f5ff12' : '#ffffff55'); glow.addColorStop(1, '#ffffff00');
  context.fillStyle = glow; context.fillRect(0, 0, w, h);
}

function prefersDark(appearance: LensStageOptions['appearance']): boolean {
  return appearance === 'dark' || (appearance === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** One shared native Lens compositor and JellyController for the entire workbench. */
export function useLensStage(ref: RefObject<HTMLElement | null>, options: LensStageOptions): MutableRefObject<GlassSystem | undefined> {
  const system = useRef<GlassSystem | undefined>(undefined);
  const latest = useRef(options); latest.current = options;
  const artwork = useRef<ArtworkState>({ dark: prefersDark(options.appearance) });
  const refresh = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const stage = ref.current;
    if (!stage) return;
    if (!options.enabled) { latest.current.onState?.('fallback'); return; }
    let destroyed = false;
    let mountFrame = 0;
    let lastState: LensRendererState | undefined;
    const publish = (): void => {
      if (destroyed) return;
      const canvas = stage.querySelector<HTMLCanvasElement>(':scope > .lg-canvas');
      const state: LensRendererState = stage.classList.contains('webgl-ready') && canvas?.dataset.gpuState === 'active'
        ? 'ready' : canvas?.dataset.gpuState === 'idle' ? 'pending' : stage.classList.contains('fallback') ? 'fallback' : 'pending';
      stage.dataset.lensState = state;
      if (state !== lastState) { lastState = state; latest.current.onState?.(state); }
    };
    const scene = (): 'ocean' | 'aurora' => artwork.current.dark ? 'ocean' : 'aurora';
    const updateScene = (): void => {
      artwork.current.dark = prefersDark(latest.current.appearance);
      system.current?.setScene(scene());
    };
    stage.dataset.lensState = 'pending'; latest.current.onState?.('pending');
    artwork.current.dark = prefersDark(latest.current.appearance);
    const instance = createGlassSystem(stage, {
      material: 'thick', scene: scene(), motion: false,
      artwork: (context, info) => drawArtwork(context, info, artwork.current),
      audio: { enabled: false, storage: null },
      onFallback: publish, onState: publish
    });
    system.current = instance; refresh.current = updateScene;

    // Surface factories run in React layout effects. Observe only their binding
    // attributes and tree changes; style writes from spring frames do not remount.
    const mounting = new MutationObserver(() => {
      if (!mountFrame) mountFrame = requestAnimationFrame(() => {
        mountFrame = 0; if (!destroyed) instance.mount();
      });
    });
    mounting.observe(stage, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-glass', 'data-lg-drag', 'data-lg-drag-handle'] });
    const stateObserver = new MutationObserver(publish);
    stateObserver.observe(stage, { attributes: true, attributeFilter: ['class'] });
    const canvas = stage.querySelector<HTMLCanvasElement>(':scope > .lg-canvas');
    if (canvas) stateObserver.observe(canvas, { attributes: true, attributeFilter: ['data-gpu-state', 'hidden'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', updateScene);
    publish();
    return () => {
      destroyed = true; cancelAnimationFrame(mountFrame); mounting.disconnect(); stateObserver.disconnect();
      scheme.removeEventListener('change', updateScene); refresh.current = undefined;
      system.current = undefined; instance.destroy(); delete stage.dataset.lensState;
    };
  }, [ref, options.enabled]);

  useEffect(() => { refresh.current?.(); }, [options.appearance, options.enabled]);

  useEffect(() => {
    let disposed = false;
    artwork.current.wallpaper = undefined; refresh.current?.();
    if (!options.wallpaper) return;
    let url: URL;
    try { url = new URL(options.wallpaper, window.location.href); }
    catch { return; }
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return;
    const image = new Image();
    // Existing local wallpaper routes keep their authentication. A remote image
    // must grant CORS before its pixels may legally enter a WebGL texture.
    if (url.protocol !== 'blob:' && url.origin !== window.location.origin) image.crossOrigin = 'anonymous';
    image.onload = () => { if (!disposed) { artwork.current.wallpaper = image; refresh.current?.(); } };
    image.onerror = () => { if (!disposed) { artwork.current.wallpaper = undefined; refresh.current?.(); } };
    image.src = url.href;
    return () => { disposed = true; image.onload = null; image.onerror = null; };
  }, [options.wallpaper]);

  return system;
}
