# VEIL Guard native filter

Build with OBS's pinned SDK using the repository build scripts. The portable CTest target runs independently of OBS and keeps its assertions enabled in Release builds.

Windows CI uses the Visual Studio 2022 image. `cmake --install` stages `dist/obs-plugins/64bit/veil-guard.dll` and `dist/data/obs-plugins/veil-guard/locale/`. Copy those two directories into the corresponding directories of your OBS installation, then restart OBS. Local MinGW smoke binaries may instead be directly under `dist/`.

macOS stages `dist/veil-guard.plugin`. Copy the complete bundle into `~/Library/Application Support/obs-studio/plugins/`, then restart OBS. Do not copy a bare dylib. macOS packaging is unsigned; runtime permission and real-stream checks remain separate from the build.

Add the VEIL Guard filter through VEIL onboarding or OBS source filters. Paranoid is the default: frames newer than the last confirmed sample stay covered, including periods when the worker is too busy to submit another sample. Balanced is an explicit opt-in that allows unknown/late output. The default delay is not a claim of sufficient inference speed. Inspect pre-flight timing and actual output.

The detector endpoint is fixed to loopback. Point the filter to VEIL's local token JSON and matching port. Do not expose this port over a tunnel. This plugin is GPL-2.0-or-later; see LICENSE.md and UPSTREAM-LICENSE.
