# Source provenance

This personal prototype was built at the user's request from their installed Meet Vanish extension.

- Upstream: https://github.com/deniza-png/snap
- Inspected upstream commit: 15e9d451e4d80ec366a7250373e4af2c3d0b689c (Meet Vanish 1.7.2)
- Adapted: camera wrapping and track lifecycle, transient snap detector, room capture, and portions of regression test infrastructure.
- Added/reworked: Clone Army compositor, synchronized frame/mask cutouts, extension identity and settings, segmentation-only background/offscreen lifecycle, private camera studio, popup, floating controls, icons, and browser tests.
- Bundled MediaPipe runtime and person model are preserved from upstream. Third-party notices are retained in extension/THIRD-PARTY-NOTICES.md and extension/vendor/LICENSE.txt. The unused hand model and dust renderer are omitted.

Upstream does not declare a license for its first-party code. No new license is asserted over that code. This is a local personal prototype, not a marketplace release or an assertion of redistribution rights.
