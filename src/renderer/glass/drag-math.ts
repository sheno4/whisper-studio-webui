export type DragPosition = { x: number; y: number; time: number };

/** Follow 1:1 in the working range; farther pulls meet a continuous soft stop. */
export function rubberBandDrag(value: number, freeRange = 64, resistanceRange = 32): number {
  const distance = Math.abs(value);
  if (distance <= freeRange) return value;
  const excess = distance - freeRange;
  return Math.sign(value) * (freeRange + excess * resistanceRange / (resistanceRange + excess));
}

/** A held pointer has no release velocity; recent moves hand momentum to springs. */
export function dragReleaseVelocity(history: readonly DragPosition[], time: number): { x: number; y: number } {
  const last = history.at(-1);
  if (!last || time - last.time > 80) return { x: 0, y: 0 };
  const first = history.find((sample) => last.time - sample.time <= 64) ?? last;
  const elapsed = Math.max(8, last.time - first.time) / 1000;
  const clamp = (value: number) => Math.max(-900, Math.min(900, value));
  return { x: clamp((last.x - first.x) / elapsed), y: clamp((last.y - first.y) / elapsed) };
}
