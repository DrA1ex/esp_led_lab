# Using ESP LED Music Lab

[← Back to the project overview](../README.md)

Music Lab runs in a browser. You can try effects with the built-in demo beat,
play music from your own files, or use your microphone. Connecting a lamp is
optional; the LED preview works on its own.

## Start in three steps

1. Open [Music Lab](https://dra1ex.github.io/esp_led_lab/).
2. Choose **Demo beat**, **Microphone**, or add music files; press **Play** for files.
3. Choose an effect in **Reaction**, then customize its colors in **Effect**.

For a real lamp, open **Lamps**, add its IP address or `.local` name, and
select **Connect all**. The device and computer must share a local network,
and the device needs firmware with Remote Audio support.

## Using the lab

The window is a music player around an LED preview:

- **Music** (left column; the **Music** tab on narrower screens): the
  playlist. **Open folder** replaces the list with a folder's audio files
  (recursive, natural sort; Chrome/Edge remember it between reloads, other
  browsers use a folder upload), **Add files** and drag-and-drop of files or
  folders anywhere on the page append. While a folder is read (a big library
  or a slow disk can take seconds) the column shows the tracks and folders
  found so far. **Cancel** keeps the original list. The **⋯** menu holds the
  demo beat, microphone and the option to clear the list. The playlist button at the right of the
  player hides or shows the column.
- **Stage** (center): with lamps added, a switcher on top picks **All lamps**
  or one lamp (see below); then the LED preview and, under it, the analyzer: FFT bars,
  bass / mid / high onsets, the tempo estimate and, for Brightness, Line and
  Speed / Scale / Light Control, the control signal with its effective value.
  The button above the preview picks the **LED layout**; **View** holds the
  preview-only display options (audio reaction strength in the preview, LEDs
  as dots, flip, orientation test, LED output simulation, palette gamma).
  The **Layout** tab controls where an effect starts and how it faces.
- **Settings** (right), in tabs: **Effect** (color effects shown as rendered
  thumbnails, the 79 palettes as swatches with a filter, brightness effect,
  speed / scale / light), **Reaction** (audio mode, its signal, visualization
  options and reaction range), **Lamps**, **Analyzer** and **Layout**.
  Only the fields that the selected mode uses are shown; each section has its
  own reset (↺).
- **Player** (bottom): ⏮ (restarts the track after 3 s, otherwise previous),
  play/pause, ⏭, shuffle, position, repeat off / all / one, volume.

Hotkeys: Space play/pause, ←/→ seek ±5 s, N / P next / previous, 1–6 open
Music, Effect, Reaction, Lamps, Analyzer, Layout. Headphone buttons, keyboard media
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
  visualization options and reaction range. Layout and ring settings are
  handled separately on the **Layout** tab. A section's
  reset (↺) on a lamp goes back to the All lamps values, **Use All lamps
  settings** drops all of them. A start offset that a lamp follows is the same
  share of its width; a lamp-specific offset counts its own LEDs.

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
Strips are drawn as they are built: one line of LEDs per row (a 2-row strip
is two lines), LEDs up to 32 px apart and at least 12 px across, so a dense
strip shows as touching segments. A closed strip (**Ring** on the Layout
tab) is drawn round a rectangle with the stage's proportions, from the
top-left corner clockwise, a second row inside the first. The preview draws
the lamp's layout (flips, a ring's turn) as the lamp does. Clicking the
preview changes nothing. The choice is remembered in the browser.

Audio modes on strips behave like the firmware: Spectrum maps the bands along
the strip, Wave scrolls loudness along it (longer strips stretch the 3.2 s
history instead of repeating it), Bass / Mid / High blends bass and mid on a
single row, Line fills the strip from the start (or from the center).

## Reaction range

The **Reaction** tab's **Reaction range** is sent to the lamp with the stream
(firmware with the `tuning` capability): a signal window. The *Signal window*
(a two-thumb slider) is stretched onto the *Reaction* range: above the
window the reaction is always at maximum, below it at the minimum, or 0 with
*Silence below the window*. Example: signal 0–60 % → reaction 150–250. The
curve shows the mapping and the live input. On matrices, *Center on a
matrix* lets the Center modes spread as a circle around an adjustable row.
Both default to the stock firmware picture.

## Layout

The **Layout** tab (key 6) says how the LEDs are mounted. Firmware with the
`layout` capability saves it on the lamp and applies it to every effect,
the built-in ones too; the lab reads it from `hello_ack` and writes back only
the field you change. Edit one lamp in the switcher, or All lamps to write
the change to every connected lamp (an offset as the same share of each
lamp's width).

- **Ring** — a closed strip, or a matrix wrapped round a cylinder.
- **Center offset** — on a ring the whole picture turns this many LEDs along
  the wiring, so the center faces you; ‹ › move it one LED. On an open strip
  it moves the start and center of the audio modes instead, and LEDs past
  the end stay dark.
- **Flip horizontally / vertically** — the first LED (row) at the other end.
- **Orientation test** — red first LED, green the end of the first row, blue
  and white the ends of the last row, yellow the center: in the preview and
  on the edited lamp(s) until switched off. Turn the center offset until
  yellow faces you.

The old *Start and direction* settings (start offset, reverse, ring) and
picking the start by clicking the preview are gone; the layout replaces
them. *First row at the bottom* in the View menu only changes how the
preview shows a matrix.

## Browser and network access

The hosted app runs over HTTPS. Chrome can connect to local `ws://` endpoints
for private-network IPs and `.local` names after you permit *Local Network
Access*. If Chrome has been denied access, change the permission in its site
settings and reconnect. Other browsers may block this connection from an
HTTPS site; use `make serve` and open `http://localhost:8000/` instead.

Microphone access requires a secure context (HTTPS or localhost) and your
permission. A device that connects but does not play may need a firmware
update; see the [Remote Output troubleshooting notes](REMOTE_OUTPUT.md).

[Effect guide](EFFECTS.md) · [Analyzer guide](ANALYZER.md) ·
[Development and testing](DEVELOPMENT.md)
