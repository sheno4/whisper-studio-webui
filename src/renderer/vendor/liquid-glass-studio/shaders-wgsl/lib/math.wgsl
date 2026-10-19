// Math helpers shared across shader passes.
// Mirrors src/shaders/lib/math.glsl for the WebGPU backend.

// asin with domain-clamped input. asin(x) returns NaN for |x| > 1 in WGSL,
// which corrupts the refraction edge just outside the shape where
// x_R_ratio > 1. Clamping keeps the result well-defined.
fn safeAsin(x: f32) -> f32 {
  return asin(clamp(x, -1.0, 1.0));
}
