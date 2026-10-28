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

- **Offline:** open `dist/standalone.html` in a recent browser. Everything,
  including WASM, is inlined.
- **Development:** `make serve`, then open <http://localhost:8000/>. The
  microphone needs `localhost` or HTTPS.

Pick a demo loop, an audio file or the microphone and choose an audio
reaction on the **Audio** tab. To drive a lamp, enter its address under
**Lamps over Wi-Fi** (the firmware's `ws://<ip>/audio`). Lamp addresses, the
LED geometry and the active settings tab are remembered in the browser.

## LED geometry

**Matrix or strip** on the **LED** tab selects what the preview renders:

| Option | WIDTH × HEIGHT | Notes |
|---|---|---|
| Matrices | 16×16, 32×32, 64×64, 128×128 | `lamp.h` is 16×16 |
| Strips | 7, 34, 46, 60, 153, 300 LEDs × 1 | the firmware's `torus`, `test`, `mini_lamp`, `ceiling` configs |
| Two-row strip | 72×2 | `tv.h` |
| Custom | any, up to 1024 wide / 128 high / 16384 LEDs | |
| From device | `hello_ack.width × height` | follows the first connected lamp |

Addressing is always row-serpentine, exactly like `Led::get_index(x, y)`.
Strips are drawn wrapped onto several display lines so every LED stays
visible; only the presentation wraps, the framebuffer is linear. The choice
is remembered in the browser.

Audio modes on strips behave like the firmware: Spectrum maps the bands along
the strip, Wave scrolls loudness along it (longer strips stretch the 3.2 s
history instead of repeating it), Bass / Mid / High blends bass and mid on a
single row, Line fills the strip from the start (or from the center).

## Reaction range and start point

The **Audio** tab has two blocks that are sent to the lamp with the stream
(firmware with the `tuning` capability):

- **Reaction range** — a signal window. The input range *Signal from–to*
  is stretched onto *Reaction from–to*: above *to* the reaction is always at
  maximum, below *from* at the minimum, or 0 with *Signal below “from” turns
  off*. Example: signal 0–60 % → reaction 150–250. The curve shows the
  mapping and the live input.
- **Start and direction** — moves the start of Wave, Spectrum, Line and
  Bass / Mid / High, and the center of the Center modes and Beat-aware.
  *Reverse direction* runs the effect from the other end, *Ring* lets a
  shifted effect wrap past the end of a closed strip, and on matrices the
  Center modes can spread as a circle around an adjustable row. Clicking the
  preview puts the start (or center) on the clicked LED.

Both default to the stock firmware picture.

## Analyzer

The **DSP** tab sets the FFT size (256–8192 points at 16 kHz; larger sizes
separate bass notes better but react more slowly) and the analysed
**frequency range** (20 Hz – 8 kHz, the Nyquist limit of the 16 kHz
analysis). The 16 preview bands and the 32/64 bands sent to the lamp are
spread logarithmically inside that range, and sound outside it is ignored.
Band levels are normalised so a tone reads the same at every FFT size. The
lamp only receives bands, so neither setting needs firmware support.

## Project layout

```
src/                 C++ sources compiled to WebAssembly
  render.cpp         effect renderer (ported color/brightness/audio effects)
  dsp.cpp            FFT/onset/BPM DSP (+ the firmware's original analyzers, used by tests)
  fastled_compat.h   FastLED 3.6.0 fixed-point math port
  tables.h           lookup tables
web/                 development page (served as-is)
  index.html
  css/app.css
  js/state.js        shared state, settings
  js/geometry.js     matrices/strips, strip display layout
  js/remote.js       Remote Audio v1 wire format, WebSocket devices, clock sync
  js/remote-ui.js    feature snapshots, presentation timing, device list
  js/tuning.js       reaction range, start point, transfer curve, mode hints
  js/view.js         settings → WASM, canvas painting, meters
  js/audio.js        file / demo / microphone input and DSP feed
  js/main.js         bootstrap, animation loop, UI wiring
  wasm/              built render.wasm, dsp.wasm (committed)
dist/standalone.html single-file build (committed)
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
Commit the rebuilt `web/wasm/` and `dist/` together with source changes.

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
