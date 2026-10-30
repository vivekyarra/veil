# VEIL Guard for OBS

## Install the release

Download the plugin for your platform from [VEIL releases](https://github.com/vivekyarra/veil/releases). Close OBS before installing and restart it afterward.

### Windows x64

1. Extract `VEIL-Guard-windows-x64.zip`.
2. Copy its **`obs-plugins`** and **`data`** directories into your OBS installation, normally `C:\Program Files\obs-studio`. Merge the matching directories.
3. Confirm these files exist:
   - `C:\Program Files\obs-studio\obs-plugins\64bit\veil-guard.dll`
   - `C:\Program Files\obs-studio\data\obs-plugins\veil-guard\locale\en-US.ini`
4. Restart OBS. Select a streaming scene, open **Filters**, and confirm **VEIL Guard** is available. VEIL Onboarding can add and configure the filter for you.

For portable OBS, use that installation's root in place of `C:\Program Files\obs-studio`.

### macOS

Run `VEIL-Guard-macos-universal.pkg`, then restart OBS. The plugin supports Apple Silicon and Intel; the VEIL desktop DMG targets Apple Silicon.

For manual installation, copy the complete `veil-guard.plugin` bundle into `~/Library/Application Support/obs-studio/plugins/`. Keep the bundle intact. Current packages are unsigned; verify the release's checksums and use the operating system's normal application-opening controls.

## Connect and check

1. Enable OBS WebSocket in **Tools → WebSocket Server Settings** and keep its password private.
2. In VEIL Onboarding, connect to the local OBS WebSocket and select your streaming scenes. **VEIL Cover** is reserved for incident response.
3. Choose **Add filters & sync audio**, run Rehearsal, and open Pre-flight. Apply the measured delay when offered, then inspect actual OBS output.

Paranoid is the default: frames newer than the last confirmed sample stay covered, including when the worker is busy. Balanced is an explicit choice that permits late output. VEIL records original audio offsets before applying the video delay and restores them on exit or reconnect after a crash. [Operating guide](../docs/acceptance.md).

## Build the plugin

Use the repository's `scripts/build-plugin.ps1` or `scripts/build-plugin.sh`. Builds use the official OBS template and pinned SDK. Portable CTest runs independently of OBS, with assertions enabled in Release builds.

Windows staging contains `dist/obs-plugins/64bit/veil-guard.dll` and `dist/data/obs-plugins/veil-guard/locale/`; macOS staging contains the complete `dist/veil-guard.plugin` bundle.

The detector endpoint is IPv4 loopback with a per-install bearer token. Onboarding supplies the local token file and port. Keep this endpoint local.

Plugin license: [GPL-2.0-or-later](LICENSE.md). [Upstream license](UPSTREAM-LICENSE).
