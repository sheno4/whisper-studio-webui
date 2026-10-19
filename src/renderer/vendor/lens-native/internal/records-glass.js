import {GlassRenderer} from './renderer.js';

/** The original material, sampling a quiet ruled-paper scene behind the records. */
export class RecordsGlass extends GlassRenderer {
  constructor(canvas, stage) {
    super(canvas, stage, {scene:'records', motion:false, brightness:1,
      onState:state => {if(state === 'lost')canvas.hidden = true;}});
    this.showFallback();
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    media.addEventListener('change', event => {
      this.reducedMotion = event.matches;
      this.invalidate();
    }, {signal:this.abort.signal});
  }

  showFallback() {
    this.canvas.hidden=true;
    this.stage.classList.remove('webgl-ready');
    this.stage.classList.add('fallback');
  }

  resize() {
    const width=this.width,height=this.height;
    super.resize();
    // Resizing clears the drawing buffer. Keep the readable CSS material until
    // a visible frame has actually been painted, including detached remounts.
    if(width!==this.width||height!==this.height)this.showFallback();
  }

  setScene(name) {
    this.settings.scene = name;
    if(this.suspended||!this.gl||this.gl.isContextLost())return;
    const art = document.createElement('canvas');
    art.width = this.width; art.height = this.height;
    const ctx = art.getContext('2d'), w = art.width, h = art.height, s = this.dpr;
    ctx.fillStyle = '#e7efeb'; ctx.fillRect(0, 0, w, h);
    // Color passes underneath the surfaces, so their bevel bends real detail.
    const wash = ctx.createLinearGradient(0, 0, w, h);
    wash.addColorStop(0, '#deebe5'); wash.addColorStop(.38, '#dee9ee');
    wash.addColorStop(.68, '#e5e0ef'); wash.addColorStop(1, '#e9e6d8');
    ctx.fillStyle = wash; ctx.fillRect(0, 0, w, h);
    for (const [y, color] of [[.10,'#b5d6cd45'],[.42,'#b5c9db38'],[.75,'#d6bcda30']]) {
      ctx.beginPath(); ctx.moveTo(-w*.1,h*y);
      ctx.bezierCurveTo(w*.3,h*(y+.24),w*.6,h*(y-.22),w*1.1,h*(y+.14));
      ctx.lineTo(w*1.1,h*(y+.23));
      ctx.bezierCurveTo(w*.6,h*(y-.13),w*.3,h*(y+.34),-w*.1,h*(y+.09));
      ctx.closePath(); ctx.fillStyle=color; ctx.fill();
      ctx.strokeStyle='#ffffff70'; ctx.lineWidth=s; ctx.stroke();
    }
    ctx.lineWidth=.65*s;
    for(let y=0;y<h;y+=24*s){
      ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.strokeStyle='#597b7920';ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,y+s);ctx.lineTo(w,y+s);ctx.strokeStyle='#ffffff6b';ctx.stroke();
    }
    const gl=this.gl;
    gl.bindTexture(gl.TEXTURE_2D,this.textures.art);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,art);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    this.invalidate();
  }

  destroy() {
    super.destroy();
    this.canvas.remove();
    this.stage.classList.remove('webgl-ready');
  }

  render(now) {
    const canPaint=!this.destroyed&&!this.suspended&&!this.lost&&!!this.gl&&!document.hidden&&this.visible;
    super.render(now);
    if(canPaint&&this.width>1&&this.height>1&&this.canvas.hidden){
      this.canvas.hidden=false;
      this.stage.classList.add('webgl-ready');
      this.stage.classList.remove('fallback');
    }
  }
}
