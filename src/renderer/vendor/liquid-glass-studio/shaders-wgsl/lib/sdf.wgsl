// Signed distance functions shared by the background and main passes.
// `#include`d into a WGSL module that already declares the `Uniforms` struct
// and the `@group(0) @binding(0) var<uniform> u: Uniforms;` binding.
// Mirrors src/shaders/lib/sdf.glsl for the WebGPU backend.

fn sdCircle(p: vec2f, r: f32) -> f32 {
  return length(p) - r;
}

fn superellipseCornerSDF(p_in: vec2f, r: f32, n: f32) -> f32 {
  let p = abs(p_in);
  let v = pow(pow(p.x, n) + pow(p.y, n), 1.0 / n);
  return v - r;
}

fn roundedRectSDF(p_in: vec2f, center: vec2f, width: f32, height: f32, cornerRadius: f32, n: f32) -> f32 {
  let p = p_in - center;
  let cr = cornerRadius * u.u_dpr;
  let d = abs(p) - vec2f(width * u.u_dpr, height * u.u_dpr) * 0.5;
  var dist: f32;
  if (d.x > -cr && d.y > -cr) {
    let cornerCenter = sign(p) * (vec2f(width * u.u_dpr, height * u.u_dpr) * 0.5 - vec2f(cr));
    let cornerP = p - cornerCenter;
    dist = superellipseCornerSDF(cornerP, cr, n);
  } else {
    dist = min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
  }
  return dist;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn mainSDF(p1: vec2f, p2: vec2f, p: vec2f) -> f32 {
  let p1n = p1 + p / u.u_resolution.y;
  let p2n = p2 + p / u.u_resolution.y;
  var d1: f32;
  if (u.u_showShape1 == 1) {
    d1 = sdCircle(p1n, 100.0 * u.u_dpr / u.u_resolution.y);
  } else {
    d1 = 1.0;
  }
  let d2 = roundedRectSDF(
    p2n, vec2f(0.0),
    u.u_shapeWidth / u.u_resolution.y,
    u.u_shapeHeight / u.u_resolution.y,
    u.u_shapeRadius / u.u_resolution.y,
    u.u_shapeRoundness
  );
  return smin(d1, d2, u.u_mergeRate);
}
