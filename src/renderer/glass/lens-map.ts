import { displacementChannel, displacementScale, lensMapResolution, sampleLens, spectralSamples, type LensGeometry } from './lens-math';

export type LensMaps = { displacement: string[]; highlight: [string, string]; ambient?: string; scale: number; width: number; height: number };
const mapCache = new Map<string, LensMaps>();
const cacheLimit = 24 * 1024 * 1024;
let retainedBytes = 0;
const mapBytes = (maps: LensMaps): number => [...maps.displacement, ...maps.highlight, maps.ambient ?? ''].reduce((bytes, uri) => bytes + uri.length * 2, 0);

/** A vector SDF rim stays subpixel-sharp when a large displacement map is scaled. */
function createVectorRim(geometry: LensGeometry, angle: number, ambient = false): string {
  const { width, height } = geometry;
  const inset = Math.min(0.85, width / 4, height / 4);
  const radii = geometry.radii.map((radius) => Math.max(inset, Math.min(radius, width / 2, height / 2)));
  const paths: string[] = [];
  const number = (value: number) => value.toFixed(3);
  const segment = (x1: number, y1: number, x2: number, y2: number) => {
    if (Math.hypot(x2 - x1, y2 - y1) < 0.001) return;
    const sample = sampleLens((x1 + x2) / 2, (y1 + y2) / 2, geometry);
    const dot = sample.normalX * Math.cos(angle) + sample.normalY * Math.sin(angle);
    const intensity = Math.pow(Math.abs(dot), 2);
    if (intensity < 0.001) return;
    paths.push(`<path d="M${number(x1)} ${number(y1)}L${number(x2)} ${number(y2)}" stroke="${ambient && dot < 0 ? '#000' : '#fff'}" stroke-opacity="${number(intensity)}"/>`);
  };
  const corner = (cx: number, cy: number, radius: number, start: number) => {
    const inner = Math.max(0, radius - inset);
    const steps = Math.min(48, Math.max(8, Math.ceil(inner * Math.PI / 4)));
    for (let step = 0; step < steps; step += 1) {
      const a = start + step / steps * Math.PI / 2;
      const b = start + (step + 1) / steps * Math.PI / 2;
      segment(cx + inner * Math.cos(a), cy + inner * Math.sin(a), cx + inner * Math.cos(b), cy + inner * Math.sin(b));
    }
  };
  segment(radii[0], inset, width - radii[1], inset);
  corner(width - radii[1], radii[1], radii[1], -Math.PI / 2);
  segment(width - inset, radii[1], width - inset, height - radii[2]);
  corner(width - radii[2], height - radii[2], radii[2], 0);
  segment(width - radii[2], height - inset, radii[3], height - inset);
  corner(radii[3], height - radii[3], radii[3], Math.PI / 2);
  segment(inset, height - radii[3], inset, radii[0]);
  corner(radii[0], radii[0], radii[0], Math.PI);
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="none" stroke-width="${ambient ? 1.75 : 1.35}" stroke-linecap="round">${paths.join('')}</g></svg>`)}`;
}

/** Generates lens geometry, never captures, copies, or rasterizes UI/background pixels. */
export function createLensMaps(geometry: LensGeometry, dispersion: boolean): LensMaps {
  if (![geometry.width, geometry.height, ...geometry.radii, geometry.refractionHeight, geometry.refractionAmount].every(Number.isFinite) || geometry.width < 2 || geometry.height < 2) {
    throw new Error('A lens requires finite visible geometry.');
  }
  const resolution = lensMapResolution(geometry.width, geometry.height, window.devicePixelRatio || 1);
  const key = [geometry.width, geometry.height, ...geometry.radii, geometry.refractionHeight, geometry.refractionAmount, dispersion, resolution.width, resolution.height].join(':');
  const cached = mapCache.get(key);
  if (cached) {
    mapCache.delete(key);
    mapCache.set(key, cached);
    return cached;
  }
  const canvas = document.createElement('canvas');
  canvas.width = resolution.width;
  canvas.height = resolution.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Lens displacement map encoding is unavailable.');
  const count = dispersion ? spectralSamples.length : 1;
  const maps = Array.from({ length: count }, () => context.createImageData(canvas.width, canvas.height));
  const scale = displacementScale(geometry.refractionAmount, dispersion);
  const direction = [-135 * Math.PI / 180, -35 * Math.PI / 180];
  for (let row = 0; row < canvas.height; row += 1) {
    for (let column = 0; column < canvas.width; column += 1) {
      const sample = sampleLens((column + 0.5) / canvas.width * geometry.width, (row + 0.5) / canvas.height * geometry.height, geometry);
      const index = (row * canvas.width + column) * 4;
      for (let channel = 0; channel < count; channel += 1) {
        const multiplier = dispersion ? 1 + sample.dispersion * spectralSamples[channel].offset : 1;
        const pixels = maps[channel].data;
        pixels[index] = displacementChannel(sample.offsetX * multiplier, scale);
        pixels[index + 1] = displacementChannel(sample.offsetY * multiplier, scale);
        pixels[index + 2] = 128;
        pixels[index + 3] = 255;
      }
    }
  }
  const encode = (data: ImageData): string => {
    context.putImageData(data, 0, 0);
    return canvas.toDataURL('image/png');
  };
  const result: LensMaps = {
    displacement: maps.map(encode),
    highlight: [createVectorRim(geometry, direction[0]), createVectorRim(geometry, direction[1])],
    ambient: createVectorRim(geometry, direction[0], true),
    scale, ...resolution
  };
  mapCache.set(key, result);
  retainedBytes += mapBytes(result);
  // Bound both entry count and encoded string memory. Mounted surfaces own their
  // active maps; this limit applies to reusable, inactive geometry textures.
  while (mapCache.size > 36 || retainedBytes > cacheLimit) {
    const oldestKey = mapCache.keys().next().value!;
    retainedBytes -= mapBytes(mapCache.get(oldestKey)!);
    mapCache.delete(oldestKey);
  }
  canvas.width = 0;
  canvas.height = 0;
  return result;
}
