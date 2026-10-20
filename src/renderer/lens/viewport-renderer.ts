import type {GlassRenderer, RendererOptions} from '../vendor/lens-native/index.js';
import {chooseRenderQuality, nextRenderPixelLimit, type RenderQuality} from './render-quality';

export type NativeGeometry = {el: HTMLElement; kind: string; opacity: number; x: number; y: number; w: number; h: number; inverse: number[]; clip: {left: number; right: number; bottom: number; top: number}};
export type NativeProgram = {p: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null>};

/** Pinned-private allocation/coordinate boundary. Native shaders, lens geometry,
 * clipping, ping-pong composition and optical state remain the upstream code. */
export type NativeRenderer = GlassRenderer & {
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  gl: WebGL2RenderingContext | null;
  destroyed: boolean;
  suspended: boolean;
  lost: boolean;
  width: number;
  height: number;
  dpr: number;
  frame: number;
  rectDirty: boolean;
  visible: boolean;
  animatingUntil: number;
  geometry: NativeGeometry[];
  programs: Record<'background' | 'copy' | 'lens', NativeProgram>;
  reducedMotion: boolean;
  pointer: {x: number; y: number};
  smoothPointer: {x: number; y: number};
  settings: RendererOptions & {scene: 'aurora' | 'sunset' | 'ocean' | 'grid'};
  targets: Array<{texture: WebGLTexture; framebuffer: WebGLFramebuffer}>;
  gpuLease?: {active: boolean; update(): void};
  artwork: ((context: CanvasRenderingContext2D, info: {width: number; height: number; dpr: number}) => void) | null;
  resize(): void;
  readGeometry(): void;
  resumeGPU(): void;
  startGPU(): void;
  suspendGPU(): void;
  render(now: number): void;
  use(program: NativeProgram, quad?: number[]): void;
};

type QualityControl = {quality?: RenderQuality; beforeAllocation: Set<() => void>; fallback(): boolean};
const qualityControls = new WeakMap<NativeRenderer, QualityControl>();

export const getViewportRenderQuality = (renderer: NativeRenderer) => qualityControls.get(renderer)?.quality;
/** A presentation allocation failure lowers the same scene on the next resize,
 * rather than blurring an independent overlay or changing quality every frame. */
export const requestViewportQualityFallback = (renderer: NativeRenderer) => qualityControls.get(renderer)?.fallback() ?? false;
export function observeViewportAllocation(renderer: NativeRenderer, release: () => void) {
  const control = qualityControls.get(renderer);
  control?.beforeAllocation.add(release);
  return () => control?.beforeAllocation.delete(release);
}

export function adaptViewportRenderer(renderer: NativeRenderer, stage: HTMLElement, canvas: HTMLCanvasElement) {
  const rectForStage = stage.getBoundingClientRect.bind(stage);
  let limits: {gl: WebGL2RenderingContext; texture: WebGLTexture | undefined; width: number; height: number} | undefined;
  let allocationPixelLimit = Infinity, allocationFailed = false, destroyed = false;
  let grantedWidthLimit = Infinity, grantedHeightLimit = Infinity;
  const nativeStartGPU = renderer.startGPU, nativeResumeGPU = renderer.resumeGPU;
  // An exhausted context must stay in CSS fallback. The native lost-context
  // listener otherwise restores an active lease immediately, creating a loop.
  renderer.startGPU = function() {if (!allocationFailed && !destroyed) nativeStartGPU.call(this);};
  renderer.resumeGPU = function() {if (!allocationFailed && !destroyed) nativeResumeGPU.call(this);};
  const viewport = () => {
    const rect = rectForStage();
    const visible = window.visualViewport;
    const viewportLeft = visible?.offsetLeft ?? 0, viewportTop = visible?.offsetTop ?? 0;
    const left = Math.max(viewportLeft, rect.left), top = Math.max(viewportTop, rect.top);
    const right = Math.max(left + 1, Math.min(viewportLeft + (visible?.width ?? window.innerWidth), rect.right));
    const bottom = Math.max(top + 1, Math.min(viewportTop + (visible?.height ?? window.innerHeight), rect.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  };
  const diagnostic = (quality: RenderQuality) => {
    const values = {
      lensPixelRatio: String(quality.dpr), lensRequestedPixelRatio: String(quality.requestedDpr),
      lensRenderWidth: String(quality.width), lensRenderHeight: String(quality.height),
      lensMaxPixels: String(quality.maxPixels), lensQuality: quality.quality
    };
    for (const [key, value] of Object.entries(values)) if (canvas.dataset[key] !== value) canvas.dataset[key] = value;
  };
  const qualityControl: QualityControl = {beforeAllocation: new Set(), fallback() {
    if (destroyed || renderer.destroyed || allocationFailed) return false;
    const limit = nextRenderPixelLimit(renderer.width, renderer.height, allocationPixelLimit);
    if (limit === undefined) {
      allocationFailed = true;
      if (canvas.dataset.lensQuality !== 'unavailable') canvas.dataset.lensQuality = 'unavailable';
      // Native startGPU finishes synchronously. Suspend after it returns too,
      // so an exhausted allocation cannot be marked active again by startup.
      queueMicrotask(() => {if (!destroyed && !renderer.destroyed) renderer.suspendGPU();});
      return false;
    }
    allocationPixelLimit = limit;
    schedule();
    return true;
  }};
  qualityControls.set(renderer, qualityControl);
  const nativeReadGeometry = renderer.readGeometry;
  const readGeometry = function(this: NativeRenderer) {
    const descriptor = Object.getOwnPropertyDescriptor(stage, 'getBoundingClientRect');
    const rect = viewport();
    // Only the native routine's stage origin changes; actual element DOMRects,
    // transforms and nested overflow clipping continue through upstream code.
    Object.defineProperty(stage, 'getBoundingClientRect', {configurable: true, value: () => rect});
    try { nativeReadGeometry.call(this); }
    finally {
      if (descriptor) Object.defineProperty(stage, 'getBoundingClientRect', descriptor);
      else Reflect.deleteProperty(stage, 'getBoundingClientRect');
    }
  };
  renderer.readGeometry = readGeometry;

  const nativeResize = renderer.resize, nativeRender = renderer.render;
  let viewportDirty = true, rendering = false;
  const applyViewportSize = function(this: NativeRenderer) {
    if (this.destroyed || this.suspended || this.lost || !this.gl || this.gl.isContextLost()) return;
    if (allocationFailed) {queueMicrotask(() => {if (!destroyed && !this.destroyed) this.suspendGPU();}); return;}
    const rect = viewport(), stageRect = rectForStage();
    // Absolute positioning follows the visible slice without creating a full
    // document texture or relying on fixed-containing-block behavior.
    const style = {right: 'auto', bottom: 'auto', left: `${rect.left - stageRect.left}px`, top: `${rect.top - stageRect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`};
    for (const [key, value] of Object.entries(style)) {
      if (canvas.style.getPropertyValue(key) !== value) canvas.style.setProperty(key, value);
    }
    const gl = this.gl;
    if (limits?.gl !== gl || limits.texture !== this.targets[0]?.texture) {
      const viewportLimits = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
      const textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const renderbufferLimit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
      limits = {gl, texture: this.targets[0]?.texture, width: Math.min(textureLimit, renderbufferLimit, viewportLimits[0], grantedWidthLimit), height: Math.min(textureLimit, renderbufferLimit, viewportLimits[1], grantedHeightLimit)};
    }
    this.rectDirty = true;
    const previousDpr = this.dpr;
    // Allocation is only attempted after size/quality changes. A failed size is
    // never retried by the animation loop or by a later equal-size resize.
    while (!allocationFailed && !gl.isContextLost()) {
      const quality = chooseRenderQuality({width: rect.width, height: rect.height, devicePixelRatio: window.devicePixelRatio,
        screenWidth: window.screen.width, screenHeight: window.screen.height, maxWidth: limits.width, maxHeight: limits.height, allocationPixelLimit});
      const {width, height, dpr} = quality;
      const sameSize = width === this.width && height === this.height;
      const sameDpr = dpr === this.dpr;
      if (sameSize && sameDpr) {qualityControl.quality = quality; diagnostic(quality); return;}
      try {
        // Drain earlier unrelated GL errors before checking this allocation.
        for (let count = 0; count < 8 && gl.getError() !== gl.NO_ERROR; count++);
        if (!sameSize) {
          // Keep the existing frame and overlays when browser zoom changes only
          // CSS density. Assigning even an equal canvas dimension clears it.
          for (const release of qualityControl.beforeAllocation) release();
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
        }
        if (gl.isContextLost()) return;
        // Some browsers grant a drawing buffer smaller than the canvas request.
        // Keep geometry, source textures and copied output on that same size.
        if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
          if (!gl.drawingBufferWidth || !gl.drawingBufferHeight ||
            (gl.drawingBufferWidth >= width && gl.drawingBufferHeight >= height)) throw new Error('Lens viewport drawing buffer allocation failed');
          grantedWidthLimit = limits.width = Math.min(limits.width, gl.drawingBufferWidth);
          grantedHeightLimit = limits.height = Math.min(limits.height, gl.drawingBufferHeight);
          // Even if the grant equals an earlier successful scene, the canvas
          // attributes still hold this larger request and must be reset too.
          this.width = 0; this.height = 0;
          continue;
        }
        this.width = width; this.height = height; this.dpr = dpr;
        if (!sameSize) {
          for (const target of this.targets) {
            gl.bindTexture(gl.TEXTURE_2D, target.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE || gl.getError() !== gl.NO_ERROR) throw new Error('Lens viewport target allocation failed');
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.setScene(this.settings.scene);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Lens viewport artwork allocation failed');
        if (previousDpr > 0 && dpr !== previousDpr) {
          // Both positions are stored in backing pixels. Preserve their CSS
          // positions and smoothing gap when a monitor/zoom changes density.
          // Commit only after allocation succeeds, never once per retry.
          const pointerScale = dpr / previousDpr;
          this.pointer.x *= pointerScale; this.pointer.y *= pointerScale;
          this.smoothPointer.x *= pointerScale; this.smoothPointer.y *= pointerScale;
        }
        qualityControl.quality = quality; diagnostic(quality);
        return;
      } catch (error) {
        // Failed attempts have not remapped pointer state, including attempts
        // that lose the context. Keep its density basis intact for restoration.
        this.dpr = previousDpr;
        if (gl.isContextLost()) return;
        const limit = nextRenderPixelLimit(width, height, allocationPixelLimit);
        if (limit === undefined) {
          allocationFailed = true;
          canvas.dataset.lensQuality = 'unavailable';
          queueMicrotask(() => {if (!destroyed && !this.destroyed) this.suspendGPU();});
          console.warn('Lens native-resolution allocation exhausted; using CSS material', error);
        } else allocationPixelLimit = limit;
        // Force the next attempt even when an earlier allocation changed fields
        // before its artwork or one of the ping-pong targets failed.
        this.width = 0; this.height = 0;
      } finally {if (!gl.isContextLost()) gl.bindFramebuffer(gl.FRAMEBUFFER, null);}
    }
  };

  const resize = function(this: NativeRenderer) {
    viewportDirty = true;
    // A top-layer allocation can request lower shared quality while native
    // render is in progress. Its own continuation must remain the only ticker.
    if (rendering) {this.rectDirty = true; return;}
    // initGL resets both dimensions before native startup reads them to place
    // its initial pointer. Runtime observers must leave the last frame intact.
    if (!this.width || !this.height) {
      viewportDirty = false;
      applyViewportSize.call(this);
    } else this.invalidate();
  };
  const render = function(this: NativeRenderer, now: number) {
    if (viewportDirty) {
      viewportDirty = false;
      // ResizeObserver runs after RAF callbacks. Allocate here instead, directly
      // before drawing, so a cleared backing store can never reach that paint.
      applyViewportSize.call(this);
      // setScene may have invalidated a direct render call. Retain only the
      // native loop's next frame, rather than leaving a second ticker behind.
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    rendering = true;
    try {
      if (!allocationFailed && this.width && this.height && !this.gl?.isContextLost()) nativeRender.call(this, now);
      else this.frame = 0;
    } finally {
      rendering = false;
      if (viewportDirty && !this.frame) this.invalidate();
    }
  };
  renderer.resize = resize;
  renderer.render = render;
  const refresh = () => {if (!destroyed) renderer.resize();};
  const schedule = refresh;
  let resolutionQuery: MediaQueryList | undefined;
  const watchResolution = () => {
    resolutionQuery?.removeEventListener('change', resolutionChanged);
    resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    resolutionQuery.addEventListener('change', resolutionChanged);
  };
  const resolutionChanged = () => {watchResolution(); schedule();};
  watchResolution();
  const pointer = (event: PointerEvent) => {
    const rect = viewport();
    renderer.pointer.x = (event.clientX - rect.left) * renderer.dpr;
    renderer.pointer.y = (rect.bottom - event.clientY) * renderer.dpr;
  };
  // Runs after the native listener, correcting its pointer to the same viewport.
  stage.addEventListener('pointermove', pointer, {passive: true});
  window.addEventListener('scroll', schedule, {capture: true, passive: true});
  window.addEventListener('resize', schedule, {passive: true});
  window.visualViewport?.addEventListener('resize', schedule, {passive: true});
  window.visualViewport?.addEventListener('scroll', schedule, {passive: true});
  return {refresh, viewport, destroy() {
    destroyed = true; qualityControls.delete(renderer);
    qualityControl.beforeAllocation.clear(); resolutionQuery?.removeEventListener('change', resolutionChanged);
    if (renderer.resize === resize) renderer.resize = nativeResize;
    if (renderer.render === render) renderer.render = nativeRender;
    if (renderer.readGeometry === readGeometry) renderer.readGeometry = nativeReadGeometry;
    stage.removeEventListener('pointermove', pointer);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
  }};
}
