import { displacementChannel, displacementScale, lensMapResolution, sampleLens, spectralSamples, type LensGeometry } from './lens-math';

export type LensMaps = { displacement: string[]; highlight: [string, string]; scale: number; width: number; height: number };
const mapCache = new Map<string, LensMaps>();
const cacheLimit = 24 * 1024 * 1024;
let retainedBytes = 0;
const mapBytes = (maps: LensMaps): number => [...maps.displacement, ...maps.highlight].reduce((bytes, uri) => bytes + uri.length * 2, 0);

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
  const rim = [context.createImageData(canvas.width, canvas.height), context.createImageData(canvas.width, canvas.height)];
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
      // A finite physical rim, lit from the SDF normal. Not a generic box shadow.
      const edge = Math.max(0, 1 - Math.abs(sample.distance + 0.7) / 1.3);
      direction.forEach((angle, light) => {
        const intensity = Math.pow(Math.abs(sample.normalX * Math.cos(angle) + sample.normalY * Math.sin(angle)), 2);
        rim[light].data[index] = 255;
        rim[light].data[index + 1] = 255;
        rim[light].data[index + 2] = 255;
        rim[light].data[index + 3] = Math.round(255 * intensity * edge);
      });
    }
  }
  const encode = (data: ImageData): string => {
    context.putImageData(data, 0, 0);
    return canvas.toDataURL('image/png');
  };
  const result: LensMaps = { displacement: maps.map(encode), highlight: [encode(rim[0]), encode(rim[1])], scale, ...resolution };
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
