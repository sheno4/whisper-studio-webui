// Fullscreen quad vertex shader for WebGPU
// Similar to vertex.glsl but with v_uv.y flipped so that v_uv=(0,0) is top-left,
// matching WebGPU's texture/framebuffer coordinate convention.

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@location(0) a_position: vec2f) -> VertexOutput {
  var out: VertexOutput;
  let uv = (a_position + 1.0) * 0.5;
  // Flip Y: in WebGPU, texture v=0 is top, but clip y=+1 is top.
  // So top of screen has uv.y=0, bottom has uv.y=1.
  out.uv = vec2f(uv.x, 1.0 - uv.y);
  out.position = vec4f(a_position, 0.0, 1.0);
  return out;
}
