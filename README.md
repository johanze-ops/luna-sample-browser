# Sample Browser for LUNA

Browse your sample folders inside LUNA and audition loops **in time with your session**,
the way Ableton's browser does. LUNA's own engine does the work: the loop is warped to your
session tempo and plays through LUNA's mixer on a track called **Sample Preview**, so you
can put plugins on your previews too.

Needs LUNA 3.1.2 or later, on macOS.

## Install

Download `sample-browser.lunaaddon` from the
[latest release](https://github.com/johanze-ops/luna-sample-browser/releases/latest) and
double-click it, and LUNA installs it. Then open **Add Ons > Browsers > Sample Browser**. It
opens in the right-hand browser panel.

## Use

- **Add a folder:** click **+ Folder** and pick a sample folder, or drag one from Finder
  onto the panel. LUNA asks you to allow it the first time. Pick a folder of samples, not a
  whole drive or your home folder, which LUNA won't allow.
- **Audition:** click a loop. If the session is playing, the loop comes in at the next bar.
  If it's stopped, the session starts playing from the playhead's bar. With LUNA's loop on,
  the preview fills the loop range, so it plays every time round.
- **Keys:** use ↑ and ↓ to step through the loops (they play as you go, unless you untick
  *Play on select*), → to open a folder, ← to go back up, **Enter** to add the loop to the
  session and **Esc** to stop.
- **Add to session:** puts the loop on a new track named after the file. It fills the loop
  range when LUNA is looping, and otherwise adds one pass from the bar the preview started
  on. The new track gets the same warp mode as the Sample Preview track.
- **Volume:** the slider is the Sample Preview track's fader.

## Tempo

Each loop's tempo comes, in order, from:

1. **the file name**, such as `120bpm`, `Loop 92 BPM` or `bpm_128`;
2. **LUNA's own tempo detection**, doubled or halved into the **Tempo range** you set (75–150
   to start with), because detectors often report half or double time;
3. **the loop's length**, assuming a whole number of bars (1–32).

The label next to each loop says which one it used. If a loop is at the wrong speed, use
**½×** or **2×** on it, and the browser remembers the fix for that file. Files shorter than
1.2 seconds with no BPM in the name play once, unwarped, as one-shots.

## Things to know

- Auditioning while the session is stopped starts the whole session playing, because LUNA
  can only play the preview through its transport.
- Each audition adds one "Preview" step to LUNA's undo history.
- Each sample you audition is copied into the session's audio folder. LUNA's unused-media
  cleanup removes the ones you didn't keep.
- Tempo detection uses a LUNA engine command that isn't part of the documented Add On API.
  If a future LUNA changes it, the browser falls back to the file name and the loop's length.
- Keep the **Sample Preview** track (you can hide it). The browser finds it by name, and a
  new one is created without your plugins if you delete it.

## Licence

MIT, see [LICENSE](LICENSE). `vendor/luna.global.js` is Universal Audio's LUNA Builder SDK,
under the Apache License 2.0 (`vendor/LICENSE-luna-builder-sdk`).
