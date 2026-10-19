/** Shu Ding's original rounded-rectangle SDF, a2d2e847f793430e3409a52927af815a23f4d372 (MIT). */
export function smoothStep(a: number, b: number, t: number) {
  t = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function roundedRectSDF(x: number, y: number, width: number, height: number, radius: number) {
  const qx = Math.abs(x) - width + radius;
  const qy = Math.abs(y) - height + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) - radius;
}

/** The same signed distance in GLSL; width/height are half extents. */
export const SHUDING_SDF_GLSL = `
float shudingRoundedRectSDF(vec2 point, vec2 halfSize, float radius) {
  vec2 q = abs(point) - halfSize + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}
float shudingSmoothStep(float a, float b, float value) {
  float t = clamp((value - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
`;
