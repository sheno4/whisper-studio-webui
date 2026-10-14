# liquid-glass-react source

The actual React component and its complete SVG optical pipeline are copied from
[rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react/tree/ac48eab18d1f7f444ae30002d240cae29c863a21),
commit `ac48eab18d1f7f444ae30002d240cae29c863a21`, package version `1.1.1`.
Copyright 2025 MAX ROVENSKY. The included `LICENSE` contains the MIT terms.

Copied source files are `src/index.tsx`, `src/utils.ts`, and `src/shader-utils.ts`.
The latter retains upstream's attribution to `shuding/liquid-glass`. No demo page,
photograph, font, or package build script is included. The existing React runtime
satisfies this component's peer dependencies; it adds no npm dependencies.

The default `LiquidGlass` export remains the original component. `GlassFilter`
retains the displacement map, RGB channel displacement, edge mask, center mask,
blur and recombination nodes. `GlassContainer` retains the backdrop warp, sharp
content layer, edge reflection layers and optional hover/press lighting.

Local changes to limit work and support the existing gesture controller:

- `ResizeObserver.contentRect` supplies untransformed size, with equality checks
  before state updates. No window resize listener or geometry read is needed to
  size the material.
- `elasticity={0}` skips the internal mouse listener and all elastic geometry
  reads. When there is no `onClick`, there are no internal mouse feedback handlers.
  Whisper Studio can pass shared constant mouse objects and let Jelly own motion.
- Broad `transition: all` declarations and utility classes are replaced with
  explicit transform/opacity transitions.
- Shader maps, when requested, preserve the original generator but are quantized,
  capped at `320 × 96` pixels, and reused in an eight-entry LRU cache. The standard,
  polar and prominent modes retain their original embedded displacement maps.
- Optional `displacementMapUrl` supplies a precomputed map through the original
  `feImage` node. It also skips built-in shader generation when provided.
- The upstream duplicate `feImage` DOM ID is omitted; the enclosing filter keeps
  its React-generated unique ID.

This component uses browser-native SVG/CSS backdrop filtering. The upstream
Firefox guard is retained: Firefox gets the blur/saturation material without the
SVG displacement filter. Its CSS positioning defaults are centered, so a fill
host should use an absolute container at `top:50%; left:50%` with explicit width
and height; its `.glass` child should fill that container. Interaction belongs to
the semantic control outside the decorative material layer.
