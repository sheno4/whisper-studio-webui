import assert from 'node:assert/strict';
import test from 'node:test';
import { Spring, jellyMatrix } from '../src/renderer/vendor/lens-native/internal/jelly-physics.js';

const near = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test('the vendored Jelly spring keeps its presentation when interrupted and settles after stalled frames', () => {
  for (const hz of [24, 60, 144]) {
    const spring = new Spring();
    spring.target = 64;
    for (let frame = 0; frame < Math.ceil(hz / 10); frame++) spring.step(1 / hz, 260, 22);
    assert.ok(spring.value > 0 && spring.velocity > 0, 'the interruption must happen during motion');
    const presentation = { value: spring.value, velocity: spring.velocity };
    spring.target = -40;
    near(spring.value, presentation.value);
    near(spring.velocity, presentation.velocity);

    let frames = 0;
    while (spring.moving && frames < hz * 4) {
      spring.step(frames % 11 === 0 ? 0.5 : 1 / hz, 260, 22);
      assert.ok(Number.isFinite(spring.value) && Number.isFinite(spring.velocity));
      assert.ok(Math.abs(spring.value) < 128, 'a stalled frame must not destabilize the spring');
      frames++;
    }
    assert.ok(frames < hz * 4, 'the interrupted spring must stop scheduling frames');
    near(spring.value, -40);
    near(spring.velocity, 0);
    assert.equal(spring.moving, false);
  }
});

test('the vendored Jelly matrix stays invertible, preserves area and bounds directional deformation', () => {
  for (const stretch of [-100, -0.2, 0, 0.15, 0.34, 100]) {
    for (const angle of [-Math.PI, 0, Math.PI / 3, Math.PI / 2, 7]) {
      for (const lift of [1, 1.04]) {
        const [a, b, c, d] = jellyMatrix(stretch, angle, lift);
        assert.ok([a, b, c, d].every(Number.isFinite));
        near(a * d - b * c, lift ** 2);
        near(b, c);
        const maximumAxis = 1.34 * lift;
        assert.ok(Math.hypot(a, c) <= maximumAxis + 1e-9);
        assert.ok(Math.hypot(b, d) <= maximumAxis + 1e-9);
        assert.ok(a * d - b * c > 0, 'content must never flip or collapse');
      }
    }
  }
  const resting = jellyMatrix(0, Math.PI / 3, 1);
  resting.forEach((value, index) => near(value, [1, 0, 0, 1][index]));
});
