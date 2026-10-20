import type { NativeRenderer } from './viewport-renderer';

/** Use existing upstream optical profiles without changing factory DOM,
 * gestures, shaders or the shared scene. The factory uses the opaque thumb
 * profile for sliders, and its menu profile adds a .60 white tint. Those are
 * unsuitable for the transparent controls used throughout this workbench. */
export function adaptControlMaterials(renderer: NativeRenderer) {
  const originalReadGeometry = renderer.readGeometry;
  const readGeometry = function(this: NativeRenderer) {
    originalReadGeometry.call(this);
    for (const geometry of this.geometry) {
      if (geometry.el.classList.contains('lg-slider-thumb')) geometry.kind = 'slider-thumb';
      else if (geometry.el.classList.contains('lg-switch-thumb')) geometry.kind = 'selected';
      else if (geometry.el.classList.contains('lg-menu-popover')) geometry.kind = 'panel';
    }
  };
  renderer.readGeometry = readGeometry;
  renderer.invalidate();
  return { destroy() { if (renderer.readGeometry === readGeometry) renderer.readGeometry = originalReadGeometry; } };
}
