# Sound Typer

Plays an audio file and types text in sync with the music. Louder = faster typing, and hits (drums, a vocal kicking in, anything sudden) slam chunks of text in and shake the screen.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

## Usage

1. Drag and drop an audio file onto the app or use the file button (top left) to select one
2. Hit play
3. Watch the text get typed out at a pace driven by the audio

## How it works

When a song is loaded it's analyzed once, up front, in a Web Worker (well under a second for a typical song):

- **Loudness** — K-weighted, normalized to the track itself, so quiet intros type slowly and the loudest parts hit full speed regardless of how loud the file was mastered.
- **Hits** — onsets from spectral flux on a semitone filterbank (SuperFlux-style, so vocal vibrato doesn't trigger false hits), picked with a centered adaptive threshold. Each hit gets a strength from how it ranks within the track combined with how much louder it is than the moment before it — so a drum after silence or someone starting to scream counts as a big hit.

Because the whole track is known in advance, playback just looks up features at the audible position (output latency compensated): no smoothing lag, no late reactions. Typing is time-based, so it behaves the same on 60 Hz and 144 Hz displays.

### Customization

- **Text source** — swap out the default text with your own via the text source button (top right)
- **Volume** — in the toolbar (hidden on phones; use the hardware buttons)
- **Visualizer** — spectrum on top; below it a timeline of the typing intensity and detected hits (bright ones shake), including a look-ahead past the playhead
- **Settings** (gear icon):
  - **Typing** — Speed (characters per second at full volume), Dynamics (higher = quiet parts slower, loud parts stand out), Punch (how hard hits slam text in), Hits complete words, Whitespace handling
  - **Effects** — Screen shake on/off, shake strength and threshold, glow on hits (0 = off, up to 3x)
  - **Layout** — Text anchor (bottom or center), text width (ignored on phones)
  - **Reset to defaults**

## Build

```bash
bun run build
```

Output goes to `dist/`.
