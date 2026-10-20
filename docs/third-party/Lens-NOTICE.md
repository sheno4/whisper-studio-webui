# Lens Design System

Copyright (c) 2026 DayDreamInAReverie. Licensed under MIT.

Whisper Studio includes the complete portable package from
[ruiqichenbiec/design-systems](https://github.com/ruiqichenbiec/design-systems/tree/7a424c93b9be13cf835b91ea67495fec2ec0584e/lens/lab/design-system),
commit `7a424c93b9be13cf835b91ea67495fec2ec0584e`, version `1.1.0-showcase.1`.

The unmodified package is in `src/renderer/vendor/lens-native/`, with the full
[MIT license](../../src/renderer/vendor/lens-native/LICENSE),
[source information](../../src/renderer/vendor/lens-native/UPSTREAM.md) and
[integrity manifest](../../src/renderer/vendor/lens-native/SHA256SUMS).

Its components, Jelly physics, WebGL renderer and styles are used by the current
frontend. Application integration lives in `src/renderer/lens/` and
`src/renderer/glass/`. The extracted Lens copy and retired mixed-material providers
have been removed. See the [integration overview](../lens-native-rewrite.md).
