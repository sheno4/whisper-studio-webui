# Liquid Glass for the Web: native control behaviour

Source: https://github.com/IshiakiZ/liquid-glass-web

Pinned revision: `ea8b7378c3cfff080ef86a32d808131353f5bac9` (verified against the local upstream checkout).

License: MIT; `LICENSE` is copied without changes. The files in `upstream/` are original, inert source excerpts from that revision's unminified `liquid-glass.js`:

| Retained original | Original lines | Active extraction |
| --- | --- | --- |
| motion.js.txt | 1407–1672 | motion terminology and spring reference; Lens retains its existing bounded-step spring |
| materialize.js.txt | 3625–3735 | `menuOrigin`, `menuMaterializeRect` |
| menu.js.txt | 6218–6447 | `MENU_MATERIALIZE`, `placeMenu` |
| slider.js.txt | 7063–7383 | `sliderBand`, `projectSlider`, projection constant |
| switch.js.txt | 7385–7566 | `SWITCH_LIFT`, `scrubSwitch`, `switchRelease` |
| pill-segmented.js.txt | 7568–8628 | `SEGMENT_LIFT`, `scrubSegment`, proportional grab, width fit |

`controls.js` exports behaviour and geometry only. It neither initializes upstream's global controller nor attaches another input listener. Existing Lens native buttons and React controlled values remain the event owners. Jelly uses the upstream scrub resistance, proportional grab and variable-width fit while keeping direct held motion. It scales its target box with a width spring and updates the corresponding x from the current presentation width. The shared material scene reads the resulting real DOM rectangle, so width and optics agree.

The existing scroll-edge adaptation is still documented under `../scroll-edge/UPSTREAM.md`; its source and provenance are not duplicated into a second active scroll controller.

Deliberate integration changes: export the pure calculations; keep held positioning direct; retain existing cancellation and focus semantics; express materialization scale as a viewport rectangle for one shared optical scene; retain menu placement as a geometry helper while Base UI owns popup placement, focus and dismissal. Reduced motion, close state, hidden documents, disabled controls and unmount clear the appropriate motion state. No auto-init bundle or original demo is loaded.
