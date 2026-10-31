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
  - `speed_floor` 0–255: Speed Control lower bound. The lab now always sends
    0: *Reaction from* sets the lowest speed, so a gated reaction can stop
    the effect;
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
- **Curve** (`input_curve`, exponent × 100, 25–400, 100 = linear): bends the
  stretch inside the window to `t^(curve / 100)`. LED brightness looks
  logarithmic, so ×2–×2.5 keeps quiet and mid signals dim and makes the
  reaction look even; below ×1 lifts quiet signals. The slider is
  logarithmic (centre = linear); the renderer uses the same 257-entry table
  as firmware `TransferCurve`, filled by the page.
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


## Lab-preview visualizations and 16/32/64 bands (2026-10-29)

- **Bands**: the firmware now accepts 16, 32 and 64 bands (`band_counts:
  [16,32,64]`, frame size 38 + 2 × count). *Spectrum bands* under *Lamps
  over Wi-Fi → Advanced* picks the count for the lamp and for the new
  preview modes below.
- **Visualizations**, audio modes 13–25: VU Meter,
  Spectrum Bars, Flow, Pulses, Sparkles, Mood, Waveform, Bass · Mid · Treble
  Meters, Fire, Aurora, Juggle, Radial Spectrum, Blobs (`src/viz_engine.h`). They adapt to the geometry:
  on strips (HEIGHT < 4, every row the same) they run along the LEDs from the
  start point, or out from the center with *From the center*; on matrices
  they use the height (bars from the bottom, a spectrogram, rings from the
  center) and *Mirror vertically* starts them from the middle row.
  *Colors* draws palette colors or masks the color effect; *Fall-off* and
  *Motion speed* set the meters' release and how fast Flow / Pulses move;
  *Auto-level* stretches each band's and meter's own recent range so quiet
  treble moves like the bass. The reaction range and curve apply to every
  level. The lamp renders them too (see below).

## Visualizations on the lamp (2026-10-29)

`src/viz_engine.h` is shared byte-for-byte with the firmware
(`esp_led_lamp/src/remote_audio/viz_engine.h`, effect ids 12–30 = lab modes
13–31; 12–24 before 2026-10-30, 12–29 before 2026-10-31). `render.cpp` and the firmware only supply the inputs and the pixel
output, so the lamp draws what the preview shows (random sparks aside).
The engine is integer only (Q12 levels, ms, 1/16-LED positions), because the
ESP8266 has no FPU; the lab host converts its float features to Q12.
Firmware with them lists the ids in `hello_ack.visualizations`; the lab sends
the mode and `viz_color`, `viz_mirror`, `viz_auto`, `viz_contrast`,
`viz_decay`, `viz_motion`, `viz_blur` (percent) to those lamps and Off to older ones (the lamp card
says "older firmware: no visualizations"). *LED reaction* (mix) and *Fast line
response* stay preview-only: the lamp follows the control source.
`scripts/mock_remote_receiver.py` advertises them; `--no-viz` acts like older
firmware.

## Adapt to each lamp (2026-10-29)

*Lamps over Wi-Fi → Advanced → Adapt to each lamp* (on by default) streams
per lamp instead of one stream for all:

- **Bands** follow the lamp's `hello_ack.width`: up to 24 columns → 16,
  up to 48 → 32, wider → 64 (the nearest count the lamp accepts). The global
  *Spectrum bands* is then ignored for lamps; it still sets the bands of the
  visualizations in the preview. Frames for each count are built once per moment and
  share the sequence number.
- **Card overrides** (shown on each lamp card): *Mode* (any mode; a lamp
  whose firmware lacks a visualization gets Off), *Bands* (Auto / 16 / 32 / 64) and
  *Start, LED* (the start offset in that lamp's LEDs; empty = the lab's
  offset as a share of the width). They are remembered per lamp URL and
  restart that lamp's session when changed. The card shows what is sent.

Geometry itself stays in the firmware: the stream carries audio features, not
pixels, and every lamp maps them onto its own WIDTH × HEIGHT.

## Effect parameters (2026-10-30)

Four more visualizations — Particles, Field, Zones (the constructors) and
Melody, lab modes 26–29 = firmware ids 25–28 — and per-mode **effect
parameters** for all of them: up to 11 values 0–255 in the order of
`Viz::paramDefaults()`, named in `web/js/fx-params.js`. Defaults reproduce
the earlier picture of the existing modes (Fire has a new look).

Firmware with them adds `"params"` to `hello_ack.capabilities` and
`"params_version":1`. The lab then sends, after the `config` and again only
when a value changes:

```json
{"type":"params","session":12345,"version":1,"effect":26,"values":[0,0,100,100,170,90,110,90,0,128]}
```

`effect` is the lab's mode number (26 = Particles; the firmware subtracts 1 for the lab
client, like `audio_effect`); `values` are at most the mode's count, missing
ones are defaults. The lamp replies `params_ack` or `error`/`invalid_params`.
Older firmware gets no `params` (and Off for the four new modes, which it
does not list in `visualizations`). The parameter table per mode is in the
firmware's `docs/REMOTE_AUDIO_PROTOCOL.md` (*Effect parameters*);
`tools/remote_audio_sender.py --effect 25 --params 0,4,200` sends them
without the lab.

## Groove: motion on the beat (2026-10-30)

Lab mode 30 = firmware id 29. The DSP's beat phase, BPM and confidence were
on the wire from the start (bytes 33–36 of the frame) but no visualization
used the phase. The engine host now has `beatPhase()` (Q16 turn since the
last predicted beat) and `tempoConfidence()` (Q12): the lab reads
`features[154]` and `[153]`, the lamp the frame's bytes, carrying the phase
on at the frame's BPM for the frame's age so it moves between the 50 Hz
frames.

Groove runs a beat clock of its own, a phase-locked loop pulled towards that
phase while the confidence is above 0.3 (it lets go below 0.2), and moves
its pattern — rings, spiral arms, stripes or a swinging ball; waves or a
swinging bar on a strip — one eased step per beat (*Step per beat*, *Snap to
the beat*). Bass hits and the beat itself kick the pattern outwards (*Bass
expansion*), a mid hit turns the next step round, the treble adds small
sparks. Without a confident tempo, bass and mid hits start the steps and the
pattern rests in between. On the demo it averages 0.22 of full RGB on a
16×16 matrix (Blobs 0.24, Fire 0.42). No new wire fields: older firmware
does not list id 29 and gets Off.

## Chroma and Chromatic Flow (2026-10-31)

Lab mode 31 = firmware id 30. The visualizations so far heard levels, bands,
hits and the beat, but not which notes play: a chord change was invisible
unless it moved the spectrum. The frame can now carry the **chroma**, the
share of each of the 12 notes (C, C♯ … B) with octaves folded together.

**Analysis** (`src/dsp.cpp`, `chroma_process()`). The short FFT that drives
the bands (512 points at 16 kHz: 31 Hz per bin) cannot tell a semitone apart
below about 500 Hz, and a longer one would smear the hits. So the chroma has
an analysis of its own, every 48 ms on the last ~0.5 s of the input
(`chroma_input_size()` samples, filled by `web/js/audio.js`):

1. decimation by D = round(rate / 8000) after a Blackman-windowed sinc
   low-pass at 2.7 kHz (24 · D + 1 taps; none for D = 1), so every rate is
   analysed at 7.35–11 kHz (8000 / 11025 / 8000 / 7350 / 7350 / 8000 Hz for
   8 / 11 / 16 / 22 / 44.1 / 48 kHz);
2. a 4096-point Hann FFT: 0.51 s and 2 Hz per bin at 8 kHz, two bins per
   semitone at A1 (55 Hz);
3. peaks only, and only where they stand over twice the local background
   (±max(4, k/8) bins): broadband noise and drums do not reach the notes;
4. each peak's frequency from parabolic interpolation of the log magnitudes,
   split between the two nearest semitones (a tone 45 cents sharp of A
   still reads mostly A); MIDI 32–96 (55 Hz – 2 kHz) with half-semitone fades
   at the ends;
5. folded into 12 classes, scaled so the strongest is 1 (but against at
   least 5 % of the total and 10 % of the loudest peak of the last ~8 s, so
   a quiet tail or hiss does not read as full chroma), then smoothed
   (80 ms attack, 250 ms release).

It reacts in about a quarter of a second, too slow for hits, right for
harmony. `tests/test_chroma.js` checks single tones from A1 to B6 at all six
rates (> 0.9 in their own class, < 0.1 elsewhere), C major and A minor pure
and with eight harmonics (the chord's notes on top), white noise (< 0.15),
a tone 10 dB under noise, and a change of note. The Analyzer's **Notes**
view shows it over the last 5 s.

**Wire.** Byte 37 of the frame was reserved 0, and firmware up to Groove
rejects anything else there, so the version stays 1 and the chroma is an
extension: bit 0 of byte 37 adds 12 bytes (0–255 per class) after the bands
(82 / 114 / 178 bytes for 16 / 32 / 64 bands). The lab adds it only for lamps
whose `hello_ack.capabilities` lists `chroma` (`Device.acceptsChroma` in
`web/js/remote.js`); all other lamps keep receiving the frames they know.
The lamp card says *sends N bands + notes*. The receiver interpolates the
chroma between queued frames like the bands; the engine reads it as
`Host::chroma(i)` (Q12).

**Chromatic Flow.** The notes are placed on the palette in the circle of
fifths (C, G, D, A, E …, 1/12 of the palette apart: related chords sit next
to each other, C major and A minor share two colours) or in semitone order,
and *C at* turns the circle. A slow noise field is split into regions, each
note taking a share of the lamp as large as its level, so one note colours
the whole lamp and a chord shares it between its notes. Shares are taken
from the field's own distribution (its rank over a 256-entry table), so a
short strip shares as fairly as a matrix. *Soft borders* turn the colour
halfway towards the neighbour at the border and dim it a little; *Follow*
(50 ms – 2 s) sets how fast the shares follow the notes; *Focus* leaves out
notes weaker than a share of the strongest; *Zoom* and *Drift* set the size
and speed of the regions. Bass hits and beats only add a glow (*Glow on
hits*) and swell the regions (*Swell on hits*): the colours belong to the
harmony. Without chroma (no music, or older firmware) the lamp stays dark.

**Cost.** Lab: `features` grows from 225 to 237 floats, the chroma analysis
takes ~116 KB of WASM memory (the input window at up to 6× decimation, magnitudes, filter). Lamp,
measured with `pio run -e release`: RAM 61 652 → 61 980 bytes (+328: 12
chroma bytes per queued frame and per interpolated output, a larger frame
buffer), flash 538 540 → 540 252 bytes (+1.7 KB). `tests/check_viz_integer.sh`:
the engine's code 51.8 → 55.6 KB (+3.8 KB, Chromatic Flow), its RAM unchanged
at 2 072 bytes for 16×16 (the note levels reuse the band meters); the mode
uses 512 bytes of stack while it draws (the rank table).

## Energy, Scroll, Water and Lava Lamp (2026-10-31)

Lab modes 32–35 = firmware ids 31–34. Four LedFx effects that look right on
a plain strip, rewritten from the idea in the integer engine (LedFx is
GPL-3.0, so no code was taken). Each draws on strips and matrices, ends
with Brightness and takes the Visualization section's auto-level, contrast,
fall-off and motion speed where they mean something.

- **Energy** (32): bass, mid and treble bars from the start of the lamp,
  each as long as its squared level (*reach* 128 = a full level fills the
  lamp), with soft edges (*soft edge*, 1–13 LEDs). By default the shortest
  bar is drawn on top, so all three show; *on top* can fix the treble or the
  bass there. Matrices fill like the VU meter: from the bottom, the middle
  row when mirrored, or out from the radial centre. With plain levels and
  the treble on top, a dense rock track kept the 153-LED strip 99 % lit and
  one colour; squared and nested, the end of the strip lights in 22 % of
  the frames and the three colours share it.
- **Scroll** (33): every frame the sound's colour (bass, mids and treble
  mixed by their squared levels, groups under *ignore below* left out)
  enters at the start and the history flows out at 0.15–1.65 lamp lengths
  per second (motion speed), so a 300-LED strip scrolls as fast as a
  30-LED one; fall-off sets the trail. Rings from the centre on a matrix.
- **Water** (34): the wave equation on the LEDs. The bass drops in at both
  ends and the middle of a strip (the centre of a matrix), the mids at two
  and the treble at four drifting places, each drop as hard as its group's
  squared level. c² = 1/2 on a strip (c = 1 rang every drop as a
  checkerboard) and 1/4 on a matrix (at 1/2 the checkerboard mode grows);
  drops are soft, half as deep around the centre. *Viscosity* sets the
  damping, motion speed the steps per second (30–180). The heights are int8
  in the engine's existing per-LED buffers: no new RAM.
- **Lava Lamp** (35): three slow sine waves multiplied into blobs (one
  across and one up on a matrix); the bass speeds them up and swells them
  (*bass reactivity*), the loudness sets the light. The hue runs there and
  back along the palette, so a palette's end never jumps to its start.

`tests/test_lab_visualizations.js` and `tests/test_fx_params.js` take the
new modes through the usual checks (silence, music, every parameter, every
geometry); the firmware's `tests/test_remote_viz.cpp` adds Energy's layers
(bars of 81, 36 and 9 LEDs for levels .9, .6, .3) and checks that the four
go dark after the music stops.

**Cost** (`pio run -e release`): RAM 62 268 → 62 348 bytes (+80: the
parameter defaults and Water's drift table, constants live in RAM on the
ESP8266), flash 540 820 → 545 124 bytes (+4.3 KB); 76.1 % RAM.
`tests/check_viz_integer.sh`: no soft-float, the engine's RAM for 16×16
unchanged at 2 336 bytes.
