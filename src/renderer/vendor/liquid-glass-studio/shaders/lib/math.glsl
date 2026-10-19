// Math helpers shared across shader passes.
// `#include`d into a shader that already declares `#version` / `precision`.

// asin with domain-clamped input. Plain asin(x) is undefined for |x| > 1 in
// GLSL (drivers may return NaN or an out-of-range value), which corrupts the
// refraction edge just outside the shape where x_R_ratio > 1. Clamping keeps
// the result well-defined and matches the WebGPU backend.
float safeAsin(float x) {
  return asin(clamp(x, -1.0, 1.0));
}
