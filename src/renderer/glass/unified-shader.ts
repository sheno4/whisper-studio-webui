import studioMain from '../vendor/liquid-glass-studio/shaders/fragment-main.glsl?raw';
import studioSdf from '../vendor/liquid-glass-studio/shaders/lib/sdf.glsl?raw';

export const GLASS_SHAPE_LIMIT=12;
export const UNIFIED_GLASS_VERTEX=`#version 300 es
in vec2 a_position;
void main(){gl_Position=vec4(a_position,0.0,1.0);}
`;

/** Extract only Studio's real SDF-normal/Fresnel/glare implementation. WebGL
 * cannot sample the browser's backdrop: this pass has no sampler, base tint,
 * refraction or opaque interior. The pinned original optical source stays
 * intact beside this narrowly scoped lighting adapter. */
const step=studioMain.indexOf('} else if (STEP <= 9) {');
const normal=studioMain.slice(studioMain.indexOf('vec2 getNormal('),studioMain.indexOf('vec2 getNormal2('))
  .replace('return grad * 1.414213562 * 1000.0;','return normalize(grad + vec2(1e-12));');
const angle=studioMain.slice(studioMain.indexOf('float vec2ToAngle('),studioMain.indexOf('vec3 vec2ToRgb('));
const fresnelStart=studioMain.indexOf('float fresnelFactor = clamp(',step);
const fresnelEnd=studioMain.indexOf('vec3 fresnelTintLCH',fresnelStart);
const glareStart=studioMain.indexOf('float glareGeoFactor = clamp(',fresnelEnd);
const glareEnd=studioMain.indexOf('vec3 glareTintLCH',glareStart);
if(step<0||fresnelStart<step||fresnelEnd<fresnelStart||glareEnd<glareStart)throw new Error('Studio lighting source is incompatible.');
const finiteLighting=(source:string)=>source
  .replace(/pow\(\s*(1\.0\s*\+\s*merged[^,]*u_(?:refFresnel|glare)Hardness),\s*5\.0\s*\)/g,'pow(clamp($1,0.0,1.0),5.0)')
  .replace('pow(glareAngleFactor, 0.1 + u_glareConvergence * 2.0)','pow(clamp(glareAngleFactor,0.0,1.0),0.1+u_glareConvergence*2.0)');

export const UNIFIED_GLASS_FRAGMENT=`#version 300 es
precision highp float;
#define PI (3.14159265359)
out vec4 fragColor;
uniform vec2 u_resolution;
uniform float u_dpr;
uniform int u_count;
uniform int u_hasBody;
uniform int u_hasDetail;
uniform vec4 u_rects[${GLASS_SHAPE_LIMIT}];
uniform vec4 u_shape[${GLASS_SHAPE_LIMIT}]; // radius, pressure, open, role
uniform vec4 u_light[${GLASS_SHAPE_LIMIT}]; // pointer x/y, energy, intensity
uniform float u_mergeRate;
uniform float u_refFresnelRange;
uniform float u_refFresnelFactor;
uniform float u_refFresnelHardness;
uniform float u_glareRange;
uniform float u_glareConvergence;
uniform float u_glareOppositeFactor;
uniform float u_glareFactor;
uniform float u_glareHardness;
uniform float u_glareAngle;
int sceneLayer;
${studioSdf.slice(0,studioSdf.indexOf('float mainSDF('))}
float mainSDF(vec2 unused1,vec2 unused2,vec2 p){
  float field=1e6;
  for(int i=0;i<${GLASS_SHAPE_LIMIT};++i){
    if(i>=u_count)break;
    if(u_shape[i].z<=.001)continue;
    bool detail=u_shape[i].w>=2.0;
    if(u_hasBody==1&&((sceneLayer==0&&detail)||(sceneLayer==1&&!detail)))continue;
    vec4 r=u_rects[i];
    float radius=min(u_shape[i].x,min(r.z,r.w)*.5);
    float d=roundedRectSDF(p,r.xy*u_dpr,r.z,r.w,radius,2.35);
    field=smin(field,d,max(.01,u_mergeRate*u_dpr));
  }
  return field/u_resolution.y;
}
${normal}
${angle}
vec4 shadeLighting(){
  vec2 p1=vec2(0.0),p2=vec2(0.0);
  vec2 u_resolution1x=u_resolution/u_dpr;
  float merged=mainSDF(p1,p2,gl_FragCoord.xy);
  float coverage=1.0-smoothstep(-.75*u_dpr/u_resolution.y,.75*u_dpr/u_resolution.y,merged);
  if(coverage<=.001)return vec4(0.0);
  vec2 normal=getNormal(p1,p2,gl_FragCoord.xy);
  vec4 lighting=vec4(0.0);
  float nearest=1e6;
  for(int i=0;i<${GLASS_SHAPE_LIMIT};++i){
    if(i>=u_count)break;
    if(u_shape[i].z<=.001)continue;
    if(u_hasBody==1&&((sceneLayer==0&&u_shape[i].w>=2.0)||(sceneLayer==1&&u_shape[i].w<2.0)))continue;
    vec4 r=u_rects[i];
    float d=abs(roundedRectSDF(gl_FragCoord.xy,r.xy*u_dpr,r.z,r.w,min(u_shape[i].x,min(r.z,r.w)*.5),2.35));
    if(d<nearest){nearest=d;lighting=u_light[i];}
  }
  ${finiteLighting(studioMain.slice(fresnelStart,fresnelEnd))}
  ${finiteLighting(studioMain.slice(glareStart,glareEnd))}
  float depth=max(0.0,-merged*u_resolution1x.y);
  float rim=1.0-smoothstep(0.0,1.4,depth);
  vec2 direction=normalize(vec2(lighting.x*.8-.35,.8-lighting.y*.65));
  float lit=clamp(.5+.5*dot(normal,direction),0.0,1.0);
  float alpha=(fresnelFactor*u_refFresnelFactor*.10+glareAngleFactor*glareGeoFactor*.14+rim*lit*.19)*coverage*lighting.w*(1.0+lighting.z*.15);
  // Keep a completely transparent center and a bounded optical-light edge.
  alpha*=1.0-smoothstep(2.0,9.0,depth);
  return vec4(vec3(1.0),clamp(alpha,0.0,.32));
}
void main(){
  sceneLayer=0;vec4 body=shadeLighting();
  if(u_hasBody==1&&u_hasDetail==1){
    sceneLayer=1;vec4 detail=shadeLighting();
    body.a=detail.a+body.a*(1.0-detail.a);
  }
  fragColor=body;
}
`;
