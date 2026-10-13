# Lens runtime source

Copied from [ruiqichenbiec/design-systems](https://github.com/ruiqichenbiec/design-systems/tree/7a424c93b9be13cf835b91ea67495fec2ec0584e/lens/lab/design-system), commit `7a424c93b9be13cf835b91ea67495fec2ec0584e`, package version `1.1.0-showcase.1`, under the included MIT license.

This directory contains the dependency closure for the original `createGlassSystem()` runtime and shared `createLensSurface()` factory, original tokens and material CSS, and upstream TypeScript declarations. It does not include showcase pages, demo content, component catalogs, or build tools. The sound module is an upstream runtime dependency; the application passes `{enabled:false, storage:null}` and does not create or play audio.

Whisper Studio uses one native WebGL2 stage. Lens refracts its own scene artwork framebuffer and composites registered lens surfaces. It does not capture arbitrary DOM or screenshots. The application provides sampled background artwork and CORS-permitted wallpaper pixels. Semantic React DOM continues to own all application controls and business actions.

Small integration changes:

- `runtime.js`: forwards renderer state notifications; accepts `data-lg-drag-handle` for title-only panel gestures; prunes detached registrations; limits button press travel; removes owned stage state on destroy.
- `internal/lens-surface.js`: accepts an existing React element, preserves its classes, and restores binding attributes on cleanup.
- `internal/jelly.js`: per-surface cleanup via `unregister()`, interactive descendant guards, interruptible grabs from the presented spring position, strict reduced-motion translation without deformation or inertia, neutral deformation targets on cancellation, Escape cancellation limited to an active gesture, and full controller cleanup.
- `internal/renderer.js`: excludes DOM overlays from the sampled scene so menus and dialogs use the original CSS material fallback; observes page scroll for sticky workbench geometry; defers context restoration until the loss event has finished dispatching and cancels pending restoration when suspended or destroyed.
- `index.d.ts` and adjacent declarations: describe the small integration additions and direct runtime imports.

The shader, Snell refraction, chromatic dispersion, ping-pong compositor, physics functions, context budget, material presets, and focus behavior remain the upstream implementations.
