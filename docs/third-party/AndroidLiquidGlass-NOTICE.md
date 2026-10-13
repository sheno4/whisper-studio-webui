# AndroidLiquidGlass optical adaptation

Copyright 2025 Kyant. Licensed under the Apache License, Version 2.0.
The complete license is included in `AndroidLiquidGlass-LICENSE.txt`.

Source: https://github.com/Kyant0/AndroidLiquidGlass, `kmp` branch at
`65ab177e90e5c1d8c62e70cf7755841982da65f6` (read 2026-10-12).

Whisper Studio adapts the rounded-rectangle signed distance function, rounded
normal, circle lens profile and seven spectral channel weights from
`backdrop/src/commonMain/kotlin/com/kyant/backdrop/internal/Shaders.kt`, and the
parameter semantics of `effects/Lens.kt`. These algorithms were translated to
TypeScript-generated geometric displacement maps and native SVG filter graphs.
The finite rim uses the source's normal/light dot product highlight model,
including white/black ambient reflection on opposite-facing normals. The rim
is encoded as a geometric SVG outline separately from the displacement texture;
scaling down a large panel's displacement map therefore cannot erase its thin
edge highlight. The outline samples the same SDF normal and squared falloff.
The web component, browser capability policy, texture caching, accessibility
preferences and pointer feedback are new implementations; no Android runtime,
Apple proprietary renderer or copied application pixels are included.

Chromium 120+ (desktop Chrome/Edge on Windows/Linux) is the selected optical
target, gated by engine/version and CSS syntax support. The filter graph is
connected to the browser's native `backdrop-filter: url(#filter)` input, using
live composited DOM pixels; seven `feDisplacementMap` samples form the spectral
result. Filter primitives are direct children of `filter`, and every sample
dependency is declared before it is consumed. Resizing regenerates
only geometry maps. Scrolling, changing a wallpaper, or updating content never
requires a DOM capture or application texture update.

Firefox/WebKit receive an explicit opaque material because those engines do
not consistently implement arbitrary SVG filter graphs as backdrop filters.
This is a native SVG filter pipeline, not a WebGL renderer. GPU execution and
frame rate depend on the browser and hardware and have not been measured.
CSS syntax acceptance does not prove optical rendering. The component's
`data-glass-mode`, `data-glass-source`, and `data-glass-fallback` report the
selected path, not visual test results. This workspace defaults to glass; an
explicit system choice follows reduced transparency. The legacy automatic
system default is migrated to glass, while a saved solid choice is preserved.
An explicit glass preference overrides only reduced transparency;
stronger contrast, forced colors, and solid preference always select solid.

The source's spectral RGB channel weights are preserved. Since the app supplies
an opaque page underneath all glass, weighted branches keep their alpha intact
while summing colors. Dividing branch alpha by seven in an SVG color matrix
would also attenuate premultiplied RGB a second time. This opaque-backdrop
adaptation is not a general-purpose filter for isolated transparent images.

Displacement maps are bounded to 196,608 pixels, encoded only when geometry changes,
and retained in an LRU cache capped at 36 entries and 24 MiB of encoded strings.
Mounted components also retain their currently active maps. The foreground is
rendered once as native HTML. Press motion changes only the control's own
transform and rim opacity,
stops after settling, retains velocity when interrupted, and attaches window
pointer listeners only while pressed. Keyboard/reduced-motion input removes
movement immediately. Hidden documents, resize during a press, and unmount
clean up gesture state and scheduled frames. Native button click behavior,
disabled states, form attributes and focus handling remain native HTML.

Draggable workbench panes use only marked title handles. Pointer capture tracks
the actual pane from its current position, with 1:1 tracking inside a 64px free
range and a finite soft boundary beyond it. Drag velocity produces subtle
anisotropic deformation and localized rim-light changes. On release, sampled
recent gesture velocity passes into a bounded elastic return; another grab can
interrupt that return without resetting position. Only transform/rim opacity
is written during the gesture, with no per-frame React render or idle loop.
Input fields, links and buttons cannot initiate pane dragging. Reduced motion
retains direct manual translation, disables deformation, and resets instantly
on release. Pointer cancellation, lost capture, window blur, hidden documents,
resize, keyboard input and unmount reset capture and movement immediately.

Validation covers the finite SDF/lens/dispersion math, channel normalization,
neutral displacement encoding, texture-size limits, spring interruption and
bounded settling, and the SVG graph's direct children/dependency ordering.
No screen capture, OCR, image matching, pixel rendering or frame-rate tests were
used. The selected optical path is not a claim of visually verified output.

SVG graph and compositing semantics were checked against
[Filter Effects 1](https://www.w3.org/TR/filter-effects-1/) sections 7, 9.1, 9.6
and 9.8. The live backdrop input connection follows
[Filter Effects 2](https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty)
section 2.1. These specifications describe the pipeline, rather than certify a
particular browser's rendered output.
