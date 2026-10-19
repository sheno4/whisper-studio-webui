/** Archis Vaze, fbeb99ef5e8dad2cbbc991ffc23e186a28dc01c4 (MIT). */
export const SURFACE_FNS = {
  convex_squircle: (x: number) => Math.pow(1 - Math.pow(1 - x, 4), .25),
  convex_circle: (x: number) => Math.sqrt(1 - (1 - x) * (1 - x)),
  concave: (x: number) => 1 - Math.sqrt(1 - (1 - x) * (1 - x)),
  lip: (x: number) => {
    const convex = Math.pow(1 - Math.pow(1 - Math.min(x * 2, 1), 4), .25);
    const concave = 1 - Math.sqrt(1 - (1 - x) * (1 - x)) + .1;
    const t = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
    return convex * (1 - t) + concave * t;
  },
};

/** Original SVG path's Snell-law lookup profile; no canvas or image decoding. */
export function calculateRefractionProfile(glassThickness: number, bezelWidth: number, heightFn: (x:number)=>number, ior: number, samples = 128) {
  const eta = 1 / ior;
  function refract(nx:number, ny:number) {
    const dot = ny;
    const k = 1 - eta * eta * (1 - dot * dot);
    if (k < 0) return null;
    const sq = Math.sqrt(k);
    return [-(eta * dot + sq) * nx, eta - (eta * dot + sq) * ny];
  }
  const profile = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = i / samples, y = heightFn(x), dx = x < 1 ? .0001 : -.0001;
    const deriv = (heightFn(x + dx) - y) / dx;
    const mag = Math.sqrt(deriv * deriv + 1);
    const ref = refract(-deriv / mag, -1 / mag);
    profile[i] = ref ? ref[0] * ((y * bezelWidth + glassThickness) / ref[1]) : 0;
  }
  return profile;
}

/** Original WebGL path's convex-squircle slope + air/glass refraction. */
export const ARCHISVAZE_REFRACTION_GLSL = `
float archisvazeSurfaceHeight(float t) {
  float s = 1.0 - t;
  return pow(1.0 - s*s*s*s, 0.25);
}
float archisvazeRefraction(float distanceFromEdge, float bezel, float thickness, float ior) {
  float t = clamp(distanceFromEdge / max(bezel, 0.001), 0.0, 1.0);
  float h = archisvazeSurfaceHeight(t);
  float dt = 0.001;
  float h2 = archisvazeSurfaceHeight(min(t + dt, 1.0));
  float dh = (h2 - h) / dt;
  float slopeAngle = atan(dh * (thickness / max(bezel, 0.001)));
  float sinR = clamp(sin(slopeAngle) / max(ior, 1.0), -1.0, 1.0);
  float thetaR = asin(sinR);
  return h * thickness * (tan(slopeAngle) - tan(thetaR));
}
`;
