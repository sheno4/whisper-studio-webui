# Lens Design System

Copyright (c) 2026 DayDreamInAReverie. Licensed under MIT.

Whisper Studio directly includes the Lens runtime from
[ruiqichenbiec/design-systems](https://github.com/ruiqichenbiec/design-systems/tree/7a424c93b9be13cf835b91ea67495fec2ec0584e/lens/lab/design-system),
commit `7a424c93b9be13cf835b91ea67495fec2ec0584e`, version `1.1.0-showcase.1`.
The full [MIT license](../../src/renderer/vendor/lens/LICENSE) and
[integration changes](../../src/renderer/vendor/lens/UPSTREAM.md) accompany the copied source.

The application uses the original WebGL2 renderer, optical shaders, material presets,
Jelly physics, shared surface factory, focus support and CSS fallback. React owns
semantic controls and business callbacks. Small documented integration patches add
existing-host binding, title-only drag handles, dynamic cleanup and reduced-motion behavior.

The original renderer samples its scene artwork and previously composited lenses;
it does not capture arbitrary DOM, video, screenshots or external pages.
Whisper Studio supplies background artwork and CORS-permitted wallpaper pixels.
The upstream audio module is a runtime dependency; audio is explicitly disabled.

The prior Kyant SVG adaptation has been removed from the active source.
