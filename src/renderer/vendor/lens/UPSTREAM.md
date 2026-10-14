# Lens gesture source

Lens source is pinned to ruiqichenbiec/design-systems commit 7a424c93b9be13cf835b91ea67495fec2ec0584e (MIT; see LICENSE). The active application uses motion-runtime.js, Jelly physics, focus support, the segmented factory and the switch extracted from original components.js.

The WebGL createGlassSystem runtime remains retained upstream source, but is no longer imported by the active application. rdev/liquid-glass-react owns local optical material. No DOM capture, full-page framebuffer or Canvas2D output transfer is active.

Integration changes: existing React hosts; controlled values with lg:set/lg:sync; disabled and keyboard handling; per-body listeners/observer cleanup; interruptible pointer/touch springs; reduced motion; direct element transform writes rather than inherited variables; fixed workbench panels. Source, license and performance patches for the actual React material are documented in ../liquid-glass-react/UPSTREAM.md.
