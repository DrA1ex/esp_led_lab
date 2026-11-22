# Analyzer and DSP reference

[← Back to the project overview](../README.md)

The **Analyzer** tab lets you tune how music becomes LED-reactive signals.
The default settings are a useful starting point; change them when you want
more precise frequency separation, beat response or noise suppression.

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
| Noise | Noise floor (dB of full scale, 1 dB a step, −90 = off), Adaptive floor (share of the learned background in dB: −39 … +6, 0 dB = 100 %, −40 = off), Floor learns in / drops in | each band's level against the noise floor, the background each band has learned and what the adaptive floor removes |

Three more views look across all the settings; they stay open while the
settings are changed:

| View | Shows |
|---|---|
| Chain | one band group after every stage on one time axis: input with the noise floor, after the level curve, after the envelope (what the LEDs show), hits and flash; beside each stage, the range it uses (5–95 % of the time) |
| Spectrogram | the FFT over the last 5 s on a log frequency axis with the frequency range, the group splits, the 16 bands and the hits of each group |
| Notes | the chroma: how much of each of the 12 notes (C … B, octaves folded) sounds over the last 5 s and now, the strongest note and the triad when three notes stand out. A separate analysis from the bands (about 8 kHz, 4096-point FFT: 0.51 s, 2 Hz per bin; notes 55 Hz – 2 kHz), so it does not depend on the FFT size above |
| Map | all 16 bands over the last 5 s before the analyzer (dB) and as the LEDs get them, and a histogram of how often each LED level occurs (dark / bright share, median) |
| A/B | **Pin as A** copies the running analyzer into a second DSP instance that keeps the pinned settings while the sliders change B; both run on the same audio. Shows the changed settings, both outputs of a group, their hits and all bands now |

The DSP exports the intermediate values for it (`new_targets_ptr`: band levels
before the envelope, `new_thresholds_ptr`: onset thresholds, `new_floor_ptr`:
learned noise floors, `new_tilt_ptr`: the tilt per band, `new_band_ref_ptr`:
each band's reference, `new_novelty_ptr` / `new_novelty_head`: the tempo
tracker's onset strength, `new_tempo_scores_ptr` / `new_tempo_info_ptr`: its
periodicity per lag and the lag range and winner). A hit just before a
predicted beat now also starts the beat pulse instead of skipping that beat.


For visual accuracy and hardware limitations, see
[Accuracy and orientation](ACCURACY.md). For the stream format and clock
synchronization, see [Remote Output](REMOTE_OUTPUT.md).

[User guide](USER_GUIDE.md) · [Effects guide](EFFECTS.md)
