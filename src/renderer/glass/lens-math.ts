/*
 * Copyright 2025 Kyant
 * Licensed under the Apache License, Version 2.0.
 * See docs/third-party/AndroidLiquidGlass-LICENSE.txt.
 *
 * Modified for Whisper Studio: TypeScript/SVG displacement adaptation of
 * AndroidLiquidGlass's rounded-rectangle AGSL shaders; no Android code executes.
 */

export type CornerRadii = readonly [number, number, number, number];
export type LensGeometry = {
  width: number;
  height: number;
  radii: CornerRadii;
  refractionHeight: number;
  refractionAmount: number;
};
export type LensSample = { distance: number; normalX: number; normalY: number; offsetX: number; offsetY: number; dispersion: number };

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** The SVG channel is corrected by (0.5 - 128/255) before displacement. */
export function displacementChannel(offset: number, scale: number): number {
  return clamp(Math.round(128 + offset / scale * 255), 0, 255);
}

export function displacementScale(amount: number, dispersion: boolean): number {
  return Math.max(1, Math.max(0, amount) * (dispersion ? 4 : 2));
}

/** Exact rounded-rectangle SDF and its outward gradient from Kyant's Shaders.kt. */
function distanceAndNormal(x: number, y: number, halfWidth: number, halfHeight: number, radius: number): [number, number, number] {
  const cornerX = Math.abs(x) - (halfWidth - radius);
  const cornerY = Math.abs(y) - (halfHeight - radius);
  const outsideX = Math.max(cornerX, 0);
  const outsideY = Math.max(cornerY, 0);
  const magnitude = Math.hypot(outsideX, outsideY);
  const distance = magnitude - radius + Math.min(Math.max(cornerX, cornerY), 0);
  const signX = x < 0 ? -1 : 1;
  const signY = y < 0 ? -1 : 1;
  if (magnitude > 0) return [distance, signX * outsideX / magnitude, signY * outsideY / magnitude];
  return cornerX >= cornerY ? [distance, signX, 0] : [distance, 0, signY];
}

export function sampleLens(x: number, y: number, geometry: LensGeometry): LensSample {
  const halfWidth = geometry.width / 2;
  const halfHeight = geometry.height / 2;
  const centeredX = x - halfWidth;
  const centeredY = y - halfHeight;
  const corner = centeredX >= 0 ? (centeredY <= 0 ? 1 : 2) : (centeredY <= 0 ? 0 : 3);
  const radius = clamp(geometry.radii[corner], 0, Math.min(halfWidth, halfHeight));
  const [distance] = distanceAndNormal(centeredX, centeredY, halfWidth, halfHeight, radius);
  const [, normalX, normalY] = distanceAndNormal(centeredX, centeredY, halfWidth, halfHeight, Math.min(radius * 1.5, halfWidth, halfHeight));
  const depth = Math.max(0, -distance);
  const height = Math.min(Math.max(0, geometry.refractionHeight), halfWidth, halfHeight);
  let refraction = 0;
  if (height > 0 && depth < height) {
    const edge = clamp(1 - depth / height, 0, 1);
    // Kyant's circleMap; the negative amount samples inward through a convex lens.
    refraction = -(1 - Math.sqrt(Math.max(0, 1 - edge * edge))) * Math.max(0, geometry.refractionAmount);
  }
  return {
    distance, normalX, normalY,
    offsetX: refraction * normalX,
    offsetY: refraction * normalY,
    dispersion: halfWidth > 0 && halfHeight > 0 ? centeredX * centeredY / (halfWidth * halfHeight) : 0
  };
}

/** Source's seven spectral samples and channel weights, in red → purple order. */
export const spectralSamples = [
  { offset: 1, red: 1 / 3.5, green: 0, blue: 0 },
  { offset: 2 / 3, red: 1 / 3.5, green: 1 / 7, blue: 0 },
  { offset: 1 / 3, red: 1 / 3.5, green: 1 / 3.5, blue: 0 },
  { offset: 0, red: 0, green: 1 / 3.5, blue: 0 },
  { offset: -1 / 3, red: 0, green: 1 / 3.5, blue: 1 / 3 },
  { offset: -2 / 3, red: 0, green: 0, blue: 1 / 3 },
  { offset: -1, red: 1 / 7, green: 0, blue: 1 / 3 }
] as const;

export function lensMapResolution(width: number, height: number, density: number): { width: number; height: number } {
  const boundedDensity = clamp(Number.isFinite(density) ? density : 1, 1, 1.5);
  let mapWidth = Math.min(1024, Math.max(2, Math.ceil(width * boundedDensity)));
  let mapHeight = Math.min(512, Math.max(2, Math.ceil(height * boundedDensity)));
  const ratio = Math.min(1, Math.sqrt(196608 / (mapWidth * mapHeight)));
  mapWidth = Math.max(2, Math.floor(mapWidth * ratio));
  mapHeight = Math.max(2, Math.floor(mapHeight * ratio));
  return { width: mapWidth, height: mapHeight };
}
