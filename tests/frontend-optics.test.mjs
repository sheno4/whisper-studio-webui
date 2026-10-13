import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('tsx'))('esbuild');
const code = buildSync({
  stdin: {
    contents: "export * from './src/renderer/glass/lens-math'; export * from './src/renderer/glass/spring'; export { LensDefinitions } from './src/renderer/glass/GlassSurface';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url))
  }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react/jsx-runtime']
}).outputFiles[0].text;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, require });
const { sampleLens, spectralSamples, lensMapResolution, displacementChannel, displacementScale, springAxis, advanceSpring, settleSpring, LensDefinitions } = module.exports;
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const geometry = { width: 200, height: 80, radii: [20, 20, 20, 20], refractionHeight: 12, refractionAmount: 20 };

test('rounded SDF bends the finite edge inward, preserves its center and mirrors opposite edges', () => {
  const left = sampleLens(0, 40, geometry);
  const right = sampleLens(200, 40, geometry);
  near(left.distance, 0);
  near(left.offsetX, 20);
  near(right.offsetX, -20);
  near(left.offsetY, 0);
  near(sampleLens(12, 40, geometry).offsetX, 0);
  const center = sampleLens(100, 40, geometry);
  near(center.offsetX, 0);
  near(center.offsetY, 0);
  const circularEdge = 20 - 20 / Math.sqrt(2);
  const corner = sampleLens(circularEdge, circularEdge, geometry);
  near(corner.distance, 0);
  near(corner.normalX, -1 / Math.sqrt(2));
  near(corner.normalY, -1 / Math.sqrt(2));
  near(corner.offsetX, 20 / Math.sqrt(2));
});

test('seven channel weights preserve neutral color and encoded samples stay within finite displacement bounds', () => {
  for (const channel of ['red', 'green', 'blue']) near(spectralSamples.reduce((sum, sample) => sum + sample[channel], 0), 1);
  for (const dispersed of [false, true]) {
    const scale = displacementScale(20, dispersed);
    near((displacementChannel(0, scale) / 255 + (0.5 - 128 / 255) - 0.5) * scale, 0);
    for (let y = 0; y <= 80; y += 2) for (let x = 0; x <= 200; x += 2) {
      const sample = sampleLens(x, y, geometry);
      if (sample.distance > 0) continue;
      for (const spectrum of dispersed ? spectralSamples : [{ offset: 0 }]) {
        for (const offset of [sample.offsetX, sample.offsetY]) {
          const expected = offset * (1 + sample.dispersion * spectrum.offset);
          const encoded = displacementChannel(expected, scale);
          const decoded = (encoded - 128) / 255 * scale;
          assert.ok(encoded >= 0 && encoded <= 255);
          assert.ok(Math.abs(decoded - expected) <= scale / 510 + 1e-9);
        }
      }
    }
  }
});

test('large displays and high DPR cannot grow a single geometry texture beyond its pixel budget', () => {
  for (const [width, height, density] of [[3840, 2160, 4], [1240, 96, 2], [44, 44, 3], [7680, 4320, Infinity]]) {
    const resolution = lensMapResolution(width, height, density);
    assert.ok(resolution.width >= 2 && resolution.width <= 1024);
    assert.ok(resolution.height >= 2 && resolution.height <= 512);
    assert.ok(resolution.width * resolution.height <= 196608);
  }
});

test('spring interruption keeps current value/velocity, reverses and settles within a bounded number of frames', () => {
  const state = springAxis(0);
  state.target = 3;
  for (let frame = 0; frame < 6; frame++) advanceSpring(state, 1 / 60);
  const before = { value: state.value, velocity: state.velocity };
  state.target = -2;
  near(state.value, before.value);
  near(state.velocity, before.velocity);
  let frames = 0;
  while (advanceSpring(state, frames % 2 ? 1 / 144 : 0.25) && frames < 240) frames++;
  assert.ok(frames < 240);
  assert.ok(Number.isFinite(state.value) && Number.isFinite(state.velocity));
  settleSpring(state);
  near(state.value, -2);
  near(state.velocity, 0);
});

test('native SVG filter primitives are direct children and every spectral dependency resolves before use', () => {
  const { renderToStaticMarkup } = require('react-dom/server');
  const markup = renderToStaticMarkup(LensDefinitions({ id: 'fixture-lens', optics: {
    width: 200, height: 80,
    maps: { displacement: Array.from({ length: 7 }, (_, i) => `data:fixture-${i}`), highlight: ['', ''], scale: 80, width: 200, height: 80 }
  } }));
  assert.equal(/<g(?:\s|>)/.test(markup), false);
  const available = new Set(['SourceGraphic']);
  const primitives = [...markup.matchAll(/<(feImage|feComponentTransfer|feDisplacementMap|feColorMatrix|feComposite)\b([^>]*)>/g)];
  assert.equal(primitives.length, 34);
  for (const [, name, attributes] of primitives) {
    for (const [, dependency] of attributes.matchAll(/\bin(?:2)?="([^"]+)"/g)) assert.ok(available.has(dependency), `${name} references missing ${dependency}`);
    const result = /\bresult="([^"]+)"/.exec(attributes)?.[1];
    if (result) available.add(result);
    if (name === 'feColorMatrix') assert.ok(/0 0 0 1 0"/.test(attributes), 'RGB weighting must not also attenuate branch alpha');
  }
  assert.equal(/result="sum-6"/.test(primitives.at(-1)[2]), true);
});
