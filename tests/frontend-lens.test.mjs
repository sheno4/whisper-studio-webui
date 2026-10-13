import assert from 'node:assert/strict';
import test from 'node:test';
import { Spring, jellyMatrix } from '../src/renderer/vendor/lens/internal/jelly-physics.js';
import { createLensSurface } from '../src/renderer/vendor/lens/internal/lens-surface.js';

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

function existingButton() {
  const classes = new Set(['app-action', 'lg-surface', 'authored']);
  const attributes = new Map([['aria-label', '开始转写'], ['role', 'button']]);
  const child = Object.freeze({ textContent: '开始' });
  const dataset = { glass: 'authored-glass', lgLens: 'authored-lens', lgDrag: 'press', lgDragHandle: '.old-handle' };
  const dataKey = name => name.startsWith('data-') ? name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : null;
  return {
    tagName: 'BUTTON', id: 'submit-media', type: 'submit', disabled: true,
    dataset,
    children: [child], onclick() {},
    get className() { return [...classes].join(' '); },
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); }
    },
    getAttribute(name) {
      const key = dataKey(name);
      return key === null ? attributes.get(name) ?? null : Object.hasOwn(dataset, key) ? dataset[key] : null;
    },
    setAttribute(name, value) {
      const key = dataKey(name);
      if (key === null) attributes.set(name, String(value));
      else dataset[key] = String(value);
    },
    removeAttribute(name) {
      const key = dataKey(name);
      if (key === null) attributes.delete(name);
      else delete dataset[key];
    }
  };
}

test('the original Lens surface factory binds an existing React host and cleans up only its own decoration', () => {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  // This small host checks ownership only; it does not emulate or render the UI.
  globalThis.document = { createElement() { throw new Error('an existing host must not be replaced'); } };
  try {
    const element = existingButton();
    const child = element.children[0], handler = element.onclick;
    const handle = createLensSurface({ element, tag: 'section', className: 'lg-button authored', kind: 'button', motion: 'tether', dragHandle: '[data-glass-drag-handle]' });
    assert.equal(handle.element, element);
    assert.equal(element.tagName, 'BUTTON');
    assert.equal(element.id, 'submit-media');
    assert.equal(element.type, 'submit');
    assert.equal(element.disabled, true);
    assert.equal(element.getAttribute('aria-label'), '开始转写');
    assert.equal(element.getAttribute('role'), 'button');
    assert.equal(element.children[0], child);
    assert.equal(element.onclick, handler);
    assert.ok(element.classList.contains('app-action') && element.classList.contains('authored'));
    assert.ok(element.classList.contains('lg-surface') && element.classList.contains('lg-button'));
    assert.equal(element.dataset.glass, 'button');
    assert.equal(element.dataset.lgLens, 'button');
    assert.equal(element.dataset.lgDrag, 'tether');
    assert.equal(element.dataset.lgDragHandle, '[data-glass-drag-handle]');

    element.classList.add('react-state-updated');
    element.dataset.reactState = 'ready';
    handle.destroy();
    handle.destroy();
    assert.ok(element.classList.contains('app-action') && element.classList.contains('authored'));
    assert.ok(element.classList.contains('lg-surface') && element.classList.contains('react-state-updated'));
    assert.equal(element.classList.contains('lg-button'), false);
    assert.deepEqual(element.dataset, { glass: 'authored-glass', lgLens: 'authored-lens', lgDrag: 'press', lgDragHandle: '.old-handle', reactState: 'ready' });
    assert.equal(element.children[0], child);
    assert.equal(element.onclick, handler);

    const undecorated = existingButton();
    undecorated.classList.remove('lg-surface');
    Object.keys(undecorated.dataset).forEach(key => delete undecorated.dataset[key]);
    const freshHandle = createLensSurface({ element: undecorated, kind: 'button' });
    assert.ok(undecorated.classList.contains('lg-surface'));
    freshHandle.destroy();
    assert.equal(undecorated.classList.contains('lg-surface'), false);
    assert.ok(undecorated.classList.contains('app-action') && undecorated.classList.contains('authored'));
    assert.deepEqual(undecorated.dataset, {});
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
});
