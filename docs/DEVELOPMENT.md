# Development, builds and testing

[← Back to the project overview](../README.md)

The application uses plain browser JavaScript and C++ compiled to WebAssembly.
GitHub Actions builds and publishes the `web/` site to GitHub Pages on each
push to `main`. The standalone build embeds CSS, JavaScript and WASM in one
offline HTML file.

## Project layout

```
src/                 C++ sources compiled to WebAssembly
  render.cpp         effect renderer (ported color/brightness/audio effects)
  viz_engine.h       visualizations 13..35 and their parameters (integer only), shared byte-for-byte with the firmware
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
  js/fx-params.js    effect parameters: names, ranges and defaults per mode, their controls
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
receiver for manual Remote Output testing without a lamp; it lists `chroma`
and prints the notes of the frames (`--no-chroma` behaves like older
firmware, which gets frames without them).

## Relationship to the firmware

Keep these in sync with `esp_led_lamp`:

- `src/viz_engine.h` ↔ `src/remote_audio/viz_engine.h`: identical copies
  (the visualization test compares them when both repos sit side by side);
- `src/render.cpp` audio modes 11/12 ↔ `src/remote_audio/reactive_math.h`
  (Bass / Mid / High, Beat-aware, spectrum shaping, control sources);
- `scaled_audio()` ↔ `audioTransfer()` in `src/audio/transfer.h`, and
  `origin_*()` ↔ `RemoteReactive::OriginMap` (signal window, start point);
  `render_test_pattern()` and `layoutMapper()` (`web/js/layout.js`) ↔
  `Layout::testPattern` / `Layout::index` in `src/misc/layout.h`;
- Wave history length and stretching ↔ `RemoteSignalProvider` / `Timeline`;
- `web/js/remote.js` ↔ `docs/REMOTE_AUDIO_PROTOCOL.md` and
  `src/network/protocol/server/remote_audio_ws.cpp`.

More: [accuracy and orientation](ACCURACY.md),
[Remote Output](REMOTE_OUTPUT.md), [revision history](HISTORY.md).

The renderer is not proven pixel-identical to the firmware (hand-ported
effects, unpinned FastLED version, no physical WS2812 model); see
`docs/ACCURACY.md`.

## Bundled metadata library

File metadata parsing uses the bundled MIT-licensed `music-metadata` library;
normal builds work offline. To regenerate its browser bundle, run
`npm ci --prefix scripts/metadata --ignore-scripts` then
`node scripts/build_metadata.mjs`. Third-party licenses are in
`web/vendor/THIRD_PARTY_LICENSES.txt`.

[User guide](USER_GUIDE.md) · [Analyzer reference](ANALYZER.md)
