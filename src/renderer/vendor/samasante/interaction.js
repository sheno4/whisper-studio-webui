/** Sam Asante, 4e7b769e1df7e5a7d3669fef22417fe3d2f79ade (MIT).
 * Exact cubic over-drag helper from src/interaction.tsx. No hooks or bindings. */
export const rubberBand = (excess, limit, range) => {
  const t = excess < range ? excess / range : 1;
  return limit * t * (3 + t * (t - 3));
};
