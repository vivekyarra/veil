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

## Defaults

| Setting | Default | Range | Notes |
| --- | --- | --- | --- |
| Video delay | 2500 ms | 300–6000 ms | Measured CPU detector round trip is p50 1.35 s / p99 2.49 s. With two requests in flight at 4 samples/s, results normally land before frames leave the buffer. A shorter delay keeps Paranoid output covered; the status line warns when the delay is below p99 plus one sample interval. |
| Sample FPS | 4 | 1–10 | Frames between two samples get the union of both samples' boxes, so text that moved or scrolled stays masked. |
| Concurrent detector requests | 2 | 1–4 | Matches the detector's engine-pool default. Results may arrive out of order; each is matched to its own sample and confirmation never moves backwards. |
| Delay buffer memory cap | 640 MiB | 128–4096 MiB | See below. |
| Mask color | `#7c5cff` (VEIL purple) | any, always drawn opaque | Also used for full-frame holds, so viewers can tell something was hidden. |

Fail-closed rules: a sample with no result, a failed or malformed detector response (including a reply without `detections`), a result for a different frame, or a stale result from before a resolution change or flush leaves its frames unconfirmed. Paranoid covers them. If a result has more boxes than the mask table holds (1024 per filter), its frames are covered in every profile instead of being shown with boxes missing. Boxes that overhang the frame edge are clipped, not dropped.

When the source is hidden, deactivated, bypassed, or not rendered for more than 500 ms, the buffer is flushed and output stays covered until it refills (one delay period). The status line reports "Connected" only if a result arrived in the last 3 seconds.

## Memory

The delay buffer stores each output frame as 4:2:0 BT.709 full-range Y'CbCr: an R8 luma texture plus a half-resolution R8G8 chroma texture, 12 bits per pixel, packed and unpacked by `data/veil-yuv.effect`. That is `width × height × 1.5 × (delay × fps + 2)` bytes of GPU memory, with fps rounded up (59.94 counts as 60), plus one RGBA working frame.

| Source | Frames at 2.5 s | 4:2:0 buffer | RGBA would need |
| --- | --- | --- | --- |
| 1920×1080, 60 fps | 152 | 451 MiB | 1202 MiB |
| 2560×1440, 60 fps | 152 | 802 MiB | 2138 MiB |
| 3840×2160, 30 fps | 77 | 914 MiB | 2436 MiB |

1080p60 fits the 640 MiB default cap at full resolution; raise the cap to 1024 MiB for 1440p60 or 2160p30. Masks and full-frame holds are drawn after unpacking, at output resolution and in the exact mask color. The image itself differs from the source by at most 2 code values on flat color, plus 4:2:0 chroma subsampling at sharp color edges. Transparency is preserved: with **Preserve transparency** set to On (or Auto, for sources that have alpha) an extra 8-bit alpha plane is delayed with the frame, which raises 1080p60 to about 751 MiB, so raise the cap to 1024 MiB. Set it to Off to composite transparent pixels over black and save that memory.

Only if the ring would exceed the cap is it stored at the largest reduced size that fits, and scaled back up on output. This is never silent: the filter's **Buffer** status line shows the stored resolution, the source resolution, the memory full resolution would need, and the cap, and OBS's log records a warning. If `veil-yuv.effect` cannot be loaded, the filter falls back to RGBA frames (32 bits per pixel) and says so in the status line.

## Limitations

The plugin delays and masks **video only**. Audio is not filtered: VEIL delays OBS audio sources by the same amount when it applies the filter, and the VEIL app mutes audio on panic. Speech that reveals private information is not detected or removed by the plugin.

## Build the plugin

Use the repository's `scripts/build-plugin.ps1` or `scripts/build-plugin.sh`. Builds use the official OBS template and pinned SDK. Portable CTest runs independently of OBS, with assertions enabled in Release builds.

Windows staging contains `dist/obs-plugins/64bit/veil-guard.dll` and `dist/data/obs-plugins/veil-guard/` (`veil-yuv.effect` and `locale/`); macOS staging contains the complete `dist/veil-guard.plugin` bundle.

The detector endpoint is IPv4 loopback with a per-install bearer token. Onboarding supplies the local token file and port. Keep this endpoint local.

Plugin license: [GPL-2.0-or-later](LICENSE.md). [Upstream license](UPSTREAM-LICENSE).
