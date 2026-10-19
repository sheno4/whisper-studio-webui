# Lens gesture source

Lens source is pinned to ruiqichenbiec/design-systems commit 7a424c93b9be13cf835b91ea67495fec2ec0584e (MIT; see LICENSE). The active application uses motion-runtime.js, Jelly physics, focus support, the segmented factory and the switch extracted from original components.js.

The WebGL createGlassSystem runtime remains retained upstream source, but is not imported by the application. The browser-native rdev/CSS backdrop stays continuously active; the separate bounded Studio WebGL2 scene adds transparent local lighting only. The former liquidGL DOM raster is not imported by production. Lens supplies native components and motion without launching a second background renderer or transferring a framebuffer into per-control canvases.

Integration changes: existing React hosts; controlled values with lg:set/lg:sync; disabled and keyboard handling; per-body listeners/observer cleanup; interruptible pointer/touch springs; reduced motion; direct element transform writes rather than inherited variables; fixed workbench panels. Source, license and performance patches for the actual React material are documented in ../liquid-glass-react/UPSTREAM.md.

Held segment and switch gestures now set presentation positions directly from
pointer deltas, preserving the grabbed local point even when interrupting a
release spring. Their held body transform has no additional pressure scaling;
release alone starts the spring and carries the last non-stale pointer velocity.
Only the selected segment capsule starts a segment drag; other tabs keep native
click/keyboard commits. Cancel, Escape, inherited fieldset disabled state and
external controlled changes restore the committed position. Panels do not drag.

The controller advances only `activeBodies`, caches rail/thumb geometry outside
animation frames, and dispatches `lg:optics` for native rdev material and
`lg:material` for the unified scene. IshiakiZ's proportional grab and width fit
keep the current presentation rectangle aligned while crossing differently sized
slots. Hidden documents cancel queued frames; unregistration disconnects the
body's observers/listeners and restores the previous transform. The optical
controllers do not transform native labels a second time.

The segment rail uses layout containment with visible overflow. The selected
capsule's spring overshoot, horizontal stretch and vertical lift remain visible
decorative ink instead of extending an outer form's scrollable area. The
neighbour and menu-tail anchors have zero area with the same non-clipping
containment. This does not clamp the original spring or replace its gesture.
Neighbour viewport rectangles add the rail border once when converting its
padding-relative option offsets; the main indicator keeps the original
padding-relative `offsetLeft` target.

`progress.js` directly extracts `createOpticalProgress` and its DOM/rim/pulse
helpers from `lens/lab/design-system/optical-components.js` at this same pinned
revision. Original lines 1–97 are retained in `upstream/optical-progress.js.txt`;
`PROGRESS-SOURCE.json` records source and license hashes. The factory's original
track, fill, emitter, fiber, completion state and `setValue` handle are retained.
`glass/GlassProgress.tsx` owns an empty React host and updates the same instance;
it adds unknown-progress ARIA, compact stable captions and visibility-aware
motion. Progress changes do not create GPU registrations, timers or RAF loops.
The adapter pauses the original fiber and indeterminate CSS motion when hidden,
offscreen, stopped or reduced motion is requested.

`slider.js` extracts the real `defineComponent('slider')` factory from the same
revision's `lens/lab/design-system/components.js`. The original factory fragment
is in `upstream/slider-factory.js.txt`; `SLIDER-SOURCE.json` records its source
range and hash. Its label, output, native range, wrapper, thumb, value callback
and `lg:sync` path are preserved. `glass/GlassSlider.tsx` adapts the factory's
DOM rather than replacing it with a separate component tree. The shared Jelly
controller owns held/release transforms. Both axes use the pinned IshiakiZ
rational `sliderBand` helper, scaled to an 8px horizontal and 14px vertical
asymptote. A local inverse of that same curve preserves the presented position
when a returning thumb is grabbed again. Endpoints use native thumb-center
travel and retain the grabbed pointer offset; semantic range values stay
clamped by the native input. Release inherits resisted presentation velocity,
and `projectSlider` feeds optical bend without changing the value. Reduced
motion bypasses elastic displacement. These integration changes do not alter
the retained source fragment or its source hashes.

The track is extracted from the native pseudo-track into one noninteractive
`data-liquid-backdrop` decoration. The range remains a transparent hit/focus
layer above the 24px circular glass thumb. The material host is the thumb itself,
rather than the full rectangular wrapper. The browser composites the live
backdrop under that host; the track remains a single capsule behind it, and fill
updates neither capture a texture nor launch another renderer.
