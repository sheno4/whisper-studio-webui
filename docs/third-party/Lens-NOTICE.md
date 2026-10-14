# Lens Design System

Copyright (c) 2026 DayDreamInAReverie. Licensed under MIT.

Whisper Studio directly includes the Lens runtime from
[ruiqichenbiec/design-systems](https://github.com/ruiqichenbiec/design-systems/tree/7a424c93b9be13cf835b91ea67495fec2ec0584e/lens/lab/design-system),
commit `7a424c93b9be13cf835b91ea67495fec2ec0584e`, version `1.1.0-showcase.1`.
The full [MIT license](../../src/renderer/vendor/lens/LICENSE) and
[integration changes](../../src/renderer/vendor/lens/UPSTREAM.md) accompany the copied source.

The active application uses Jelly physics, the shared surface binding, segmented
control, extracted native switch, focus support and CSS tokens. React owns semantic
controls and business callbacks; optical materials use the actual
[rdev React component](Liquid-Glass-React-NOTICE.md).

The upstream WebGL renderer and audio modules remain retained source but are not
imported by the active motion-only runtime or included in the production bundle.
There is no whole-page framebuffer, webpage raster or output-copy loop.

The prior Kyant SVG adaptation has been removed from the active source.
