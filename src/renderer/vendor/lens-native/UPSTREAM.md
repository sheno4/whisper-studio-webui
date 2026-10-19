# Lens native upstream

- Source: https://github.com/ruiqichenbiec/design-systems
- Commit: `7a424c93b9be13cf835b91ea67495fec2ec0584e`
- Source directory: `lens/lab/design-system/`
- Pinned package version: `1.1.0-showcase.1`
- License: repository-root MIT `LICENSE`, copied alongside the package.

All 48 portable package files are copied without source modifications, including
their original types, tokens, CSS, components, renderer, optics, Jelly physics,
sound service, examples and documentation. `SHA256SUMS` contains SHA-256 hashes
for those 48 files and the root license, using the pinned commit's canonical Git
blob bytes (LF, independent of Windows checkout conversion). This provenance
file and the checksum manifest are application additions.

The application imports this package's actual `createGlassSystem`, native
component factories, `tokens.css`, and `components.css`. It uses the original
Thick optical material, Snell refraction shader, ping-pong scene composition,
deformation, optical state, Jelly springs and focus modality. Default scenes
remain the original Aurora / Ocean. Default sound is explicitly disabled with
`storage:null`; background `motion:false` prevents an idle background ticker.

Application adapters live outside this unmodified directory in `../../lens/`:

- `Runtime.tsx` owns one system per workbench, observes the existing appearance
  and intensity preferences, and registers/releases dynamic React nodes without
  rebuilding a context for text, task or progress changes. Stored intensity .8
  maps to the unmodified Thick parameters. The material picker explicitly offers
  application-rendered glass or solid; solid and high contrast can suspend the
  GPU. Reduced motion removes elastic deformation.
- `native-lifecycle.ts` supplements the upstream app-wide-only cleanup with
  detachable node scopes. The initial non-detachable runtime mount is suppressed
  by a local, synchronous query override for its four control selectors. Native
  `JellyController.register()` still creates each body's handlers and springs;
  the adapter records those source listeners and owns per-control sync listeners
  and ResizeObservers so removal releases listeners, observers, pointer capture
  and retained body entries. It respects inherited fieldset disabled state.
- `native-dom.ts` adds Lens material semantics to existing business-owned native
  buttons/text fields without replacing their DOM, callbacks, refs, or inputs.
  Factory internals, menu items and explicit ignore subtrees are excluded.
- `viewport-renderer.ts` restricts the one canvas/scene to the stage's visible
  viewport. It changes allocation and the stage coordinate origin, retaining
  upstream geometry/clipping and all optical shaders. `render-quality.ts` selects
  real display DPR within actual GPU/drawing-buffer limits and a 16M-pixel base
  allowance (enough for physical 4K/5K), extensible to 32M for larger screens.
  Actual allocation failures halve area in fixed, retained steps; frame time
  never changes density. Pointer coordinates follow DPR changes. Tall mobile
  documents do not allocate full-page images.
- `top-layer-presentation.ts` checkpoints the same native lens loop at dialog /
  popover paint boundaries using its original COPY program. Each lens is still
  drawn once. A visible overlay adds one base-scene blit, group-boundary copies
  and a final base restore; its original optical result is copied from the one
  WebGL canvas into decorative 2D canvases inside the corresponding DOM layer.
  The checkpoint matches the scene, and normal 2D copies retain its same DPR.
  Oversized stacks or allocation failure lower the shared scene consistently;
  resizing releases old copies before reallocating. No overlay means no extra
  buffers or copies.
  Closing overlays, suspension, hidden pages and teardown release resources.
  This adapter owns no shader, WebGL context, DOM capture or animation ticker.

An existing wallpaper setting can supply a normal Image to the documented
artwork callback. Image load/texture failures retain the previous scene. This is
ordinary artwork rendering; there is no DOM rasterization, screenshot capture,
pixel readback, arbitrary DOM refraction, rdev displacement or Studio lighting
pipeline in the active adapter. The original renderer refracts only its own scene
texture and glass already composited into that texture. Semantic DOM text and
inputs remain browser-rendered on top.

No screenshot, image-recognition, pixel-reading, real backend job or visual test
is part of this integration. Static checks cannot establish appearance, pointer
feel, WebGL driver stability, or hardware frame time; those remain human runtime
validation boundaries.
