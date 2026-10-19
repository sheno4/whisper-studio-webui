export interface GlassRect { left:number; top:number; width:number; height:number }
export interface SegmentSlot { x:number; w:number }
export const SEGMENT_LIFT: Readonly<{zoom:number;dispersion:number;grow:number;blur:number}>;
export const SWITCH_LIFT: Readonly<{zoom:number;dispersion:number;growX:number;growY:number;blur:number}>;
export const MENU_MATERIALIZE: Readonly<{scale:number;gap:number;edge:number;contentDuration:number;contentDelay:number}>;
export const SLIDER_PROJECTION: number;
export const SWITCH_FLICK: number;
export function segmentBand(distance:number):number;
export function scrubSegment(position:number, first:SegmentSlot, last:SegmentSlot, width:number):number;
export function switchBand(distance:number):number;
export function scrubSwitch(position:number, travel:number):number;
export function switchRelease(position:number, travel:number, velocity:number):boolean;
export function sliderBand(distance:number):number;
export function projectSlider(position:number, velocity:number):number;
export function segmentGrab(pointer:number, x:number, width:number):number;
export function segmentCenter(pointer:number, grab:number, width:number):number;
export function refitSegment(x:number, previousWidth:number, width:number):number;
export function menuOrigin(trigger:GlassRect,popup:GlassRect):{x:number;y:number};
export function menuMaterializeRect(trigger:GlassRect,popup:GlassRect,progress:number):GlassRect & {origin:{x:number;y:number};scale:number;progress:number};
export function placeMenu(trigger:GlassRect,width:number,height:number,viewportWidth:number,viewportHeight:number,options?:{rtl?:boolean;cover?:boolean}):GlassRect;
