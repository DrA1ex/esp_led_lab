# Remote Output (browser → ESP)

The lab can now send **derived DSP features**, not PCM audio, to one or more ESP
LED lamps over a LAN. The local preview and file/demo/microphone inputs
remain usable with streaming off. This is a browser-side implementation;
**real ESP hardware has not yet been tested**. The control messages and 32-band binary format were checked against the source of `DrA1ex/esp_led_lamp` branch `feature/remote-audio-dsp`, including its lab-compatibility handshake, clock, start and status commands.

1. Run `make serve` and open `http://localhost:8000/`. Alternatively open
   `dist/standalone.html` for file/demo visualization; microphone and WebSocket
   permissions can vary for standalone `file://` URLs.
2. Find **Lamps over Wi-Fi** under the player. Enter your device's
   hostname or IP, click Connect, and wait for a `ready` handshake and clock
   sync. Connect additional lamps individually, and select which should stream.
3. Select 16, 32, or 64 logarithmic bands (default 32); **16 and 64 require
   explicit `band_counts`/`supported_bands` capability acknowledgement** from
   the receiver. The original draft protocol specified only 32 bands.
4. Audio-feature streaming is **enabled by default**. Connect the lamp and
   start the demo, a file, or the microphone. Uncheck the streaming toggle
   only when you want the lamp connected but idle. No decoded PCM is sent,
   and a remote connection stays open when streaming is disabled.
5. The signed latency adjustment delays (+) or advances (-) the requested
   presentation timestamp. Negative adjustment is not guaranteed to be
   achievable for a live microphone; the app does not claim hardware-measured
   end-to-end audio-to-light latency.

## Packet layout and control contract

All multi-byte integer fields use little-endian encoding. A version-1 binary
`AUDIO_FRAME` is `38 + 2 * band_count` bytes (70, **102**, or 166 bytes).
The first 38 bytes contain ASCII `ELAF` (4), version (1), type (1), flags (1),
count (1), session ID (4), sequence (4), sender presentation timestamp in
monotonic milliseconds (4), RMS/bass/mid/high/peak/onset strength (6×2), onset
mask (1), beat phase (1), BPM×10 (2), confidence (1), reserved (1). The payload
contains `band_count` unsigned 16-bit amplitude values in ascending logarithmic
frequency order, scaled to `0..4096`.

**JSON messages:** `hello`/`hello_ack`, `sync`/`sync_ack`, `clock`,
`config`, `start`, `stop`, `status`. They are implemented in `web/remote.js`;
The control exchange has been compared against the firmware source on
`feature/remote-audio-dsp`. On the current ESP8266 firmware only **32 bands**
are accepted; 16/64 are retained for future compatible receivers. Browser
`ready` means a successful clock acknowledgement, not audio playback.
No credentials are stored in the standalone file, no preset persistence is
requested. Non-TLS `ws://` can be blocked when the page itself uses HTTPS.

At 16 kHz sample rate, an FFT of 256/512/1024 has frequency-bin widths of
62.5/31.25/15.625 Hz. Narrow low-frequency remote bands overlap FFT bins;
**64 output bands are not 64 independently resolved frequency measurements**.
The native 16-band preview remains unchanged; 32 and 64 are derived from the
**same existing C++ FFT**, with no additional transform in JavaScript.

## Tests

```sh
node tests/test_remote_audio.js
python3 tests/test_remote_browser.py
python3 scripts/mock_remote_receiver.py --port 8765
```

`test_remote_audio.js` verifies exact byte offsets, three payload sizes, and
WASM spectral outputs. `test_remote_browser.py` runs Chromium with **fake
WebSocket endpoints** and tests handshake, clock sync, two devices, 16/32/64
band changes, and pause/resume. The mock receiver is an actual small WebSocket
server for manual end-to-end testing on a machine that permits local sockets;
it accepts the **provisional** JSON contract and validates binary packets.
The environment used to produce this archive blocked Chromium navigation to
localhost, so a physical ESP receiver and real network transport have not
been exercised in that environment. `tests/test_firmware_browser_contract.py`
checks `hello_ack`, `clock_ack`, `start_ack`, and `status.playing` against a
browser-side mock of the ESP8266 receiver's actual 32-band contract.


## Responsive workstation layout

The preview is now capped at 208 px per matrix on desktop and 200–230 px on smaller layouts, rather than scaling to the full page width. At widths of 1200 px and above, the matrix comparison, transport, playback volume and LED reaction sliders, and Remote Output controls share a two-column sticky workspace while the settings panel scrolls independently. If the browser window is too short to show the whole workspace, its left side can scroll without hiding the controls entirely. Below 1200 px the workspace is static, and the existing compact floating canvas preview follows page scrolling. The responsive layout is CSS-only; rendering and DSP timing do not depend on canvas display size.

**Volume controls:** “Volume” adjusts only the audible file/demo Web Audio gain; it does not alter analysis input, remote packets or microphone capture. “LED reaction” is the existing `mix` / audio-strength control relocated from the settings sidebar. Both sliders remain immediately accessible next to the player on desktop.


## Troubleshooting: WebSocket connected, but ESP replies `playing:false`

The firmware sends `playing:false` in **responses to status polling** when
it has not accepted a `start`, or when its 300 ms audio stream watchdog has
timed out. The application does **not** send `playing:false` commands. An
open WebSocket alone is not an active audio session.

In this revision the audio-streaming checkbox defaults to on, and `ready`
requires `clock_ack`. Start an audio source and inspect the per-device line:
`ESP playing` means the receiver acknowledged streaming, `TX` counts
WebSocket binary frames sent, and `RX` counts frames accepted by the ESP.
`ERROR` shows explicit firmware rejections. For this firmware select 32
bands; selecting 16 or 64 displays a receiver capability warning. If `TX`
increases but `RX` stays at zero, verify device firmware build, timestamps,
and packet status; if both stay at zero, verify browser playback, streaming
checkbox, and the device's `ready` handshake.

## Feature semantics, tuning and clock (strip revision, 2026-10-28)

Changes made together with the firmware (`esp_led_lamp`, `feature/remote-audio-dsp`):

- **`rms` is the normalised loudness envelope.** It used to carry the raw
  Hann-windowed frame RMS × 4, which depended on the track's mastering level
  and the microphone gain and rarely used more than ~40 % of the range, so
  Line / Brightness / Speed on the lamp barely moved for quiet sources. The
  frame now carries `newLoudness` (the AGC'd RMS envelope, the new-FFT
  default control source). The new-FFT Wave history also follows loudness,
  matching the lamp's own 25 ms `rms` history.
- **Reaction tuning is sent in `config`** and applied by firmware that
  advertises `"tuning"` in `hello_ack` (older firmware ignores the fields):
  - `param_source` 0–7: loudness, spectral, bass, mid, high, peak, onset,
    beat — the "Signal source" selector, used by Brightness, Line and
    Speed/Scale/Light;
  - `speed_floor` 0–255: Speed Control lower bound;
  - `spectrum_shape`, `spectrum_onset` 0–100 %: the brighter Wave/Spectrum
    curve and onset accents. Both 0 reproduce the stock `dim8_raw` curve.
  
  Not transmitted: "LED reaction" (mix) and "Fast line response"; the lamp
  renders those at 100 % and with the control source only.
- **Clock sync**: five `sync` probes at connect, then one every 5 s, also
  while streaming. The offset comes from the lowest-RTT sample of the last
  30 s (previously: the lowest RTT ever, i.e. frozen at connect, so crystal
  drift accumulated over long sessions until frames went stale). `clock` is
  re-sent only when the rounded offset changes, and a resync no longer leaves
  the `ready` state, which used to skip frames for one round trip.
- **Geometry**: `hello_ack.width/height` are shown per device; the device
  button or the "From connected ESP" geometry option makes the preview use
  the lamp's WIDTH × HEIGHT (matrix or strip).

## Reaction range, start point and a single preview (2026-10-28)

- **Signal window** (`input_min`, `input_max`, `input_gate`): the *Reaction
  range* block stretches a chosen input range onto the reaction range and can
  cut everything below it to 0. Same rule as firmware `audioTransfer()`.
- **Origin** (`origin_shift` in ‰ of WIDTH, `origin_reverse`, `origin_ring`,
  `origin_radial`, `origin_y`): the *Start and direction* block moves the
  start of every spatial mode and the center of the Center modes. The slider
  counts LEDs and is sent as permille of the preview width, which round-trips
  exactly up to 1000 LEDs; set the preview geometry to the lamp's size (or
  *From connected ESP*) for a 1:1 position. Same mapping as firmware
  `RemoteReactive::OriginMap`.
- The side-by-side preview of the firmware's original DFT/volume analyzers
  was removed from the page: the comparison is finished, and the page now
  shows one preview, computed from the features the lamp receives. The
  original analyzers stay in `src/dsp.cpp` for the regression tests.
- The UI is in English, matching the firmware.
- **Analyzer**: FFT sizes up to 8192 and a frequency range (default
  40 Hz – 8 kHz, the former fixed band tables). The 32 transmitted bands are
  logarithmic inside the chosen range, so the lamp's spectrum follows it
  without protocol changes. Band levels are the RMS of the FFT bins scaled
  by `sqrt(n / 512)`, which keeps tones from fading at large FFT sizes.

