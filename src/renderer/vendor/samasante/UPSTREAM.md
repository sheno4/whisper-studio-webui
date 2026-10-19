# Sam Asante Liquid Glass: optical contract and motion boundary

Source: https://github.com/samasante/liquid-glass

Pinned revision: `4e7b769e1df7e5a7d3669fef22417fe3d2f79ade` (HEAD resolved 2026-10-16).

License: MIT, Copyright 2026 Sam Asante; the original notice is in `LICENSE`.

Unchanged source is retained in `upstream/displacement.ts.txt` and `upstream/interaction.tsx.txt`. These are reference text, not a second DOM or WebGL runtime. The upstream DOM-copy lens, its per-pixel map generator and development image-alpha warning are not loaded by the application.

`optics.ts` extracts the `GlassOptics` geometry-separated contract, exact default lens values, `DISPERSION_SPREAD`, `computeDomeConstants` and `domeGradient` from displacement.ts. That optical adapter is retained as reference after removal of the approximate DOM-background compositor; it is not imported by the current transparent lighting pass. `interaction.js` is the exact cubic `rubberBand(excess, limit, range)` helper from interaction.tsx lines 108–115 and remains active for bounded segment deformation. Slider axes use the same IshiakiZ rational curve instead. The existing Lens controller remains the only input and spring owner.

Geometry remains separate from optical appearance. Native range inputs continue to own real values and keyboard/form interaction; the scene's lens follows their measured thumb, with no clone of the business controls and no additional refraction layer.
