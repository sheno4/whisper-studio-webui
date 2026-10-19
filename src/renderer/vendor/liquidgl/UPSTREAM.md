# liquidGL

Repository: https://github.com/naughtyduk/liquidGL
Pinned revision: `88f681ab7035fd55b04f63edff1841e32c4199e9` (MIT, NaughtyDuk).

`liquidGL.js`, `LICENSE`, `README.upstream.md`, and `package.upstream.json` retain the upstream source and notices. `liquidGL.js` SHA-256 is `1025e58436096a8d66ba787fac840ebd2e211c29835cd4c356f4d268f58b8926`, verified against the fixed revision's `scripts/liquidGL.js`. `dom-raster.js` is the upstream `NaughtyDOM` closure extracted into an ES module. Local changes export the closure, add cache release, and allow ready HTML video frames through the existing replaced-element painter (using video dimensions and volatile invalidation). DOM measurement, asset loading, clipping, text rendering, and incremental `paintLayer` otherwise remain upstream implementations. `dom-raster.d.ts` describes the used interface.

This DOM measurement/paint engine is no longer imported by the production material path. Its approximate paint plan could not reproduce the browser's actual backdrop and was removed from `glass/unified-scene.ts`. The source and extracted adapter remain for provenance/reference only. There are no DOM background captures, background texture uploads, upstream renderer, snapshot scheduler or per-lens background mirrors in the active material architecture. Native rdev/CSS filtering samples the browser-painted backdrop; Studio contributes transparent lighting separately.

The inactive extracted adapter also masks nonempty `input[type=password]` values with bullet characters before creating text runs. Empty password fields retain their placeholder. The unmodified upstream file is kept for source comparison. This historical adaptation does not imply that the product currently captures any fields.

`data-liquid-backdrop` declarations retained in the DOM are historical metadata. No raster engine or background refresh scheduler consumes them. This source is not counted as an active liquidGL renderer integration.
