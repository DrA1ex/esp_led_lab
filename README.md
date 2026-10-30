# ESP LED Music Lab

Browser lab for [`DrA1ex/esp_led_lamp`](https://github.com/DrA1ex/esp_led_lamp):
the lamp's color/brightness/audio effects ported to C++ → WebAssembly, an
FFT + onset + tempo DSP, and **Remote Output**, which streams the DSP's
features to real lamps over Wi-Fi. The preview shows what a connected lamp
renders from the same features.

Works for LED **matrices** (16×16 … 128×128) and LED **strips** (HEIGHT = 1
or a few rows, up to 1024 LEDs), the same WIDTH × HEIGHT the firmware is
built with.

![preview](docs/preview.png)

## Quick start

- **Offline:** `make`, then open `dist/standalone.html` in a recent browser.
  Everything, including WASM, is inlined.
- **Development:** `make serve`, then open <http://localhost:8000/>. The
  microphone needs `localhost` or HTTPS.

## Using the lab

The window is a music player around an LED preview:

- **Music** (left column; the **Music** tab on narrower screens): the
  playlist. **Open folder** replaces the list with a folder's audio files
  (recursive, natural sort; Chrome/Edge remember it between reloads, other
  browsers use a folder upload), **Add files** and drag-and-drop of files or
  folders anywhere on the page append. The **⋯** menu holds the demo beat, the
  microphone and clearing the list. The playlist button at the right of the
  player hides or shows the column.
- **Stage** (center): with lamps added, a switcher on top picks **All lamps**
  or one lamp (see below); then the LED preview and, under it, the analyzer: FFT bars,
  bass / mid / high onsets, the tempo estimate and, for Brightness, Line and
  Speed / Scale / Light Control, the control signal with its effective value.
  The button above the preview picks the **LED layout**; **View** holds the
  preview-only display options (audio reaction strength in the preview, LEDs
  as dots, flip, orientation test, LED output simulation, palette gamma).
  Clicking an LED moves the start (or center) of the audio effect there.
- **Settings** (right), in tabs: **Effect** (color effects shown as rendered
  thumbnails, the 79 palettes as swatches with a filter, brightness effect,
  speed / scale / light), **Reaction** (audio mode, its signal, visualization
  options, reaction range, start and direction), **Lamps** and **Analyzer**.
  Only the fields that the selected mode uses are shown; each section has its
  own reset (↺).
- **Player** (bottom): ⏮ (restarts the track after 3 s, otherwise previous),
  play/pause, ⏭, shuffle, position, repeat off / all / one, volume.

Hotkeys: Space play/pause, ←/→ seek ±5 s, N / P next / previous, 1–5 open
Music, Effect, Reaction, Lamps, Analyzer. Headphone buttons, keyboard media
keys and the OS media controls drive the player too (Media Session; a silent
looped `<audio>` keeps the browser routing them to the page).

On phones the preview stays pinned at the top while the settings scroll under
it (its arrow button makes it smaller), and the player is fixed at the bottom.

Settings, lamps with their own settings, names and max brightness, the LED
layout, the open tab and whether the music column is hidden are remembered in
the browser; **? → Reset all settings** returns to the defaults (lamps and
their names stay).

## Lamps

The **Lamps** tab streams to every listed lamp: enter an address (the
firmware's `ws://<ip>/audio`), then use **Connect all** (optionally when the
page opens). The pill in the header shows one dot per lamp and opens the tab.

**Each lamp can have its own settings.** The switcher above the preview picks
what the preview shows and what the Effect and Reaction tabs edit:

- **All lamps** — the shared settings, on the LED layout from the menu above
  the preview.
- **A lamp** — the preview takes the lamp's own size (reported by the lamp and
  remembered for when it is offline) and shows its settings. A lamp follows
  All lamps until something is changed while it is selected; from then on that
  setting is its own, marked with a dot. Every setting the lamp receives can be
  its own: effect, palette, parameters, audio mode and its signal,
  visualization options, reaction range, start, direction and ring. A section's
  reset (↺) on a lamp goes back to the All lamps values, **Use All lamps
  settings** drops all of them. A start offset that a lamp follows is the same
  share of its width; its own offset counts its own LEDs.

**Power and brightness** apply to every connected lamp from the **All lamps**
block and per lamp on its card; they are saved on the lamp (`power` /
`brightness` on the `/audio` socket; older firmware gets `/api/power` and
`/api/brightness` over HTTP). A card's slider is the lamp's **max
brightness**: the all-lamps brightness scales within it, so a lamp at 50 % runs
at half of the others at any level. The card's details hold the lamp's name,
its spectrum band count (Auto: about one band per column), whether it gets the
stream, the connection statistics, Disconnect and Remove.

## LED geometry

The **LED layout** menu above the preview selects what it renders:

| Option | WIDTH × HEIGHT | Notes |
|---|---|---|
| Matrices | 16×16, 32×32, 64×64, 128×128 | `lamp.h` is 16×16 |
| Strips | 7, 34, 46, 60, 153, 300 LEDs × 1 | the firmware's `torus`, `test`, `mini_lamp`, `ceiling` configs |
| Two-row strip | 72×2 | `tv.h` |
| Custom | any, up to 1024 wide / 128 high / 16384 LEDs | |
| From device | `hello_ack.width × height` | follows the first connected lamp |

Addressing is always row-serpentine, exactly like `Led::get_index(x, y)`.
Strips are drawn wrapped onto several display lines so every LED stays
visible, with LEDs as large as the stage allows; only the presentation wraps,
the framebuffer is linear. The choice is remembered in the browser.

Audio modes on strips behave like the firmware: Spectrum maps the bands along
the strip, Wave scrolls loudness along it (longer strips stretch the 3.2 s
history instead of repeating it), Bass / Mid / High blends bass and mid on a
single row, Line fills the strip from the start (or from the center).

## Reaction range and start point

The **Reaction** tab has two sections that are sent to the lamp with the
stream (firmware with the `tuning` capability):

- **Reaction range** — a signal window. The *Signal window* (a two-thumb
  slider) is stretched onto the *Reaction* range: above the window the
  reaction is always at maximum, below it at the minimum, or 0 with *Silence
  below the window*. Example: signal 0–60 % → reaction 150–250. The curve
  shows the mapping and the live input.
- **Start and direction** — moves the start of Wave, Spectrum, Line and
  Bass / Mid / High, and the center of the Center modes and Beat-aware.
  *Reverse direction* runs the effect from the other end, *Ring* lets a
  shifted effect wrap past the end of a closed strip, and on matrices the
  Center modes can spread as a circle around an adjustable row. Clicking the
  preview puts the start (or center) on the clicked LED.

Both default to the stock firmware picture.

## Analyzer

The **Analyzer** tab sets the FFT size (64–8192 points) and **analysis sample rate**
(8, 16, 32 or 48 kHz; default 16 kHz). Bin spacing is sample rate / FFT size;
window duration is FFT size / sample rate. Larger FFTs or lower rates separate
nearby frequencies better, while smaller FFTs react faster. The analysed
**frequency range** runs from 20 Hz to half the selected rate (Nyquist).
The 16 LED feature bands and the 32/64 bands sent to the lamp are
spread logarithmically inside that range, and sound outside it is ignored.
Band levels are normalised so a tone reads the same at every FFT size. The
lamp only receives features, so these settings need no firmware changes.
Changing the analysis rate resamples the loaded audio without altering playback;
live microphone resampling and anti-alias filters follow the selected rate.
Short FFTs overlap by at least 50%; the tempo tracker keeps its own 16 ms cadence.
The original file rate is read from its metadata before browser decoding; the
microphone rate comes from the capture track settings. Analysis rates above the
source are disabled, and lower-rate sources automatically cap the selected rate.
A native-rate option covers sources such as 22.05 or 44.1 kHz. If file metadata
is unavailable, the UI says so and uses the decoded buffer's rate as a fallback.
Files below the minimum 8 kHz analysis rate are resampled to 8 kHz, with the
frequency range still capped at half the original rate; the UI explains this.
File decoding uses an offline context so a lower-rate playback device cannot
prematurely discard frequencies the analyzer can use.

The bars under the LED preview show actual FFT bins grouped logarithmically
for the available display width. Unresolved low-frequency groups merge; a
64-point FFT therefore draws fewer, broader bars than a large FFT. Captions
show the displayed group count and Hz per bin. The lamps still receive their
negotiated 16/32/64 feature bands independently of this analyzer display.

Beyond the basic sliders the analyzer has the settings that decide which parts
of the sound drive the effects. All of them run in the lab's DSP, so the lamp
gets the shaped features without firmware changes, and every default
reproduces the fixed behaviour it replaces:

| Section | Setting | What it does |
|---|---|---|
| Resolution | Window | Hann (default), Hamming, Blackman-Harris (least leakage: a loud bass does not spill into its neighbours), flat-top (exact levels between bins) or rectangular (sharpest, most leakage). Levels stay comparable across windows |
| Bands | Tilt | ±6 dB per octave around 1 kHz: lifts the highs (music loses energy toward the top) or the lows |
| Bands | Bass / Mid / High trim | ±12 dB per band group, after the tilt |
| Bands | Groups | the first band of mid and of high: which of the 16 bands make up bass, mid and high (levels, hits, tempo) |
| Bands | Band balance | 0–100 %: each band is normalised toward its own average (within ±18 dB of the global one), so every band uses its range |
| Bands | Band smoothing | 0–100 %: blends each band with its neighbours (up to ¼ ½ ¼), so the bars move as a wave |
| Level | Compression | below 0 it expands: quiet parts go dark, only the peaks light up |
| Envelope | Peak hold | 0–400 ms: a peak stays before the release starts |
| Onsets | Memory | 0.2–4 s: how long the adaptive threshold remembers the flux |
| Onsets | Threshold, hold-off, flash per group | a trim of the onset threshold, the rest after a hit (default 160 / 85 / 85 ms) and the flash fade (220 / 130 / 130 ms) for bass, mid and high |
| Tempo | Tempo range | 40–240 BPM (default 65–180): the beat lengths the tracker searches; narrowing it prevents octave jumps |

### DSP view

On the Analyzer tab, **LEDs / DSP** above the preview switches the stage to a
view of what the analyzer settings do to the signal. Touching a setting opens
its panel; the curves are computed from the same formulas as `new_process()`,
and the live traces come from the running DSP:

| Panel | Settings | Shows |
|---|---|---|
| Resolution | FFT size, sample rate, frequency range, window | the live spectrum as FFT bins on a frequency axis, the 16 bands inside the range (bands narrower than a bin are marked), the window of consecutive frames and the hop between them, and a pure tone through the selected window with its leakage |
| Bands | Tilt, group trims, groups, band balance, band smoothing | the music's spectrum over the last 3 s before and after the equalizer, the equalizer per band (fixed, and with the balance applied now), the group regions, and each band's LED level as a box plot (dead, pinned and flat bands are counted) |
| Level | Sensitivity, Compression, Auto gain | the band level → LED level curve (with and without compression), the noise floor, the 16 bands on it now, where the music's average level lands, and the AGC reference following the average over the last 5 s |
| Envelope | Attack, Release, Peak hold | a band group (bass / mid / high) before and after the envelope over the last 5 s, and the response to a sound that starts and stops, with the time to 63 % / 90 %, the hold and back to 37 % |
| Onsets | Onset threshold, memory, per-group threshold / hold-off / flash | the group's energy rise (flux) against its adaptive threshold, the hits with their hold-off and the flash they trigger, and a histogram of the time between hits (double triggers, hits cut by the hold-off) |
| Tempo | Tempo range | the onset strength the tracker hears with the predicted beats and the bass hits, the periodicity at every beat length (½× and 2× marked), the tempo and confidence over time, and the beat phase |
| Noise | Noise floor, Adaptive floor | each band's level against the noise floor, the background each band has learned and what the adaptive floor removes |

Three more views look across all the settings; they stay open while the
settings are changed:

| View | Shows |
|---|---|
| Chain | one band group after every stage on one time axis: input with the noise floor, after the level curve, after the envelope (what the LEDs show), hits and flash; beside each stage, the range it uses (5–95 % of the time) |
| Spectrogram | the FFT over the last 5 s on a log frequency axis with the frequency range, the group splits, the 16 bands and the hits of each group |
| Map | all 16 bands over the last 5 s before the analyzer (dB) and as the LEDs get them, and a histogram of how often each LED level occurs (dark / bright share, median) |
| A/B | **Pin as A** copies the running analyzer into a second DSP instance that keeps the pinned settings while the sliders change B; both run on the same audio. Shows the changed settings, both outputs of a group, their hits and all bands now |

The DSP exports the intermediate values for it (`new_targets_ptr`: band levels
before the envelope, `new_thresholds_ptr`: onset thresholds, `new_floor_ptr`:
learned noise floors, `new_tilt_ptr`: the tilt per band, `new_band_ref_ptr`:
each band's reference, `new_novelty_ptr` / `new_novelty_head`: the tempo
tracker's onset strength, `new_tempo_scores_ptr` / `new_tempo_info_ptr`: its
periodicity per lag and the lag range and winner). A hit just before a
predicted beat now also starts the beat pulse instead of skipping that beat.

File metadata parsing uses the bundled MIT-licensed `music-metadata` library;
normal builds work offline. To regenerate its browser bundle, run
`npm ci --prefix scripts/metadata --ignore-scripts` then
`node scripts/build_metadata.mjs`. Third-party licenses are in
`web/vendor/THIRD_PARTY_LICENSES.txt`.

## Project layout

```
src/                 C++ sources compiled to WebAssembly
  render.cpp         effect renderer (ported color/brightness/audio effects)
  viz_engine.h       visualizations 13..25 (integer only), shared byte-for-byte with the firmware
  dsp.cpp            FFT/onset/BPM DSP (+ the firmware's original analyzers, used by tests)
  fastled_compat.h   FastLED 3.6.0 fixed-point math port
  tables.h           lookup tables
web/                 development page (served as-is)
  index.html
  css/app.css
  js/state.js        shared state, settings
  js/geometry.js     matrices/strips, strip display layout
  js/remote.js       Remote Audio v1 wire format, WebSocket devices, clock sync
  js/lamps.js        per-lamp settings: All lamps vs a lamp's own values, the edited target, max brightness
  js/remote-ui.js    feature snapshots, presentation timing, lamp cards, power / brightness, target switcher
  js/tuning.js       reaction range, start point, transfer curve, mode hints
  js/view.js         settings → WASM, canvas painting, meters
  js/dsp-view.js     the Analyzer tab's DSP view: what each analyzer setting does to the signal
  js/ui.js           choices bound to the selects, sliders, popovers, tabs, music column,
                     palette swatches and effect thumbnails, remembered settings
  js/audio.js        file / demo / microphone input and DSP feed
  js/playlist.js     playlist, folder / files / drop, next / previous, repeat, shuffle, hotkeys
  js/main.js         bootstrap, animation loop, UI wiring
  wasm/              built render.wasm, dsp.wasm (make wasm, not committed)
dist/standalone.html single-file build (make standalone, not committed)
scripts/             build_wasm.sh, build_standalone.py, mock_remote_receiver.py
tests/               Node/WASM unit tests (test_*.js), Chromium tests (test_*.py)
docs/                accuracy notes, Remote Output protocol notes, history
```

The scripts in `web/js/` are classic (non-module) scripts sharing one global
scope, loaded in the order listed in `index.html`; the standalone build
inlines them in that order.

## Build

```sh
make            # WASM + dist/standalone.html
make wasm       # only web/wasm/*.wasm
make standalone # only dist/standalone.html
```

WASM needs an LLVM with the `wasm32` target and `wasm-ld` (`brew install llvm lld`;
Apple's `/usr/bin/clang` has no WebAssembly backend). `scripts/build_wasm.sh`
finds Homebrew LLVM automatically; set `CXX=` to override. No Emscripten.
`web/wasm/` and `dist/` are build outputs and are ignored by git; `make serve`,
`make test` and `make standalone` build the WASM first when it is missing or stale.

## Tests

```sh
make test          # Node 18+: WASM renderer/DSP, FastLED math, strips, remote format and clock
make test-browser  # Chromium via Playwright (pip install playwright && playwright install chromium)
```

Set `CHROMIUM=/path/to/chromium` to use a specific browser binary.
`python3 scripts/mock_remote_receiver.py --port 8765` is a small WebSocket
receiver for manual Remote Output testing without a lamp.

## Relationship to the firmware

Keep these in sync with `esp_led_lamp`:

- `src/viz_engine.h` ↔ `src/remote_audio/viz_engine.h`: identical copies
  (the visualization test compares them when both repos sit side by side);
- `src/render.cpp` audio modes 11/12 ↔ `src/remote_audio/reactive_math.h`
  (Bass / Mid / High, Beat-aware, spectrum shaping, control sources);
- `scaled_audio()` ↔ `audioTransfer()` in `src/audio/transfer.h`, and
  `origin_*()` ↔ `RemoteReactive::OriginMap` (signal window, start point);
- Wave history length and stretching ↔ `RemoteSignalProvider` / `Timeline`;
- `web/js/remote.js` ↔ `docs/REMOTE_AUDIO_PROTOCOL.md` and
  `src/network/protocol/server/remote_audio_ws.cpp`.

More: [accuracy and orientation](docs/ACCURACY.md),
[Remote Output](docs/REMOTE_OUTPUT.md), [revision history](docs/HISTORY.md).

The renderer is not proven pixel-identical to the firmware (hand-ported
effects, unpinned FastLED version, no physical WS2812 model); see
`docs/ACCURACY.md`.
