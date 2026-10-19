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

- A mount `useLayoutEffect` adopts `offsetWidth/offsetHeight` before the first
  paint so upstream's demonstration size of 270 by 69 never becomes visible
  filter coordinates. `ResizeObserver.contentRect` supplies subsequent
  untransformed sizes, with equality checks before state updates. This narrow
  sizing adapter preserves the original filter graph. `localOptics` starts
  with no demo dimensions; its first valid local field is adopted before paint.
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
- `localOptics` is a documented native-backdrop adapter. The SVG reference is
  applied directly in `backdrop-filter`, whose input is the real browser
  backdrop, with ordinary `filter` cleared. This follows the [Filter Effects
  rendering order](https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty).
  The upstream separate `filter` placement remains the default for other users.
- `local-bezel.ts` generates a mathematical rounded-rectangle vector field for
  structural width/height/radius changes only. Its signed R/B channels follow a
  local circular bezel and Snell transmission; its alpha is an explicit bezel
  mask, zero in the center. It never captures or reads any image/page pixels.
  Maps are bounded to 32,768 generated pixels and an eight-entry LRU cache.
  This adapter does not use the square embedded JPEG's `slice` cropping.
- The local adapter sets SVG filter/primitive coordinates to `userSpaceOnUse`
  and the `feImage` to the actual local CSS width/height with
  `preserveAspectRatio="none"`. Its edge-alpha transfer is an identity table;
  opaque JPEG alpha would otherwise make the original alpha-only mask cover
  the entire material. RGB channel displacement, screen recombination, edge
  composite, original clean center, and unique filter identity are retained.

This component uses browser-native SVG/CSS backdrop filtering. The upstream
Firefox guard is retained: Firefox gets the blur/saturation material without the
SVG displacement filter. Its CSS positioning defaults are centered, so a fill
host should use an absolute container at `top:50%; left:50%` with explicit width
and height; its `.glass` child should fill that container. Interaction belongs to
the semantic control outside the decorative material layer.

Whisper Studio's live integration is outside this copied source, in
`glass/RdevMaterial.tsx` and `glass/live-material.ts`. Constant mouse props disable
upstream React mouse tracking. One imperative controller provides shared
pointer/pressure/bend/velocity samples to native lighting/shadow and Studio
lighting. Normal material nodes expand their inset by their host's actual four
computed border widths before measuring/reserving the lens, matching the
semantic host's outer border box instead of its inner padding box. Structural
host/material ResizeObserver updates keep that geometry current; synthetic
satellites retain their explicit presentation rectangles. Local bezel width is
24% of the smaller untransformed lens dimension,
bounded to 3–14 CSS pixels. Its mathematical refraction offset is bounded to
30% of that dimension (2–14 CSS pixels); the SVG scale is twice that bound
because map channels encode signed displacement around 0.5. The actual field
offset follows the bezel normal/Snell profile and the material intensity.
Press pressure may add at most 10%; ordinary hover, focus and pointer velocity
never change depth or spectral spacing. The three scales keep the original
1.0/1.1/1.2 ratios and only write when their actual values change. The original
graph, unique filter ID, shape-only `feImage` and `.glass__warp` element remain
intact. No background image is captured or generated per frame. Backdrop blur
is fixed at 0.5px for compact controls and 1px for menus so text under the bezel
retains a distinct shape instead of being hidden by frosting.

Native admission is fixed for the mounted material: six steady moving-lens
slots (actual indicator/thumb roles, excluding switch tracks) reserve 80,000
CSS pixels and two menu/highlight slots reserve 120,000, with a total
ceiling of eight SVG layers and 200,000 reserved CSS pixels. Zero-size nodes
are not admitted. Segments reserve the complete known bar width and height,
so fitting a different selected-pill width does not suspend SVG during a drag;
menu highlights reserve their known menu-width row of up to 48 CSS pixels.
The diagnostics separately report current painted pixels and reserved pixels.
If structural resizing exceeds a surface's reservation, its original mounted
SVG subtree pauses painting and fixed browser frost continues until it fits;
there is no new slot admission or subtree replacement. The allocator
never evicts or promotes on hover, focus or menu opening. Denied nodes retain
the same transparent tint and fixed browser backdrop blur; only SVG
displacement is absent. Hidden highlights reserve a menu-width row estimate.
Legacy `gpuOnly` tail/neighbour proxies now paint their own actual CSS backdrop
at the incoming presentation rectangle; they never consume a fake 1px SVG slot.
Ordinary button/select/toolbar materials use stable native backdrop frost and
glint/shadow rather than consuming the moving-lens SVG allocation. Their
provider is explicitly marked as `browser-backdrop`, not full SVG optics.
Large panel frosting is an independent background sibling rather than an
ancestor backdrop filter, so nested controls retain native scene sampling.
The inline ImportSheet is a plain container inside its input pane's material.
Segment labels now paint before the glass
indicator, so actual background labels can be refracted through the bezel;
the clean center retains text detail. Button labels remain native foreground.
Jelly exclusively controls body
transforms. Reduced motion removes added optical deformation/inertia while
native background sampling remains live. Solid and contrast modes mount no SVG
material. This graph stays mounted during every ordinary interaction. The
separate bounded Studio canvas contributes transparent SDF/Fresnel/glare
lighting only and never owns the backdrop or removes this graph. The native
shadow node remains continuously mounted and uses transform/opacity for
pointer-responsive position and extent. Its static outer box shadow has no
filled center, preventing a dark silhouette from tinting the sampled backdrop.
Its native glint fades out only when
that same local group has Studio lighting. This is not fused background
refraction across neighbouring lenses: their real browser backdrop filtering
remains separate. DOM/input/GL-call checks do not establish visual quality or
hardware FPS.
