/** One quality policy for the shared scene and its DOM top-layer copies.
 * 16M pixels covers a physical 5120 × 2880 display at native density. A larger
 * physical screen can raise that allowance, up to a 32M-pixel extreme guard.
 * At roughly 32 bytes per pixel for scene/art/checkpoint/presentation storage,
 * these ceilings bound the working set without imposing a 1080p output. */
export const nativeRenderPixelFloor = 16_777_216;
export const maximumRenderPixels = 33_554_432;
export const minimumFallbackPixels = 65_536;

export type RenderQualityInput = {
  width: number;
  height: number;
  devicePixelRatio: number;
  screenWidth?: number;
  screenHeight?: number;
  maxWidth: number;
  maxHeight: number;
  allocationPixelLimit?: number;
};

export type RenderQuality = {
  width: number;
  height: number;
  dpr: number;
  requestedDpr: number;
  maxWidth: number;
  maxHeight: number;
  pixelBudget: number;
  maxPixels: number;
  quality: 'native' | 'hardware-limit' | 'memory-limit' | 'allocation-fallback';
};

const positive = (value: number | undefined, fallback: number) => value && Number.isFinite(value) && value > 0 ? value : fallback;

/** Pure sizing policy. CSS viewport × DPR is already physical pixel size;
 * visualViewport.scale must not multiply browser page zoom a second time. */
export function chooseRenderQuality(input: RenderQualityInput): RenderQuality {
  const cssWidth = positive(input.width, 1), cssHeight = positive(input.height, 1);
  const requestedDpr = positive(input.devicePixelRatio, 1);
  const screenPixels = positive(input.screenWidth, cssWidth) * positive(input.screenHeight, cssHeight) * requestedDpr ** 2;
  const pixelBudget = Math.min(maximumRenderPixels, Math.max(nativeRenderPixelFloor, screenPixels));
  const allocationLimit = positive(input.allocationPixelLimit, Infinity);
  const maxPixels = Math.max(1, Math.floor(Math.min(pixelBudget, allocationLimit)));
  const maxWidth = Math.max(1, Math.floor(positive(input.maxWidth, 1)));
  const maxHeight = Math.max(1, Math.floor(positive(input.maxHeight, 1)));
  const memoryDpr = Math.sqrt(maxPixels / (cssWidth * cssHeight));
  const hardwareDpr = Math.min(maxWidth / cssWidth, maxHeight / cssHeight);
  const dpr = Math.min(requestedDpr, memoryDpr, hardwareDpr);
  const quality = dpr >= requestedDpr ? 'native'
    : allocationLimit <= pixelBudget && memoryDpr <= hardwareDpr ? 'allocation-fallback'
    : hardwareDpr < memoryDpr ? 'hardware-limit' : 'memory-limit';
  return {
    width: Math.max(1, Math.floor(cssWidth * dpr)), height: Math.max(1, Math.floor(cssHeight * dpr)),
    dpr, requestedDpr, maxWidth, maxHeight, pixelBudget, maxPixels, quality
  };
}

/** Allocation failures halve area in fixed steps. The successful ceiling is
 * retained across resizes/context restoration; frame timing never changes it. */
export function nextRenderPixelLimit(width: number, height: number, previousLimit = Infinity): number | undefined {
  const current = Math.min(positive(width, 1) * positive(height, 1), previousLimit);
  if (current <= minimumFallbackPixels) return undefined;
  return Math.max(minimumFallbackPixels, Math.floor(current / 2));
}
