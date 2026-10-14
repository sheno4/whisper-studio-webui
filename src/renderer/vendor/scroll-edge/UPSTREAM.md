Scroll edge CSS and its bar-measurement behavior are adapted from
[Liquid Glass for the Web](https://github.com/IshiakiZ/liquid-glass-web).

Pinned revision: `ea8b7378c3cfff080ef86a32d808131353f5bac9`.

Original source sections:

- `liquid-glass.css`, `27-scroll-edge.css`, lines 1743–1865.
- `liquid-glass.js`, `comp-scroll-edge.js`, lines 6449–6564.

Adapted files: `../../glass/useScrollEdge.ts` and `../../styles/scroll-edge.css`.

The original three masked backdrop layers (2 / 6 / 12 px) and page-color fade
are preserved. The adapter anchors independent bands to local scroll viewports,
measures sticky bars with their 20 px overlap, hides bands at content boundaries,
and cleans up listeners and observers on unmount. It never wraps or masks glass
controls and does not intercept wheel, touch or keyboard scrolling.

License: MIT; the complete upstream notice is preserved in `LICENSE`.
