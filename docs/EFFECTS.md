# Effects and audio reactions

[← Back to the project overview](../README.md)

Use the **Reaction** tab to choose how sound drives the LEDs. **Effect**
contains the color effect and palette; **Visualization** contains controls
specific to the chosen visualization. The on-screen preview works without a
lamp, so you can browse the effects before connecting a device.

## What to try

| Goal | Try | What to expect |
|---|---|---|
| See individual frequencies | **Spectrum Bars**, **Flow**, **Radial Spectrum** | Bands and motion reacting to the spectrum |
| Follow overall volume | **VU Meter**, **Waveform**, **Aurora** | Brightness, shape or movement tracking loudness |
| Emphasize kick and percussion | **Pulses**, **Sparkles**, **Energy** | Accents responding to bass, mid and treble hits |
| Make motion follow the beat | **Groove** | Rings, spirals or stripes stepping with the rhythm |
| Use harmony and pitch | **Melody**, **Chromatic Flow** | Patterns that follow dominant frequencies or notes |
| Build your own pattern | **Particles**, **Field**, **Zones** | Choose the shape, trigger, movement and colors |

## Audio modes and effect parameters

The **Reaction** tab's audio modes are grouped by what drives them:

- **Spectrum**, **Loudness**, **Drives a parameter**, **Experimental**: the
  firmware's own audio modes 1–12, which modulate the color effect.
- **Visualizations** draw the picture themselves (`src/viz_engine.h`, shared
  with the firmware): *spectrum* (Spectrum Bars, Flow, Fire, Juggle, Radial
  Spectrum, Melody — Melody follows the dominant frequency), *bass, mid,
  treble* (the meters, Pulses, Sparkles, Blobs, Energy, Scroll, Water),
  *loudness* (VU Meter, Waveform, Mood, Aurora, Lava Lamp), *beat* (Groove: rings, spiral arms, stripes or
  a swinging ball move one step per beat, locked to the beat phase) and
  *notes* (Chromatic Flow: soft colour regions, one per sounding note,
  placed on the palette by the circle of fifths; the colours change with
  the chords, hits only add a glow).
- Energy, Scroll, Water and Lava Lamp follow ideas of LedFx's effects of
  the same names (our own integer code): bass, mid and treble bars nested
  from the start; the sound's colour scrolling out from the start (rings on
  a matrix); drops of bass, mid and treble rippling on the wave equation;
  slow blobs that the bass swells and speeds up.
- **Constructors**: Particles, Field and Zones, whose parameters pick the
  shape, what launches or lights it, the motion and the colors.

Two settings of the Visualization section apply to every visualization
(both 0 by default, the stock picture): **Contrast** (with Auto-level) lights
only what rises above the last 2 s average at 50 % and only the peaks at
100 %, so loud, dense music no longer holds the meters at the top; **Blur**
softens the drawn frame with a Gaussian of up to 3 LEDs, along a strip and
across a matrix, which removes the comb-like trails of fast dots on strips.

The hint under the list says what drives the selected mode. **Effect
parameters** (under Visualization) are the selected mode's own settings:
up to 11 values per mode, e.g. Fire's fuel, height and wind, Particles'
shape, trigger, speed and gravity, Zones' layout and pattern. Particles,
Field, Zones, Melody, Groove, Chromatic Flow, Energy, Scroll, Water and
Lava Lamp end with **Brightness** (×1 = as drawn, up to ×2).
They are ordinary settings: remembered, reset by the section's ↺, set per
lamp, and sent to lamps whose firmware has the `params` capability (older
firmware draws the mode with its defaults; see
[Remote Output](REMOTE_OUTPUT.md#effect-parameters-2026-10-30)).

## More control

The **Reaction range** lets you choose how quiet or loud audio maps to a
response. **Analyzer** controls FFT resolution, frequency bands, onset
detection, tempo tracking and noise reduction. Most users can leave these
at their defaults; see the [Analyzer guide](ANALYZER.md) for details.

Older firmware may render customizable effects with default parameters.
See [Remote Output](REMOTE_OUTPUT.md) for compatibility and transport details.

[User guide](USER_GUIDE.md) · [Analyzer guide](ANALYZER.md)
