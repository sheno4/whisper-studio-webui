# Verification · 2026-09-18

- `npm test`: 17 passed, 0 failed. Covers production PCM synthesis, default material, token immutability, lazy audio, rate limiting, six-voice limit, mute cancellation, persistence, unavailable audio, extension registration, portable imports, bilingual strings, existing spring behavior and shared keyboard-focus modality.
- `npm run check`: 26 JavaScript modules and extracted standalone scripts passed syntax checks.
- `npm run build`: Chinese and English standalone HTML rebuilt successfully.
- TypeScript: `examples/typed.ts` compiled with strict mode, ES2022, NodeNext and DOM declarations, without errors.
- Browser: the lab and live component catalog were inspected at desktop and 390 × 844 mobile sizes. The mobile catalog and lab had no horizontal document overflow.
- Browser interactions: switch click and drag commit; choice keyboard selection; slider keyboard increment; stepper; dismiss/restore; mute and stored preferences; independent example integration; lens keyboard movement and pointer drag.
- The active switch thumb remains visible above its rail. The dark scene uses readable action text and a light slider thumb. Console errors were empty in the inspected lab, catalog and independent example.
- Focus update: browser inspection confirmed that clicking a choice leaves its outline hidden, arrow-key selection displays the outline, wheel input hides it while keeping the selected control focused, and Tab restores the outline on the next control. The lab's custom checkbox focus proxy follows the same rules. Unit tests also cover pointer movement, touch, held-key repeat after pointer input, modifiers, document blur/visibility and independent mount/cleanup.

Browser automation blocked the `file:` URL for the standalone preview. These two files were rebuilt and syntax-checked; the HTTP module version was used for browser verification. No workaround to that browser policy was used.

Audio validation covers generated samples, playback service behavior and live control wiring. It is not a listening review across physical devices. CSS/WebGL fallback and reduced-motion paths retain their implementation, but were not exhaustively tested across browsers.
