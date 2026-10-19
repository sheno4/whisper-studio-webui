/** Sam Asante, 4e7b769e1df7e5a7d3669fef22417fe3d2f79ade (MIT).
 * Optical parameters and spherical-cap functions extracted from displacement.ts.
 * Geometry stays outside GlassOptics; the app shares a single compositor. */
export interface GlassOptics {
  mapSize:number; clipToShape:boolean; softEdge:boolean; strength:number; depth:number;
  curvature:number; splay:number; dispersion:number; bend:number; bendWidth:number;
  frost:number; brightness:number; specular:number; sheenAngle:number; sheenDark:boolean;
  sheen:number; sheenWidth:number; sheenFalloff:number; glow:number; glowSpread:number;
  glowFalloff:number; scaleX?:number; scaleY?:number; saturate?:number;
}

export const DEFAULT_LENS_PARAMS = Object.freeze({
  lensW:95, lensH:95, borderRadius:95, mapSize:512, clipToShape:true, softEdge:true,
  strength:.06, depth:.65, curvature:.6, splay:0, dispersion:.5, bend:0, bendWidth:.16,
  frost:.5, brightness:.1, specular:1, sheenAngle:45, sheenDark:false, sheen:.3,
  sheenWidth:3, sheenFalloff:1.5, glow:.12, glowSpread:1, glowFalloff:.5,
});
export const DISPERSION_SPREAD = .22;

const domeGradientMean = (radius:number, halfExtent:number) => halfExtent > 0
  ? (radius - Math.sqrt(radius * radius - halfExtent * halfExtent)) / halfExtent : 0;
export function computeDomeConstants(capDepth:number, halfW:number, halfH:number) {
  const cap = Math.max(.01, Math.min(capDepth, Math.min(halfW, halfH) - 1));
  const Rx = (halfW * halfW + cap * cap) / (2 * cap);
  const Ry = (halfH * halfH + cap * cap) / (2 * cap);
  const meanX = domeGradientMean(Rx, halfW), meanY = domeGradientMean(Ry, halfH);
  return { Rx, Ry, scaleX:meanX > 0 ? .5 / meanX : 1, scaleY:meanY > 0 ? .5 / meanY : 1 };
}
export function domeGradient(distance:number, radius:number, scale:number) {
  const inside = Math.min(distance, radius * (1 - 1e-3));
  return (inside / Math.sqrt(radius * radius - inside * inside)) * scale;
}
