export type SpringAxis = { value: number; velocity: number; target: number };

export const springAxis = (value: number): SpringAxis => ({ value, velocity: 0, target: value });

/** Bounded substeps keep a resumed/slow frame stable without losing input velocity. */
export function advanceSpring(state: SpringAxis, elapsedSeconds: number): boolean {
  const elapsed = Math.max(0, Math.min(0.032, elapsedSeconds));
  const steps = Math.max(1, Math.ceil(elapsed * 120));
  const delta = elapsed / steps;
  for (let step = 0; step < steps; step += 1) {
    state.velocity += ((state.target - state.value) * 620 - state.velocity * 40) * delta;
    state.value += state.velocity * delta;
  }
  return Math.abs(state.target - state.value) > 0.0005 || Math.abs(state.velocity) > 0.015;
}

export function settleSpring(state: SpringAxis): void {
  state.value = state.target;
  state.velocity = 0;
}
