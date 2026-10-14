# liquid-glass-react

Copyright 2025 MAX ROVENSKY. Licensed under MIT.

Whisper Studio vendors and uses the default React component from
[rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react/tree/ac48eab18d1f7f444ae30002d240cae29c863a21),
commit `ac48eab18d1f7f444ae30002d240cae29c863a21`, version `1.1.1`.
The full [MIT license](../../src/renderer/vendor/liquid-glass-react/LICENSE),
[copied component](../../src/renderer/vendor/liquid-glass-react/index.tsx), and
[documented integration changes](../../src/renderer/vendor/liquid-glass-react/UPSTREAM.md)
accompany the source.

The complete original SVG edge-mask, RGB refraction and channel recombination
pipeline is retained. Embedded displacement maps remain in `utils.ts`, and the
optional shader map generator retains upstream's `shuding/liquid-glass`
attribution. Demo assets are excluded. Local patches bound generated map size and
cache entries, replace broad CSS transitions, size with ResizeObserver, and permit
the existing Jelly gesture controller to own elastic motion without duplicate
pointer work. Firefox's upstream SVG-filter fallback is preserved.
