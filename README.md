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

### Game mode

Switch the toolbar toggle from **Type** to **Game** for a rhythm game generated from the song. Pick a style on the start screen (or in Settings):

**Bullet hell** — emitters charge up and fire on the beat: bass hits throw out rings, crisp hits fire aimed spreads, the biggest hits get a warned laser, and loud sections fill the screen with spirals.

- **Move** — mouse, WASD or arrow keys; on touch, drag anywhere (the ship moves relative to your finger)
- **Focus** — hold Shift or the mouse button for slow, precise movement
- **Space**, **Esc** or **P** — pause / resume
- Only the white dot is your hitbox. Grazing bullets scores extra. Getting hit clears nearby bullets; there's no game over.

**Shapes** (Just Shapes & Beats style) — faint pink shapes warn where something is about to land, then turn solid exactly on the beat. Mostly bars: full rows and columns slamming down (some aimed at where you're standing), bars marching across the arena one lane per beat, walls sweeping through with a gap, and beams spinning around a drifting pivot, speeding up with the music and firing bursts of rays on the big hits. In between: circles and boxes popping up on the beat, trails of small bombs stepping across the arena, rows of shots flying in from an edge, and the occasional small bomb that lands where you were standing. Every warning lasts long enough to walk out of the way, so you never *have* to dash. Like the typewriter, it follows the music's intensity: quiet passages thin out and the background crawls; loud ones fill up, the background streaks rush past, and strong hits punch the camera in and thump the arena.

- **Move** — mouse, WASD or arrow keys; on touch, drag anywhere
- **Dash** — Space, Shift, X or click (on touch: a quick tap or a second finger). You're invulnerable while dashing, so you can dash *through* shapes, which scores extra
- **Esc** or **P** — pause
- You have a few health pips (more on Easy). Run out and the song rewinds to the last checkpoint (about every 30 s)
- Dashes need to recharge (a ring around you fills back up), longer on harder difficulties

**Wave** (Geometry Dash wave style) — hold to fly up at a steep diagonal, let go to fly down, while the level scrolls by. The level is laid around a path that turns on the music's hits, so you click and release on the beat. Tight tunnels zigzag along it, spiked corridors have saws on the outside of the turns, block columns leave a gap where the path passes, mini sections make the wave smaller and twice as steep, and spam sections turn on every hit. Speed follows the song: it changes only where the music does (a drop, a breakdown, a build), across six speed stages from the calmest parts to the most intense, and the wave goes mini for the busiest drops. Changes are marked by portals, a FASTER/SLOWER callout and a color change (cool when slow, hot when fast; the meter in the corner shows the current stage). Orbs on the turns score extra.

- **Fly up** — hold Space, W, Up or the mouse button (on touch: hold anywhere)
- **Esc** or **P** — pause
- Health and checkpoints work like in Shapes; after a hit you're put back on the path
- Plain floors and ceilings are safe to slide along, spiked ones aren't

In every style, the score multiplier grows the longer you go without getting hit. At the end you get a grade and your best score for that song, style and difficulty. Seeking turns the run into a practice run that doesn't count.

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
  - **Game** — Style (Bullet hell / Shapes / Wave), Difficulty (Easy / Normal / Hard: density, speed, warning time, timing window, health)
  - **Effects** — Screen shake on/off, shake strength and threshold, glow on hits (0 = off, up to 3x)
  - **Layout** — Text anchor (bottom or center), text width (ignored on phones)
  - **Reset to defaults**

## Build

```bash
bun run build
```

Output goes to `dist/`.
