import {getViewportRenderQuality, observeViewportAllocation, requestViewportQualityFallback, type NativeGeometry, type NativeRenderer} from './viewport-renderer';

type Presentation = {host: HTMLElement; canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; copied: boolean};
type Bindings = {read: WebGLFramebuffer | null; draw: WebGLFramebuffer | null; texture: WebGLTexture | null};

/** Present the native compositor's real output in DOM top layers. This copies
 * only its own WebGL canvas, never DOM pixels, and owns no frame ticker/shader.
 * One native lens loop is kept: checkpoints use the original COPY program. */
export function createTopLayerPresentation(renderer: NativeRenderer, stage: HTMLElement, sourceCanvas: HTMLCanvasElement, viewport: () => DOMRect) {
  const originalReadGeometry = renderer.readGeometry;
  const originalRender = renderer.render;
  const originalUse = renderer.use;
  const originalSuspend = renderer.suspendGPU;
  const presentations = new Map<HTMLElement, Presentation>();
  const openedAt = new WeakMap<HTMLElement, number>();
  const abort = new AbortController();
  let openSequence = 0, destroyed = false;
  let rawGeometry: NativeGeometry[] = [];
  let hosts: HTMLElement[] = [], drawnGroups: Array<HTMLElement | null> = [];
  let group: HTMLElement | null = null, lensIndex = 0, inRender = false, baseSaved = false;
  let density = 1;
  let blockedSize = '', blockedTarget: WebGLTexture | undefined;
  let base: {gl: WebGL2RenderingContext; texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number} | undefined;

  const bindings = (gl: WebGL2RenderingContext): Bindings => ({
    read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    texture: gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
  });
  const restoreBindings = (gl: WebGL2RenderingContext, state: Bindings) => {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.read);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.draw);
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
  };
  const remove = (host: HTMLElement) => {
    const entry = presentations.get(host);
    if (!entry) return;
    presentations.delete(host); entry.canvas.remove();
    entry.canvas.width = 1; entry.canvas.height = 1;
  };
  const releaseBase = () => {
    if (!base) return;
    if (!base.gl.isContextLost()) {
      base.gl.deleteFramebuffer(base.framebuffer); base.gl.deleteTexture(base.texture);
    }
    base = undefined; baseSaved = false;
  };
  const clear = () => {
    for (const host of presentations.keys()) remove(host);
    releaseBase();
  };
  const stopObservingAllocation = observeViewportAllocation(renderer, clear);
  const sizeKey = () => `${renderer.width}x${renderer.height}@${renderer.dpr}`;
  const blocked = () => blockedSize === sizeKey() && blockedTarget === renderer.targets[0]?.texture;
  const failPresentation = () => {
    if (blocked()) return;
    blockedSize = sizeKey(); blockedTarget = renderer.targets[0]?.texture;
    clear();
    // Checkpoint and 2D copies share the scene's density. On a real allocation
    // failure lower that one scene once, then retry only after its size changes.
    requestViewportQualityFallback(renderer);
  };
  const available = () => !destroyed && !renderer.destroyed && !renderer.suspended && !renderer.lost && renderer.visible && !document.hidden && !stage.classList.contains('opaque') && sourceCanvas.dataset.gpuState === 'active';
  const isPopover = (host: HTMLElement) => host.hasAttribute('popover') && host.matches(':popover-open');
  const visible = (host: HTMLElement) => {
    if (!host.isConnected || !host.getClientRects().length || getComputedStyle(host).visibility === 'hidden') return false;
    const rect = host.getBoundingClientRect(), view = viewport();
    return rect.right > view.left && rect.bottom > view.top && rect.left < view.right && rect.top < view.bottom;
  };
  const path = (element: HTMLElement) => {
    const result: HTMLElement[] = [];
    for (let current: HTMLElement | null = element; current && current !== stage; current = current.parentElement) result.unshift(current);
    return result;
  };
  const paintOrder = (a: HTMLElement, b: HTMLElement) => {
    const aPopover = isPopover(a), bPopover = isPopover(b);
    if (aPopover !== bPopover) return aPopover ? 1 : -1;
    if (aPopover) {
      const order = (openedAt.get(a) ?? 0) - (openedAt.get(b) ?? 0);
      if (order) return order;
    }
    const aPath = path(a), bPath = path(b);
    let common = 0;
    while (aPath[common] && aPath[common] === bPath[common]) common++;
    // At a diverging modal branch the backdrop's stacking level is the paint
    // boundary; equal levels retain DOM order. Descendant dialogs follow parents.
    const stackLevel = (branch: HTMLElement[]) => {
      for (const element of branch.slice(common)) {
        const style = getComputedStyle(element);
        if (style.zIndex !== 'auto' && style.position !== 'static') return Number(style.zIndex) || 0;
        if (style.transform !== 'none' || style.isolation === 'isolate' || Number(style.opacity) < 1) return 0;
      }
      return 0;
    };
    const level = stackLevel(aPath) - stackLevel(bPath);
    if (level) return level;
    if (a.contains(b)) return -1;
    if (b.contains(a)) return 1;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  };

  const clipWithin = (element: HTMLElement, host: HTMLElement, view: DOMRect) => {
    let left = view.left, top = view.top, right = view.right, bottom = view.bottom;
    // Top layers escape outer scroll ancestry, but menus and prefs-scroll keep
    // clipping their own descendants. The host's material itself uses viewport.
    if (element !== host) for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), explicit = parent.dataset.lgClip === 'true';
      const clipX = explicit || /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const clipY = explicit || /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      if (clipX || clipY) {
        const rect = parent.getBoundingClientRect();
        const clientLeft = rect.left + parent.clientLeft, clientTop = rect.top + parent.clientTop;
        if (clipX) {left = Math.max(left, clientLeft); right = Math.min(right, clientLeft + parent.clientWidth);}
        if (clipY) {top = Math.max(top, clientTop); bottom = Math.min(bottom, clientTop + parent.clientHeight);}
      }
      if (parent === host) break;
    }
    return {left: (left - view.left) * renderer.dpr, right: (right - view.left) * renderer.dpr, bottom: (view.bottom - bottom) * renderer.dpr, top: (view.bottom - top) * renderer.dpr};
  };
  const linearTransform = (element: HTMLElement, stop?: HTMLElement) => {
    let matrix = new DOMMatrix();
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const transform = getComputedStyle(current).transform;
      if (transform !== 'none') {
        const own = new DOMMatrix(transform); own.e = 0; own.f = 0;
        matrix = own.multiply(matrix);
      }
      if (current === stop) break;
    }
    return matrix;
  };
  const prepare = () => {
    hosts = [...stage.querySelectorAll<HTMLElement>('[role="dialog"].lg-surface,[popover].lg-surface')]
      .filter(host => (!host.hasAttribute('popover') || isPopover(host)) && visible(host)).sort(paintOrder);
    for (const [host, entry] of presentations) {entry.copied = false; if (!hosts.includes(host)) remove(host);}
    if (!hosts.length) {renderer.geometry = rawGeometry; drawnGroups = []; releaseBase(); return;}
    const view = viewport(), order = new Map(hosts.map((host, index) => [host, index + 1]));
    const groupFor = new Map<HTMLElement, HTMLElement>();
    const geometry = rawGeometry.map(geometry => {
      // Innermost active top-layer host owns each lens, even inside a dialog.
      const host = [...hosts].reverse().find(candidate => candidate === geometry.el || candidate.contains(geometry.el));
      if (!host) return geometry;
      groupFor.set(geometry.el, host);
      let opacity = 1;
      for (let element: HTMLElement | null = geometry.el; element && element !== host; element = element.parentElement) opacity *= Number(getComputedStyle(element).opacity);
      let inverse = geometry.inverse;
      if (isPopover(host)) {
        // The top layer also escapes ancestor transforms. Keep only the menu's
        // own WAAPI pose and transforms inside it, using native GL Y convention.
        const matrix = linearTransform(geometry.el, host), determinant = matrix.a * matrix.d - matrix.b * matrix.c;
        inverse = Math.abs(determinant) > .001 ? [matrix.d / determinant, matrix.b / determinant, matrix.c / determinant, matrix.a / determinant] : [1, 0, 0, 1];
      }
      return {...geometry, inverse, opacity, clip: clipWithin(geometry.el, host, view)};
    });
    // Stable sort retains the upstream rank/depth order inside every group.
    geometry.sort((a, b) => (order.get(groupFor.get(a.el)!) ?? 0) - (order.get(groupFor.get(b.el)!) ?? 0));
    renderer.geometry = geometry;
    const pad = 36 * renderer.dpr;
    drawnGroups = geometry.filter(item => {
      const x = Math.max(0, item.clip.left, Math.floor(item.x - pad)), y = Math.max(0, item.clip.bottom, Math.floor(item.y - pad));
      const right = Math.min(renderer.width, item.clip.right, Math.ceil(item.x + item.w + pad)), top = Math.min(renderer.height, item.clip.top, Math.ceil(item.y + item.h + pad));
      return right > x && top > y;
    }).map(item => groupFor.get(item.el) ?? null);
    density = renderer.dpr;
    const quality = getViewportRenderQuality(renderer);
    if (quality && !blocked()) {
      const totalPixels = hosts.reduce((area, host) => area + Math.max(1, host.clientWidth) * Math.max(1, host.clientHeight) * density ** 2, 0);
      // Normal dialogs/popovers retain exactly the source density. Protect
      // against enormous/offscreen hosts or unbounded stacks of full dialogs
      // using the same persistent scene fallback, never a blurry copy alone.
      if (totalPixels > quality.pixelBudget * 2 || hosts.some(host =>
        host.clientWidth * density > quality.maxWidth || host.clientHeight * density > quality.maxHeight ||
        host.clientWidth * host.clientHeight * density ** 2 > quality.pixelBudget)) failPresentation();
    }
  };

  const ensurePresentation = (host: HTMLElement) => {
    let entry = presentations.get(host);
    if (!entry) {
      const canvas = host.ownerDocument.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true'); canvas.dataset.lensPresentation = isPopover(host) ? 'popover' : 'dialog';
      // Set decorative styles once. Rewriting them during render would feed the
      // upstream style MutationObserver and sustain an otherwise idle renderer.
      Object.assign(canvas.style, {position: 'absolute', inset: 'auto', left: '0px', top: '0px', width: '100%', height: '100%', pointerEvents: 'none', borderRadius: 'inherit', zIndex: '-1', display: 'block'});
      const context = canvas.getContext('2d', {alpha: true});
      if (!context) {failPresentation(); return undefined;}
      entry = {host, canvas, context, copied: false}; presentations.set(host, entry); host.prepend(canvas);
    }
    return entry;
  };
  const copyVisibleHost = (host: HTMLElement) => {
    const entry = ensurePresentation(host); if (!entry) return;
    const {canvas, context} = entry;
    const localWidth = Math.max(1, host.clientWidth), localHeight = Math.max(1, host.clientHeight);
    // Absolute children scroll with the host's content. Counter that movement
    // so this material stays over its client viewport, including its padding.
    // Explicit client dimensions also exclude the scrollbar from the canvas.
    // Only changed values feed the native style observer, avoiding an idle loop.
    const placement = {left: `${host.scrollLeft}px`, top: `${host.scrollTop}px`, width: `${localWidth}px`, height: `${localHeight}px`};
    for (const property of ['left', 'top', 'width', 'height'] as const) {
      if (canvas.style[property] !== placement[property]) canvas.style[property] = placement[property];
    }
    const width = Math.max(1, Math.floor(localWidth * density)), height = Math.max(1, Math.floor(localHeight * density));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (canvas.dataset.lensPixelRatio !== String(density)) canvas.dataset.lensPixelRatio = String(density);
    const rect = canvas.getBoundingClientRect(), view = viewport();
    const left = Math.max(rect.left, view.left), top = Math.max(rect.top, view.top);
    const right = Math.min(rect.right, view.right), bottom = Math.min(rect.bottom, view.bottom);
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, width, height);
    if (right <= left || bottom <= top) return;
    // Map screen CSS coordinates back through the host's linear transform. The
    // DOM then applies that transform once; scale/rotation are not applied twice.
    const matrix = linearTransform(canvas, isPopover(host) ? host : undefined);
    const expectedWidth = Math.abs(matrix.a) * localWidth + Math.abs(matrix.c) * localHeight;
    const expectedHeight = Math.abs(matrix.b) * localWidth + Math.abs(matrix.d) * localHeight;
    // Account for CSS zoom/layout rounding in addition to transform matrices.
    const scaleX = rect.width / Math.max(.001, expectedWidth), scaleY = rect.height / Math.max(.001, expectedHeight);
    matrix.a *= scaleX; matrix.c *= scaleX; matrix.b *= scaleY; matrix.d *= scaleY;
    if (Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < .00001) return;
    const inverse = matrix.inverse(), centerX = (rect.left + rect.right) / 2, centerY = (rect.top + rect.bottom) / 2;
    const backingX = width / localWidth, backingY = height / localHeight;
    context.setTransform(inverse.a * backingX, inverse.b * backingY, inverse.c * backingX, inverse.d * backingY,
      (localWidth / 2 - inverse.a * centerX - inverse.c * centerY) * backingX,
      (localHeight / 2 - inverse.b * centerX - inverse.d * centerY) * backingY);
    const sourceX = renderer.width / view.width, sourceY = renderer.height / view.height;
    context.drawImage(sourceCanvas, (left - view.left) * sourceX, (top - view.top) * sourceY, (right - left) * sourceX, (bottom - top) * sourceY, left, top, right - left, bottom - top);
    if (context.isContextLost?.()) throw new Error('Lens presentation 2D allocation lost');
    entry.copied = true;
  };
  const copyHost = (host: HTMLElement) => {
    if (blocked() || !available() || !visible(host)) {remove(host); return;}
    try {copyVisibleHost(host);} catch {failPresentation();}
  };

  const copyToDefault = (gl: WebGL2RenderingContext, texture: WebGLTexture) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindTexture(gl.TEXTURE_2D, texture);
    const program = renderer.programs.copy;
    originalUse.call(renderer, program); gl.uniform1i(program.uniforms.uScene, 0); gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
  const saveBase = (gl: WebGL2RenderingContext, sourceTexture: WebGLTexture) => {
    const source = renderer.targets.find(target => target.texture === sourceTexture);
    if (!source) throw new Error('Lens presentation source is not a native scene target');
    if (base?.gl !== gl) releaseBase();
    if (!base) {
      const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
      if (!texture || !framebuffer) {
        if (texture) gl.deleteTexture(texture);
        if (framebuffer) gl.deleteFramebuffer(framebuffer);
        throw new Error('Lens presentation checkpoint allocation failed');
      }
      base = {gl, texture, framebuffer, width: 0, height: 0};
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    if (base.width !== renderer.width || base.height !== renderer.height) {
      for (let count = 0; count < 8 && gl.getError() !== gl.NO_ERROR; count++);
      gl.bindTexture(gl.TEXTURE_2D, base.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, renderer.width, renderer.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, base.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, base.texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE || gl.getError() !== gl.NO_ERROR) throw new Error('Incomplete Lens presentation checkpoint');
      base.width = renderer.width; base.height = renderer.height;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, base.framebuffer);
    gl.blitFramebuffer(0, 0, renderer.width, renderer.height, 0, 0, renderer.width, renderer.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    baseSaved = true;
  };

  renderer.readGeometry = function() {originalReadGeometry.call(this); rawGeometry = this.geometry; prepare();};
  renderer.use = function(program, quad) {
    if (inRender && hosts.length && !blocked() && program === this.programs.lens) {
      const next = drawnGroups[lensIndex++] ?? null;
      if (next !== group) {
        const gl = this.gl;
        if (gl) {
          const state = bindings(gl), sourceTexture = state.texture;
          try {
            if (sourceTexture && !baseSaved && next) saveBase(gl, sourceTexture);
            if (sourceTexture && group) {copyToDefault(gl, sourceTexture); copyHost(group);}
          } catch {failPresentation();} finally {restoreBindings(gl, state);}
        }
        group = next;
      }
    }
    originalUse.call(this, program, quad);
  };
  renderer.render = function(now) {
    if (!available()) {clear(); originalRender.call(this, now); return;}
    group = null; lensIndex = 0; baseSaved = false; inRender = true;
    // Let native render perform its normal geometry read. Reuse its last read
    // when pointer-light updates intentionally leave geometry clean.
    if (!this.rectDirty && now >= this.animatingUntil) prepare();
    try {
      originalRender.call(this, now);
      if (group && baseSaved) copyHost(group);
    } finally {
      inRender = false;
      if (baseSaved && base && this.gl && !this.gl.isContextLost()) {
        const gl = this.gl, state = bindings(gl);
        try {copyToDefault(gl, base.texture);} finally {restoreBindings(gl, state);}
      }
      for (const [host, entry] of presentations) if (!entry.copied) remove(host);
    }
  };
  renderer.suspendGPU = function() {clear(); originalSuspend.call(this);};
  const release = (root: HTMLElement) => {
    for (const host of presentations.keys()) if (host === root || root.contains(host)) remove(host);
    if (!presentations.size) releaseBase();
  };
  const removed = new MutationObserver(() => {
    for (const host of presentations.keys()) if (!stage.contains(host)) remove(host);
    if (!presentations.size) releaseBase();
  });
  removed.observe(stage, {subtree: true, childList: true});
  stage.addEventListener('toggle', event => {
    const host = event.target;
    if (!(host instanceof HTMLElement) || !host.hasAttribute('popover')) return;
    if ((event as ToggleEvent).newState === 'open') openedAt.set(host, ++openSequence);
    else {remove(host); if (!presentations.size) releaseBase();}
    renderer.invalidate(160);
  }, {capture: true, signal: abort.signal});
  sourceCanvas.addEventListener('webglcontextlost', clear, {signal: abort.signal});
  document.addEventListener('visibilitychange', () => {if (document.hidden) clear();}, {signal: abort.signal});
  return {release, hide: clear, destroy() {
    if (destroyed) return;
    destroyed = true; abort.abort(); removed.disconnect(); stopObservingAllocation(); clear();
    renderer.readGeometry = originalReadGeometry; renderer.render = originalRender; renderer.use = originalUse; renderer.suspendGPU = originalSuspend;
  }};
}
