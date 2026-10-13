import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('tsx'))('esbuild');
const code = buildSync({
  stdin: {
    contents: "export * from './src/renderer/glass/drag-math';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url))
  }, bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, require });
const { rubberBandDrag, dragReleaseVelocity } = module.exports;
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('glass drag follows the working range and reaches a continuous symmetric soft stop', () => {
  for (const value of [-64, -32, 0, 32, 64]) near(rubberBandDrag(value), value);
  near(rubberBandDrag(64 + 1e-6), 64 + 1e-6);
  near(rubberBandDrag(-64 - 1e-6), -64 - 1e-6);
  let previous = 64;
  for (const value of [65, 80, 120, 256, 1000, 1e9]) {
    const position = rubberBandDrag(value);
    assert.ok(Number.isFinite(position) && position > previous && position < 96);
    near(rubberBandDrag(-value), -position);
    previous = position;
  }
});

test('glass drag transfers recent bounded velocity and releases a held pointer without stale momentum', () => {
  const history = [{ x: 0, y: 0, time: 1000 }, { x: 12, y: -6, time: 1032 }];
  const moving = dragReleaseVelocity(history, 1040);
  near(moving.x, 375);
  near(moving.y, -187.5);
  for (const velocity of [dragReleaseVelocity([], 1040), dragReleaseVelocity(history, 1113)]) {
    near(velocity.x, 0);
    near(velocity.y, 0);
  }
  const fast = dragReleaseVelocity([{ x: 0, y: 0, time: 0 }, { x: 1000, y: -1000, time: 8 }], 8);
  assert.ok(Number.isFinite(fast.x) && Number.isFinite(fast.y));
  assert.ok(Math.abs(fast.x) <= 900 && Math.abs(fast.y) <= 900);
});
