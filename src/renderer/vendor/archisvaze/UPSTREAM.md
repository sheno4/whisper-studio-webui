# Archis Vaze Liquid Glass: Snell refraction profile

Source: https://github.com/archisvaze/liquid-glass

Pinned revision: `fbeb99ef5e8dad2cbbc991ffc23e186a28dc01c4` (HEAD resolved 2026-10-16).

License: MIT, Copyright 2026 Archis Vaze; the original notice is in `LICENSE`.

Unchanged original optical sources are `upstream/index.html` and `upstream/webgl.html`. No demo images, Three.js/CDN imports or demo controls are imported by the application.

`optics.ts` extracts `SURFACE_FNS` and `calculateRefractionProfile` from index.html lines 222–259. Its `ARCHISVAZE_REFRACTION_GLSL` adapts webgl.html lines 233–236 and 294–306: convex-squircle surface height, surface derivative, slope angle, IOR/Snell refraction and optical displacement. Functions are namespaced; nonzero bezel and minimum air/glass IOR guards prevent invalid application geometry from dividing by zero. The former background compositor called this displacement; the current transparent Studio lighting pass has no background refraction or samplers and does not import this adapter. These sources remain reference, not an active second renderer.
