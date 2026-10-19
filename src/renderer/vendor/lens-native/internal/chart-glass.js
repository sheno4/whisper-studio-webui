import {observeGPU} from './context-budget.js';
// Chart materials use the same signed-distance, Snell refraction and rim-light
// vocabulary as the main glass compositor. Only chart geometry is drawn here;
// labels, inputs, hit targets and the accessible data stay in the existing DOM.
const CHART_VERTEX=`#version 300 es
in vec2 aPosition;
out vec2 vUV;
void main(){vUV=aPosition*.5+.5;gl_Position=vec4(aPosition,0.,1.);}`;
const CHART_FRAGMENT=`#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform vec2 uSize;
uniform vec2 uPointer;
uniform vec2 uLens;
uniform int uKind;
uniform int uCount;
uniform int uSelected;
uniform vec2 uPoints[14];
uniform vec4 uBars[4];
uniform vec4 uValues;
uniform vec4 uLift;
uniform float uFlow;
uniform float uRefraction;
uniform float uMarkScale;
uniform float uLensRadius;
const float TAU=6.28318530718;
vec3 pigment(int i){
  if(i==1)return vec3(.25,.49,.78);
  if(i==2)return vec3(.58,.36,.72);
  if(i==3)return vec3(.78,.53,.16);
  return vec3(.12,.53,.40);
}
float box(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
float segment(vec2 p,vec2 a,vec2 b){vec2 ab=b-a;return length(p-a-ab*clamp(dot(p-a,ab)/max(dot(ab,ab),.01),0.,1.));}
float curve(vec2 p){float d=10000.;for(int i=0;i<13;i++){if(i>=uCount-1)break;d=min(d,segment(p,uPoints[i],uPoints[i+1]));}return d;}
float curveY(float x){
  float y=uPoints[0].y;
  for(int i=0;i<13;i++){if(i>=uCount-1)break;if(x>=uPoints[i].x)y=mix(uPoints[i].y,uPoints[i+1].y,clamp((x-uPoints[i].x)/max(uPoints[i+1].x-uPoints[i].x,1.),0.,1.));}
  return y;
}
float arc(vec2 p,float start,float end){
  // A rounded annular sector: curved glass with softly sealed end faces.
  float mid=(start+end)*.5,halfAngle=(end-start)*.5;
  vec2 axis=vec2(sin(mid),-cos(mid));
  vec2 q=vec2(dot(p,axis),dot(p,vec2(-axis.y,axis.x)));
  float radial=abs(length(p)-81.5)-15.5;
  float cap=abs(q.y)*cos(halfAngle)-q.x*sin(halfAngle);
  vec2 d=vec2(radial+2.,cap+2.);
  return length(max(d,0.))+min(max(d.x,d.y),0.)-2.;
}
float shape(vec2 p,out int item){
  item=0;if(uKind==0)return curve(p)-5.8*uMarkScale;
  float result=10000.,angle=0.;
  for(int i=0;i<4;i++){
    float d;
    if(uKind==1){
      float end=angle+uValues[i]*TAU,mid=(angle+end)*.5;
      vec2 lift=vec2(sin(mid),-cos(mid))*uLift[i]*4.;
      d=arc(p-vec2(120.)-lift,angle+.035,end-.035);angle=end;
    }else{
      vec4 r=uBars[i];float width=max(1.,r.z*uValues[i]);
      d=box(p-r.xy-vec2(width,r.w)*.5,vec2(width,r.w)*.5,min(width,r.w)*.5);
    }
    if(d<result){result=d;item=i;}
  }
  return result;
}
vec3 scene(vec2 p){
  vec2 uv=p/uSize;
  vec3 c=vec3(.925,.953,.942);
  c=mix(c,vec3(.71,.84,.91),exp(-length((uv-vec2(.06,.70))*vec2(2.3,2.7)))*.38);
  c=mix(c,vec3(.85,.74,.89),exp(-length((uv-vec2(.89,.06))*vec2(2.7,3.4)))*.26);
  c=mix(c,vec3(.98,.89,.66),exp(-length((uv-vec2(.86,.91))*vec2(3.0,2.8)))*.22);
  float grid=0.;
  if(uKind==0){
    vec2 spacing=vec2(576./float(max(uCount-1,1)),178./3.);
    vec2 nearest=abs(mod(p-vec2(32.,26.)+spacing*.5,spacing)-spacing*.5);
    grid=(1.-smoothstep(.35,1.,min(nearest.x,nearest.y)))*step(31.,p.x)*step(p.x,609.)*step(25.,p.y)*step(p.y,205.);
  }else if(uKind==1){
    vec2 q=p-vec2(120.);float radius=length(q);
    float rings=abs(mod(radius+12.,24.)-12.);
    float spoke=abs(sin(atan(q.y,q.x)*12.))*radius;
    grid=max(1.-smoothstep(.25,.75,rings),(1.-smoothstep(.3,.7,spoke))*.42)*smoothstep(37.,46.,radius)*(1.-smoothstep(111.,119.,radius));
  }else{
    for(int i=0;i<4;i++){
      vec4 r=uBars[i];vec2 q=p-r.xy;
      float tick=abs(mod(q.x+r.z*.05,r.z*.1)-r.z*.05);
      float inside=step(0.,q.x)*step(q.x,r.z)*step(-5.,q.y)*step(q.y,r.w+5.);
      grid=max(grid,(1.-smoothstep(.3,.8,tick))*inside*.7);
    }
  }
  c=mix(c,vec3(.40,.56,.54),grid*.23);
  return c;
}
vec3 plotScene(vec2 p){
  vec3 c=scene(p);
  if(uKind==0){
    float area=step(32.,p.x)*step(p.x,608.)*step(curveY(p.x),p.y)*step(p.y,204.);
    c=mix(c,pigment(max(0,uSelected)),area*.12*(1.-.6*clamp((p.y-curveY(p.x))/100.,0.,1.)));
  }
  return c;
}
vec3 glass(vec2 p,float d,vec2 n,int item,bool lens){
  vec3 tint=pigment(item);float bevel=lens?10.:(uKind==0?5.8*uMarkScale:9.);
  float edge=clamp(1.+d/bevel,0.,1.);
  vec2 normalXY=n*pow(edge,1.5)*.93;
  vec3 normal=vec3(normalXY,sqrt(max(.001,1.-dot(normalXY,normalXY))));
  vec3 ray=refract(vec3(0.,0.,-1.),normal,1./1.45);
  vec2 at=p+ray.xy/max(-ray.z,.08)*(lens?24.:21.)*uRefraction;
  if(lens)at=uLens+(p-uLens)/1.65+(at-p)*.22;
  vec3 c=plotScene(at);
  if(lens){float ink=1.-smoothstep(3.8,5.2,curve(at));c=mix(c,pigment(max(uSelected,0)),ink*.68);}
  float split=pow(edge,2.)*.9*uRefraction;
  c.r+= (plotScene(at+n*split).r-plotScene(at).r)*.8;
  c.b+= (plotScene(at-n*split).b-plotScene(at).b)*.8;
  float localY;
  if(uKind==2)localY=(p.y-uBars[item].y)/max(uBars[item].w,1.);
  else if(uKind==1)localY=.5+(length(p-vec2(120.))-81.5)/31.;
  else localY=.5+(p.y-curveY(p.x))/(12.*uMarkScale);
  float motion=uFlow<1.?sin(uFlow*TAU):0.;
  float meniscus=.51+sin(p.x*.053+motion*2.)*.08;
  float liquid=smoothstep(meniscus-.10,meniscus+.07,localY);
  float focus=uSelected<0||uSelected==item?1.:.36;
  c=mix(c,tint,((lens?.06:.14)+liquid*(lens?.08:.30))*focus);
  // Colored absorption grows at the edge; the center stays transmissive.
  c*=1.-pow(edge,3.)*.18;
  vec2 light=normalize(uPointer-p+vec2(-65.,-120.));
  float lit=pow(max(dot(n,light),0.),5.),back=pow(max(dot(n,-light),0.),7.);
  float rim=exp(-pow((d+.7)/.8,2.));
  c+=rim*(vec3(.22)+vec3(.76)*lit+tint*back*.35);
  c+=exp(-pow((d+2.8)/1.1,2.))*back*vec3(.36,.42,.36);
  c-=exp(-pow((d+1.9)/.7,2.))*max(dot(n,vec2(.4,.91)),0.)*.11;
  float surface=exp(-pow((localY-.25)/.16,2.));
  c+=surface*(lens?.025:.085)*vec3(.94,1.,.99);
  float caustic=exp(-pow((localY-meniscus-.10)/.035,2.));
  c+=caustic*.06*focus;
  float along=uKind==1?fract((atan(p.x-120.,120.-p.y)+TAU)/TAU):(uKind==2?(p.x-uBars[item].x)/max(uBars[item].z*uValues[item],1.):p.x/640.);
  float beam=exp(-pow((along-uFlow)/.085,2.))*sin(clamp(uFlow,0.,1.)*3.14159);
  c+=beam*(pow(edge,2.)*.46+liquid*.06)*mix(tint,vec3(1.),.65)*focus;
  return c;
}
void main(){
  vec2 p=vec2(vUV.x,1.-vUV.y)*uSize;
  vec3 c=plotScene(p);int item,unused;
  float d=shape(p,item),shadow=shape(p-vec2(0.,4.),unused);
  c*=1.-exp(-max(shadow,0.)/4.)*.16*smoothstep(-.5,1.,d);
  if(d<1.2){
    float e=.45;vec2 n=normalize(vec2(shape(p+vec2(e,0.),unused)-shape(p-vec2(e,0.),unused),shape(p+vec2(0.,e),unused)-shape(p-vec2(0.,e),unused))+vec2(.00001));
    c=mix(c,glass(p,d,n,uKind==0?max(uSelected,0):item,false),1.-smoothstep(-.6,.9,d));
  }
  if(uKind==0){
    vec2 q=p-uLens;float lens=length(q)-uLensRadius;
    c*=1.-exp(-max(length(q-vec2(0.,5.))-uLensRadius,0.)/5.)*.12*smoothstep(0.,2.,lens);
    if(lens<1.2)c=mix(c,glass(p,lens,normalize(q+vec2(.001)),max(uSelected,0),true),1.-smoothstep(-.6,.9,lens));
    vec2 source=uLens-vec2(uLensRadius*.6);float glow=exp(-length(p-source)/5.5)*.18;
    c+=mix(pigment(max(uSelected,0)),vec3(1.),.7)*glow;
  }else{
    vec2 source;
    if(uKind==1){float a=0.;for(int i=0;i<4;i++){float mid=a+uValues[i]*TAU*.68;source=vec2(120.)+vec2(sin(mid),-cos(mid))*81.5;float strength=uSelected<0?.11:(uSelected==i?.24:.025);c+=mix(pigment(i),vec3(1.),.6)*exp(-length(p-source)/7.)*strength;a+=uValues[i]*TAU;}}
    else for(int i=0;i<4;i++){vec4 r=uBars[i];source=r.xy+vec2(r.z*uValues[i]-min(r.w,r.z*uValues[i])*.52,r.w*.5);c+=mix(pigment(i),vec3(1.),.65)*exp(-length(p-source)/6.)*(uSelected==i?.26:.12);}
  }
  outColor=vec4(clamp(c,0.,1.),1.);
}`;

export class ChartGlass {
  constructor(host,{kind='line',measure}={}){
    this.host=host;this.kind={line:0,ring:1,bars:2}[kind];this.measure=measure;
    this.abort=new AbortController();this.frame=0;this.visible=true;this.destroyed=false;this.ready=false;
    this.values=new Float32Array([.42,.18,.30,.10]);this.targetValues=new Float32Array(this.values);this.lift=new Float32Array(4);this.points=new Float32Array(28);this.targetPoints=new Float32Array(28);this.rects=new Float32Array(16);
    this.targetLens=[608,60];this.lens=[608,60];this.pointer=[0,0];this.count=0;this.selected=-1;this.flowStart=-Infinity;this.refraction=1;
    this.canvas=document.createElement('canvas');this.canvas.className='viz-glass-canvas';this.canvas.setAttribute('aria-hidden','true');host.prepend(this.canvas);
    const signal=this.abort.signal;this.motion=matchMedia('(prefers-reduced-motion: reduce)');
    this.gl=null;this.suspended=true;this.canvas.hidden=true;this.canvas.dataset.gpuState='idle';
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);
    this.intersectionObserver=new IntersectionObserver(([entry])=>{this.visible=entry.isIntersecting;if(this.visible)this.request();else{cancelAnimationFrame(this.frame);this.frame=0;}},{rootMargin:'80px'});this.intersectionObserver.observe(host);
    host.addEventListener('pointermove',event=>{const rect=host.getBoundingClientRect();this.pointer=[(event.clientX-rect.left)/rect.width*this.width,(event.clientY-rect.top)/rect.height*this.height];this.request();},{signal,passive:true});
    this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.lossObserved=true;this.fallback();if(this.gpuLease?.active)this.resumeGPU();},{signal});
    this.canvas.addEventListener('webglcontextrestored',()=>{this.lossObserved=false;if(this.destroyed||!this.gpuLease?.active){this.contextExtension?.loseContext();return;}this.startGPU();},{signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(this.frame);this.frame=0;}else this.request();},{signal});
    this.motion.addEventListener('change',()=>this.request(),{signal});this.resize();
    this.gpuLease=observeGPU(host,()=>this.resumeGPU(),()=>this.suspendGPU());
  }
  resumeGPU(){
    if(this.destroyed)return;
    if(this.gl?.isContextLost()){if(this.lossObserved)this.contextExtension?.restoreContext();return;}
    this.startGPU();
  }
  startGPU(){
    try{
      const gl=this.gl ||= this.canvas.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:true});if(!gl)throw new Error('WebGL2 unavailable');
      this.contextExtension=gl.getExtension('WEBGL_lose_context');
      const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(error);}return shader;};
      const vertex=compile(gl.VERTEX_SHADER,CHART_VERTEX),fragment=compile(gl.FRAGMENT_SHADER,CHART_FRAGMENT),program=this.program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
      this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.useProgram(program);const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      this.uniforms=Object.fromEntries(['uSize','uPointer','uLens','uKind','uCount','uSelected','uPoints','uBars','uValues','uLift','uFlow','uRefraction','uMarkScale','uLensRadius'].map(name=>[name,gl.getUniformLocation(program,name)]));
      this.suspended=false;this.ready=true;this.canvas.hidden=false;this.canvas.dataset.gpuState='active';this.lastTime=0;this.resize();this.request();
    }catch(error){this.error=error.message;this.fallback();}
  }
  suspendGPU(){this.suspended=true;this.canvas.dataset.gpuState='suspended';this.fallback();if(this.gl&&!this.gl.isContextLost())this.contextExtension?.loseContext();}
  fallback(){this.ready=false;this.host.dataset.glassReady='false';this.canvas.hidden=true;cancelAnimationFrame(this.frame);this.frame=0;}
  resize(){
    if(this.destroyed)return;const rect=this.host.getBoundingClientRect();
    this.width=this.kind===0?640:this.kind===1?240:Math.max(1,rect.width);this.height=this.kind===0?230:this.kind===1?240:Math.max(1,rect.height);
    this.markScale=Math.min(1.5,Math.max(1,this.width/Math.max(rect.width,1)));this.lensRadius=Math.min(30,Math.max(20,20*this.width/Math.max(rect.width,1)));
    const ratio=Math.min(devicePixelRatio||1,1.5);this.canvas.width=Math.max(1,Math.round(rect.width*ratio));this.canvas.height=Math.max(1,Math.round(rect.height*ratio));
    if(this.measure)this.rects.set(this.measure().flat());this.request();
  }
  set({points,values,selected=this.selected,lens,animate=false,refraction=this.refraction}={}){
    if(this.destroyed)return;
    if(points){const count=Math.min(14,points.length);this.targetPoints.fill(0);points.slice(0,14).forEach((p,i)=>{this.targetPoints[i*2]=p.x;this.targetPoints[i*2+1]=p.y;});if(!animate||count!==this.count)this.points.set(this.targetPoints);this.count=count;}
    if(values){this.targetValues.set(values);if(!animate)this.values.set(values);}
    if(lens){this.targetLens=[lens.x,lens.y];if(!this.hasLens||this.motion.matches){this.lens=[...this.targetLens];this.hasLens=true;}}
    if(animate&&!this.motion.matches)this.flowStart=performance.now();
    this.selected=selected;this.refraction=refraction;this.request();
  }
  request(){if(this.frame||!this.ready||this.destroyed||!this.visible||document.hidden)return;this.frame=requestAnimationFrame(now=>{this.frame=0;this.render(now);});}
  render(now=performance.now()){
    if(!this.ready||this.destroyed||!this.visible||document.hidden)return;
    const dt=Math.min(.05,Math.max(.001,(now-(this.lastTime||now-16))/1000));this.lastTime=now;
    const factor=this.motion.matches?1:1-Math.exp(-dt*18);let moving=false;
    for(let i=0;i<this.count*2;i++){this.points[i]+=(this.targetPoints[i]-this.points[i])*factor;moving||=Math.abs(this.targetPoints[i]-this.points[i])>.03;}
    for(let i=0;i<4;i++){this.values[i]+=(this.targetValues[i]-this.values[i])*factor;moving||=Math.abs(this.targetValues[i]-this.values[i])>.0001;}
    for(let i=0;i<2;i++){this.lens[i]+=(this.targetLens[i]-this.lens[i])*factor;moving||=Math.abs(this.targetLens[i]-this.lens[i])>.08;}
    for(let i=0;i<4;i++){const target=i===this.selected?1:0;this.lift[i]+=(target-this.lift[i])*factor;moving||=Math.abs(target-this.lift[i])>.002;}
    const flow=this.motion.matches?1:Math.min(1,(now-this.flowStart)/950),gl=this.gl,u=this.uniforms;
    gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.useProgram(this.program);
    gl.uniform2f(u.uSize,this.width,this.height);gl.uniform2fv(u.uPointer,this.pointer);gl.uniform2fv(u.uLens,this.lens);gl.uniform1i(u.uKind,this.kind);gl.uniform1i(u.uCount,this.count);gl.uniform1i(u.uSelected,this.selected);gl.uniform2fv(u.uPoints,this.points);gl.uniform4fv(u.uBars,this.rects);gl.uniform4fv(u.uValues,this.values);gl.uniform4fv(u.uLift,this.lift);gl.uniform1f(u.uFlow,flow);gl.uniform1f(u.uRefraction,this.refraction);gl.uniform1f(u.uMarkScale,this.markScale);gl.uniform1f(u.uLensRadius,this.lensRadius);gl.drawArrays(gl.TRIANGLES,0,6);
    this.host.dataset.glassReady='true';if(moving||flow<1)this.request();
  }
  destroy(){
    if(this.destroyed)return;this.destroyed=true;cancelAnimationFrame(this.frame);this.frame=0;this.abort.abort();this.resizeObserver?.disconnect();this.intersectionObserver?.disconnect();
    this.gpuLease?.destroy();
    if(this.gl){this.gl.deleteBuffer(this.buffer);this.gl.deleteProgram(this.program);this.contextExtension?.loseContext();}
    delete this.host.dataset.glassReady;this.canvas.remove();
  }
}
