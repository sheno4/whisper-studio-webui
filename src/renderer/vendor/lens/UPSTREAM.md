# Lens gesture source

Lens source is pinned to ruiqichenbiec/design-systems commit 7a424c93b9be13cf835b91ea67495fec2ec0584e (MIT; see LICENSE). The active application uses motion-runtime.js, Jelly physics, focus support, the segmented factory and the switch extracted from original components.js.

The WebGL createGlassSystem runtime remains retained upstream source, but is no longer imported by the active application. rdev/liquid-glass-react owns local optical material. No DOM capture, full-page framebuffer or Canvas2D output transfer is active.

Integration changes: existing React hosts; controlled values with lg:set/lg:sync; disabled and keyboard handling; per-body listeners/observer cleanup; interruptible pointer/touch springs; reduced motion; direct element transform writes rather than inherited variables; fixed workbench panels. Source, license and performance patches for the actual React material are documented in ../liquid-glass-react/UPSTREAM.md.

Held segment and switch gestures now set presentation positions directly from
pointer deltas, preserving the grabbed local point even when interrupting a
release spring. Their held body transform has no additional pressure scaling;
release alone starts the spring and carries the last non-stale pointer velocity.
Only the selected segment capsule starts a segment drag; other tabs keep native
click/keyboard commits. Cancel, Escape, inherited fieldset disabled state and
external controlled changes restore the committed position. Panels do not drag.

The controller advances only `activeBodies`, caches rail/thumb geometry outside
animation frames, and dispatches local `lg:optics` events for the matching rdev
material. It does not build unused shader shape arrays or query all body geometry
per frame. Hidden documents cancel queued frames and resume on visibility; body
unregistration disconnects its listeners/availability observer, removes active
membership and restores its previous transform. The rdev controller performs the
optical SVG updates separately and never transforms native labels again.
