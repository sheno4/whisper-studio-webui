// Signed distance functions shared by the background and main passes.
// `#include`d into a shader that already declares `#version` / `precision`.
// Requires these uniforms to be declared by the includer:
//   float u_dpr; vec2 u_resolution; int u_showShape1;
//   float u_shapeWidth, u_shapeHeight, u_shapeRadius, u_shapeRoundness, u_mergeRate;

float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

float superellipseCornerSDF(vec2 p, float r, float n) {
  p = abs(p);
  float v = pow(pow(p.x, n) + pow(p.y, n), 1.0 / n);
  return v - r;
}

float roundedRectSDF(vec2 p, vec2 center, float width, float height, float cornerRadius, float n) {
  // 移动到中心坐标系
  p -= center;

  float cr = cornerRadius * u_dpr;

  // 计算到矩形边缘的距离
  vec2 d = abs(p) - vec2(width * u_dpr, height * u_dpr) * 0.5;

  // 对于边缘区域和角落，我们需要不同的处理
  float dist;

  if (d.x > -cr && d.y > -cr) {
    // 角落区域
    vec2 cornerCenter = sign(p) * (vec2(width * u_dpr, height * u_dpr) * 0.5 - vec2(cr));
    vec2 cornerP = p - cornerCenter;
    dist = superellipseCornerSDF(cornerP, cr, n);
  } else {
    // 内部和边缘区域
    dist = min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
  }

  return dist;
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float mainSDF(vec2 p1, vec2 p2, vec2 p) {
  vec2 p1n = p1 + p / u_resolution.y;
  vec2 p2n = p2 + p / u_resolution.y;

  float d1 = u_showShape1 == 1 ? sdCircle(p1n, 100.0 * u_dpr / u_resolution.y) : 1.0;
  // float d2 = sdSuperellipse(p2, 200.0 / u_resolution.y, 4.0).x;
  float d2 = roundedRectSDF(
    p2n,
    vec2(0.0),
    u_shapeWidth / u_resolution.y,
    u_shapeHeight / u_resolution.y,
    u_shapeRadius / u_resolution.y,
    u_shapeRoundness
  );

  return smin(d1, d2, u_mergeRate);
}
