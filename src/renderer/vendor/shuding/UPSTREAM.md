# Shu Ding Liquid Glass: rounded-rectangle field

Source: https://github.com/shuding/liquid-glass

Pinned revision: `a2d2e847f793430e3409a52927af815a23f4d372` (HEAD resolved 2026-10-16).

License: MIT, Copyright 2025 Shu Ding; the original notice is in `LICENSE`.

`upstream/liquid-glass.js` is the unchanged original. `sdf.ts` extracts its `smoothStep` and `roundedRectSDF` utility functions and translates the identical arithmetic into namespaced GLSL. This adapter was used by the former DOM-raster background compositor; it is retained as reference and is not imported by the current transparent lighting pass. `width` and `height` are half extents in both implementations.

The original demo's global singleton, page drag handlers, hidden displacement canvas and SVG filter are retained as inert reference, not imported. The rdev material's existing shader-utils attribution to Shu Ding remains valid. Retaining this directory does not mean the application is running this demo or its separate field adapter.
