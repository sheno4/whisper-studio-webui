const key='whisper-studio.glass-intensity';
const listeners=new Set<()=>void>();
const clamp=(value:number)=>Math.max(0,Math.min(1,Number.isFinite(value)?value:.8));
let intensity=.8;
let lastSaved=.8;
export function initializeGlassIntensity():void {
  try{const raw=localStorage.getItem(key);if(raw!==null)intensity=clamp(Number(raw));}catch{/* In-memory preference remains usable. */}
  lastSaved=intensity;listeners.forEach(listener=>listener());
}
export const getGlassIntensity=():number=>intensity;
export function setGlassIntensity(value:number):void {
  const next=clamp(value);if(next===intensity)return;
  intensity=next;listeners.forEach(listener=>listener());
}
export function saveGlassIntensity():void {
  if(lastSaved===intensity)return;
  try{localStorage.setItem(key,String(intensity));lastSaved=intensity;}catch{/* Private browsing retains the current value until the page closes. */}
}
export function subscribeGlassIntensity(listener:()=>void):()=>void {listeners.add(listener);return()=>listeners.delete(listener);}
