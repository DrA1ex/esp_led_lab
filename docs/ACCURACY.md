# Accuracy and orientation

What the WASM renderer reproduces from the firmware and what it does not.

## Orientation

The firmware's `Led::get_index(x,y)` uses **serpentine rows**:

```cpp
(y & 1 ? width - 1 - x : x) + y * width
```

The WASM framebuffer keeps exactly that memory layout. The lamp's layout (Layout tab: flips, a ring's turn, saved on the lamp and applied by its `Led::get_index`) is applied when the preview is drawn, so the preview shows the wiring as the lamp does. **First row at the bottom** in the View menu changes only the canvas presentation; it is on by default to match a standing lamp.

Turn on **Orientation test** on the Layout tab; the lamp being edited shows it too. In firmware logical coordinates the markers are:

| Logical location | Color |
|---|---|
| `(0,0)` | Red |
| `(W-1,0)` | Green |
| `(0,H-1)` | Blue |
| `(W-1,H-1)` | White |
| column `W/2` (moved by an open strip's offset) | Yellow |

With **Flip vertically on**, the browser shows blue/white on the top row and red/green on the bottom row. With it off, the mapping is reversed. Compare the test pattern with the actual wired matrix before evaluating dynamic effects.

## Accuracy: what is and isn't equivalent

| Subsystem | Status |
|---|---|
| Logical `Led` framebuffer and serpentine XY coordinates | Matches repository formula; verified by corner tests on even/odd dimensions |
| `sin16`, `cubicwave8`, `ease`, fixed 8-bit `scale8` and `blend8` | Ported from FastLED **3.6.0** fixed math (**reference version only**; the `FastLED@^3.6.0` dependency is a range and may resolve to a newer 3.x release); arithmetic regression tests |
| `inoise16` (2D and 3D) | Fixed-point hash/gradients/easing/interpolation ported from FastLED 3.6.0 source, replacing previous *incorrect value noise*. Frozen regression vectors included; hardware FastLED cross-run still outstanding |
| HSL, 16-color palette interpolation, per-pixel scaling | Ported from **lamp-specific functions** instead of generic CSS/JS color interpolation |
| Ten original color and five brightness effects | Source-formula ports, with corrected Particle scaling, `cubicwave8`, and Double Wave odd-width handling |
| Color → Brightness → Audio order | Preserved |
| Source palette collection | **All 79 palettes** imported from firmware source in PaletteEnum order |
| Effect time | Uses virtual integer-millisecond deltas accumulated from browser frame timing; isn't a recorded real ESP frame timestamp stream |
| Random behavior | Same 16-bit FastLED PRNG formula with controlled initial seed. Hardware `micros()` entropy at effect changes isn't reproduced |
| Legacy audio | A reference **model**, not literal firmware DSP/ADC: no analog sample jitter, missing samples, undefined overflow/OOB, or hardware scheduling |
| New audio | Experimental real FFT + Hann + attack/release + onset DSP; not part of the original firmware |
| Audio-reactive modes 3 and 4 | **Experimental new effects**, not stock lamp effects |
| WS2812 output, actual optical appearance | **Not one-to-one**: device current limiting, FastLED dithering, global brightness/power correction, physical LED calibration, and ambient light are not simulated exactly |

**A pixel-identical firmware replica has NOT yet been demonstrated.** The pure RGB effect framebuffer is now substantially closer to FastLED, but the actual library is not compiled into the WASM target; the effect source is still manually ported. To claim parity, first identify and pin the **actual resolved FastLED version**, then compile the **same `src/fx/` and FastLED source** for device and WASM, run identical timestamp/preset/random-seed traces, and compare per-pixel RGBA buffers or capture reference outputs from device/firmware tests. The current tests establish important invariants and prevent regressions, but do not prove complete runtime equivalence.

The **Simulate LED output** option is intentionally **off by default**: only the raw logical RGB framebuffer is used by default. Turning it on applies an approximate global brightness plus `TypicalLEDStrip` correction. Do not use that mode for exact framebuffer comparisons. The LED-dot display mode is a visualization only, not a model of physical optical scattering.

## Validation performed

- Verified complete WebAssembly compilation of effect renderer and DSP.
- Ran all **10 × 5 × 4** combinations of color effect, brightness effect, and matrix size; outputs have opaque alpha and nonempty RGB.
- Checked `sin16` for all 65,536 inputs and `cubicwave8` for all 256 inputs against independent JavaScript ports of FastLED 3.6.0 equations.
- Checked fixed-point `blend8` across a broad input grid, plus fixed regression vectors for 2D and 3D `inoise16`.
- Verified serpentine addressing and all four logical corners for both odd/even and rectangular matrices; checked UI Y inversion is enabled by default.
- Chromium browser checks validate playback and replay, source switching, LED canvas rendering and sticky preview. Microphone path is validated with a synthetic real Web Audio MediaStream using ScriptProcessor fallback; browser-native microphone permissions and AudioWorklet remain to be checked in an eligible secure-origin browser.
