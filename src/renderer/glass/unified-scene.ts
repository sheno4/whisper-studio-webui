import {GLASS_SHAPE_LIMIT,UNIFIED_GLASS_FRAGMENT,UNIFIED_GLASS_VERTEX} from './unified-shader';
import {setUnifiedGlassReady} from './capabilities';
import type {LiveMaterialSample} from './live-material';

export type GlassPoint={x:number;y:number};
export type GlassRect=GlassPoint&{width:number;height:number};
/** Compatibility name only: WebGL no longer owns any optical backdrop. */
export type GlassOwnership='gpu'|'fallback';
export interface UnifiedGlassNode {
  element:HTMLElement;owner:string;group?:string;host?:HTMLElement;source?:HTMLElement|'page';
  /** Presentation geometry in viewport CSS pixels, never device pixels. */
  rect?:GlassRect;captureBounds?:GlassRect;radius?:number;role?:'surface'|'indicator'|'menu'|'thumb';
  pressure?:number;bend?:GlassPoint;velocity?:GlassPoint;open?:number;origin?:GlassPoint;tint?:[number,number,number,number];active?:boolean;
  /** Former GPU-only proxy. It now paints a real browser-backdrop satellite. */
  synthetic?:boolean;transient?:boolean;sample?:LiveMaterialSample;onOwnership?:(owner:GlassOwnership)=>void;
}
export type UnifiedGlassPatch=Partial<Omit<UnifiedGlassNode,'element'|'owner'>>;
export interface UnifiedGlassHandle {update(patch:UnifiedGlassPatch):void;unregister():void;}
type Entry={node:UnifiedGlassNode;order:number;abort:AbortController;group:Group;visible:boolean};
type Geometry={local:GlassRect;world:GlassRect;sx:number;sy:number;entries:{entry:Entry;rect:GlassRect}[]};
type GPU={canvas:HTMLCanvasElement;slot:HTMLSpanElement;gl:WebGL2RenderingContext;program:WebGLProgram;buffer:WebGLBuffer;uniforms:Map<string,WebGLUniformLocation|null>};
type Group={id:string;host:HTMLElement;entries:Set<Entry>;transient:boolean;admitted:boolean;blocked:boolean;gpu:GPU|null;dirty:boolean;geometry:Geometry|null;abort:AbortController;resize:ResizeObserver;pixels:number;};
const MAX_CONTEXTS=4,MAX_CANVAS_PIXELS=196_608,PIXELS_PER_GROUP=49_152,MAX_GROUP_AREA=240_000;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const rectOf=(element:HTMLElement):GlassRect=>{const r=element.getBoundingClientRect();return{x:r.left,y:r.top,width:r.width,height:r.height};};
const hostOf=(node:UnifiedGlassNode)=>node.host??(node.source instanceof HTMLElement?node.source:node.element.parentElement)??node.element;
const sourceOf=(entry:Entry)=>entry.node.source instanceof HTMLElement?entry.node.source:entry.group.host;
const disabled=(entry:Entry)=>sourceOf(entry).matches(':disabled')||Boolean(sourceOf(entry).closest('[inert],[hidden],[aria-disabled="true"]'));
const neutral:LiveMaterialSample={pointer:{x:0,y:0},pressure:0,energy:0,bend:{x:0,y:0},velocity:{x:0,y:0},engaged:false,reduced:false,intensity:.8};

/** Stable, bounded local lighting. This class never captures DOM, allocates a
 * background texture, listens for its own pointer physics, reparents a canvas,
 * or runs an idle ticker. Native rdev/CSS is the only background optical path. */
class UnifiedGlassScene {
  private entries=new Map<string,Entry>();
  private groups=new Set<Group>();
  private sequence=0;
  private frame=0;
  private intensity=.8;
  private abort:AbortController|null=null;
  private media:MediaQueryList[]=[];
  private stats={captures:0,uploads:0,draws:0,failures:0};
  private lastFailure:string|null=null;

  register(node:UnifiedGlassNode):UnifiedGlassHandle {
    this.unregister(node.owner);this.install();
    const host=hostOf(node),id=node.group??node.owner;
    let group=[...this.groups].find(item=>item.id===id&&item.host===host);
    if(!group){
      const transient=node.transient??(node.role==='menu'||Boolean(host.closest('[role="listbox"],[role="menu"]')));
      const occupied=[...this.groups].filter(item=>item.admitted);
      const freeLens=node.role==='indicator'||node.role==='thumb';
      const structuralWidth=host.clientWidth+(freeLens?104:48),structuralHeight=host.clientHeight+(freeLens?136:48);
      // Reserve the two steady lighting groups for moving lenses that benefit
      // from a shared SDF. Ordinary buttons/toolbars already have persistent
      // native glint/shadow and cannot consume those slots on first mount.
      const eligible=(transient||freeLens)&&structuralWidth*structuralHeight<=MAX_GROUP_AREA&&structuralWidth<=1200&&structuralHeight<=1000;
      const admitted=eligible&&occupied.length<MAX_CONTEXTS&&occupied.filter(item=>item.transient===transient).length<2&&getComputedStyle(host).position!=='static';
      const abort=new AbortController();
      group={id,host,entries:new Set(),transient,admitted,blocked:false,gpu:null,dirty:true,geometry:null,abort,resize:new ResizeObserver(()=>{group!.dirty=true;this.wake();}),pixels:0};
      group.resize.observe(host);
      const invalidate=()=>{group!.dirty=true;this.wake();};
      // Local scroll and window movement are geometry invalidations only.
      window.addEventListener('scroll',invalidate,{signal:abort.signal,capture:true,passive:true});
      window.addEventListener('resize',invalidate,{signal:abort.signal,passive:true});
      this.groups.add(group);
    }
    const entry:Entry={node:{...node},order:++this.sequence,abort:new AbortController(),group,visible:true};
    this.entries.set(node.owner,entry);group.entries.add(entry);group.resize.observe(node.element);
    const source=sourceOf(entry);
    source.addEventListener('lg:material',event=>{
      if(event.target!==source&&(!(event.target instanceof Node)||!event.target.contains(entry.node.element)))return;
      const detail=(event as CustomEvent<UnifiedGlassPatch>).detail;if(!detail)return;
      // Pressure/bend/velocity are consumed once by createLiveMaterial. This
      // geometry adapter does not run another pressure/decay/input model.
      const patch:UnifiedGlassPatch={};
      for(const key of ['rect','captureBounds','radius','open','origin','active'] as const)if(detail[key]!==undefined)Object.assign(patch,{[key]:detail[key]});
      if(Object.keys(patch).length)this.update(node.owner,patch);
    },{signal:entry.abort.signal});
    node.onOwnership?.('fallback');
    node.element.dataset.studioLighting=group.admitted?'pending':'capacity';
    group.dirty=true;this.wake();
    return{update:patch=>this.update(node.owner,patch),unregister:()=>this.unregister(node.owner)};
  }

  update(owner:string,patch:UnifiedGlassPatch):void {
    const entry=this.entries.get(owner);if(!entry)return;
    entry.node={...entry.node,...patch};entry.group.dirty=true;this.wake();
  }
  unregister(owner:string):void {
    const entry=this.entries.get(owner);if(!entry)return;
    entry.abort.abort();delete entry.node.element.dataset.studioLighting;
    entry.group.resize.unobserve(entry.node.element);entry.group.entries.delete(entry);this.entries.delete(owner);
    if(!entry.group.entries.size)this.disposeGroup(entry.group);else{entry.group.dirty=true;this.wake();}
    if(!this.entries.size)this.dispose();
  }
  setIntensity(value:number):void {this.intensity=clamp(Number.isFinite(value)?value:.8,0,1);for(const group of this.groups)group.dirty=true;this.wake();}
  /** Legacy diagnostic counters intentionally remain zero for capture/upload. */
  getSnapshot(){
    const gpuGroups=[...this.groups].filter(group=>group.gpu),geometry=gpuGroups[0]?.geometry;
    return{mode:'native-backdrop-with-studio-lighting',backgroundOptics:'browser-native',fusedBackgroundRefraction:false,activeGroup:null,activeOwner:null,ready:gpuGroups.some(group=>!group.blocked&&!group.gpu!.slot.hidden&&group.pixels>0),blocked:[...this.groups].some(group=>group.blocked),contextCount:gpuGroups.length,pendingFrame:Boolean(this.frame),backgroundDirty:false,geometryDirty:[...this.groups].some(group=>group.dirty),backgroundAnimations:0,videoSubscriptions:0,captureInterval:0,generation:this.sequence,intensity:this.intensity,pressure:Math.max(0,...[...this.entries.values()].map(entry=>entry.node.sample?.pressure??0)),mergeRate:7,rasterPixels:0,canvasPixels:gpuGroups.reduce((sum,group)=>sum+group.pixels,0),bounds:geometry?.local??null,worldBounds:geometry?.world??null,stats:{...this.stats},lastFailure:this.lastFailure,shapes:[...this.groups].flatMap(group=>group.geometry?.entries.map(({entry,rect})=>({owner:entry.node.owner,group:group.id,role:entry.node.role??'surface',rect:{...rect},radius:entry.node.radius??16,pressure:entry.node.sample?.pressure??0,open:entry.node.open??1,origin:entry.node.origin??null,explicitRect:Boolean(entry.node.rect),ownership:'native',lighting:entry.node.element.dataset.studioLighting}))??[]),registered:[...this.entries.values()].map(entry=>({owner:entry.node.owner,group:entry.group.id,role:entry.node.role??'surface',ownership:'native',visible:entry.visible,active:entry.node.active!==false,lighting:entry.node.element.dataset.studioLighting}))};
  }
  private install():void {
    if(this.abort)return;this.abort=new AbortController();const signal=this.abort.signal;
    this.media=[matchMedia('(prefers-reduced-transparency: reduce)'),matchMedia('(prefers-contrast: more)'),matchMedia('(forced-colors: active)')];
    const changed=()=>{for(const group of this.groups)group.dirty=true;if(document.hidden){if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;for(const group of this.groups)if(group.gpu)group.gpu.slot.hidden=true;this.ready();}else this.wake();};
    this.media.forEach(query=>query.addEventListener('change',changed,{signal}));
    document.addEventListener('visibilitychange',changed,{signal});
    const preference=new MutationObserver(changed);preference.observe(document.documentElement,{attributes:true,attributeFilter:['data-material']});
    signal.addEventListener('abort',()=>preference.disconnect(),{once:true});
  }
  private allowed():boolean {
    const material=document.documentElement.dataset.material;
    return !document.hidden&&this.intensity>0&&material!=='solid'&&!this.media.some((query,index)=>query.matches&&(index>0||material!=='glass'));
  }
  private wake():void {if(!document.hidden&&this.entries.size&&!this.frame)this.frame=requestAnimationFrame(this.tick);}
  private geometry(group:Group):Geometry|null {
    const host=group.host,box=host.getBoundingClientRect();
    if(!host.isConnected||box.width<1||box.height<1||box.bottom<=0||box.right<=0||box.top>=innerHeight||box.left>=innerWidth)return null;
    const sx=box.width/Math.max(1,host.offsetWidth),sy=box.height/Math.max(1,host.offsetHeight);
    const entries=[...group.entries].filter(entry=>entry.node.element.isConnected&&entry.node.active!==false&&entry.node.open!==0&&!disabled(entry)).slice(0,GLASS_SHAPE_LIMIT).map(entry=>{
      // For an explicit presentation rect, undo the host transform once.
      const r=entry.node.rect??rectOf(entry.node.element);
      return{entry,rect:{x:(r.x-box.left)/sx-host.clientLeft,y:(r.y-box.top)/sy-host.clientTop,width:r.width/sx,height:r.height/sy}};
    }).filter(item=>item.rect.width>.5&&item.rect.height>.5);
    if(!entries.length)return null;
    const freeLens=entries.every(({entry})=>entry.node.role==='indicator'||entry.node.role==='thumb');
    const mx=freeLens?52:24,my=freeLens?68:24;
    let left=-mx,top=-my,right=host.clientWidth+mx,bottom=host.clientHeight+my;
    const clip=(x:number,y:number,width:number,height:number)=>{
      left=Math.max(left,(x-box.left)/sx-host.clientLeft);top=Math.max(top,(y-box.top)/sy-host.clientTop);
      right=Math.min(right,(x+width-box.left)/sx-host.clientLeft);bottom=Math.min(bottom,(y+height-box.top)/sy-host.clientTop);
    };
    clip(0,0,innerWidth,innerHeight);
    // Clip only this later lighting decoration to the nearest scroll/paint
    // boundaries. Native lenses remain outside this subtree and retain lift.
    for(let ancestor=host.parentElement;ancestor;ancestor=ancestor.parentElement){
      const style=getComputedStyle(ancestor),clipX=/auto|scroll|hidden|clip/.test(style.overflowX),clipY=/auto|scroll|hidden|clip/.test(style.overflowY);
      if(!clipX&&!clipY)continue;
      const r=ancestor.getBoundingClientRect(),ax=r.width/Math.max(1,ancestor.offsetWidth),ay=r.height/Math.max(1,ancestor.offsetHeight);
      const x=r.left+ancestor.clientLeft*ax,y=r.top+ancestor.clientTop*ay;
      if(clipX){left=Math.max(left,(x-box.left)/sx-host.clientLeft);right=Math.min(right,(x+ancestor.clientWidth*ax-box.left)/sx-host.clientLeft);}
      if(clipY){top=Math.max(top,(y-box.top)/sy-host.clientTop);bottom=Math.min(bottom,(y+ancestor.clientHeight*ay-box.top)/sy-host.clientTop);}
    }
    const local={x:left,y:top,width:right-left,height:bottom-top};
    if(local.width<=0||local.height<=0)return null;
    if(local.width*local.height>MAX_GROUP_AREA||local.width>1200||local.height>1000)return null;
    return{local,world:{x:box.left+(local.x+host.clientLeft)*sx,y:box.top+(local.y+host.clientTop)*sy,width:local.width*sx,height:local.height*sy},sx,sy,entries};
  }
  private positionSatellites(group:Group):void {
    for(const entry of group.entries){
      const {node}=entry;if(!node.synthetic)continue;
      const r=node.rect,parent=node.element.parentElement;
      if(!r||!parent){node.element.hidden=true;continue;}
      const box=parent.getBoundingClientRect(),sx=parent.offsetWidth?box.width/parent.offsetWidth:1,sy=parent.offsetHeight?box.height/parent.offsetHeight:1;
      node.element.hidden=node.active===false||(node.open??1)<=.025||r.width<.5||r.height<.5;
      // Absolute decoration only; explicit local dimensions keep its real
      // browser backdrop in the same geometry as the Studio lighting field.
      node.element.style.inset='auto';node.element.style.left=`${(r.x-box.left)/(sx||1)-parent.clientLeft}px`;node.element.style.top=`${(r.y-box.top)/(sy||1)-parent.clientTop}px`;
      node.element.style.width=`${Math.max(0,r.width/(sx||1))}px`;node.element.style.height=`${Math.max(0,r.height/(sy||1))}px`;node.element.style.borderRadius=`${node.radius??999}px`;
    }
  }
  private initGPU(group:Group):GPU|null {
    if(group.blocked||!group.admitted)return null;if(group.gpu)return group.gpu;
    const canvas=document.createElement('canvas'),slot=document.createElement('span');slot.className='unified-glass-slot';slot.setAttribute('aria-hidden','true');slot.setAttribute('data-liquid-ignore','');
    // This zero-area later sibling contains lighting only. Layout containment
    // with visible overflow makes the canvas's extended bounds decorative ink,
    // so they cannot enlarge an ancestor form's scrollable area. Native lenses
    // remain siblings: no material ancestor gets clipping/mask/opacity/filter.
    // Light paints after the z=1 native lenses, outside their backdrop input.
    slot.style.cssText='position:absolute;left:0;top:0;width:0;height:0;z-index:2;pointer-events:none;overflow:visible;contain:layout style;';
    canvas.className='unified-glass-canvas';canvas.setAttribute('aria-hidden','true');canvas.setAttribute('data-liquid-ignore','');canvas.style.cssText='position:absolute;pointer-events:none;display:block;max-width:none;max-height:none;';slot.append(canvas);
    const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
    if(!gl){group.blocked=true;return null;}
    const shaders:WebGLShader[]=[];let program:WebGLProgram|null=null;
    try{
      for(const [kind,source] of [[gl.VERTEX_SHADER,UNIFIED_GLASS_VERTEX],[gl.FRAGMENT_SHADER,UNIFIED_GLASS_FRAGMENT]] as const){const shader=gl.createShader(kind);if(!shader)throw new Error('Could not allocate lighting shader.');shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader)??'Studio lighting shader failed.');}
      program=gl.createProgram();if(!program)throw new Error('Could not allocate lighting program.');shaders.forEach(shader=>gl.attachShader(program!,shader));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??'Studio lighting link failed.');
      const buffer=gl.createBuffer();if(!buffer)throw new Error('Could not allocate lighting geometry.');
      gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
      const position=gl.getAttribLocation(program,'a_position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);gl.disable(gl.BLEND);gl.clearColor(0,0,0,0);
      group.gpu={canvas,slot,gl,program,buffer,uniforms:new Map()};group.host.append(slot);
      canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();group.blocked=true;slot.hidden=true;for(const entry of group.entries)entry.node.element.dataset.studioLighting='context-lost';this.ready();},{signal:group.abort.signal});
      return group.gpu;
    }catch(error){if(program)gl.deleteProgram(program);group.blocked=true;this.stats.failures++;this.lastFailure=error instanceof Error?error.message:String(error);gl.getExtension('WEBGL_lose_context')?.loseContext();return null;}
    finally{shaders.forEach(shader=>gl.deleteShader(shader));}
  }
  private tick=():void=>{
    this.frame=0;
    // Read every group before writing satellite layout or GPU canvas styles.
    const batch=[...this.groups].filter(group=>group.dirty);
    const allowed=this.allowed();
    for(const group of batch){group.geometry=this.geometry(group);group.dirty=false;}
    for(const group of batch){
      this.positionSatellites(group);
      const geometry=group.geometry;
      if(!allowed||!geometry){if(group.gpu)group.gpu.slot.hidden=true;for(const entry of group.entries)entry.node.element.dataset.studioLighting=group.admitted?'suspended':'capacity';continue;}
      const gpu=this.initGPU(group);if(!gpu){if(group.blocked)for(const entry of group.entries)entry.node.element.dataset.studioLighting='unavailable';continue;}
      gpu.slot.hidden=false;
      try{this.draw(group,geometry);}catch(error){group.blocked=true;gpu.slot.hidden=true;this.stats.failures++;this.lastFailure=error instanceof Error?error.message:String(error);for(const entry of group.entries)entry.node.element.dataset.studioLighting='unavailable';}
    }
    this.ready();
  };
  private draw(group:Group,geometry:Geometry):void {
    const gpu=group.gpu!;const{gl,canvas,program}=gpu,{local,entries}=geometry;
    const scale=Math.min(devicePixelRatio||1,1.5,Math.sqrt(PIXELS_PER_GROUP/(local.width*local.height)));
    const width=Math.max(1,Math.floor(local.width*scale)),height=Math.max(1,Math.floor(local.height*scale));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    canvas.style.left=`${local.x}px`;canvas.style.top=`${local.y}px`;canvas.style.width=`${local.width}px`;canvas.style.height=`${local.height}px`;group.pixels=width*height;
    gl.viewport(0,0,width,height);gl.useProgram(program);gl.clear(gl.COLOR_BUFFER_BIT);
    const uniform=(name:string)=>{if(!gpu.uniforms.has(name))gpu.uniforms.set(name,gl.getUniformLocation(program,name));return gpu.uniforms.get(name)!;};
    const f=(name:string,value:number)=>gl.uniform1f(uniform(name),value);
    const rects=new Float32Array(GLASS_SHAPE_LIMIT*4),shapes=new Float32Array(GLASS_SHAPE_LIMIT*4),lights=new Float32Array(GLASS_SHAPE_LIMIT*4);
    let hasBody=false,hasDetail=false,pressure=0;
    const engaged=entries.filter(({entry})=>entry.node.sample?.engaged).sort((a,b)=>sourceOf(a.entry).contains(sourceOf(b.entry))?1:sourceOf(b.entry).contains(sourceOf(a.entry))?-1:b.entry.order-a.entry.order)[0]?.entry;
    for(let index=0;index<entries.length;index++){
      const {entry,rect}=entries[index],node=entry.node,sample=node.sample??neutral,offset=index*4;
      rects.set([rect.x-local.x+rect.width/2,local.height-(rect.y-local.y+rect.height/2),rect.width,rect.height],offset);
      const detail=node.role==='indicator'||node.role==='thumb';hasBody||=!detail;hasDetail||=detail;pressure=Math.max(pressure,sample.pressure);
      shapes.set([node.radius??16,sample.pressure,node.open??1,detail?2:0],offset);
      // Nested sources do not compete over this group's lighting direction.
      const direction=engaged?.node.sample??sample;
      const motionX=direction.reduced?0:clamp(direction.bend.x/12,-1,1)*.12+clamp(direction.velocity.x/1800,-1,1)*.08;
      const motionY=direction.reduced?0:clamp(direction.bend.y/12,-1,1)*.12+clamp(direction.velocity.y/1800,-1,1)*.08;
      lights.set([direction.pointer.x+motionX,direction.pointer.y+motionY,sample.energy,this.intensity],offset);
    }
    gl.uniform2f(uniform('u_resolution'),width,height);f('u_dpr',scale);gl.uniform1i(uniform('u_count'),entries.length);gl.uniform1i(uniform('u_hasBody'),hasBody?1:0);gl.uniform1i(uniform('u_hasDetail'),hasDetail?1:0);
    gl.uniform4fv(uniform('u_rects[0]'),rects);gl.uniform4fv(uniform('u_shape[0]'),shapes);gl.uniform4fv(uniform('u_light[0]'),lights);
    f('u_mergeRate',7+pressure*4);f('u_refFresnelRange',18);f('u_refFresnelFactor',.55);f('u_refFresnelHardness',0);f('u_glareRange',18);f('u_glareConvergence',.6);f('u_glareOppositeFactor',.42);f('u_glareFactor',.55);f('u_glareHardness',0);
    const direction=engaged?.node.sample??neutral;f('u_glareAngle',Math.PI/4+direction.pointer.x*.35+direction.pointer.y*.2);
    gl.drawArrays(gl.TRIANGLES,0,6);if(gl.isContextLost())throw new Error('Studio lighting context lost.');if(!this.stats.draws&&gl.getError()!==gl.NO_ERROR)throw new Error('Studio lighting first draw failed.');this.stats.draws++;
    for(const {entry} of entries)entry.node.element.dataset.studioLighting='available';
  }
  private ready():void {setUnifiedGlassReady([...this.groups].some(group=>group.gpu&&!group.blocked&&!group.gpu.slot.hidden&&group.pixels>0),'studio-transparent-lighting');}
  private disposeGroup(group:Group):void {
    group.abort.abort();group.resize.disconnect();
    if(group.gpu){const{gl,program,buffer,slot}=group.gpu;slot.remove();gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();}
    this.groups.delete(group);
  }
  dispose():void {if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;for(const group of [...this.groups])this.disposeGroup(group);this.entries.clear();this.abort?.abort();this.abort=null;this.media=[];setUnifiedGlassReady(false,'not-mounted');}
}

export const unifiedGlassScene=new UnifiedGlassScene();
export const STUDIO_LIGHTING_BUDGET={contexts:MAX_CONTEXTS,pixels:MAX_CANVAS_PIXELS} as const;
