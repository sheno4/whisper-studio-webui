/**
 * Behaviour-only extraction from IshiakiZ/liquid-glass-web (MIT),
 * ea8b7378c3cfff080ef86a32d808131353f5bac9. See UPSTREAM.md and upstream/.
 * No DOM discovery, renderer, input bindings or automatic initialization.
 */
export const SEGMENT_LIFT = Object.freeze({ zoom: 1.1, dispersion: .5, grow: 1.1, blur: .4 });
export const SWITCH_LIFT = Object.freeze({ zoom: 1.12, dispersion: .8, growX: 58 / 37, growY: 38.33 / 24, blur: .3 });
export const MENU_MATERIALIZE = Object.freeze({ scale: .6, gap: 6, edge: 8, contentDuration: 150, contentDelay: 60 });
export const SLIDER_PROJECTION = .2;
export const SWITCH_FLICK = 300;

// comp-tabbar.js / Pill.scrub: exponential resistance, eight-pixel asymptote.
export const segmentBand = distance => 8 * (1 - Math.exp(-Math.max(0, distance) / 24));
export function scrubSegment(position, first, last, width) {
  const lo = first.x, hi = Math.max(lo, last.x + last.w - width);
  return position < lo ? lo - segmentBand(lo - position) : position > hi ? hi + segmentBand(position - hi) : position;
}

// comp-switch.js: 12% initial response, saturating at six pixels.
export const switchBand = distance => 6 * (1 - 1 / (1 + (.12 * Math.max(0, distance)) / 6));
export function scrubSwitch(position, travel) {
  return position < 0 ? -switchBand(-position) : position > travel ? travel + switchBand(position - travel) : position;
}
export const switchRelease = (position, travel, velocity) => Math.abs(velocity) > SWITCH_FLICK ? velocity > 0 : position >= travel / 2;

// comp-slider.js: the real track overshoot and velocity projection.
export const sliderBand = distance => 8 * (1 - 1 / (1 + (.55 * Math.max(0, distance)) / 8));
export const projectSlider = (position, velocity) => position + velocity * SLIDER_PROJECTION;

// comp-segmented.js: preserve a relative grab when the pill fits another slot.
export const segmentGrab = (pointer, x, width) => (pointer - (x + width / 2)) / (width / 2 || 1);
export const segmentCenter = (pointer, grab, width) => pointer - grab * width / 2;
export const refitSegment = (x, previousWidth, width) => x + (previousWidth - width) / 2;

// materialize.js / setOriginFrom. Rects are viewport-space layout boxes.
export function menuOrigin(trigger, popup) {
  return { x: trigger.left + trigger.width / 2 - popup.left, y: trigger.top + trigger.height / 2 - popup.top };
}

/** The upstream scale channel expressed as the matching viewport-space box. */
export function menuMaterializeRect(trigger, popup, progress) {
  const origin = menuOrigin(trigger, popup);
  const scale = MENU_MATERIALIZE.scale + (1 - MENU_MATERIALIZE.scale) * progress;
  return {
    left: popup.left + origin.x * (1 - scale),
    top: popup.top + origin.y * (1 - scale),
    width: popup.width * scale,
    height: popup.height * scale,
    origin, scale, progress,
  };
}

/** comp-menu.js / place: fall back above, then clamp to the viewport. */
export function placeMenu(trigger, width, height, viewportWidth, viewportHeight, { rtl = false, cover = false } = {}) {
  const { gap, edge } = MENU_MATERIALIZE;
  const start = rtl ? trigger.left + trigger.width - width : trigger.left;
  const end = rtl ? trigger.left : trigger.left + trigger.width - width;
  let left = start >= edge && start + width <= viewportWidth - edge ? start : end;
  let top = cover
    ? trigger.top + height <= viewportHeight - edge ? trigger.top : trigger.top + trigger.height - height
    : trigger.top + trigger.height + gap + height <= viewportHeight - edge ? trigger.top + trigger.height + gap : trigger.top - gap - height;
  left = Math.max(edge, Math.min(Math.max(edge, viewportWidth - edge - width), left));
  top = Math.max(edge, Math.min(Math.max(edge, viewportHeight - edge - height), top));
  return { left, top, width, height };
}
