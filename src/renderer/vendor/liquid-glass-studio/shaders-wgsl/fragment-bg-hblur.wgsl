// Horizontal Gaussian blur pass for WebGPU
// Ported from fragment-bg-hblur.glsl (blurs along X axis)

const MAX_BLUR_RADIUS: i32 = 200;

struct BlurUniforms {
  u_resolution: vec2f,
  u_blurRadius: i32,
  _pad: i32,
};

@group(0) @binding(0) var<uniform> u: BlurUniforms;
@group(0) @binding(1) var u_prevPassTexture: texture_2d<f32>;
@group(0) @binding(2) var u_sampler: sampler;
@group(0) @binding(3) var<storage, read> u_blurWeights: array<f32>;

@fragment
fn fs_main(@location(0) v_uv: vec2f) -> @location(0) vec4f {
  let texelSize = 1.0 / u.u_resolution;
  var color = textureSampleLevel(u_prevPassTexture, u_sampler, v_uv, 0.0) * u_blurWeights[0];
  for (var i: i32 = 1; i <= u.u_blurRadius; i = i + 1) {
    if (i > MAX_BLUR_RADIUS) { break; }
    let w = u_blurWeights[i];
    let offset_x = f32(i) * texelSize.x;
    color += textureSampleLevel(u_prevPassTexture, u_sampler, v_uv + vec2f(offset_x, 0.0), 0.0) * w;
    color += textureSampleLevel(u_prevPassTexture, u_sampler, v_uv - vec2f(offset_x, 0.0), 0.0) * w;
  }
  return color;
}
