# Revision history

Dated notes from the lab's development before it became a git repository
(October 2026). Paths are as they were then: `standalone.html` now lives in
`dist/`, WASM binaries in `web/wasm/`, `app.js` was split into `web/js/*.js`
and `build_standalone.py` moved to `scripts/`.

## UI and audio overlay corrections (revision 2026-10-28)

- On desktop, the compact, two-column matrix/player/Remote Output workspace stays sticky beside the effects panel. Matrix previews are capped at 208 px instead of stretching to fill the left column. On narrow screens the compact floating mirror follows scrolling.
- Below 1040px the sidebar moves under the matrix. A compact fixed mirror of **the same two rendered canvas frames** is shown after scrolling beyond the normal matrix card. This does not create a third renderer or modify the original pixel buffers.
- Experimental Audio Reaction modes **Bass / Mid / High** and **Beat-aware reactive** previously had hand-coded `rgb_lerp_pixel(..., 0xffffff, ...)` overlays. These caused exactly the unwanted pair of lit pixels at the center of the matrix and flashing white specks seen in screenshots. The overlays are removed. Both modes now modulate the existing effect colors only.
- New regression tests ensure reactive modes cannot increase any RGB channel relative to an otherwise identical unmodulated frame. The resulting reactive image can still contain white if the **underlying selected effect/palette itself** contains white.

## Audio inputs and transport (2026-10-28)

- **File/demo:** stopping a non-looping track naturally now resets both DSP sample cursors, analysis state, and UI playback position to zero. Pressing Play again creates a fresh `AudioBufferSourceNode` and correctly reprocesses the song from the start (no manual Reset required). Demo remains an automatically repeating 16-second loop.
- **Microphone:** choose **Microphone** in the audio source dropdown. `getUserMedia` requests unprocessed mono audio (`echoCancellation`, `noiseSuppression`, `autoGainControl` requested off); AudioWorklet captures 1024-sample blocks when supported, and ScriptProcessorNode is used as a compatibility fallback. When input hardware runs above 20 kHz, a pair of browser-native low-pass biquad sections (7 kHz) precedes continuous resampling to 16 kHz to reduce high-frequency aliasing. The resulting PCM is passed through **the same existing C++/WASM DSP paths** as decoded files. A bounded 12-second ring buffer supplies recent PCM; the microphone is **not** played to speakers and is not transmitted to any server.
- **Permissions:** some browsers only permit microphone access from a secure origin (`https://` or `http://localhost`), and microphone permissions are user-controlled. The autonomous `standalone.html` still works for local audio files even if microphone capture is disallowed by a browser's `file://` policy. For development with a permitted origin, run `python3 -m http.server 8000` in the project directory and open `http://localhost:8000/standalone.html`.
- **Visual input meter:** for controls consuming a single value (Brightness, Line, Speed, Scale, Light), show a moving bar/marker for the selected **new DSP** input and one effective output. The old/new numerical paragraph was removed; the old matrix and its actual DFT spectrum remain available separately for comparison.
- **Regression testing:** `tests/test_audio_sources.py` uses a real Chromium audio context and a synthetic `MediaStream` for microphone capture; browser policy in the test environment blocks direct local/HTTPS navigation, so native microphone-permission prompts and native `AudioWorklet` execution are **not** validated there. Replays, the fallback capture path, resampling, source switching, and updated UI meter are automated.


## Audio-reaction + DSP completion pass (2026-10-28)

This revision restores **all ten `AudioEffectEnum` modes** from `src/fx/audio_effect.cpp` alongside the two experimental modes. They are ordered as in the original enum: Wave, Wave Center, Spectrum, Spectrum Center, Brightness, Line, Line Center, Speed Control, Scale Control, Light Control. The user interface additionally offers **Off**, **Bass/Mid/High** and **Beat-aware reactive**.

**AudioConfig range and evaluation order:** Original `AudioConfig.min/max` are now editable as **Audio minimum / maximum** (0–255). The parametric modes use the normalized volume analyzer output to compute a value in this range and update a temporary preset **before** `ColorEffects` and `BrightnessEffects`. The original preset is restored after each frame. `Audio strength` = **100%** preserves the original full modulation behavior; lower strengths are a laboratory-only way of blending with the unmodified preset/effect, and are not present in stock firmware.

**Old audio is three separate models**, reflecting the source (not just a cosine DFT):

- SpectrumAnalyzer: cosine-only DFT, 128 ADC samples, ~10 Hz, rolling log-scale reference (with out-of-bounds lookups clamped).
- Wave/VolumeAnalyzer: 16 ADC samples at 40 Hz, 5-second rolling amplitude normalization, scrolling amplitude history.
- Parametric/VolumeAnalyzer: 64 ADC samples at ~30 Hz, 5-second rolling amplitude normalization.

These are browser reconstructions fed by decoded audio, *not* a literal ESP ADC capture: the browser cannot reproduce missed samples, ADC noise/gain hardware, cooperative timer jitter or undefined behavior of the original code. The new FFT stream also calculates independent normalized loudness and 40 Hz history so the same Wave/Control effects can be compared on both sides.

**New DSP additions:**

- Adjustable AGC response (100–3500 ms) and dynamic-range compression (0–100%).
- Optional adaptive per-band noise floor subtraction (0–100%), following quieter conditions quickly and rising slowly during music.
- Smoothed bass/mid/high envelopes in addition to their onset pulses.
- An experimental tempo/beat tracker using ~3 seconds of spectral-flux autocorrelation for ~65–180 BPM; BPM/confidence shown on the browser panel. Its predicted beat pulse influences the experimental Beat-aware reactive effect without injecting white pixels. It can lock to half/double tempo or lose confidence in complex/non-percussive music. This is NOT a production-grade beat tracker.
- `OfflineAudioContext` downsampling to 16 kHz with browser resampling filters (falling back to linear interpolation if unsupported), to reduce high-frequency aliasing from 44.1/48 kHz music files.
- Seek and FFT switching reset the old and new analyzer schedules at the current audio position, rather than replaying analyzer frames from the beginning of the file.

**All 79 firmware palette presets** have now been copied from `src/fx/palette_def.h`, in the exact order of `src/fx/palette.cpp` / `PaletteEnum` (including the original `Custom` default palette last). `Bloom` remains the default selected palette. Unlike the earlier 12-palette preview, this palette selection is now faithful to the firmware's catalog. It does not yet support interactive editing of the Custom palette stops.

**Remaining work (not claimed complete):** The effect code and several FastLED routines are still hand-ported instead of being built from the original source files; the hardware-resolved FastLED version is unconfirmed; physical WS2812 output/current limit and timing cannot be predicted exactly. Old analog acquisition is modeled, not captured. BPM confidence requires validation against real music with varying tempo. New DSP has not been benchmarked on ESP32-C3 or other ESP32 targets. A direct trace-by-trace framebuffer comparison with hardware or a native firmware reference harness remains the criterion for calling the renderer *pixel-identical*.

## Audio-reactivity regression fix (2026-10-28, follow-up)

The previous build passed unit tests but was poorly suited to judging live audio:

1. **New FFT / AGC saturation:** The DSP clamped its compressed normalized bands to `1.0` and, for the 120-BPM demo, multiple low-frequency bins stayed pinned at 100% for seconds. This also caused `Speed/Scale/Light Control` values to stay close to the upper end. The new signal mapping uses a **monotonic soft knee** (`compressed / (0.85 + compressed)`) instead of hard clipping, with a less aggressive AGC reference scaling. This is an experimental DSP tuning change, not a change to the original firmware effects.
2. **Old DFT looks too dark on the original Spectrum modes:** `AudioEffectManager::signal` literally applies `dim8_raw` followed by `CRGB::nscale8` to every column, so quiet frequency bins become practically black. The original formula was **not modified** to hide this issue. Instead, 16 live signal-level bars have been added immediately under each matrix, and each panel now reports both signal strength and measured WASM framebuffer brightness. This distinguishes a missing signal from an intentionally dimmed original effect.
3. **The 16-second demo stopped and left the last audio features frozen.** The demo now loops, resets the DSP state at the audio boundary and continues updating the matrices. User-supplied files do not loop automatically.
4. **Blank initial display:** On an idle page the selected Spectrum mode previously multiplied all colors by zero without an audio source. The starting mode is now **Off**; loading a demo or file automatically chooses original Spectrum if Off is still selected.
5. **Preset limitation:** `Light Control` is a no-op with `Fixed Brightness` and a non-Solid color effect because neither of those effects consumes the `light` preset parameter. The interface now explicitly warns about this behavior (it matches `src/main.cpp` and `ColorEffectManager::call`, rather than being a WASM error). For `Solid Color`, Speed and Scale act on HSL hue and saturation, as in source.

New browser regression test: `python tests/test_live_audio_reaction.py`, `python tests/test_control_browser.py`. It uses actual Chromium and generated PCM, checks both spectra and a non-clipped FFT, compares **all ten original audio modes** against the Off mode on an otherwise constant Solid/Fixed reference frame, verifies the Light Control incompatibility warning, and simulates crossing the demo-loop boundary. Previous tests are retained. No source effect formula was modified as part of this fix.

## Speed / Line / Spectrum responsiveness fixes (2026-10-28)

The original firmware's **Speed Control, Scale Control and Light Control all read a single `VolumeAnalyzer<64>` sampled at approximately 30 Hz** (`src/main.cpp::render()`, `src/audio/volume_analyzer.h`). The firmware does not natively select a bass/mid/high source for these modes. The legacy/left preview intentionally retains its 5-second normalization and source behavior.

The previous experimental/new FFT preview incorrectly used a weighted mean of spectral bands as its only parametric control input. On some tracks this remains low or overly smooth, making Speed Control nearly motionless, notably for effects like Perlin. For Gradient the original speed parameter has a **directional neutral point at 128** (`(speed-128)/512`), so naive low-range speed mappings can also cause surprising direction and motion.

Changes to the **right/new DSP only**:

- New time-domain RMS/loudness envelope (`new_loudness_value()`), with a slowly decaying reference, faster attack and release; this is the **default control source** for Brightness/Line/Speed/Scale/Light. Other selectable sources: weighted spectral activity (old experimental behavior), bass, mid, high, strongest band, onset pulse and confidence-weighted predicted beat pulse. The old preview always uses original VolumeAnalyzer; the source selector never silently changes firmware simulation.
- New Speed floor (default 144) maps the Audio minimum/maximum result into a non-stationary range on the new panel. Zero turns off this experimental floor. **The original/left Speed mapping is unchanged.** The main panel shows actual effective Speed/Scale/Light values, the selected source and its live percentage. The Audio min/max sliders remain available for both panels.
- New Line / Line Center use a fast transient-friendly RMS envelope (16 ms attack / ~105 ms release), mixed via *Line fast response* slider (default 75%). At 0% only the selected parametric source is used, and the original/left preview remains untouched.
- New Spectrum / Spectrum Center have a tunable mapping from the stock squared FastLED `dim8_raw` brightness to a brighter perceptual curve (default 70%), with optional low/mid/high onset accents (default 30%). At 0% for both sliders the original column brightness formula is restored. **Old DFT / left always uses the exact original curve.** These sliders intentionally change music presentation; they are not evidence of firmware pixel parity.
- Fixed a separate legacy Wave display bug introduced in the lab: every 40 Hz volume sample was being inserted twice into the rolling history. It now advances once per sample, like original `VolumeAnalyzer`.

Validation: `node tests/test_control_dynamics.js`, `node tests/test_audio_modes.js`, `python tests/test_live_audio_reaction.py`, `python tests/test_control_browser.py`. The new control-dynamics tests verify perceptually brighter new Spectrum mapping, dynamic Line envelope, the new Speed floor, no changes to original Speed mapping and single-step legacy history insertion.
